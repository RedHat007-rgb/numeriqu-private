/**
 * End-to-end deterministic backbone test: raw ClickHouse-shaped column stats →
 * DataProfiler → SemanticModelBuilder → SpecCompiler. Proves the auto-derived
 * model produces correct, tenant-scoped SQL with NO hardcoded catalog and NO DAX.
 */
import { profileTable, type ColumnStats } from './data-profiler';
import { buildSemanticModel, prettifyLabel } from './semantic-model-builder';
import { compileSpec } from './spec-compiler';
import type { EngineChartSpec, PhysicalSchema } from './semantic-model.types';

const col = (over: Partial<ColumnStats> & Pick<ColumnStats, 'column' | 'type'>): ColumnStats => ({
  table: 'v_fact',
  distinctCount: 50,
  nullFraction: 0,
  sampleValues: [],
  rowCount: 5000,
  ...over,
});

// A schema the engine has "never seen" — no EBPO catalog, no DAX.
const rawStats: ColumnStats[] = [
  col({ column: 'client_name', type: 'String' }),
  col({ column: 'business_unit', type: 'String' }),
  col({ column: 'period_date', type: 'Date' }),
  col({ column: 'revenue_usd', type: 'Decimal(18, 2)' }),
  col({ column: 'pl_amount_usd', type: 'Decimal(18, 2)' }),
  col({ column: 'total_revenue_usd', type: 'Decimal(18, 2)' }),
  col({ column: 'gross_profit_usd', type: 'Decimal(18, 2)' }),
  col({ column: 'gross_margin_pct', type: 'Float64' }),
  col({ column: 'cash_balance', type: 'Decimal(18, 2)' }),
  col({ column: 'client_id', type: 'UInt64' }),
];

const schema: PhysicalSchema = {
  datasetId: 'unseen-client',
  introspectedAt: '2026-07-13T00:00:00Z',
  relationships: [],
  tables: [{ name: 'v_fact', rowCountEstimate: 5000, columns: rawStats.map((s) => ({ name: s.column, type: s.type, nullable: false })) }],
};

describe('semantic labels', () => {
  it('preserves standard financial and operating acronyms', () => {
    expect(prettifyLabel('ebitda_margin_pct')).toBe('EBITDA Margin %');
    expect(prettifyLabel('total_cogs_usd')).toBe('Total COGS');
    expect(prettifyLabel('average_dso_days')).toBe('Average DSO Days');
    expect(prettifyLabel('employee_headcount_key')).toBe('Employee Headcount');
  });
});

const ctx = { analyticsDb: 'analytics', tenantId: 'org-uuid', externalOrgIds: ['ext-1'] };

describe('auto-derived pipeline (no hardcoded catalog, no DAX)', () => {
  const profiles = profileTable(rawStats);
  const { model, skipped } = buildSemanticModel({ schema, profilesByTable: { v_fact: profiles } });

  it('derives measures with correct aggregation semantics from data alone', () => {
    const byKey = Object.fromEntries(model.measures.map((m) => [m.key, m]));
    expect(byKey['revenue_usd']?.expr).toEqual({ kind: 'sum', column: 'revenue_usd' });
    expect(byKey['gross_margin_pct']?.expr).toEqual({ kind: 'ratio_of_sums', numerator: 'gross_profit_usd', denominator: 'revenue_usd' });
    expect(byKey['pl_amount_pct_of_revenue']?.expr).toEqual({ kind: 'ratio_of_sums', numerator: 'pl_amount_usd', denominator: 'total_revenue_usd' });
    expect(byKey['cash_balance']?.expr).toEqual({ kind: 'last_value', column: 'cash_balance', orderBy: 'period_date' });
    expect(byKey['client_id']?.expr).toEqual({ kind: 'count_distinct', column: 'client_id' });
  });

  it('derives dimensions + a client entity + a time grain', () => {
    expect(model.dimensions.map((d) => d.key)).toEqual(expect.arrayContaining(['client_name', 'business_unit']));
    expect(model.entities.some((e) => e.nameColumn === 'client_name')).toBe(true);
    expect(model.time?.column).toBe('period_date');
  });

  it('does NOT expose integer calendar-part columns as dimensions (time grain covers them)', () => {
    const stats2 = [
      col({ column: 'client_name', type: 'String' }),
      col({ column: 'period_date', type: 'Date' }),
      col({ column: 'year', type: 'UInt16' }),
      col({ column: 'quarter', type: 'UInt8', min: 1, max: 4 }),
      col({ column: 'month', type: 'UInt8', min: 1, max: 12 }),
      col({ column: 'month_name', type: 'LowCardinality(String)' }),
      col({ column: 'revenue_usd', type: 'Decimal(18, 2)' }),
    ];
    const m = buildSemanticModel({
      schema: { ...schema, tables: [{ name: 'v_fact', rowCountEstimate: 0, columns: stats2.map((s) => ({ name: s.column, type: s.type, nullable: false })) }] },
      profilesByTable: { v_fact: profileTable(stats2) },
    }).model;
    const dimKeys = m.dimensions.map((d) => d.key);
    expect(dimKeys).toContain('client_name');
    expect(dimKeys).not.toContain('month');
    expect(dimKeys).not.toContain('quarter');
    expect(dimKeys).not.toContain('year');
    expect(dimKeys).not.toContain('month_name');
    expect(m.time?.column).toBe('period_date');
  });

  it('compiles "top 5 clients by revenue" into correct scoped SQL', () => {
    const spec: EngineChartSpec = { chartType: 'bar', measureKeys: ['revenue_usd'], dimensionKey: 'client_name', topN: 5, title: 'Top clients' };
    const r = compileSpec(spec, model, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sql).toContain('sum(revenue_usd) AS `__measure_0`');
    expect(r.sql).toContain('FROM analytics.v_fact');
    expect(r.sql).toContain('tenant_id = {tenantId:String}');
    expect(r.sql).toContain('ORDER BY `__measure_0` DESC');
    expect(r.sql).toContain('LIMIT 5');
  });

  it('compiles gross margin trend as SUM/SUM per month — the accuracy win', () => {
    const spec: EngineChartSpec = { chartType: 'line', measureKeys: ['gross_margin_pct'], timeGrain: 'month', title: 'Margin trend' };
    const r = compileSpec(spec, model, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sql).toContain('sum(gross_profit_usd) / nullIf(sum(revenue_usd), 0)');
    expect(r.sql).not.toMatch(/avg\s*\(/i);
    expect(r.sql).toContain('toStartOfMonth(period_date)');
  });
});
