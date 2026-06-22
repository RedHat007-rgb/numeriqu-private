import {
  compileEbpoSpec,
  validateEbpoSpec,
  resolveEbpoView,
  EBPO_MEASURES,
} from './chart-spec-ebpo';
import type { ChartSpec } from './chart-spec';

const DB = 'analytics';
const noRows = async () => [] as Array<Record<string, unknown>>;

// Convenience: compile and assert success, returning the SQL.
async function sqlFor(
  spec: ChartSpec,
  runRows = noRows,
): Promise<string> {
  const r = await compileEbpoSpec(spec, DB, runRows);
  if (!r.ok) throw new Error(`expected build, got refusal: ${r.refusal}`);
  return r.sql;
}

const base = (over: Partial<ChartSpec>): ChartSpec => ({
  measure: 'total_revenue',
  dimension: 'month',
  chartType: 'line',
  ...over,
});

describe('EBPO catalog — view resolution', () => {
  test('revenue by business_unit resolves to the dedicated BU view', () => {
    expect(resolveEbpoView('total_revenue', 'business_unit', null)?.name).toBe(
      'v_ebpo_revenue_by_business_unit',
    );
  });

  test('revenue over time resolves to the monthly revenue view', () => {
    expect(resolveEbpoView('total_revenue', 'month', null)?.name).toBe(
      'v_ebpo_revenue_monthly',
    );
  });

  test('a measure with no view exposing the dimension does not resolve', () => {
    // DSO only exists in the time-only KPI view → cannot be grouped by client.
    expect(resolveEbpoView('dso_days', 'client', null)).toBeNull();
  });

  test('derived cost per employee resolves to the payroll view by country', () => {
    expect(resolveEbpoView('cost_per_employee', 'country', null)?.name).toBe(
      'v_ebpo_payroll_monthly',
    );
  });

  test('employee count by department avoids the monthly payroll view', () => {
    const view = resolveEbpoView('employee_count', 'department', null);
    expect(view).not.toBeNull();
    expect(view?.hasTime).toBe(false);
    expect(view?.name).not.toBe('v_ebpo_payroll_monthly');
  });

  test('allocated revenue resolves to the delivery-center efficiency view', () => {
    expect(resolveEbpoView('allocated_revenue', 'delivery_center', null)?.name).toBe(
      'v_ebpo_delivery_center_efficiency_monthly',
    );
  });
});

describe('EBPO compiler — aggregation correctness', () => {
  test('flow measure uses SUM', async () => {
    const sql = await sqlFor(base({ measure: 'total_revenue', dimension: 'business_unit', chartType: 'bar' }));
    expect(sql).toMatch(/sum\(total_revenue_usd\)/);
    expect(sql).not.toMatch(/avg\(total_revenue_usd\)/);
    expect(sql).toContain('analytics.v_ebpo_revenue_by_business_unit');
  });

  test('ratio measure uses RATIO-OF-SUMS, never a naive SUM of the ratio', async () => {
    // gross_margin_pct = sum(gross_margin)/sum(revenue)*100 (matches PowerBI DAX
    // DIVIDE(SUM,SUM)). Averaging a precomputed per-row pct is wrong when the view
    // grain is finer than the cell (BU×contract_type×month) — it produced impossible
    // values (>100%) and NaN→0% for missing combos.
    const sql = await sqlFor(base({ measure: 'gross_margin_pct', dimension: 'business_unit', chartType: 'bar' }));
    expect(sql).toMatch(/sum\(gross_margin_usd\)\s*\/\s*nullIf\(sum\(total_revenue_usd\), 0\)\s*\*\s*100/);
    expect(sql).not.toMatch(/avg\(gross_margin_pct\)/);
    expect(sql).not.toMatch(/sum\(gross_margin_pct\)/);
  });

  test('cash balance uses MAX (matches DAX MAX(CashBalance))', async () => {
    const sql = await sqlFor(base({ measure: 'cash_balance', dimension: 'month', chartType: 'line' }));
    expect(sql).toMatch(/max\(cash_balance_usd\)/);
  });

  test('stock measure grouped by a non-time dim restricts to the latest period', async () => {
    const sql = await sqlFor(base({ measure: 'ar_outstanding', dimension: 'client', chartType: 'bar' }));
    expect(sql).toContain('period_date = (SELECT max(period_date)');
    expect(sql).toMatch(/sum\(outstanding_balance_usd\)/);
  });

  test('stock measure over time shows the monthly balance (no latest-period filter)', async () => {
    const sql = await sqlFor(base({ measure: 'ar_outstanding', dimension: 'month', chartType: 'line' }));
    expect(sql).not.toContain('period_date = (SELECT max(period_date)');
  });
});

