import {
  applyEngineSpecConstraints,
  compileSpec,
  compileNameValueSql,
  compileSeriesSql,
  compileRatioComponentsTotal,
  buildEngineDisplay,
  SCOPE_WHERE,
} from './spec-compiler';
import type { EngineChartSpec, SemanticModel } from './semantic-model.types';

const model: SemanticModel = {
  datasetId: 'ds1',
  version: 1,
  builtBy: 'auto',
  factGrain: 'one row per client per month',
  entities: [
    {
      key: 'client',
      label: 'Client',
      table: 'v_fact',
      nameColumn: 'client_name',
    },
  ],
  dimensions: [
    { key: 'client', label: 'Client', table: 'v_fact', column: 'client_name' },
    {
      key: 'business_unit',
      label: 'Business Unit',
      table: 'v_fact',
      column: 'business_unit',
    },
  ],
  time: {
    table: 'v_fact',
    column: 'period_date',
    grains: ['month', 'quarter', 'year'],
  },
  measures: [
    {
      key: 'revenue',
      label: 'Revenue',
      unit: 'USD',
      sourceTable: 'v_fact',
      expr: { kind: 'sum', column: 'revenue_usd' },
    },
    {
      key: 'gross_margin_pct',
      label: 'Gross Margin %',
      unit: '%',
      sourceTable: 'v_fact',
      expr: {
        kind: 'ratio_of_sums',
        numerator: 'gross_profit_usd',
        denominator: 'revenue_usd',
      },
    },
    {
      key: 'cash_balance',
      label: 'Cash Balance',
      unit: 'USD',
      sourceTable: 'v_fact',
      expr: { kind: 'last_value', column: 'cash_usd', orderBy: 'period_date' },
    },
    {
      key: 'clients',
      label: 'Clients',
      unit: 'count',
      sourceTable: 'v_fact',
      expr: { kind: 'count_distinct', column: 'client_id' },
    },
    {
      key: 'dso_days',
      label: 'Dso Days',
      unit: 'days',
      sourceTable: 'v_fact',
      expr: { kind: 'mean', column: 'dso_days' },
    },
    {
      key: 'sla_pct',
      label: 'Sla %',
      unit: '%',
      sourceTable: 'v_fact',
      expr: { kind: 'mean', column: 'sla_pct_sum', weight: 'sla_pct_wt' },
    },
    {
      // Composed ratio, plain multiple (as-of / as-of) — e.g. Debt-to-Equity.
      key: 'debt_to_equity_ratio',
      label: 'Debt To Equity Ratio',
      unit: 'x',
      sourceTable: 'v_fact',
      expr: {
        kind: 'ratio_of_aggs',
        numerator: { agg: 'as_of', column: 'liabilities_usd', orderBy: 'period_date' },
        denominator: { agg: 'as_of', column: 'equity_usd', orderBy: 'period_date' },
      },
    },
    {
      // Composed ratio, percent (flow / average-of-level) — e.g. ROA.
      key: 'roa_pct',
      label: 'Return On Assets %',
      unit: '%',
      sourceTable: 'v_fact',
      expr: {
        kind: 'ratio_of_aggs',
        numerator: { agg: 'sum', column: 'net_profit_usd' },
        denominator: { agg: 'mean', column: 'assets_usd' },
      },
    },
  ],
};

const ctx = {
  analyticsDb: 'analytics',
  tenantId: 'org-uuid',
  externalOrgIds: ['ext-1', 'ext-2'],
};

describe('SpecCompiler tenant scoping', () => {
  it('always binds tenant_id + org_id as parameters, never interpolated', () => {
    const spec: EngineChartSpec = {
      chartType: 'bar',
      measureKeys: ['revenue'],
      dimensionKey: 'business_unit',
      title: 'Revenue by BU',
    };
    const r = compileSpec(spec, model, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sql).toContain(SCOPE_WHERE);
    expect(r.params).toEqual({
      tenantId: 'org-uuid',
      externalOrgIds: ['ext-1', 'ext-2'],
    });
    // The raw values must not appear inline in the SQL.
    expect(r.sql).not.toContain('org-uuid');
    expect(r.sql).not.toContain('ext-1');
  });
});

describe('compileRatioComponentsTotal — ratio reconciliation tripwire', () => {
  const ratioMeasure = model.measures.find(
    (m) => m.key === 'gross_margin_pct',
  )!;

  it('emits scoped SUM(num) + SUM(den) as raw components (no grouping, no scaling)', () => {
    const r = compileRatioComponentsTotal(ratioMeasure, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sql).toContain('sum(gross_profit_usd) AS `num`');
    expect(r.sql).toContain('sum(revenue_usd) AS `den`');
    expect(r.sql).toContain(SCOPE_WHERE);
    expect(r.sql).not.toMatch(/GROUP BY/i);
    expect(r.sql).not.toContain('100'); // components are unscaled — no ×100 here
    expect(r.params).toEqual({
      tenantId: 'org-uuid',
      externalOrgIds: ['ext-1', 'ext-2'],
    });
    // Tenant values are bound as params, never interpolated.
    expect(r.sql).not.toContain('org-uuid');
  });

  it('refuses a non-ratio measure (caller bug, never a data reason)', () => {
    const sumMeasure = model.measures.find((m) => m.key === 'revenue')!;
    const r = compileRatioComponentsTotal(sumMeasure, ctx);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/not a ratio measure/i);
  });
});

