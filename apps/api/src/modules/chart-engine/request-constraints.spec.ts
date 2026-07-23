import type { EngineChartSpec, SemanticModel } from './semantic-model.types';
import {
  applyRequestConstraints,
  extractRequestConstraints,
  validateChartRows,
  validateRequestFidelity,
} from './request-constraints';

const model: SemanticModel = {
  datasetId: 'dataset',
  version: 1,
  entities: [],
  factGrain: 'one row per account per month',
  builtBy: 'auto',
  time: {
    table: 'semantic_view',
    column: 'period_date',
    grains: ['month', 'quarter', 'year'],
  },
  measures: [
    {
      key: 'revenue_amount',
      label: 'Revenue Amount',
      unit: 'USD',
      sourceTable: 'semantic_view',
      expr: { kind: 'sum', column: 'revenue_amount' },
    },
    {
      key: 'direct_cost_amount',
      label: 'Direct Cost Amount',
      unit: 'USD',
      sourceTable: 'semantic_view',
      expr: { kind: 'sum', column: 'direct_cost_amount' },
    },
  ],
  dimensions: [
    {
      key: 'account_class',
      label: 'Account Class',
      table: 'semantic_view',
      column: 'account_class',
      sampleValues: ['Asset', 'Expense', 'Revenue'],
    },
    {
      key: 'account_name',
      label: 'Account Name',
      table: 'semantic_view',
      column: 'account_name',
    },
  ],
};

const baseSpec: EngineChartSpec = {
  chartType: 'bar',
  measureKeys: ['revenue_amount'],
  dimensionKey: 'account_name',
  title: 'Revenue by account',
};

describe('request constraints', () => {
  it('extracts calendar, ranking, sorting, and catalog filters without dataset constants', () => {
    expect(
      extractRequestConstraints(
        'For Q2 2025 show the six largest Expense accounts.',
        model,
      ),
    ).toMatchObject({
      dateRange: { start: '2025-04-01', end: '2025-06-30' },
      topN: 6,
      sort: 'desc',
      filters: [
        {
          dimensionKey: 'account_class',
          operator: 'in',
          values: ['Expense'],
        },
      ],
    });
  });

  it('removes a planner-invented time axis while retaining a requested calendar filter', () => {
    const constrained = applyRequestConstraints(
      'For Q2 2025 show the six largest Expense accounts.',
      { ...baseSpec, timeGrain: 'quarter' },
      model,
    );
    expect(constrained.timeGrain).toBeUndefined();
    expect(constrained.dateRange).toEqual({
      start: '2025-04-01',
      end: '2025-06-30',
    });
  });

  it('refuses arithmetic that is not represented as a governed calculation', () => {
    expect(
      validateRequestFidelity(
        'Show revenue minus direct cost by account.',
        { ...baseSpec, measureKeys: ['revenue_amount'] },
        model,
      ),
    ).toContain('arithmetic is not explicitly represented');
  });

  it('refuses negative part-to-whole results', () => {
    expect(
      validateChartRows({ ...baseSpec, chartType: 'pie' }, [
        { name: 'A', value: 10 },
        { name: 'B', value: -2 },
      ]),
    ).toContain('cannot contain negative');
  });

  it('forces a month grain when the user defines each slice as one month', () => {
    const constrained = applyRequestConstraints(
      'Make a pie chart where each slice is one month of 2025.',
      { ...baseSpec, chartType: 'pie' },
      model,
    );
    expect(constrained.timeGrain).toBe('month');
    expect(constrained.dateRange).toEqual({
      start: '2025-01-01',
      end: '2025-12-31',
    });
  });

  it('turns a relative month window plus a line chart into a monthly series', () => {
    const question =
      'Please give me profit for the last six months in a line chart.';
    expect(extractRequestConstraints(question, model)).toMatchObject({
      period: { kind: 'LAST_N_MONTHS', value: 6 },
      requiresTimeAxis: true,
      timeGrain: 'month',
    });
    expect(
      applyRequestConstraints(
        question,
        {
          chartType: 'line',
          measureKeys: ['revenue_amount'],
          title: 'Profit',
        },
        model,
      ).timeGrain,
    ).toBe('month');
  });

  it('refuses a one-point result for a requested time-series chart', () => {
    expect(
      validateChartRows(
        {
          chartType: 'line',
          measureKeys: ['revenue_amount'],
          timeGrain: 'month',
          title: 'Monthly profit',
        },
        [{ name: 'Total', value: 100 }],
      ),
    ).toContain('at least two period points');
  });

  it('refuses a qualified category when the plan has no catalog filter', () => {
    expect(
      validateRequestFidelity(
        'Show the largest expense accounts.',
        baseSpec,
        model,
      ),
    ).toContain('category qualifier is not represented');
  });
});