describe('EBPO compiler — shapes', () => {
  test('KPI (no dimension) selects a single value with no GROUP BY', async () => {
    const r = await compileEbpoSpec({ measure: 'total_revenue', dimension: '', chartType: 'kpi' } as ChartSpec, DB, noRows);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.sql).toMatch(/SELECT round\(sum\(total_revenue_usd\), 0\) AS value/);
      expect(r.sql).not.toContain('GROUP BY');
    }
  });

  test('breakdown produces a WIDE pivot using conditional aggregation', async () => {
    const runRows = async () => [
      { v: 'Banking BPO', m: 50 },
      { v: 'Healthcare BPO', m: 30 },
    ];
    const sql = await sqlFor(
      base({ measure: 'total_revenue', dimension: 'month', breakdown: 'business_unit', chartType: 'stacked_bar' }),
      runRows,
    );
    expect(sql).toMatch(/sumIf\(total_revenue_usd, .*Banking BPO/);
    expect(sql).toContain('"Banking BPO"');
    expect(sql).toContain('"Healthcare BPO"');
  });

  test('topN and value sort are honored for ranking charts', async () => {
    const sql = await sqlFor(base({ measure: 'total_revenue', dimension: 'client', chartType: 'bar', topN: 5, sort: 'value_desc' }));
    expect(sql).toContain('LIMIT 5');
    expect(sql).toContain('ORDER BY value DESC');
  });

  test('time dimension always orders chronologically', async () => {
    const sql = await sqlFor(base({ measure: 'total_revenue', dimension: 'month', chartType: 'line' }));
    expect(sql).toMatch(/ORDER BY toStartOfMonth\(period_date\) ASC/);
  });

  test('employee count by department compiles against a non-time headcount view', async () => {
    const sql = await sqlFor(base({ measure: 'employee_count', dimension: 'department', chartType: 'bar' }));
    expect(sql).toMatch(/analytics\.v_ebpo_(employee_headcount|salary_by_dept_grade)/);
    expect(sql).not.toContain('v_ebpo_payroll_monthly');
    expect(sql).not.toContain('period_date = (SELECT max(period_date)');
  });
});

describe('EBPO compiler — honest refusals', () => {
  test('unavailable concept is refused, not fabricated', async () => {
    const r = await compileEbpoSpec({ measure: 'budget', dimension: 'month', chartType: 'line' } as ChartSpec, DB, noRows);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal).toMatch(/budget/i);
  });

  test('unknown measure is refused', async () => {
    const r = validateEbpoSpec({ measure: 'made_up_kpi', dimension: 'month', chartType: 'line' } as ChartSpec);
    expect(r?.ok).toBe(false);
  });

  test('measure×dimension with no provider view is refused (no guessed join)', async () => {
    const r = validateEbpoSpec({ measure: 'dso_days', dimension: 'client', chartType: 'bar' } as ChartSpec);
    expect(r?.ok).toBe(false);
    if (r) expect(r.refusal).toMatch(/DSO/i);
  });
});