describe('compileSpec — governed period constraints', () => {
  const spec: EngineChartSpec = {
    chartType: 'line',
    measureKeys: ['revenue'],
    timeGrain: 'month',
    title: 'Revenue trend',
  };
  const ratioMeasure = model.measures.find(
    (measure) => measure.key === 'gross_margin_pct',
  )!;

  it('binds an explicit date range without interpolating values into SQL', () => {
    const result = compileSpec(spec, model, {
      ...ctx,
      dateRange: { start: '2025-01-01', end: '2025-12-31' },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sql).toContain(
      'period_date >= {dateStart:Date} AND period_date <= {dateEnd:Date}',
    );
    expect(result.sql).not.toContain('2025-01-01');
    expect(result.params).toMatchObject({
      dateStart: '2025-01-01',
      dateEnd: '2025-12-31',
    });
  });

  it('derives a rolling-week boundary from the scoped maximum source date', () => {
    const result = compileSpec(spec, model, {
      ...ctx,
      period: { kind: 'LAST_N_WEEKS', value: 4 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sql).toContain('addDays((SELECT max(period_date)');
    expect(result.sql).toContain(', -27)');
    expect(result.sql).toContain('tenant_id = {tenantId:String}');
    expect(result.sql).toContain('org_id IN ({externalOrgIds:Array(String)})');
  });

  it('refuses a requested period when the capability has no compatible time axis', () => {
    const result = compileSpec(
      spec,
      { ...model, time: undefined },
      { ...ctx, period: { kind: 'YTD' } },
    );

    expect(result).toEqual({
      ok: false,
      reason: 'selected capability cannot apply the requested period',
    });
  });

  it('applies the identical date range to ratio reconciliation components', () => {
    const result = compileRatioComponentsTotal(
      ratioMeasure,
      {
        ...ctx,
        dateRange: { start: '2025-01-01', end: '2025-03-31' },
      },
      model.time,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sql).toContain(
      'period_date >= {dateStart:Date} AND period_date <= {dateEnd:Date}',
    );
    expect(result.params).toMatchObject({
      dateStart: '2025-01-01',
      dateEnd: '2025-03-31',
    });
  });

  it('governs rendered SQL with the same date range and catalog-backed filters', () => {
    const governedSpec: EngineChartSpec = {
      ...spec,
      dateRange: { start: '2025-04-01', end: '2025-06-30' },
      filters: [
        {
          dimensionKey: 'business_unit',
          operator: 'in',
          values: ['Support'],
        },
      ],
    };
    const result = applyEngineSpecConstraints(
      compileNameValueSql(governedSpec, model, ctx),
      governedSpec,
      model,
      ctx,
      'v_fact',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sql).toContain(
      'period_date >= {dateStart:Date} AND period_date <= {dateEnd:Date}',
    );
    expect(result.sql).toContain(
      'business_unit IN ({constraintFilter0:Array(String)})',
    );
    expect(result.params).toMatchObject({
      dateStart: '2025-04-01',
      dateEnd: '2025-06-30',
      constraintFilter0: ['Support'],
    });
    expect(result.sql).not.toContain('2025-04-01');
    expect(result.sql).not.toContain("'Support'");
  });

  it('refuses filters that are not available on the selected cube', () => {
    const foreignModel: SemanticModel = {
      ...model,
      dimensions: [
        ...model.dimensions,
        {
          key: 'foreign_dimension',
          label: 'Foreign Dimension',
          table: 'another_view',
          column: 'foreign_dimension',
        },
      ],
    };
    const governedSpec: EngineChartSpec = {
      ...spec,
      filters: [
        {
          dimensionKey: 'foreign_dimension',
          operator: 'in',
          values: ['A'],
        },
      ],
    };
    const result = applyEngineSpecConstraints(
      compileNameValueSql(governedSpec, foreignModel, ctx),
      governedSpec,
      foreignModel,
      ctx,
      'v_fact',
    );

    expect(result).toEqual({
      ok: false,
      reason: 'cross-table filter not supported',
    });
  });
});

describe('SpecCompiler correctness contract', () => {
  it('compiles a ratio as SUM/SUM — never an average', () => {
    const spec: EngineChartSpec = {
      chartType: 'bar',
      measureKeys: ['gross_margin_pct'],
      dimensionKey: 'business_unit',
      title: 'Margin by BU',
    };
    const r = compileSpec(spec, model, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sql).toContain(
      'sum(gross_profit_usd) / nullIf(sum(revenue_usd), 0)',
    );
    expect(r.sql).not.toMatch(/avg\s*\(/i);
  });

  it('composes a DAX-faithful ratio with per-side aggregation (ROA = SUM flow / AVG level)', () => {
    // The analytic query emits the raw composed ratio: numerator summed (flow),
    // denominator averaged (mean of per-period levels).
    const roa = compileSpec(
      { chartType: 'kpi', measureKeys: ['roa_pct'], title: 'ROA' },
      model,
      ctx,
    );
    expect(roa.ok).toBe(true);
    if (!roa.ok) return;
    expect(roa.sql).toContain('sum(net_profit_usd) / nullIf(avg(assets_usd), 0)');

    // Debt-to-Equity = as-of / as-of (argMax point-in-time, both sides).
    const de = compileSpec(
      { chartType: 'kpi', measureKeys: ['debt_to_equity_ratio'], title: 'DE' },
      model,
      ctx,
    );
    expect(de.ok).toBe(true);
    if (!de.ok) return;
    expect(de.sql).toContain(
      'argMax(liabilities_usd, period_date) / nullIf(argMax(equity_usd, period_date), 0)',
    );
  });

  it('scales a percent ratio ×100 but a plain-multiple ratio (unit x) raw in the value column', () => {
    const pct = compileNameValueSql(
      { chartType: 'bar', measureKeys: ['gross_margin_pct'], dimensionKey: 'business_unit', title: 't' },
      model,
      ctx,
    );
    const plain = compileNameValueSql(
      { chartType: 'bar', measureKeys: ['debt_to_equity_ratio'], dimensionKey: 'business_unit', title: 't' },
      model,
      ctx,
    );
    expect(pct.ok && plain.ok).toBe(true);
    if (!pct.ok || !plain.ok) return;
    // percent → ×100 percent-points for the UI's percent formatter
    expect(pct.sql).toContain('round(100 * (sum(gross_profit_usd)');
    // plain multiple → NOT scaled (debt-to-equity renders 0.47, not 47)
    expect(plain.sql).not.toContain('100 *');
    expect(plain.sql).toContain(
      'round(argMax(liabilities_usd, period_date) / nullIf(argMax(equity_usd, period_date), 0), 6)',
    );
  });

  it('does not put a share-of-total window expression in HAVING', () => {
    const shareModel: SemanticModel = {
      ...model,
      measures: [
        ...model.measures,
        {
          key: 'revenue_share',
          label: 'Revenue Share',
          unit: '%',
          sourceTable: 'v_fact',
          expr: {
            kind: 'ratio_of_sum_to_total',
            numerator: 'revenue_usd',
            denominator: 'total_revenue_usd',
          },
        },
      ],
    };
    const spec: EngineChartSpec = {
      chartType: 'bar',
      measureKeys: ['revenue_share'],
      dimensionKey: 'business_unit',
      title: 'Revenue Share by BU',
    };
    const result = compileNameValueSql(spec, shareModel, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sql).toContain(
      'sum(revenue_usd) / nullIf(sum(sum(total_revenue_usd)) OVER (), 0)',
    );
    expect(result.sql).not.toContain('HAVING');
    expect(result.sql).toContain(
      'QUALIFY abs(ifNull(value, 0)) > 0.000000000001',
    );
  });

  it('compiles a stock (cash balance) as argMax over time — never summed', () => {
    const spec: EngineChartSpec = {
      chartType: 'kpi',
      measureKeys: ['cash_balance'],
      title: 'Cash',
    };
    const r = compileSpec(spec, model, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sql).toContain('argMax(cash_usd, period_date)');
    expect(r.sql).not.toContain('sum(cash_usd)');
  });

  it('compiles count_distinct as uniqExact', () => {
    const spec: EngineChartSpec = {
      chartType: 'kpi',
      measureKeys: ['clients'],
      title: 'Clients',
    };
    const r = compileSpec(spec, model, ctx);
    expect(r.ok && r.sql.includes('uniqExact(client_id)')).toBe(true);
  });

  it('compiles an unweighted mean (duration) as avg — never summed, never ×100 scaled', () => {
    const spec: EngineChartSpec = {
      chartType: 'bar',
      measureKeys: ['dso_days'],
      dimensionKey: 'business_unit',
      title: 'DSO by BU',
    };
    const r = compileNameValueSql(spec, model, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sql).toContain('avg(dso_days) AS value');
    expect(r.sql).not.toContain('sum(dso_days)');
    expect(r.sql).not.toContain('100 *'); // a duration must not be percent-scaled
  });

  it('compiles a WEIGHTED mean (pre-summed % + weight) as sum/sum, not avg-of-averages, not ×100', () => {
    const spec: EngineChartSpec = {
      chartType: 'bar',
      measureKeys: ['sla_pct'],
      dimensionKey: 'business_unit',
      title: 'SLA by BU',
    };
    const r = compileNameValueSql(spec, model, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Already in percent-points, so SUM(value)/SUM(weight) with NO ×100 scaling.
    expect(r.sql).toContain(
      'sum(sla_pct_sum) / nullIf(sum(sla_pct_wt), 0) AS value',
    );
    expect(r.sql).not.toContain('100 *');
  });
});

describe('SpecCompiler grouping, time, top-N', () => {
  it('emits a monthly time grain with ORDER BY period', () => {
    const spec: EngineChartSpec = {
      chartType: 'line',
      measureKeys: ['revenue'],
      timeGrain: 'month',
      title: 'Revenue trend',
    };
    const r = compileSpec(spec, model, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sql).toContain('toStartOfMonth(period_date) AS period');
    expect(r.sql).toContain('ORDER BY period ASC');
  });

  it('emits ORDER BY measure DESC + LIMIT for top-N', () => {
    const spec: EngineChartSpec = {
      chartType: 'bar',
      measureKeys: ['revenue'],
      dimensionKey: 'client',
      topN: 5,
      title: 'Top 5 clients',
    };
    const r = compileSpec(spec, model, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sql).toContain('ORDER BY `__measure_0` DESC');
    expect(r.sql).toContain('LIMIT 5');
  });

  it('never aliases an aggregate to its source column name', () => {
    const collisionModel: SemanticModel = {
      ...model,
      measures: [
        {
          key: 'revenue_usd',
          label: 'Revenue',
          unit: 'USD',
          sourceTable: 'v_fact',
          expr: { kind: 'sum', column: 'revenue_usd' },
        },
      ],
    };
    const r = compileSpec(
      {
        chartType: 'bar',
        measureKeys: ['revenue_usd'],
        dimensionKey: 'business_unit',
        topN: 5,
        title: 'Revenue',
      },
      collisionModel,
      ctx,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sql).toContain('sum(revenue_usd) AS `__measure_0`');
    expect(r.sql).not.toContain('AS `revenue_usd`');
  });
});

describe('compileNameValueSql axis labels', () => {
  it('emits a HUMAN month label and sorts chronologically by the date bucket', () => {
    const spec: EngineChartSpec = {
      chartType: 'line',
      measureKeys: ['revenue'],
      timeGrain: 'month',
      title: 'Revenue trend',
    };
    const r = compileNameValueSql(spec, model, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Pretty label, not a raw "2025-01-01".
    expect(r.sql).toContain(
      "formatDateTime(toStartOfMonth(period_date), '%b %Y') AS name",
    );
    // Ordered by the real date bucket so "Apr" never precedes "Jan".
    expect(r.sql).toContain('ORDER BY toStartOfMonth(period_date) ASC');
    expect(r.sql).not.toContain('ORDER BY name ASC');
  });

  it('emits Q1 2025-style quarter labels', () => {
    const spec: EngineChartSpec = {
      chartType: 'bar',
      measureKeys: ['revenue'],
      timeGrain: 'quarter',
      title: 'Quarterly revenue',
    };
    const r = compileNameValueSql(spec, model, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sql).toContain(
      "concat('Q', toString(toQuarter(toStartOfQuarter(period_date)))",
    );
  });

  it('keeps a dimension breakdown sorted by value DESC', () => {
    const spec: EngineChartSpec = {
      chartType: 'bar',
      measureKeys: ['revenue'],
      dimensionKey: 'business_unit',
      title: 'Revenue by BU',
    };
    const r = compileNameValueSql(spec, model, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sql).toContain('toString(business_unit) AS name');
    expect(r.sql).toContain('ORDER BY value DESC');
  });
});

describe('compileSeriesSql — percentage contribution (normalize)', () => {
  it('turns each series into its share of the per-axis total when normalize is set', () => {
    const spec: EngineChartSpec = {
      chartType: 'stacked_area',
      measureKeys: ['revenue'],
      timeGrain: 'month',
      dimensionKey: 'business_unit',
      normalize: true,
      title: "Each business unit's % contribution",
    };
    const r = compileSeriesSql(spec, model, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // outer wrapper divides each value by the per-name (per period) total, ×100
    expect(r.sql).toContain(
      'round(100 * value / nullIf(sum(value) OVER (PARTITION BY name), 0), 2) AS value',
    );
  });

  it('leaves values raw when normalize is not set', () => {
    const spec: EngineChartSpec = {
      chartType: 'stacked_area',
      measureKeys: ['revenue'],
      timeGrain: 'month',
      dimensionKey: 'business_unit',
      title: 'Revenue by BU',
    };
    const r = compileSeriesSql(spec, model, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sql).not.toContain('OVER (PARTITION BY name)');
  });

  it('display forces percent format + share axis label when normalized', () => {
    const spec: EngineChartSpec = {
      chartType: 'stacked_area',
      measureKeys: ['revenue'],
      timeGrain: 'month',
      dimensionKey: 'business_unit',
      normalize: true,
      title: 't',
    };
    const d = buildEngineDisplay(spec, model);
    expect(d.valueFormat).toBe('percent');
    expect(d.yAxisLabel).toBe('Share of total (%)');
  });
});

describe('compileSeriesSql multi-series output', () => {
  it('aligns current and previous year into month-of-year series', () => {
    const spec: EngineChartSpec = {
      chartType: 'line',
      measureKeys: ['revenue'],
      timeGrain: 'month',
      comparison: 'previous_year',
      title: 'Revenue vs previous year',
    };
    const r = compileSeriesSql(spec, model, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sql).toContain('AS "Current Year"');
    expect(r.sql).toContain('AS "Previous Year"');
    expect(r.sql).toContain('toMonth(period_date)');
    expect(r.sql).toContain('max(toYear(period_date))');
  });

  it('compiles previous-year category waterfall as a bridge with cumulative values', () => {
    const spec: EngineChartSpec = {
      chartType: 'waterfall',
      measureKeys: ['revenue'],
      dimensionKey: 'business_unit',
      timeGrain: 'month',
      comparison: 'previous_year',
      showCumulative: true,
      title: 'Revenue change by category',
    };
    const r = compileSeriesSql(spec, model, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sql).toContain('category_changes AS');
    expect(r.sql).toContain("'Previous Year' AS name");
    expect(r.sql).toContain("'Current Year' AS name");
    expect(r.sql).toContain('change_value AS value');
    expect(r.sql).toContain('AS "Cumulative Value"');
  });

  it('computes YoY growth percent at the retained monthly grain for every category', () => {
    const spec: EngineChartSpec = {
      chartType: 'line',
      measureKeys: ['revenue'],
      dimensionKey: 'business_unit',
      timeGrain: 'month',
      comparison: 'yoy_growth_pct',
      title: 'Revenue YoY Growth by Business Unit',
    };
    const result = compileSeriesSql(spec, model, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sql).toContain('INNER JOIN base AS prev');
    expect(result.sql).toContain('prev.period = addYears(cur.period, -1)');
    expect(result.sql).toContain('prev.series = cur.series');
    expect(result.sql).toContain('100 * (cur.amount - prev.amount)');
    expect(result.sql).toContain('AS value');
  });

  it('emits the explicit x/y/z transport contract for point charts', () => {
    const spec: EngineChartSpec = {
      chartType: 'bubble',
      measureKeys: ['revenue', 'gross_margin_pct', 'clients'],
      dimensionKey: 'client',
      breakdownKey: 'business_unit',
      title: 'Client performance',
    };
    const r = compileSeriesSql(spec, model, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sql).toContain(
      "concat(toString(client_name), ' — ', toString(business_unit)) AS name",
    );
    expect(r.sql).toContain('toFloat64(sum(revenue_usd)) AS x');
    expect(r.sql).toContain('AS y');
    expect(r.sql).toContain('toFloat64(uniqExact(client_id)) AS z');
    expect(r.sql).not.toContain(' AS series');
  });

  it('emits name + one aliased column PER measure and no `value` column', () => {
    const spec: EngineChartSpec = {
      chartType: 'bar',
      measureKeys: ['revenue', 'gross_margin_pct'],
      timeGrain: 'month',
      title: 'Revenue & Margin',
    };
    const r = compileSeriesSql(spec, model, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sql).toContain('sum(revenue_usd) AS "Revenue"');
    // Ratio still SUM/SUM, scaled ×100 for the UI, aliased by its label.
    expect(r.sql).toContain(
      'sum(gross_profit_usd) / nullIf(sum(revenue_usd), 0)',
    );
    expect(r.sql).toContain('AS "Gross Margin %"');
    expect(r.sql).not.toMatch(/AS value\b/);
    // Chronological for a time axis.
    expect(r.sql).toContain('ORDER BY toStartOfMonth(period_date) ASC');
  });

  it('orders a multi-measure dimension breakdown by the FIRST measure DESC', () => {
    const spec: EngineChartSpec = {
      chartType: 'bar',
      measureKeys: ['revenue', 'gross_margin_pct'],
      dimensionKey: 'business_unit',
      title: 'x',
    };
    const r = compileSeriesSql(spec, model, ctx);
    expect(r.ok && r.sql.includes('ORDER BY "Revenue" DESC')).toBe(true);
  });

  it('emits generic long-form rows for a monthly series breakdown', () => {
    const spec: EngineChartSpec = {
      chartType: 'stacked_area',
      measureKeys: ['revenue'],
      dimensionKey: 'business_unit',
      timeGrain: 'month',
      title: 'Monthly revenue by business unit',
    };
    const r = compileSeriesSql(spec, model, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sql).toContain('AS name');
    expect(r.sql).toContain('toString(business_unit) AS series');
    expect(r.sql).toContain('toFloat64(sum(revenue_usd)) AS value');
    expect(r.sql).toContain(
      'GROUP BY toStartOfMonth(period_date), business_unit',
    );
    expect(r.sql).toContain('ORDER BY _series_order ASC, series ASC');
  });

  it('keeps a primary breakdown stacked and aggregates a mixed-scale overlay by the x-axis only', () => {
    const employeeModel: SemanticModel = {
      ...model,
      dimensions: [
        ...model.dimensions,
        {
          key: 'grade',
          label: 'Grade',
          table: 'v_fact',
          column: 'grade',
        },
      ],
      measures: [
        ...model.measures,
        {
          key: 'salary',
          label: 'Average Monthly Salary',
          unit: 'USD',
          sourceTable: 'v_fact',
          expr: { kind: 'mean', column: 'salary' },
        },
      ],
    };
    const spec: EngineChartSpec = {
      chartType: 'stacked_bar',
      measureKeys: ['clients', 'salary'],
      dimensionKey: 'business_unit',
      breakdownKey: 'grade',
      title: 'Headcount and salary by department',
    };
    const r = compileSeriesSql(spec, employeeModel, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sql).toContain(
      "concat(toString(grade), ' — ', 'Clients') AS series",
    );
    expect(r.sql).toContain("'Average Monthly Salary' AS series");
    expect(r.sql).toContain('GROUP BY business_unit, grade');
    expect(r.sql).toContain('GROUP BY business_unit\nHAVING');
  });

  it('keeps every combo measure at the requested time-plus-dimension grain', () => {
    const spec: EngineChartSpec = {
      chartType: 'combo',
      measureKeys: ['revenue', 'clients'],
      dimensionKey: 'client',
      timeGrain: 'month',
      title: 'Monthly revenue and clients by client',
    };
    const r = compileSeriesSql(spec, model, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sql).toContain(
      "concat(toString(client_name), ' — ', 'Revenue') AS series",
    );
    expect(r.sql).toContain(
      "concat(toString(client_name), ' — ', 'Clients') AS series",
    );
    expect(
      r.sql.match(/GROUP BY toStartOfMonth\(period_date\), client_name/g),
    ).toHaveLength(2);
  });
});

describe('buildEngineDisplay axis assignment', () => {
  it('publishes a semantic format for every mixed-unit KPI column', () => {
    const display = buildEngineDisplay(
      {
        chartType: 'kpi',
        measureKeys: ['revenue', 'gross_margin_pct', 'dso_days'],
        dimensionKey: 'client',
        title: 'Client scorecard',
      },
      model,
    );
    expect(display.series?.map(({ key, format }) => [key, format])).toEqual([
      ['Revenue', 'currency'],
      ['Gross Margin %', 'percent'],
      ['Dso Days', 'number'],
    ]);
  });

  it('renders an explicitly requested same-unit combo as a bar plus lines', () => {
    const cashModel: SemanticModel = {
      ...model,
      measures: [
        {
          key: 'net_cash',
          label: 'Net Cash Flow',
          unit: 'USD',
          sourceTable: 'v_fact',
          expr: { kind: 'sum', column: 'net_cash' },
        },
        {
          key: 'gl_cash',
          label: 'General Ledger Cash Movement',
          unit: 'USD',
          sourceTable: 'v_fact',
          expr: { kind: 'sum', column: 'gl_cash' },
        },
        {
          key: 'difference',
          label: 'Cash Reconciliation Difference',
          unit: 'USD',
          sourceTable: 'v_fact',
          expr: { kind: 'sum', column: 'difference' },
        },
      ],
    };
    const d = buildEngineDisplay(
      {
        chartType: 'combo',
        measureKeys: ['net_cash', 'gl_cash', 'difference'],
        timeGrain: 'month',
        title: 'Cash reconciliation',
      },
      cashModel,
    );
    expect(d.series?.map((series) => series.role)).toEqual([
      'bar',
      'line',
      'line',
    ]);
  });

  it('provides two named series for a previous-year comparison', () => {
    const spec: EngineChartSpec = {
      chartType: 'line',
      measureKeys: ['revenue'],
      timeGrain: 'month',
      comparison: 'previous_year',
      title: 'Revenue vs previous year',
    };
    const d = buildEngineDisplay(spec, model);
    expect(d.series?.map((series) => series.key)).toEqual([
      'Current Year',
      'Previous Year',
    ]);
    expect(d.chartType).toBe('line');
  });

  it('formats YoY growth as percent, never as the base measure unit', () => {
    const spec: EngineChartSpec = {
      chartType: 'line',
      measureKeys: ['revenue'],
      dimensionKey: 'business_unit',
      timeGrain: 'month',
      comparison: 'yoy_growth_pct',
      title: 'Revenue YoY Growth by Business Unit',
    };
    const display = buildEngineDisplay(spec, model);
    expect(display.valueFormat).toBe('percent');
    expect(display.yAxisLabel).toBe('YoY Growth (%)');
    expect(display.chartType).toBe('line');
  });

  it('preserves scatter/bubble type and maps the first measures to x/y', () => {
    const spec: EngineChartSpec = {
      chartType: 'bubble',
      measureKeys: ['revenue', 'gross_margin_pct', 'clients'],
      dimensionKey: 'client',
      title: 'Client performance',
    };
    const d = buildEngineDisplay(spec, model);
    expect(d.chartType).toBe('bubble');
    expect(d.xAxisLabel).toBe('Revenue');
    expect(d.yAxisLabel).toBe('Gross Margin %');
    expect(d.secondaryAxisFormat).toBe('percent');
    expect(d.secondaryLabel).toBe('Clients');
  });

  it('accepts hierarchy-only grouping for point charts', () => {
    const hierarchyModel: SemanticModel = {
      ...model,
      dimensions: [
        ...model.dimensions,
        {
          key: 'delivery_center',
          label: 'Delivery Center',
          table: 'v_fact',
          column: 'delivery_center',
        },
      ],
    };
    const result = compileSeriesSql(
      {
        chartType: 'scatter',
        measureKeys: ['revenue', 'gross_margin_pct'],
        hierarchyKeys: ['business_unit', 'client', 'delivery_center'],
        title: 'Performance hierarchy',
      },
      hierarchyModel,
      ctx,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sql).toContain('business_unit');
      expect(result.sql).toContain('client_name');
      expect(result.sql).toContain('delivery_center');
    }
  });

  it('compiles KPI hierarchy metadata into visible leaf scorecard rows', () => {
    const hierarchyModel: SemanticModel = {
      ...model,
      dimensions: [
        ...model.dimensions,
        {
          key: 'delivery_center',
          label: 'Delivery Center',
          table: 'v_fact',
          column: 'delivery_center',
        },
      ],
    };
    const result = compileSeriesSql(
      {
        chartType: 'kpi',
        measureKeys: ['revenue', 'gross_margin_pct'],
        hierarchyKeys: ['business_unit', 'client', 'delivery_center'],
        title: 'Executive drill-down',
      },
      hierarchyModel,
      ctx,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sql).toContain(
        "concat(toString(business_unit), ' › ', toString(client_name), ' › ', toString(delivery_center)) AS name",
      );
      expect(result.sql).toContain(
        'GROUP BY business_unit, client_name, delivery_center',
      );
      expect(result.sql).toContain('AS "Revenue"');
      expect(result.sql).toContain('AS "Gross Margin %"');
    }
  });

  it('compiles a single-measure treemap hierarchy into path rows', () => {
    const result = compileSeriesSql(
      {
        chartType: 'treemap',
        measureKeys: ['revenue'],
        hierarchyKeys: ['business_unit', 'client'],
        title: 'Revenue hierarchy',
      },
      model,
      ctx,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sql).toContain('AS path');
      expect(result.sql).toContain('GROUP BY business_unit, client_name');
      expect(result.sql).not.toContain("SELECT 'Total'");
    }
  });

  it('single measure → just a value format, no series', () => {
    const spec: EngineChartSpec = {
      chartType: 'bar',
      measureKeys: ['revenue'],
      dimensionKey: 'business_unit',
      title: 'x',
    };
    const d = buildEngineDisplay(spec, model);
    expect(d.valueFormat).toBe('currency');
    expect(d.series).toBeUndefined();
    expect(d.chartType).toBe('bar');
    // Human axis titles so the chart explains itself.
    expect(d.xAxisLabel).toBe('Business Unit');
    expect(d.yAxisLabel).toBe('USD');
  });

  it('forwards negative-value emphasis to the renderer', () => {
    const display = buildEngineDisplay(
      {
        chartType: 'line',
        measureKeys: ['revenue'],
        timeGrain: 'month',
        highlightNegative: true,
        title: 'Monthly Revenue',
      },
      model,
    );
    expect(display.highlightNegative).toBe(true);
  });

  it('forwards top-N emphasis without changing the query limit', () => {
    const spec: EngineChartSpec = {
      chartType: 'bar',
      measureKeys: ['revenue'],
      dimensionKey: 'business_unit',
      highlightTopN: 5,
      title: 'Revenue by Business Unit',
    };
    expect(buildEngineDisplay(spec, model).highlightTopN).toBe(5);
    const sql = compileNameValueSql(spec, model, ctx);
    expect(sql.ok).toBe(true);
    if (!sql.ok) return;
    expect(sql.sql).not.toMatch(/LIMIT 5(?:\s|$)/);
  });

  it('marks a total measure as labels instead of a plotted series', () => {
    const componentModel: SemanticModel = {
      ...model,
      measures: [
        ...model.measures,
        {
          key: 'cost',
          label: 'Cost',
          unit: 'USD',
          sourceTable: 'v_fact',
          expr: { kind: 'sum', column: 'cost_usd' },
        },
      ],
    };
    const display = buildEngineDisplay(
      {
        chartType: 'stacked_bar',
        measureKeys: ['revenue', 'cost'],
        dimensionKey: 'business_unit',
        componentMode: true,
        labelMeasureKey: 'revenue',
        title: 'Components and total',
      },
      componentModel,
    );
    expect(display.labelSeries).toBe('Revenue');
    expect(display.valueFormat).toBe('currency');
  });

  it('keeps a component dimension stacked while plotting added measures once per period', () => {
    const componentModel: SemanticModel = {
      ...model,
      measures: [
        ...model.measures,
        {
          key: 'benchmark',
          label: 'Benchmark',
          unit: 'USD',
          sourceTable: 'v_fact',
          expr: { kind: 'sum', column: 'benchmark_usd' },
        },
      ],
    };
    const spec: EngineChartSpec = {
      chartType: 'stacked_area',
      measureKeys: ['revenue', 'benchmark'],
      dimensionKey: 'business_unit',
      timeGrain: 'month',
      componentMode: true,
      title: 'Components and benchmark',
    };
    const compiled = compileSeriesSql(spec, componentModel, ctx);
    expect(compiled.ok).toBe(true);
    if (compiled.ok) {
      expect(compiled.sql).toContain(
        'toString(business_unit) AS series',
      );
      expect(compiled.sql).toContain("'Benchmark' AS series");
      expect(compiled.sql).toContain('GROUP BY toStartOfMonth(period_date)');
    }
    const display = buildEngineDisplay(spec, componentModel);
    expect(display.chartType).toBe('combo');
    expect(display.series?.[1]).toMatchObject({
      key: 'Benchmark',
      role: 'line',
    });
  });

  it('keeps an added measure to one series when a component chart becomes a combo', () => {
    const comboModel: SemanticModel = {
      ...model,
      measures: [
        ...model.measures,
        {
          key: 'benchmark',
          label: 'Benchmark',
          unit: 'USD',
          sourceTable: 'v_fact',
          expr: { kind: 'sum', column: 'benchmark_usd' },
        },
      ],
    };
    const compiled = compileSeriesSql(
      {
        chartType: 'combo',
        measureKeys: ['revenue', 'benchmark'],
        dimensionKey: 'business_unit',
        timeGrain: 'month',
        componentMode: true,
        title: 'Components and benchmark',
      },
      comboModel,
      ctx,
    );
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.sql).toContain(
      'toString(business_unit) AS series',
    );
    expect(compiled.sql).toContain("'Benchmark' AS series");
    expect(compiled.sql).not.toContain(
      "concat(toString(business_unit), ' — ', 'Benchmark') AS series",
    );
  });

  it('a $ measure + a % measure → dual-axis COMBO (%, line, right)', () => {
    const spec: EngineChartSpec = {
      chartType: 'bar',
      measureKeys: ['revenue', 'gross_margin_pct'],
      timeGrain: 'month',
      title: 'x',
    };
    const d = buildEngineDisplay(spec, model);
    expect(d.chartType).toBe('combo');
    expect(d.series).toEqual([
      { key: 'Revenue', role: 'bar', axis: 'left', format: 'currency' },
      { key: 'Gross Margin %', role: 'line', axis: 'right', format: 'percent' },
    ]);
    expect(d.secondaryAxisFormat).toBe('percent');
    expect(d.secondaryLabel).toBe('Gross Margin %');
    expect(d.xAxisLabel).toBe('Month');
    expect(d.yAxisLabel).toBe('USD');
  });

  it('labels a mixed-unit right axis with all right-side units', () => {
    const spec: EngineChartSpec = {
      chartType: 'bar',
      measureKeys: ['revenue', 'dso_days', 'gross_margin_pct'],
      dimensionKey: 'business_unit',
      title: 'x',
    };
    const d = buildEngineDisplay(spec, model);
    expect(d.chartType).toBe('combo');
    expect(d.series).toEqual([
      { key: 'Revenue', role: 'bar', axis: 'left', format: 'currency' },
      { key: 'Dso Days', role: 'line', axis: 'right', format: 'number' },
      { key: 'Gross Margin %', role: 'line', axis: 'right', format: 'percent' },
    ]);
    expect(d.yAxisLabel).toBe('USD');
    expect(d.secondaryLabel).toBe('Days / Percent');
  });

  it('uses time as the x-axis when a dimension is the series breakdown', () => {
    const spec: EngineChartSpec = {
      chartType: 'stacked_area',
      measureKeys: ['revenue'],
      dimensionKey: 'business_unit',
      timeGrain: 'month',
      title: 'x',
    };
    expect(buildEngineDisplay(spec, model).xAxisLabel).toBe('Month');
  });

  it('two same-unit ($) measures → both left-axis bars, stays a clustered bar (not combo)', () => {
    const twoMoney = {
      ...model,
      measures: [
        ...model.measures,
        {
          key: 'cost',
          label: 'Cost',
          unit: 'USD',
          sourceTable: 'v_fact',
          expr: { kind: 'sum', column: 'cost_usd' } as const,
        },
      ],
    };
    const spec: EngineChartSpec = {
      chartType: 'bar',
      measureKeys: ['revenue', 'cost'],
      dimensionKey: 'business_unit',
      title: 'x',
    };
    const d = buildEngineDisplay(spec, twoMoney);
    expect(d.chartType).toBe('bar');
    expect(d.series?.every((s) => s.axis === 'left' && s.role === 'bar')).toBe(
      true,
    );
  });

  it('a summed $ total + an average $ rate → dual-axis combo', () => {
    const revenueAndRate = {
      ...model,
      measures: [
        ...model.measures,
        {
          key: 'average_billing_rate',
          label: 'Average Billing Rate',
          unit: 'USD',
          sourceTable: 'v_fact',
          expr: { kind: 'mean', column: 'billing_rate' } as const,
        },
      ],
    };
    const spec: EngineChartSpec = {
      chartType: 'bar',
      measureKeys: ['revenue', 'average_billing_rate'],
      dimensionKey: 'business_unit',
      title: 'Revenue and billing rate',
    };
    const display = buildEngineDisplay(spec, revenueAndRate);
    expect(display.chartType).toBe('combo');
    expect(display.series).toEqual([
      { key: 'Revenue', role: 'bar', axis: 'left', format: 'currency' },
      {
        key: 'Average Billing Rate',
        role: 'line',
        axis: 'right',
        format: 'currency',
      },
    ]);
    expect(display.secondaryAxisFormat).toBe('currency');
    expect(display.secondaryLabel).toBe('Average Billing Rate');
  });

  it('draws scheduled capacity as a same-axis line over stacked attendance components', () => {
    const attendanceModel: SemanticModel = {
      ...model,
      measures: [
        {
          key: 'present',
          label: 'Present Days',
          unit: 'count',
          sourceTable: 'v_fact',
          expr: { kind: 'sum', column: 'present_days' },
        },
        {
          key: 'paid_leave',
          label: 'Paid Leave Days',
          unit: 'count',
          sourceTable: 'v_fact',
          expr: { kind: 'sum', column: 'paid_leave_days' },
        },
        {
          key: 'scheduled',
          label: 'Scheduled Work Days',
          unit: 'count',
          sourceTable: 'v_fact',
          expr: { kind: 'sum', column: 'scheduled_work_days' },
        },
      ],
    };
    const display = buildEngineDisplay(
      {
        chartType: 'stacked_bar',
        measureKeys: ['present', 'paid_leave', 'scheduled'],
        timeGrain: 'month',
        title: 'Attendance',
      },
      attendanceModel,
    );
    expect(display.chartType).toBe('combo');
    expect(display.series).toEqual([
      { key: 'Present Days', role: 'bar', axis: 'left', format: 'number' },
      { key: 'Paid Leave Days', role: 'bar', axis: 'left', format: 'number' },
      {
        key: 'Scheduled Work Days',
        role: 'line',
        axis: 'left',
        format: 'number',
      },
    ]);
    expect(display.yAxisLabel).toBe('Days');
  });

  it('uses the shared hour unit for profiled hour measures', () => {
    const hoursModel: SemanticModel = {
      ...model,
      measures: [
        {
          key: 'overtime_hours',
          label: 'Overtime Hours',
          unit: 'count',
          sourceTable: 'v_fact',
          expr: { kind: 'sum', column: 'overtime_hours' },
        },
        {
          key: 'working_hours',
          label: 'Working Hours',
          unit: 'count',
          sourceTable: 'v_fact',
          expr: { kind: 'sum', column: 'working_hours' },
        },
      ],
    };
    const display = buildEngineDisplay(
      {
        chartType: 'stacked_bar',
        measureKeys: ['overtime_hours', 'working_hours'],
        dimensionKey: 'business_unit',
        title: 'Hours',
      },
      hoursModel,
    );
    expect(display.yAxisLabel).toBe('Hours');
  });

  it('keeps mixed-format measures as bars when clustered columns were explicit', () => {
    const display = buildEngineDisplay(
      {
        chartType: 'bar',
        clustered: true,
        measureKeys: ['revenue', 'gross_margin_pct'],
        dimensionKey: 'business_unit',
        title: 'Clustered KPIs',
      },
      model,
    );
    expect(display.chartType).toBe('combo');
    expect(display.series).toEqual([
      { key: 'Revenue', role: 'bar', axis: 'left', format: 'currency' },
      { key: 'Gross Margin %', role: 'bar', axis: 'right', format: 'percent' },
    ]);
  });

  it('promotes a three-measure scatter to a bubble so the third metric is visible', () => {
    const display = buildEngineDisplay(
      {
        chartType: 'scatter',
        measureKeys: ['revenue', 'gross_margin_pct', 'clients'],
        dimensionKey: 'business_unit',
        title: 'Three-variable point chart',
      },
      model,
    );
    expect(display.chartType).toBe('bubble');
    expect(display.secondaryLabel).toBe('Clients');
  });

  it('compiles every current/prior profit series and a percentage variance axis', () => {
    const profitModel: SemanticModel = {
      ...model,
      measures: [
        model.measures[0]!,
        ...['gross_profit', 'ebitda', 'operating_profit', 'net_profit'].map(
          (key) => ({
            key,
            label: key.replace(/_/g, ' '),
            unit: 'USD',
            sourceTable: 'v_fact',
            expr: { kind: 'sum' as const, column: `${key}_usd` },
          }),
        ),
      ],
    };
    const spec: EngineChartSpec = {
      chartType: 'line',
      measureKeys: [
        'revenue',
        'gross_profit',
        'ebitda',
        'operating_profit',
        'net_profit',
      ],
      timeGrain: 'month',
      comparison: 'previous_year',
      showVariancePct: true,
      title: 'Monthly profitability',
    };
    const display = buildEngineDisplay(spec, profitModel);
    expect(display.chartType).toBe('combo');
    expect(display.secondaryAxisFormat).toBe('percent');
    expect(display.series).toHaveLength(15);
    expect(
      display.series?.filter((series) => series.axis === 'right'),
    ).toHaveLength(5);
    const compiled = compileSeriesSql(spec, profitModel, ctx);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.sql).toContain('"Revenue — Current Year"');
    expect(compiled.sql).toContain('"net profit — Previous Year"');
    expect(compiled.sql).toContain('"ebitda — Variance %"');
    expect(compiled.sql).toContain('/ nullIf(abs(toFloat64(');
  });
});

describe('SpecCompiler honest refusals', () => {
  it('refuses an unknown measure instead of guessing', () => {
    const spec: EngineChartSpec = {
      chartType: 'bar',
      measureKeys: ['ebitda'],
      title: 'x',
    };
    const r = compileSpec(spec, model, ctx);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/unknown measure/);
  });

  it('refuses a cross-table query in v1 rather than joining blindly', () => {
    const twoTable: SemanticModel = {
      ...model,
      measures: [
        ...model.measures,
        {
          key: 'other',
          label: 'Other',
          unit: 'USD',
          sourceTable: 'v_other',
          expr: { kind: 'sum', column: 'amount' },
        },
      ],
    };
    const spec: EngineChartSpec = {
      chartType: 'bar',
      measureKeys: ['revenue', 'other'],
      title: 'x',
    };
    const r = compileSpec(spec, twoTable, ctx);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/cross-table/);
  });
});
