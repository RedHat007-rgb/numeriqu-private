import {
  compileEbpoSpec,
  validateEbpoSpec,
  resolveEbpoView,
  ebpoComboSeriesRoles,
  EBPO_MEASURES,
  effectiveEbpoChartType,
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
    // Cash Balance only exists in time-only views → cannot be grouped by client.
    expect(resolveEbpoView('cash_balance', 'client', null)).toBeNull();
  });

  test('payroll per employee (payroll/headcount) resolves to the payroll view by country', () => {
    expect(resolveEbpoView('payroll_per_employee', 'country', null)?.name).toBe(
      'v_ebpo_payroll_monthly',
    );
  });

  test('cost per employee (DAX: Total Cost/headcount) resolves where cost + headcount co-exist', () => {
    // Total Cost is booked by client/business unit, so cost-per-employee resolves to the
    // BU efficiency view (real per-BU values + company grain) — NOT the payroll view.
    expect(resolveEbpoView('cost_per_employee', null, null)?.name).toBe(
      'v_ebpo_business_unit_efficiency',
    );
    expect(resolveEbpoView('cost_per_employee', 'business_unit', null)?.name).toBe(
      'v_ebpo_business_unit_efficiency',
    );
  });

  test('cost per employee by month can use a view that exposes the precomputed monthly metric directly', () => {
    expect(resolveEbpoView('cost_per_employee', 'month', null)?.name).toBe(
      'v_ebpo_department_efficiency_monthly',
    );
  });

  test('derived overtime to payroll percentage resolves to the payroll view', () => {
    expect(resolveEbpoView('overtime_to_payroll_pct', 'department', null)?.name).toBe(
      'v_ebpo_payroll_monthly',
    );
  });

  test('employee count by department avoids the monthly payroll view', () => {
    const view = resolveEbpoView('employee_count', 'department', null);
    expect(view).not.toBeNull();
    expect(view?.hasTime).toBe(false);
    expect(view?.name).not.toBe('v_ebpo_payroll_monthly');
  });

  test('revenue has NO geography relationship — no view exposes it by country/region/delivery center', () => {
    // FactRevenue has no geography key. The fabricated allocated_revenue measure was removed,
    // so total_revenue does not resolve against any geography dimension.
    expect(resolveEbpoView('total_revenue', 'country', null)).toBeNull();
    expect(resolveEbpoView('total_revenue', 'region', null)).toBeNull();
    expect(resolveEbpoView('total_revenue', 'delivery_center', null)).toBeNull();
    expect(resolveEbpoView('total_revenue', 'city', null)).toBeNull();
    // and there is no longer an allocated_revenue measure at all
    expect(EBPO_MEASURES['allocated_revenue']).toBeUndefined();
  });

  test('OPERATIONS metrics still resolve by delivery center / country (real relationship)', () => {
    // operations are genuinely keyed by delivery_center (→ geography), so these resolve to a
    // real operations view (v_ebpo_operations_monthly wins as the dedicated provider).
    expect(resolveEbpoView('calls_handled', 'delivery_center', null)?.name).toMatch(
      /^v_ebpo_(operations_monthly|delivery_center_efficiency_monthly)$/,
    );
    expect(resolveEbpoView('utilization_pct', 'country', null)?.name).toMatch(
      /^v_ebpo_(operations_monthly|delivery_center_efficiency_monthly)$/,
    );
  });

});