describe('EBPO catalog — derived CFO ratios', () => {
  // Catalogued (backed by the canonical superset view) so create + combo follow-ups
  // are deterministic. Current/quick ratio remain refused (no current-liabilities).
  test.each([
    ['cost_to_income_pct', 'cost_to_income_pct'],
    ['fcf_margin_pct', 'fcf_margin_pct'],
    ['operating_cf_to_revenue_pct', 'operating_cf_to_revenue_pct'],
    ['ebitda_style_margin_pct', 'ebitda_style_margin_pct'],
    ['working_capital', 'working_capital_usd'],
  ])('%s resolves to the canonical cfo-ratios view by month', async (measure, column) => {
    expect(resolveEbpoView(measure, 'month', null)?.name).toBe('v_ebpo_cfo_ratios_monthly');
    const sql = await sqlFor(base({ measure, dimension: 'month', chartType: 'line' }));
    expect(sql).toContain('analytics.v_ebpo_cfo_ratios_monthly');
    expect(sql).toContain(column);
  });

  test('a ratio + base-measure combo resolves to the superset view', async () => {
    const sql = await sqlFor(
      base({ measure: 'ebitda_style_margin_pct', measures: ['ebitda_style_margin_pct', 'gross_margin_pct'], dimension: 'month', chartType: 'combo' }),
    );
    expect(sql).toContain('analytics.v_ebpo_cfo_ratios_monthly');
    expect(sql).toContain('"EBITDA-style Margin %"');
    expect(sql).toContain('"Gross Margin %"');
  });

  test('receivables/revenue and payables/cost compile as ratios of sums', async () => {
    const arSql = await sqlFor(
      base({ measure: 'ar_to_revenue_pct', dimension: 'month', chartType: 'line' }),
    );
    const apSql = await sqlFor(
      base({ measure: 'ap_to_cost_pct', dimension: 'month', chartType: 'line' }),
    );
    expect(arSql).toMatch(
      /sum\(ar_outstanding_usd\) \/ nullIf\(sum\(total_revenue_usd\), 0\) \* 100/,
    );
    expect(apSql).toMatch(
      /sum\(ap_outstanding_usd\) \/ nullIf\(sum\(total_cost_usd\), 0\) \* 100/,
    );
  });

  test('current/quick ratio are NOT catalogued (refused upstream, never faked)', () => {
    expect(EBPO_MEASURES['current_ratio']).toBeUndefined();
    expect(EBPO_MEASURES['quick_ratio']).toBeUndefined();
  });
});

