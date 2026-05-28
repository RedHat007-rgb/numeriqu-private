import {
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
});
