/**
 * DAX oracle — STATIC parity gate.
 *
 * The runtime numeric gate (values match PowerBI to the dollar on live CH) is
 * scripts/powerbi-parity.ts. THIS test proves, with no live data, that the
 * auto-derived semantic model reproduces the SAME FORMULA SHAPE the DAX oracle
 * uses — i.e. every EBPO ratio derives to DIVIDE(SUM(num), SUM(den)) with the
 * correct numerator/denominator, never an average. If this is green, the
 * derivation is faithful to the DAX definitions; only the live values remain.
 *
 * Golden formulas transcribed from scripts/powerbi-parity.ts's DAX oracle.
 */
import { profileTable, type ColumnStats } from './data-profiler';
import { buildSemanticModel } from './semantic-model-builder';
import type { PhysicalSchema } from './semantic-model.types';

// Representative EBPO fact columns (names as they exist in the analytics views).
const EBPO_COLUMNS: Array<[string, string]> = [
  ['client_name', 'String'],
  ['period_date', 'Date'],
  ['total_revenue_usd', 'Decimal(18, 2)'],
  ['total_cost_usd', 'Decimal(18, 2)'],
  ['total_payroll_usd', 'Decimal(18, 2)'],
  ['gross_margin_usd', 'Decimal(18, 2)'],
  ['collected_amount_usd', 'Decimal(18, 2)'],
  ['paid_amount_usd', 'Decimal(18, 2)'],
  ['invoice_amount_usd', 'Decimal(18, 2)'],
  // ratio measures the engine must derive as SUM/SUM:
  ['gross_margin_pct', 'Float64'],
  ['payroll_to_revenue_pct', 'Float64'],
  ['collection_rate_pct', 'Float64'],
  ['cost_to_income_pct', 'Float64'],
];

// DAX ground-truth numerator/denominator for each ratio (from powerbi-parity.ts).
const DAX_RATIOS: Record<string, { numerator: string; denominator: string }> = {
  gross_margin_pct: { numerator: 'gross_margin_usd', denominator: 'total_revenue_usd' },
  payroll_to_revenue_pct: { numerator: 'total_payroll_usd', denominator: 'total_revenue_usd' },
  collection_rate_pct: { numerator: 'collected_amount_usd', denominator: 'invoice_amount_usd' },
  cost_to_income_pct: { numerator: 'total_cost_usd', denominator: 'total_revenue_usd' },
};

const col = (column: string, type: string): ColumnStats => ({
  table: 'v_ebpo_fact', column, type, distinctCount: 100, nullFraction: 0, sampleValues: [], rowCount: 10000,
});

describe('DAX oracle — auto-derived model reproduces DAX formula shape', () => {
  const stats = EBPO_COLUMNS.map(([c, t]) => col(c, t));
  const profiles = profileTable(stats);
  const schema: PhysicalSchema = {
    datasetId: 'ebpo', introspectedAt: '2026-07-13T00:00:00Z', relationships: [],
    tables: [{ name: 'v_ebpo_fact', rowCountEstimate: 10000, columns: stats.map((s) => ({ name: s.column, type: s.type, nullable: false })) }],
  };
  const { model } = buildSemanticModel({ schema, profilesByTable: { v_ebpo_fact: profiles } });
  const byKey = Object.fromEntries(model.measures.map((m) => [m.key, m]));

  it.each(Object.entries(DAX_RATIOS))('derives %s as SUM(num)/SUM(den) matching DAX', (key, dax) => {
    const measure = byKey[key];
    expect(measure).toBeDefined();
    expect(measure!.expr).toEqual({ kind: 'ratio_of_sums', numerator: dax.numerator, denominator: dax.denominator });
  });

  it('derives additive dollar measures as SUM', () => {
    expect(byKey['total_revenue_usd']?.expr).toEqual({ kind: 'sum', column: 'total_revenue_usd' });
    expect(byKey['total_payroll_usd']?.expr).toEqual({ kind: 'sum', column: 'total_payroll_usd' });
  });

  it('NEVER derives a ratio measure as an average or a bare sum', () => {
    for (const key of Object.keys(DAX_RATIOS)) {
      expect(byKey[key]?.expr.kind).toBe('ratio_of_sums');
    }
  });
});
