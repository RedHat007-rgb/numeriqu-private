import {
  injectTenantScopePredicate,
  rewriteRelativeNowToAsOf,
  sqlUsesNowOrToday,
  validateDynamicSql,
} from './dynamic-sql';

describe('dynamic-sql', () => {
  test('accepts a scoped analytics query with name/value', () => {
    const sql = validateDynamicSql(
      `SELECT 'A' AS name, 1 AS value
       FROM analytics.sample_trial_balance
       WHERE tenant_id = {tenantId:String} AND org_id IN ({externalOrgIds:Array(String)})
       LIMIT 100`,
      { analyticsDb: 'analytics', chartType: 'bar' },
    );
    expect(sql).toMatch(/FROM analytics\.sample_trial_balance/i);
  });

  test('rejects missing tenant predicate', () => {
    expect(() =>
      validateDynamicSql(
        `SELECT 'A' AS name, 1 AS value
         FROM analytics.sample_trial_balance
         WHERE org_id IN ({externalOrgIds:Array(String)}) AND {tenantId:String} != ''
         LIMIT 100`,
        { analyticsDb: 'analytics', chartType: 'bar' },
      ),
    ).toThrow(/tenant_id scope predicate/i);
  });

  test('rejects missing org predicate', () => {
    expect(() =>
      validateDynamicSql(
        `SELECT 'A' AS name, 1 AS value
         FROM analytics.sample_trial_balance
         WHERE tenant_id = {tenantId:String} AND {externalOrgIds:Array(String)} != []
         LIMIT 100`,
        { analyticsDb: 'analytics', chartType: 'bar' },
      ),
    ).toThrow(/org_id scope predicate/i);
  });

  test('rejects cross-database reads', () => {
    expect(() =>
      validateDynamicSql(
        `SELECT 'A' AS name, 1 AS value
         FROM otherdb.some_table
         WHERE tenant_id = {tenantId:String} AND org_id IN ({externalOrgIds:Array(String)})
         LIMIT 10`,
        { analyticsDb: 'analytics', chartType: 'bar' },
      ),
    ).toThrow(/only read from "analytics\.\*"/i);
  });

  test('table charts may omit name/value', () => {
    const sql = validateDynamicSql(
      `SELECT invoice_number, total_amount
       FROM analytics.v_fact_accounting_invoices_latest
       WHERE tenant_id = {tenantId:String} AND org_id IN ({externalOrgIds:Array(String)})
       LIMIT 50`,
      { analyticsDb: 'analytics', chartType: 'table' },
    );
    expect(sql).toMatch(/invoice_number/i);
  });

  test('injectTenantScopePredicate adds tenant_id when the planner writes org_id only', () => {
    // Reproduces the real failure: every planner widget was rejected with
    // "missing tenantId param placeholder" because the LLM scoped by org_id only.
    const orgOnly = `SELECT account_name AS name, round(sum(toFloat64(debit)), 0) AS value
       FROM analytics.sample_gl_dump
       WHERE org_id IN ({externalOrgIds:Array(String)}) AND account_type = 'Expense'
       GROUP BY account_name ORDER BY value DESC LIMIT 15`;
    const injected = injectTenantScopePredicate(orgOnly);
    expect(injected).toMatch(
      /tenant_id = \{tenantId:String\} AND org_id IN \(\{externalOrgIds:Array\(String\)\}\)/,
    );
    // And the result must now pass full validation end-to-end.
    expect(() =>
      validateDynamicSql(injected, { analyticsDb: 'analytics', chartType: 'bar' }),
    ).not.toThrow();
  });

  test('injectTenantScopePredicate is a no-op when tenant predicate already present', () => {
    const scoped = `SELECT 'A' AS name, 1 AS value
       FROM analytics.sample_trial_balance
       WHERE tenant_id = {tenantId:String} AND org_id IN ({externalOrgIds:Array(String)})
       LIMIT 100`;
    expect(injectTenantScopePredicate(scoped)).toBe(scoped);
  });

  test('injectTenantScopePredicate scopes every org predicate (subqueries too)', () => {
    const twoPredicates = `SELECT name, value FROM (
         SELECT account_name AS name, sum(toFloat64(debit)) AS value
         FROM analytics.sample_gl_dump
         WHERE org_id IN ({externalOrgIds:Array(String)})
         GROUP BY account_name
       ) WHERE value > (
         SELECT avg(toFloat64(debit)) FROM analytics.sample_gl_dump
         WHERE org_id IN ({externalOrgIds:Array(String)})
       ) LIMIT 50`;
    const injected = injectTenantScopePredicate(twoPredicates);
    const matches = injected.match(/tenant_id = \{tenantId:String\}/g) ?? [];
    expect(matches.length).toBe(2);
  });

  test('accepts a WITH (CTE) query for month-over-month growth', () => {
    const sql = `WITH m AS (
        SELECT toStartOfMonth(journal_date) AS mo,
               round(sumIf(toFloat64(line_amount), line_amount > 0), 2) AS spend
        FROM analytics.v_fact_accounting_journal_lines_latest
        WHERE tenant_id = {tenantId:String} AND org_id IN ({externalOrgIds:Array(String)})
        GROUP BY toStartOfMonth(journal_date)
      )
      SELECT formatDateTime(mo, '%b %Y') AS name,
             round((spend - lagInFrame(spend) OVER (ORDER BY mo)) / nullIf(lagInFrame(spend) OVER (ORDER BY mo), 0) * 100, 1) AS value
      FROM m ORDER BY mo ASC LIMIT 200`;
    const out = validateDynamicSql(sql, { analyticsDb: 'analytics', chartType: 'line' });
    expect(out).toMatch(/^WITH/i);
  });

  test('accepts a WIDE multi-series query with no "value" column', () => {
    const sql = `SELECT formatDateTime(toStartOfMonth(issued_at), '%b %Y') AS name,
             round(sumIf(total_amount, contact_name = 'Apex Ventures Ltd'), 2) AS apex_ventures_ltd,
             round(sumIf(total_amount, contact_name = 'BlueOak Distributors'), 2) AS blueoak_distributors
      FROM analytics.v_fact_accounting_invoices_latest
      WHERE tenant_id = {tenantId:String} AND org_id IN ({externalOrgIds:Array(String)})
      GROUP BY toStartOfMonth(issued_at) ORDER BY toStartOfMonth(issued_at) ASC LIMIT 24`;
    const out = validateDynamicSql(sql, { analyticsDb: 'analytics', chartType: 'line' });
    expect(out).toMatch(/apex_ventures_ltd/);
  });

  test('rejects a single-series query that omits "value"', () => {
    expect(() =>
      validateDynamicSql(
        `SELECT account_name AS name, round(sum(toFloat64(debit)), 0) AS spend
         FROM analytics.sample_gl_dump
         WHERE tenant_id = {tenantId:String} AND org_id IN ({externalOrgIds:Array(String)})
         GROUP BY account_name LIMIT 20`,
        { analyticsDb: 'analytics', chartType: 'bar' },
      ),
    ).toThrow(/value.*or.*series|series columns/i);
  });

  test('rejects a query starting with neither SELECT nor WITH', () => {
    expect(() =>
      validateDynamicSql(
        `EXPLAIN SELECT 'A' AS name, 1 AS value FROM analytics.sample_gl_dump
         WHERE tenant_id = {tenantId:String} AND org_id IN ({externalOrgIds:Array(String)}) LIMIT 1`,
        { analyticsDb: 'analytics', chartType: 'bar' },
      ),
    ).toThrow(/start with SELECT or WITH/i);
  });

  test('rewriteRelativeNowToAsOf replaces now()/today()', () => {
    const raw = `SELECT now() AS n, today() AS d
                 FROM analytics.sample_gl_dump
                 WHERE tenant_id = {tenantId:String} AND org_id IN ({externalOrgIds:Array(String)})
                 LIMIT 1`;
    expect(sqlUsesNowOrToday(raw)).toBe(true);
    const rewritten = rewriteRelativeNowToAsOf(raw);
    expect(rewritten).toMatch(/\{asOf:String\}/);
    expect(rewritten).not.toMatch(/\bnow\s*\(\s*\)\b/i);
    expect(rewritten).not.toMatch(/\btoday\s*\(\s*\)\b/i);
  });

  // ─── Security: tenant-scope bypass + external source functions ───────────────
  test('rejects a block-comment scope bypass (proven cross-tenant leak)', () => {
    // The scope predicate is hidden in a comment: it satisfies a naive text check
    // but ClickHouse ignores the comment and runs WHERE 1=1 → all tenants.
    expect(() =>
      validateDynamicSql(
        `SELECT account_name AS name, sum(toFloat64(debit)) AS value
         FROM analytics.sample_gl_dump
         WHERE 1=1 /* AND tenant_id = {tenantId:String} AND org_id IN ({externalOrgIds:Array(String)}) */
         GROUP BY account_name LIMIT 50`,
        { analyticsDb: 'analytics', chartType: 'bar' },
      ),
    ).toThrow(/must not contain comments/i);
  });

  test('rejects a line-comment (--) scope bypass', () => {
    expect(() =>
      validateDynamicSql(
        `SELECT a AS name, 1 AS value FROM analytics.sample_gl_dump
         WHERE 1=1 -- tenant_id = {tenantId:String} AND org_id IN ({externalOrgIds:Array(String)})
         LIMIT 50`,
        { analyticsDb: 'analytics', chartType: 'bar' },
      ),
    ).toThrow(/must not contain comments/i);
  });

  test('rejects external table/source functions (url/remote/s3/file)', () => {
    for (const fn of [
      `url('http://attacker/', 'CSV', 's String')`,
      `remote('1.2.3.4', 'db.t')`,
      `s3('http://x/y', 'CSV', 'c String')`,
      `file('/etc/passwd', 'CSV', 'c String')`,
    ]) {
      expect(() =>
        validateDynamicSql(
          `SELECT name, value FROM ${fn}
           WHERE tenant_id = {tenantId:String} AND org_id IN ({externalOrgIds:Array(String)})
           LIMIT 1`,
          { analyticsDb: 'analytics', chartType: 'bar' },
        ),
      ).toThrow(/table\/source functions/i);
    }
  });

  test('rejects an unscoped subquery to an analytics table (cross-tenant leak)', () => {
    // Outer query is scoped, but the subquery reads analytics.sample_gl_dump with NO
    // scope predicate → it would expose every tenant's rows.
    expect(() =>
      validateDynamicSql(
        `SELECT account_name AS name, sum(toFloat64(debit)) AS value
         FROM analytics.sample_gl_dump
         WHERE tenant_id = {tenantId:String} AND org_id IN ({externalOrgIds:Array(String)})
           AND debit > (SELECT avg(toFloat64(debit)) FROM analytics.sample_gl_dump)
         GROUP BY account_name LIMIT 50`,
        { analyticsDb: 'analytics', chartType: 'bar' },
      ),
    ).toThrow(/scope every analytics table reference/i);
  });

  test('accepts a subquery when BOTH references are scoped', () => {
    const sql = validateDynamicSql(
      `SELECT account_name AS name, sum(toFloat64(debit)) AS value
       FROM analytics.sample_gl_dump
       WHERE tenant_id = {tenantId:String} AND org_id IN ({externalOrgIds:Array(String)})
         AND debit > (SELECT avg(toFloat64(debit)) FROM analytics.sample_gl_dump
                      WHERE tenant_id = {tenantId:String} AND org_id IN ({externalOrgIds:Array(String)}))
       GROUP BY account_name LIMIT 50`,
      { analyticsDb: 'analytics', chartType: 'bar' },
    );
    expect(sql).toMatch(/account_name AS name/i);
  });

  test('a column merely named "url" is not blocked (no false positive)', () => {
    const sql = validateDynamicSql(
      `SELECT url AS name, count() AS value
       FROM analytics.sample_gl_dump
       WHERE tenant_id = {tenantId:String} AND org_id IN ({externalOrgIds:Array(String)})
       GROUP BY url LIMIT 50`,
      { analyticsDb: 'analytics', chartType: 'bar' },
    );
    expect(sql).toMatch(/url AS name/i);
  });
});
