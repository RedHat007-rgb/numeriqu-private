import { profileTable, type ColumnStats } from './data-profiler';
import { buildSemanticModel } from './semantic-model-builder';
import { sfinDeclaredMeasuresForTables } from './sfin-measure-registry';
import { buildSfinSemanticCubeDdls } from './sfin-semantic-cubes';
import { compileSpec } from './spec-compiler';
import type { EngineChartSpec, PhysicalSchema } from './semantic-model.types';

const TABLE = 'v_sfin_balance_ratio_semantic';
const CASH_FLOW_TABLE = 'v_sfin_cashflow_semantic';
const WORKING_CAPITAL_TABLE = 'v_sfin_working_capital_semantic';
const numericColumns = [
  'closing_total_assets_usd',
  'closing_total_liabilities_usd',
  'closing_total_equity_usd',
  'closing_current_assets_usd',
  'closing_current_liabilities_usd',
  'total_revenue_usd',
  'net_profit_usd',
];

const stats: ColumnStats[] = [
  {
    table: TABLE,
    column: 'tenant_id',
    type: 'String',
    distinctCount: 1,
    nullFraction: 0,
    sampleValues: ['tenant'],
    rowCount: 24,
  },
  {
    table: TABLE,
    column: 'org_id',
    type: 'String',
    distinctCount: 1,
    nullFraction: 0,
    sampleValues: ['org'],
    rowCount: 24,
  },
  {
    table: TABLE,
    column: 'period_date',
    type: 'Date',
    distinctCount: 24,
    nullFraction: 0,
    sampleValues: ['2025-12-01'],
    rowCount: 24,
  },
  ...numericColumns.map(
    (column): ColumnStats => ({
      table: TABLE,
      column,
      type: 'Float64',
      distinctCount: 24,
      nullFraction: 0,
      min: 1,
      max: 1000,
      sampleValues: [100],
      rowCount: 24,
    }),
  ),
];

const schema: PhysicalSchema = {
  datasetId: 'numeriqu-demo',
  introspectedAt: '2026-07-27T00:00:00.000Z',
  relationships: [],
  tables: [
    {
      name: TABLE,
      rowCountEstimate: 24,
      columns: stats.map((column) => ({
        name: column.column,
        type: column.type,
        nullable: false,
      })),
    },
  ],
};

function buildBalanceModel(columns = stats) {
  const profiles = profileTable(columns, { allowMean: true });
  return buildSemanticModel({
    schema,
    profilesByTable: { [TABLE]: profiles },
    declaredMeasures: sfinDeclaredMeasuresForTables([TABLE]),
  });
}