describe('EBPO compiler — multi-measure (combo / dual-axis)', () => {
  test('two measures by month → one view, two series columns, sum vs avg respected', async () => {
    const sql = await sqlFor(
      base({ measure: 'total_revenue', measures: ['total_revenue', 'gross_margin_pct'], dimension: 'month', chartType: 'combo' }),
    );
    expect(sql).toMatch(/sum\(total_revenue_usd\).*AS "Total Revenue"/);
    expect(sql).toMatch(/sum\(gross_margin_usd\)\s*\/\s*nullIf\(sum\(total_revenue_usd\), 0\)\s*\*\s*100.*AS "Gross Margin %"/);
    expect(sql).toMatch(/GROUP BY toStartOfMonth\(period_date\)/);
    // single FROM — all series come from one view
    expect((sql.match(/FROM analytics\./g) || []).length).toBe(1);
  });

  test('multi-measure plus breakdown preserves both measures for every breakdown value', async () => {
    const sql = await sqlFor(
      base({
        measure: 'opening_balance',
        measures: ['opening_balance', 'closing_balance'],
        dimension: 'month',
        breakdown: 'account',
        chartType: 'line',
      }),
      async () => [
        { v: 'Cash', m: 100 },
        { v: 'Accounts Payable', m: -80 },
      ],
    );

    expect(sql).toContain('analytics.v_ebpo_trial_balance_monthly');
    expect(sql).toContain('"Cash | Opening Balance"');
    expect(sql).toContain('"Cash | Closing Balance"');
    expect(sql).toContain('"Accounts Payable | Opening Balance"');
    expect(sql).toContain('"Accounts Payable | Closing Balance"');
    expect(sql).toMatch(/sumIf\(opening_balance_usd, .*'Cash'/);
    expect(sql).toMatch(/sumIf\(closing_balance_usd, .*'Cash'/);
  });

  test('cash-flow components combo resolves to the cash-flow view', async () => {
    const sql = await sqlFor(
      base({ measure: 'operating_cf', measures: ['operating_cf', 'investing_cf', 'financing_cf'], dimension: 'month', chartType: 'combo' }),
    );
    expect(sql).toContain('analytics.v_ebpo_cash_flow_monthly');
    expect(sql).toContain('"Operating Cash Flow"');
    expect(sql).toContain('"Financing Cash Flow"');
  });

  test('scatter emits name/x/y columns (measure-vs-measure per point)', async () => {
    const sql = await sqlFor(
      base({ measure: 'total_revenue', measures: ['total_revenue', 'gross_margin'], dimension: 'client', chartType: 'scatter' }),
    );
    expect(sql).toMatch(/AS name/);
    expect(sql).toMatch(/sum\(total_revenue_usd\).*AS x/);
    expect(sql).toMatch(/sum\(gross_margin_usd\).*AS y/);
  });

  test('client revenue and collection rate bubble compiles against the client revenue view', async () => {
    const sql = await sqlFor(
      base({
        measure: 'total_revenue',
        measures: ['total_revenue', 'collection_rate_pct', 'ar_outstanding'],
        dimension: 'client',
        chartType: 'bubble',
      }),
    );
    expect(sql).toContain('analytics.v_ebpo_client_revenue_collection');
    expect(sql).toMatch(/AS x/);
    expect(sql).toMatch(/AS y/);
    expect(sql).toMatch(/AS z/);
  });

  test('bubble adds a z (size) column', async () => {
    const sql = await sqlFor(
      base({ measure: 'total_revenue', measures: ['total_revenue', 'collection_rate_pct', 'ar_outstanding'], dimension: 'client', chartType: 'bubble' }),
    );
    expect(sql).toMatch(/AS x/);
    expect(sql).toMatch(/AS y/);
    expect(sql).toMatch(/AS z/);
  });

  test('multi-measure with no dimension → KPI scorecard (one row per measure)', async () => {
    const r = await compileEbpoSpec(
      { measure: 'total_revenue', measures: ['total_revenue', 'total_cost'], dimension: '', chartType: 'kpi' } as ChartSpec,
      DB, noRows,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.sql).toContain('UNION ALL');
      expect(r.sql).toContain("'Total Revenue' AS name");
      expect(r.sql).toContain("'Total Cost' AS name");
      expect(r.sql).toContain("'Total Revenue' AS label");
      expect(r.sql).toContain("'currency' AS format");
    }
  });

  test('KPI scorecards can union measures from independently verified views', async () => {
    const r = await compileEbpoSpec(
      {
        measure: 'gross_margin_pct',
        measures: ['gross_margin_pct', 'cost_per_employee', 'fcf_margin_pct'],
        dimension: '',
        chartType: 'kpi',
      } as ChartSpec,
      DB,
      noRows,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.view).toBe('multiple_verified_views');
      expect(r.sql).toContain("'Gross Margin %' AS label");
      expect(r.sql).toContain("'Cost per Employee' AS label");
      expect(r.sql).toContain("'Free Cash Flow Margin %' AS label");
      expect(r.sql).toContain("'percent' AS format");
    }
  });

  test('measures with no common view are refused (no cross-view join guessed)', async () => {
    const r = await compileEbpoSpec(
      { measure: 'avg_monthly_salary', measures: ['avg_monthly_salary', 'calls_handled'], dimension: 'month', chartType: 'combo' } as ChartSpec,
      DB, noRows,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal).toMatch(/no single EBPO view/i);
  });
});

describe('EBPO catalog — coverage', () => {
  test('all 27 DAX measures (+derived) are registered and each has a provider view', () => {
    const ids = Object.keys(EBPO_MEASURES);
    expect(ids.length).toBeGreaterThanOrEqual(27);
    // Every measure must be served by at least one view (otherwise it can never compile).
    const orphans = ids.filter((id) => resolveEbpoView(id, null, null) === null);
    expect(orphans).toEqual([]);
  });
});
