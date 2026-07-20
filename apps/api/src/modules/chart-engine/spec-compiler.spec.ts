import {
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
});

describe('buildEngineDisplay axis assignment', () => {
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
      { key: 'Scheduled Work Days', role: 'line', axis: 'left', format: 'number' },
    ]);
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