describe('EBPO compiler — aggregation correctness', () => {
  test('preserves an explicitly requested pie or donut for ratio measures', () => {
    expect(
      effectiveEbpoChartType({
        measure: 'csat_pct',
        dimension: 'country',
        chartType: 'pie',
      }),
    ).toBe('pie');
    expect(
      effectiveEbpoChartType({
        measure: 'sla_compliance_pct',
        dimension: 'region',
        chartType: 'donut',
      }),
    ).toBe('donut');
  });

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

  test('overtime to payroll percentage uses RATIO-OF-SUMS', async () => {
    const sql = await sqlFor(
      base({
        measure: 'overtime_to_payroll_pct',
        dimension: 'department',
        chartType: 'bar',
      }),
    );
    expect(sql).toMatch(/sum\(total_overtime_usd\)\s*\/\s*nullIf\(sum\(total_payroll_usd\), 0\)\s*\*\s*100/);
    expect(sql).not.toMatch(/avg\(overtime_to_payroll_pct\)/);
    expect(sql).not.toMatch(/sum\(overtime_to_payroll_pct\)/);
  });

  test('cash balance uses MAX (matches DAX MAX(CashBalance))', async () => {
    const sql = await sqlFor(base({ measure: 'cash_balance', dimension: 'month', chartType: 'line' }));
    expect(sql).toMatch(/max\(cash_balance_usd\)/);
  });

  test('stock measure grouped by a non-time dim restricts to the latest period', async () => {
    const sql = await sqlFor(base({ measure: 'closing_balance', dimension: 'account', chartType: 'bar' }));
    expect(sql).toContain('period_date = (SELECT max(period_date)');
    expect(sql).toMatch(/sum\(closing_balance_usd\)/);
  });

  test('stock measure over time shows the monthly balance (no latest-period filter)', async () => {
    const sql = await sqlFor(base({ measure: 'closing_balance', dimension: 'month', chartType: 'line' }));
    expect(sql).not.toContain('period_date = (SELECT max(period_date)');
  });

  // Account-level (trial-balance) expense is REFUSED: it doesn't reconcile with the
  // dataset's authoritative figures (its Payroll Expense account ≪ actual Total Payroll),
  // so an expense-by-account-category chart would present contradictory numbers.
  test('account-level (trial-balance) expense breakdown is refused as inconsistent', async () => {
    const r = await compileEbpoSpec(
      base({
        measure: 'account_expense',
        dimension: 'month',
        breakdown: 'account',
        chartType: 'heatmap',
      }),
      DB,
      async () => [],
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.refusal).toMatch(/trustworthy expense breakdown by account/i);
      expect(r.refusal).toMatch(/trial balance/i);
      expect(r.refusal).toMatch(/Total Cost, Total Payroll, or Total Expenses/i);
    }
  });

  // AR/AP Outstanding match PowerBI: SUM over the snapshot/date context, NOT latest-month
  // (the .pbix "AR vs AP" page slices only by FiscalYear). kind=flow → no latest filter.
  test.each(['ar_outstanding', 'ap_outstanding'])(
    '%s sums across snapshots (matches PowerBI DAX), no latest-period filter',
    async (measure) => {
      const sql = await sqlFor(base({ measure, dimension: measure === 'ar_outstanding' ? 'client' : 'vendor', chartType: 'bar' }));
      expect(sql).not.toContain('period_date = (SELECT max(period_date)');
      expect(sql).toMatch(/sum\(outstanding_balance_usd\)/);
    },
  );
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
    // Most-recent-N wrap: the inner query takes the latest periods (ORDER BY __ord
    // DESC) then the outer re-sorts ascending for display. __ord is the month key, so
    // the final series is chronological.
    expect(sql).toMatch(/toStartOfMonth\(period_date\) AS __ord/);
    expect(sql).toMatch(/ORDER BY __ord ASC/);
  });

  test('employee count by department compiles against a non-time headcount view', async () => {
    const sql = await sqlFor(base({ measure: 'employee_count', dimension: 'department', chartType: 'bar' }));
    expect(sql).toMatch(/analytics\.v_ebpo_(employee_headcount|salary_by_dept_grade)/);
    expect(sql).not.toContain('v_ebpo_payroll_monthly');
    expect(sql).not.toContain('period_date = (SELECT max(period_date)');
  });

  test('revenue by country / region is REFUSED, not fabricated (no geography relationship)', async () => {
    // total_revenue is an additive flow with no geography view → not replicated, refused.
    const country = await compileEbpoSpec(
      { measure: 'total_revenue', dimension: 'country', chartType: 'bar' } as ChartSpec,
      DB,
      noRows,
    );
    expect(country.ok).toBe(false);
    if (!country.ok) {
      // polite + professional, no internal jargon, and HELPFUL (suggests real alternatives)
      expect(country.refusal).toMatch(/^I'm sorry/);
      expect(country.refusal).toMatch(/Country/);
      expect(country.refusal).not.toMatch(/no EBPO view|view exposes/i); // no jargon
      expect(country.refusal).toMatch(/I can show Total Revenue by .*Business Unit/);
      expect(country.refusal).toMatch(/over time \(by month, quarter, or year\)/);
      expect(country.refusal).toMatch(/I've left the chart unchanged\./);
    }

    const region = await compileEbpoSpec(
      { measure: 'total_revenue', dimension: 'region', chartType: 'bar' } as ChartSpec,
      DB,
      noRows,
    );
    expect(region.ok).toBe(false);
  });

  test('operations by delivery center compiles against an operations view', async () => {
    const sql = await sqlFor(
      base({ measure: 'calls_handled', dimension: 'delivery_center', chartType: 'bar' }),
    );
    expect(sql).toMatch(/analytics\.v_ebpo_(operations_monthly|delivery_center_efficiency_monthly)/);
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

  test('a RATIO measure replicates across an unrelated dimension (PowerBI parity)', async () => {
    // csat_pct (an average %) has no per-client view but resolves company-wide and client
    // categories can be enumerated → the compiler replicates the company AVERAGE across
    // clients (a flat benchmark reads sensibly for an average). Allowed, not refused.
    const r = validateEbpoSpec({ measure: 'csat_pct', dimension: 'client', chartType: 'bar' } as ChartSpec);
    expect(r).toBeNull();
  });

  test('an ADDITIVE measure does NOT replicate across an unrelated dimension', async () => {
    // asset_cost / cash_balance are sum/stock measures: replicating the company TOTAL onto
    // every category is nonsense ("asset cost by client" = the whole company on every
    // client), so an unrelated breakdown is refused, not replicated.
    const assets = validateEbpoSpec({ measure: 'asset_cost', dimension: 'client', chartType: 'bar' } as ChartSpec);
    expect(assets?.ok).toBe(false);
    const cash = validateEbpoSpec({ measure: 'cash_balance', dimension: 'client', chartType: 'bar' } as ChartSpec);
    expect(cash?.ok).toBe(false);
  });

  test('a measure absent from the catalog is still refused (no fabrication)', async () => {
    const r = validateEbpoSpec({ measure: 'headcount_forecast', dimension: 'client', chartType: 'bar' } as ChartSpec);
    expect(r?.ok).toBe(false);
  });
});

describe('EBPO catalog — derived CFO ratios', () => {
  // Catalogued (backed by the canonical superset view) so create + combo follow-ups
  // are deterministic. Current/quick ratio remain refused (no current-liabilities).
  // Still backed by the precomputed superset column (no base-column derivation yet).
  test.each([['working_capital', 'working_capital_usd']])(
    '%s resolves to the canonical cfo-ratios view by month',
    async (measure, column) => {
      expect(resolveEbpoView(measure, 'month', null)?.name).toBe('v_ebpo_cfo_ratios_monthly');
      const sql = await sqlFor(base({ measure, dimension: 'month', chartType: 'line' }));
      expect(sql).toContain('analytics.v_ebpo_cfo_ratios_monthly');
      expect(sql).toContain(column);
    },
  );

  // Now derived = ratio-of-sums (DIVIDE(SUM,SUM)), matching PowerBI DAX — NOT avg of the
  // precomputed per-month pct column (which diverged at coarse grains, see
  // scripts/powerbi-parity.ts). Resolves to whichever view exposes both base columns.
  test.each([
    ['cost_to_income_pct', 'total_cost_usd', 'total_revenue_usd'],
    ['fcf_margin_pct', 'free_cash_flow_usd', 'total_revenue_usd'],
    ['operating_cf_to_revenue_pct', 'operating_cash_flow_usd', 'total_revenue_usd'],
  ])('%s compiles as ratio-of-sums of its base columns', async (measure, num, den) => {
    const sql = await sqlFor(base({ measure, dimension: 'month', chartType: 'line' }));
    expect(sql).toContain(`sum(${num})`);
    expect(sql).toContain(`nullIf(sum(${den})`);
    // must NOT average the precomputed percentage column
    expect(sql).not.toContain(`avg(${measure})`);
  });

  // Composite numerator: (revenue − cost − payroll) / revenue (ratio-of-sums, not avg).
  test('ebitda_style_margin_pct compiles as a composite ratio-of-sums', async () => {
    const sql = await sqlFor(base({ measure: 'ebitda_style_margin_pct', dimension: 'month', chartType: 'line' }));
    expect(sql).toContain('sum(total_revenue_usd) - sum(total_cost_usd) - sum(total_payroll_usd)');
    expect(sql).toContain('nullIf(sum(total_revenue_usd)');
    expect(sql).not.toContain('avg(ebitda_style_margin_pct)');
  });

  test('a ratio + base-measure combo resolves to a single view exposing both', async () => {
    const sql = await sqlFor(
      base({ measure: 'ebitda_style_margin_pct', measures: ['ebitda_style_margin_pct', 'gross_margin_pct'], dimension: 'month', chartType: 'combo' }),
    );
    // One FROM (no cross-view join); both series computed as ratio-of-sums.
    expect(sql.match(/FROM analytics\./g)?.length).toBe(1);
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

describe('EBPO catalog — time filters', () => {
  test('year filters are applied to monthly charts', async () => {
    const sql = await sqlFor(
      base({
        measure: 'operating_cf',
        filters: [{ dimension: 'year', op: 'in', values: ['2025'] }],
      }),
    );

    expect(sql).toContain('toYear(period_date) IN (2025)');
  });
});

describe('EBPO catalog — windowed YoY measure', () => {
  // Revenue YoY = window over grain-aggregated revenue vs one year prior (DAX YoY),
  // correct at any time grain — NOT avg of the precomputed monthly pct column.
  test.each([
    ['month', 12],
    ['quarter', 4],
    ['year', 1],
  ])('revenue_yoy_pct by %s lags one year (%d periods) over aggregated revenue', async (dim, lag) => {
    const sql = await sqlFor(base({ measure: 'revenue_yoy_pct', dimension: dim, chartType: 'line' }));
    expect(sql).toContain(`ROWS BETWEEN ${lag} PRECEDING AND ${lag} PRECEDING`);
    expect(sql).toContain('sum(total_revenue_usd)');
    // must NOT fall back to averaging the precomputed per-month pct column
    expect(sql).not.toContain('avg(revenue_yoy_pct)');
  });

  test('revenue_yoy_pct without a time axis is refused (needs month/quarter/year)', async () => {
    const r = await compileEbpoSpec({ measure: 'revenue_yoy_pct', chartType: 'kpi' } as ChartSpec, DB, noRows);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal).toMatch(/time axis/i);
  });

  // Revenue LY = same period one year ago (DAX SAMEPERIODLASTYEAR), windowed.
  test('revenue_ly by month is the prior-year value, blank in the first year', async () => {
    const sql = await sqlFor(base({ measure: 'revenue_ly', dimension: 'month', chartType: 'line' }));
    expect(sql).toContain('ROWS BETWEEN 12 PRECEDING AND 12 PRECEDING');
    expect(sql).toContain('any(sum(total_revenue_usd))');
    // first year has no prior period → NULL (matches PowerBI blank), not a misleading 0
    expect(sql).toContain('= 0, NULL');
  });

  // Revenue YTD = TOTALYTD: cumulative within the fiscal year, reset each year.
  test('revenue_ytd by month accumulates within the year (partitioned by year)', async () => {
    const sql = await sqlFor(base({ measure: 'revenue_ytd', dimension: 'month', chartType: 'line' }));
    expect(sql).toContain('PARTITION BY toYear(');
    expect(sql).toContain('ROWS UNBOUNDED PRECEDING');
  });

  test('revenue_ytd can be combined with total_revenue on a monthly chart', async () => {
    const sql = await sqlFor(
      base({
        measure: 'total_revenue',
        measures: ['total_revenue', 'revenue_ytd'],
        dimension: 'month',
        chartType: 'combo',
      }),
    );
    expect(sql).toContain('AS "Total Revenue"');
    expect(sql).toContain('AS "Revenue YTD"');
    expect(sql).toContain('PARTITION BY toYear(');
    expect(sql).not.toContain('sum(undefined)');
  });

  test('windowed measures are refused in KPI/no-axis multi-measure charts', async () => {
    const r = await compileEbpoSpec(
      {
        measure: 'total_revenue',
        measures: ['total_revenue', 'revenue_ytd'],
        chartType: 'kpi',
      } as ChartSpec,
      DB,
      noRows,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal).toMatch(/time axis/i);
  });
});

describe('EBPO catalog — DSO / DPO (ratio × 365)', () => {
  // DSO = DIVIDE([AR Outstanding],[Total Revenue]/365) = sum(AR)/sum(Rev)×365.
  test('dso_days compiles as AR/Revenue × 365 (ratio-of-sums, not avg)', async () => {
    const sql = await sqlFor(base({ measure: 'dso_days', dimension: 'month', chartType: 'line' }));
    expect(sql).toMatch(/sum\(ar_outstanding_usd\) \/ nullIf\(sum\(total_revenue_usd\), 0\) \* 365/);
    expect(sql).not.toContain('avg(dso_days)');
  });
  // DPO = DIVIDE([AP Outstanding],[Total Cost]/365) = sum(AP)/sum(Cost)×365.
  test('dpo_days compiles as AP/Cost × 365 (ratio-of-sums, not avg)', async () => {
    const sql = await sqlFor(base({ measure: 'dpo_days', dimension: 'month', chartType: 'line' }));
    expect(sql).toMatch(/sum\(ap_outstanding_usd\) \/ nullIf\(sum\(total_cost_usd\), 0\) \* 365/);
    expect(sql).not.toContain('avg(dpo_days)');
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

  test('bubble preserves a duplicate size measure and still emits z', async () => {
    const sql = await sqlFor(
      base({
        measure: 'total_revenue',
        measures: ['total_revenue', 'total_cost', 'total_cost'],
        dimension: 'client',
        chartType: 'bubble',
      }),
    );
    expect(sql).toMatch(/sum\(total_revenue_usd\).*AS x/);
    expect(sql).toMatch(/sum\(total_cost_usd\).*AS y/);
    expect(sql).toMatch(/sum\(total_cost_usd\).*AS z/);
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
    if (!r.ok) expect(r.refusal).toMatch(/same level of detail|can't be combined/i);
  });
});

describe('EBPO combo series roles — dual-axis by unit', () => {
  // Regression: browser-verified bug. Adding a $ measure (Total Revenue) to a %
  // base chart (Gross Margin %) put BOTH series on the left %-axis, so revenue
  // rendered as "900000.0%". ANY series whose unit differs from the primary/left
  // unit must move to the right axis — including BARS, not just lines.
  test('a differing-unit BAR goes on the right axis (currency added to a percent base)', () => {
    const roles = ebpoComboSeriesRoles(['gross_margin_pct', 'total_revenue'], {
      baseType: 'line',
      forceBar: ['total_revenue'], // user said "as bars"
    });
    const margin = roles.find((r) => r.key === EBPO_MEASURES['gross_margin_pct']!.label)!;
    const revenue = roles.find((r) => r.key === EBPO_MEASURES['total_revenue']!.label)!;
    expect(margin.format).toBe('percent');
    expect(margin.axis).toBe('left');
    expect(revenue.role).toBe('bar'); // honored "as bars"
    expect(revenue.format).toBe('currency');
    expect(revenue.axis).toBe('right'); // the fix: different unit ⇒ right axis
  });

  test('same-unit series all stay on the left axis (comparable magnitudes)', () => {
    const roles = ebpoComboSeriesRoles(['total_revenue', 'total_cost'], {
      baseType: 'bar',
    });
    expect(roles.every((r) => r.axis === 'left')).toBe(true);
  });

  test('a same-format per-employee metric stays readable against a total by using the right axis', () => {
    const roles = ebpoComboSeriesRoles(['cost_per_employee', 'total_payroll'], {
      baseType: 'bar',
      forceLine: ['total_payroll'],
    });
    const costPerEmployee = roles.find((r) => r.key === EBPO_MEASURES['cost_per_employee']!.label)!;
    const payroll = roles.find((r) => r.key === EBPO_MEASURES['total_payroll']!.label)!;
    expect(costPerEmployee.axis).toBe('left');
    expect(payroll.role).toBe('line');
    expect(payroll.axis).toBe('right');
  });
});

describe('EBPO catalog — extended DAX measures (added, old ones preserved)', () => {
  // All 27 original DAX measures must remain registered after the extension.
  const ORIGINAL_27 = [
    'ap_outstanding', 'ar_outstanding', 'avg_monthly_salary', 'utilization_pct',
    'cash_balance', 'collection_rate_pct', 'csat_pct', 'dpo_days', 'dso_days',
    'financing_cf', 'free_cash_flow', 'gross_margin', 'gross_margin_pct',
    'investing_cf', 'operating_cf', 'payroll_to_revenue_pct', 'revenue_ly',
    'revenue_yoy_pct', 'revenue_ytd', 'sla_compliance_pct', 'total_base_salary',
    'total_benefits', 'total_bonus', 'total_cost', 'total_overtime',
    'total_payroll', 'total_revenue',
  ];
  test.each(ORIGINAL_27)('original measure %s is still registered', (id) => {
    expect(EBPO_MEASURES[id]).toBeDefined();
  });

  // Payroll-composition ratios = DIVIDE([Total <X>],[Total Payroll]) as ratio-of-sums.
  test.each([
    ['base_salary_to_payroll_pct', 'total_base_salary_usd'],
    ['benefits_to_payroll_pct', 'total_benefits_usd'],
    ['bonus_to_payroll_pct', 'total_bonus_usd'],
  ])('%s compiles as <component>/payroll ratio-of-sums', async (measure, num) => {
    const sql = await sqlFor(base({ measure, dimension: 'department', chartType: 'bar' }));
    expect(sql).toMatch(new RegExp(`sum\\(${num}\\)\\s*/\\s*nullIf\\(sum\\(total_payroll_usd\\), 0\\)\\s*\\*\\s*100`));
    expect(sql).toContain('analytics.v_ebpo_payroll_monthly');
    expect(sql).not.toContain(`avg(${measure})`);
  });

  test('payroll_per_employee = payroll / headcount (ratio-of-sums, scale 1)', async () => {
    const sql = await sqlFor(base({ measure: 'payroll_per_employee', dimension: 'department', chartType: 'bar' }));
    expect(sql).toMatch(/sum\(total_payroll_usd\)\s*\/\s*nullIf\(sum\(employee_count\), 0\)\s*\*\s*1/);
  });

  // Cost Per Employee = DIVIDE([Total Cost], DISTINCTCOUNT(EmployeeID)) — now cost-based.
  test('cost_per_employee = total cost / headcount, by business unit', async () => {
    const sql = await sqlFor(base({ measure: 'cost_per_employee', dimension: 'business_unit', chartType: 'bar' }));
    expect(sql).toMatch(/sum\(total_cost_usd\)\s*\/\s*nullIf\(sum\(employee_count\), 0\)\s*\*\s*1/);
    expect(sql).toContain('analytics.v_ebpo_business_unit_efficiency');
    // legacy payroll-based formula must no longer be used for cost_per_employee
    expect(sql).not.toContain('total_payroll_usd');
  });

  test('cost_per_employee by month uses the precomputed monthly column when that is what the view exposes', async () => {
    const sql = await sqlFor(base({ measure: 'cost_per_employee', dimension: 'month', chartType: 'bar' }));
    expect(sql).toContain('analytics.v_ebpo_department_efficiency_monthly');
    expect(sql).toContain('avg(cost_per_employee_usd)');
    expect(sql).not.toContain('sum(undefined)');
  });

  // No. Clients = DISTINCTCOUNT(DimClient[ClientKey]) → uniqExact over client_name.
  test('no_clients counts DISTINCT clients (uniqExact), excluding blanks', async () => {
    const r = await compileEbpoSpec({ measure: 'no_clients', dimension: '', chartType: 'kpi' } as ChartSpec, DB, noRows);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.sql).toMatch(/uniqExactIf\(client_name, client_name != ''\)/);
      expect(r.sql).toContain('analytics.v_ebpo_revenue_by_client');
    }
  });

  test('no_clients by industry groups the distinct client count', async () => {
    const sql = await sqlFor(base({ measure: 'no_clients', dimension: 'industry', chartType: 'bar' }));
    expect(sql).toMatch(/uniqExactIf\(client_name/);
    expect(sql).toContain('GROUP BY');
  });

  // Avg Revenue per Client = DIVIDE([Total Revenue],[No. Clients]) — revenue SUM over the
  // DISTINCTCOUNT of clients (denominator uses no_clients' own uniqExact agg).
  test('avg_revenue_per_client = revenue / distinct clients', async () => {
    const r = await compileEbpoSpec({ measure: 'avg_revenue_per_client', dimension: '', chartType: 'kpi' } as ChartSpec, DB, noRows);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.sql).toMatch(/sum\(total_revenue_usd\)\s*\/\s*nullIf\(uniqExactIf\(client_name, client_name != ''\), 0\)\s*\*\s*1/);
    }
  });

  // Total Expenses = [Total Cost] + [Total Payroll] (absolute additive, no denominator).
  test('total_expenses sums cost + payroll (no denominator)', async () => {
    const sql = await sqlFor(base({ measure: 'total_expenses', dimension: 'month', chartType: 'line' }));
    expect(sql).toContain('(sum(total_cost_usd) + sum(total_payroll_usd))');
    // absolute additive → no "/ nullIf(... ) * 100" ratio tail
    expect(sql).not.toMatch(/\* 100/);
  });

  // Expense to Revenue % = (cost + payroll) / revenue (composite-numerator ratio-of-sums).
  test('expense_to_revenue_pct = (cost+payroll)/revenue ratio-of-sums', async () => {
    const sql = await sqlFor(base({ measure: 'expense_to_revenue_pct', dimension: 'month', chartType: 'line' }));
    expect(sql).toContain('(sum(total_cost_usd) + sum(total_payroll_usd))');
    expect(sql).toMatch(/nullIf\(sum\(total_revenue_usd\), 0\)\s*\*\s*100/);
  });

  // Cost time-intelligence mirrors revenue's window measures.
  test('cost_ly is the prior-year cost (12-month lag, blank first year)', async () => {
    const sql = await sqlFor(base({ measure: 'cost_ly', dimension: 'month', chartType: 'line' }));
    expect(sql).toContain('ROWS BETWEEN 12 PRECEDING AND 12 PRECEDING');
    expect(sql).toContain('any(sum(total_cost_usd))');
    expect(sql).toContain('= 0, NULL');
  });
  test('cost_yoy_pct is the YoY growth % over aggregated cost', async () => {
    const sql = await sqlFor(base({ measure: 'cost_yoy_pct', dimension: 'month', chartType: 'line' }));
    expect(sql).toContain('sum(total_cost_usd)');
    expect(sql).toMatch(/\/ nullIf\(any\(sum\(total_cost_usd\)\).*, 0\) \* 100/);
  });

  // Payroll time-intelligence, including the new absolute yoy_abs window kind.
  test('payroll_ytd accumulates within the fiscal year', async () => {
    const sql = await sqlFor(base({ measure: 'payroll_ytd', dimension: 'month', chartType: 'line' }));
    expect(sql).toContain('PARTITION BY toYear(');
    expect(sql).toContain('sum(total_payroll_usd)');
  });
  test('payroll_yoy_growth is the ABSOLUTE YoY change (no /prior, no *100)', async () => {
    const sql = await sqlFor(base({ measure: 'payroll_yoy_growth', dimension: 'month', chartType: 'line' }));
    // absolute diff: (this period − same period last year), not a percentage
    expect(sql).toMatch(/round\(sum\(total_payroll_usd\) - any\(sum\(total_payroll_usd\)\)/);
    expect(sql).not.toMatch(/\* 100/);
  });
  test('payroll_yoy_pct is the YoY growth % (divides by the prior year)', async () => {
    const sql = await sqlFor(base({ measure: 'payroll_yoy_pct', dimension: 'month', chartType: 'line' }));
    expect(sql).toMatch(/\/ nullIf\(any\(sum\(total_payroll_usd\)\).*, 0\) \* 100/);
  });

  // New aliases resolve their owning measures (planner-prompt grounding).
  test('extended aliases are attached to the correct measures', () => {
    expect(EBPO_MEASURES['cost_to_income_pct']!.aliases).toEqual(
      expect.arrayContaining(['cost to revenue']),
    );
    expect(EBPO_MEASURES['payment_rate_pct']!.aliases).toEqual(
      expect.arrayContaining(['ap payment rate']),
    );
    expect(EBPO_MEASURES['avg_aht_minutes']!.aliases).toEqual(
      expect.arrayContaining(['average aht']),
    );
    expect(EBPO_MEASURES['tickets_resolved']!.aliases).toEqual(
      expect.arrayContaining(['resolved tickets']),
    );
    expect(EBPO_MEASURES['operating_cf_to_revenue_pct']!.aliases).toEqual(
      expect.arrayContaining(['operating cash flow margin']),
    );
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