describe('SFIN data-driven composed measure registry', () => {
  it('overrides profiled stock semantics with the client DAX SUM declarations', () => {
    const columns = [
      'opening_cash_balance_usd',
      'closing_cash_balance_usd',
      'net_cash_flow_usd',
    ];
    const cashStats: ColumnStats[] = [
      {
        table: CASH_FLOW_TABLE,
        column: 'period_date',
        type: 'Date',
        distinctCount: 2,
        nullFraction: 0,
        sampleValues: ['2025-12-01'],
        rowCount: 16,
      },
      ...columns.map(
        (column): ColumnStats => ({
          table: CASH_FLOW_TABLE,
          column,
          type: 'Float64',
          distinctCount: 16,
          nullFraction: 0,
          min: -10,
          max: 100,
          sampleValues: [10],
          rowCount: 16,
        }),
      ),
    ];
    const cashSchema: PhysicalSchema = {
      datasetId: 'numeriqu-demo',
      introspectedAt: '2026-07-27T00:00:00.000Z',
      relationships: [],
      tables: [
        {
          name: CASH_FLOW_TABLE,
          rowCountEstimate: 16,
          columns: cashStats.map((column) => ({
            name: column.column,
            type: column.type,
            nullable: false,
          })),
        },
      ],
    };
    const { model } = buildSemanticModel({
      schema: cashSchema,
      profilesByTable: {
        [CASH_FLOW_TABLE]: profileTable(cashStats, { allowMean: true }),
      },
      declaredMeasures: sfinDeclaredMeasuresForTables([CASH_FLOW_TABLE]),
    });
    const byKey = Object.fromEntries(
      model.measures.map((measure) => [measure.key, measure]),
    );

    expect(byKey['opening_cash_balance_usd']?.expr).toEqual({
      kind: 'sum',
      column: 'opening_cash_balance_usd',
    });
    expect(byKey['closing_cash_balance_usd']?.expr).toEqual({
      kind: 'sum',
      column: 'closing_cash_balance_usd',
    });
    expect(byKey['cash_balance_usd']?.expr).toEqual({
      kind: 'sum',
      column: 'closing_cash_balance_usd',
    });
    expect(byKey['net_cash_flow_usd']?.expr).toEqual({
      kind: 'sum',
      column: 'net_cash_flow_usd',
    });

    const result = compileSpec(
      {
        chartType: 'line',
        measureKeys: [
          'opening_cash_balance_usd',
          'closing_cash_balance_usd',
          'net_cash_flow_usd',
          'cash_balance_usd',
        ],
        timeGrain: 'month',
        title: 'Cash flow balances',
      },
      model,
      {
        analyticsDb: 'analytics',
        tenantId: 'tenant',
        externalOrgIds: ['org'],
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sql).toContain(
      'sum(opening_cash_balance_usd) AS `__measure_0`',
    );
    expect(result.sql).toContain(
      'sum(closing_cash_balance_usd) AS `__measure_1`',
    );
    expect(result.sql).toContain(
      'sum(net_cash_flow_usd) AS `__measure_2`',
    );
    expect(result.sql).toContain(
      'sum(closing_cash_balance_usd) AS `__measure_3`',
    );
    expect(result.sql).not.toContain('argMax(opening_cash_balance_usd');
    expect(result.sql).not.toContain('argMax(closing_cash_balance_usd');
  });

  it('feeds PBIX cash balance into the consolidated working-capital cube', () => {
    const ddl = buildSfinSemanticCubeDdls('analytics', {
      accountSubTypes: ['Cash', 'Receivables'],
    }).find((statement) =>
      statement.includes(
        'CREATE OR REPLACE VIEW analytics.v_sfin_working_capital_semantic',
      ),
    );
    expect(ddl).toContain(
      'sum(closing_cash_balance_usd) AS cash_flow_closing_balance_usd',
    );
    expect(
      sfinDeclaredMeasuresForTables([WORKING_CAPITAL_TABLE]),
    ).toContainEqual(
      expect.objectContaining({
        key: 'cash_balance_usd',
        sourceTable: WORKING_CAPITAL_TABLE,
        expr: {
          kind: 'sum',
          column: 'cash_flow_closing_balance_usd',
        },
      }),
    );
  });

  it('registers the six Q57 ratios with their DAX aggregation shapes', () => {
    const { model } = buildBalanceModel();
    const byKey = Object.fromEntries(
      model.measures.map((measure) => [measure.key, measure]),
    );

    expect(byKey['debt_to_equity_ratio']).toMatchObject({
      unit: 'x',
      expr: {
        kind: 'ratio_of_aggs',
        numerator: {
          agg: 'as_of',
          column: 'closing_total_liabilities_usd',
          orderBy: 'period_date',
        },
        denominator: {
          agg: 'as_of',
          column: 'closing_total_equity_usd',
          orderBy: 'period_date',
        },
      },
    });
    expect(byKey['roa_pct']?.expr).toEqual({
      kind: 'ratio_of_aggs',
      numerator: { agg: 'sum', column: 'net_profit_usd' },
      denominator: { agg: 'mean', column: 'closing_total_assets_usd' },
    });
    expect(byKey['roe_pct']?.expr).toEqual({
      kind: 'ratio_of_aggs',
      numerator: { agg: 'sum', column: 'net_profit_usd' },
      denominator: { agg: 'mean', column: 'closing_total_equity_usd' },
    });
    expect(byKey['asset_turnover_ratio']?.unit).toBe('x');
    expect(byKey['debt_ratio_pct']?.unit).toBe('%');
    expect(byKey['equity_ratio_pct']?.unit).toBe('%');
    expect(byKey['current_ratio']?.unit).toBe('x');
  });

  it('compiles the Q57 quarterly trend without averaging precomputed ratios', () => {
    const { model } = buildBalanceModel();
    const spec: EngineChartSpec = {
      chartType: 'line',
      measureKeys: [
        'debt_to_equity_ratio',
        'roa_pct',
        'roe_pct',
        'asset_turnover_ratio',
        'debt_ratio_pct',
        'equity_ratio_pct',
      ],
      timeGrain: 'quarter',
      title: 'Quarterly balance ratios',
    };
    const result = compileSpec(spec, model, {
      analyticsDb: 'analytics',
      tenantId: 'tenant',
      externalOrgIds: ['org'],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sql).toContain('toStartOfQuarter(period_date)');
    expect(result.sql).toContain(
      'argMax(closing_total_liabilities_usd, period_date) / nullIf(argMax(closing_total_equity_usd, period_date), 0)',
    );
    expect(result.sql).toContain(
      'sum(net_profit_usd) / nullIf(avg(closing_total_assets_usd), 0)',
    );
    expect(result.sql).toContain(
      'sum(total_revenue_usd) / nullIf(avg(closing_total_assets_usd), 0)',
    );
    expect(result.sql).not.toContain('average_debt_to_equity_ratio');
  });

  it('refuses a stale declaration when its view no longer exposes a component', () => {
    const withoutEquity = stats.filter(
      (column) => column.column !== 'closing_total_equity_usd',
    );
    const { model, skipped } = buildBalanceModel(withoutEquity);

    expect(
      model.measures.some((measure) => measure.key === 'debt_to_equity_ratio'),
    ).toBe(false);
    expect(skipped).toContainEqual({
      table: TABLE,
      column: 'debt_to_equity_ratio',
      reason:
        'declared measure references missing column(s): closing_total_equity_usd',
    });
  });
});
