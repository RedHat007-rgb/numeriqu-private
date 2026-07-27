/**
 * Client-owned derived-measure catalog for the SFIN semantic views.
 *
 * These declarations translate the supplied DAX catalog into the engine's
 * generic MeasureExpr data model. The compiler and model builder contain no
 * knowledge of ROA, debt-to-equity, or any other business-specific formula.
 * Another client can supply a different registry.
 *
 * Oracle: docs/dax-measures-canonical.md
 */
import type { SemanticMeasure } from './semantic-model.types';

const BALANCE_TABLE = 'v_sfin_balance_ratio_semantic';
const PERIOD = 'period_date';

const asOf = (column: string) =>
  ({ agg: 'as_of', column, orderBy: PERIOD }) as const;
const mean = (column: string) => ({ agg: 'mean', column }) as const;
const sum = (column: string) => ({ agg: 'sum', column }) as const;

const SFIN_DECLARED_MEASURES: readonly SemanticMeasure[] = [
  {
    key: 'debt_to_equity_ratio',
    label: 'Debt-to-Equity Ratio',
    unit: 'x',
    sourceTable: BALANCE_TABLE,
    expr: {
      kind: 'ratio_of_aggs',
      numerator: asOf('closing_total_liabilities_usd'),
      denominator: asOf('closing_total_equity_usd'),
    },
  },
  {
    key: 'roa_pct',
    label: 'ROA',
    unit: '%',
    sourceTable: BALANCE_TABLE,
    expr: {
      kind: 'ratio_of_aggs',
      numerator: sum('net_profit_usd'),
      denominator: mean('closing_total_assets_usd'),
    },
  },
  {
    key: 'roe_pct',
    label: 'ROE',
    unit: '%',
    sourceTable: BALANCE_TABLE,
    expr: {
      kind: 'ratio_of_aggs',
      numerator: sum('net_profit_usd'),
      denominator: mean('closing_total_equity_usd'),
    },
  },
  {
    key: 'asset_turnover_ratio',
    label: 'Asset Turnover',
    unit: 'x',
    sourceTable: BALANCE_TABLE,
    expr: {
      kind: 'ratio_of_aggs',
      numerator: sum('total_revenue_usd'),
      denominator: mean('closing_total_assets_usd'),
    },
  },
  {
    key: 'debt_ratio_pct',
    label: 'Debt Ratio',
    unit: '%',
    sourceTable: BALANCE_TABLE,
    expr: {
      kind: 'ratio_of_aggs',
      numerator: asOf('closing_total_liabilities_usd'),
      denominator: asOf('closing_total_assets_usd'),
    },
  },
  {
    key: 'equity_ratio_pct',
    label: 'Equity Ratio',
    unit: '%',
    sourceTable: BALANCE_TABLE,
    expr: {
      kind: 'ratio_of_aggs',
      numerator: asOf('closing_total_equity_usd'),
      denominator: asOf('closing_total_assets_usd'),
    },
  },
  {
    key: 'current_ratio',
    label: 'Current Ratio',
    unit: 'x',
    sourceTable: BALANCE_TABLE,
    expr: {
      kind: 'ratio_of_aggs',
      numerator: asOf('closing_current_assets_usd'),
      denominator: asOf('closing_current_liabilities_usd'),
    },
  },
];

/** Return declarations whose physical source table is part of this model. */
export function sfinDeclaredMeasuresForTables(
  tableNames: Iterable<string>,
): SemanticMeasure[] {
  const tables = new Set(tableNames);
  return SFIN_DECLARED_MEASURES.filter((measure) =>
    tables.has(measure.sourceTable),
  ).map((measure) => structuredClone(measure));
}
