import {
  parsePlannerResponse,
  fieldMatchScore,
  planChart,
  planEdit,
  preferDistinctAxisMeasure,
  requestedChartType,
  type LlmCaller,
} from './chart-planner';
import type { EngineChartSpec, SemanticModel } from './semantic-model.types';

const model: SemanticModel = {
  datasetId: 'ebpo',
  version: 1,
  builtBy: 'auto',
  factGrain: 'one row per client per month',
  entities: [
    { key: 'client', label: 'Client', table: 'v', nameColumn: 'client_name' },
  ],
  dimensions: [
    { key: 'client_name', label: 'Client', table: 'v', column: 'client_name' },
    {
      key: 'business_unit',
      label: 'Business Unit',
      table: 'v',
      column: 'business_unit',
    },
  ],
  time: {
    table: 'v',
    column: 'period_date',
    grains: ['month', 'quarter', 'year'],
  },
  measures: [
    {
      key: 'total_revenue_usd',
      label: 'Revenue',
      unit: 'USD',
      sourceTable: 'v',
      expr: { kind: 'sum', column: 'total_revenue_usd' },
    },
    {
      key: 'gross_margin_pct',
      label: 'Gross Margin %',
      unit: '%',
      sourceTable: 'v',
      expr: { kind: 'ratio_of_sums', numerator: 'gm', denominator: 'rev' },
    },
  ],
};

describe('ChartPlanner.parsePlannerResponse', () => {
  it('prefers a distinctive qualified metric over a generic cost measure', () => {
    expect(
      fieldMatchScore('monthly SG&A cost', 'total_sga_usd', 'Total SG&A'),
    ).toBeGreaterThan(
      fieldMatchScore('monthly SG&A cost', 'total_cost_usd', 'Total Cost'),
    );
    expect(
      fieldMatchScore('total cost', 'total_cost_usd', 'Total Cost'),
    ).toBeGreaterThan(
      fieldMatchScore('total cost', 'total_sga_usd', 'Total SG&A'),
    );
  });

  it('does not confuse a service-line dimension with a requested line chart', () => {
    expect(
      requestedChartType(
        'Create a bar chart showing revenue by service line.',
      ),
    ).toBe('bar');
    expect(
      requestedChartType('Create a line chart showing revenue by service line.'),
    ).toBe('line');
  });

  it('accepts a valid spec referencing real measures/dimensions', () => {
    const r = parsePlannerResponse(
      JSON.stringify({
        chartType: 'bar',
        measureKeys: ['total_revenue_usd'],
        dimensionKey: 'client_name',
        topN: 5,
        sort: 'desc',
        title: 'Top clients',
      }),
      model,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.spec.measureKeys).toEqual(['total_revenue_usd']);
  });

  it('tolerates ```json fences from the LLM', () => {
    const r = parsePlannerResponse(
      '```json\n{"chartType":"line","measureKeys":["gross_margin_pct"],"timeGrain":"month","title":"Margin"}\n```',
      model,
    );
    expect(r.ok).toBe(true);
  });

  it.each([
    'horizontal_bar',
    'stacked_bar',
    'stacked_area',
    'combo',
    'donut',
    'treemap',
    'waterfall',
    'heatmap',
  ] as const)('accepts frontend-supported chart type %s', (chartType) => {
    const r = parsePlannerResponse(
      JSON.stringify({
        chartType,
        measureKeys: ['total_revenue_usd'],
        dimensionKey: 'business_unit',
        title: 'x',
      }),
      model,
    );
    expect(r.ok).toBe(true);
  });

  it('REFUSES an invented measure (no hallucination surface)', () => {
    const r = parsePlannerResponse(
      JSON.stringify({ chartType: 'bar', measureKeys: ['ebitda'], title: 'x' }),
      model,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/unknown measure/);
  });

  it('normalizes a catalog unit annotation echoed after a real measure key', () => {
    const r = parsePlannerResponse(
      JSON.stringify({
        chartType: 'bar',
        measureKeys: ['gross_margin_pct (%)'],
        title: 'Margin',
      }),
      model,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.spec.measureKeys).toEqual(['gross_margin_pct']);
  });

  it('deduplicates a measure and accepts a previous-year comparison', () => {
    const r = parsePlannerResponse(
      JSON.stringify({
        chartType: 'line',
        measureKeys: ['total_revenue_usd', 'total_revenue_usd'],
        timeGrain: 'month',
        comparison: 'previous_year',
        title: 'Revenue vs previous year',
      }),
      model,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.spec.measureKeys).toEqual(['total_revenue_usd']);
      expect(r.spec.comparison).toBe('previous_year');
    }
  });

  it('keeps the prior monthly grain and produces percent YoY growth on edit', async () => {
    const prior: EngineChartSpec = {
      chartType: 'stacked_bar',
      measureKeys: ['total_revenue_usd'],
      dimensionKey: 'business_unit',
      timeGrain: 'month',
      title: 'Monthly Revenue by Business Unit',
    };
    const llm: LlmCaller = async () =>
      JSON.stringify({
        chartType: 'stacked_bar',
        measureKeys: ['total_revenue_usd'],
        dimensionKey: 'business_unit',
        timeGrain: 'year',
        comparison: 'previous_year',
        title: 'Monthly Revenue by Business Unit',
      });
    const result = await planEdit(
      'In the same chart, show year-over-year growth for each business unit.',
      prior,
      model,
      llm,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.comparison).toBe('yoy_growth_pct');
    expect(result.spec.timeGrain).toBe('month');
    expect(result.spec.chartType).toBe('line');
  });

  it('marks negative values for emphasis on a highlight edit', async () => {
    const prior: EngineChartSpec = {
      chartType: 'line',
      measureKeys: ['total_revenue_usd'],
      timeGrain: 'month',
      title: 'Monthly Revenue',
    };
    const llm: LlmCaller = async () => JSON.stringify(prior);
    const result = await planEdit(
      'In the same chart, highlight months with negative values.',
      prior,
      model,
      llm,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.highlightNegative).toBe(true);
  });

  it('does not introduce a time grain when an edit did not request time', async () => {
    const prior: EngineChartSpec = {
      chartType: 'stacked_bar',
      measureKeys: ['total_revenue_usd'],
      dimensionKey: 'business_unit',
      title: 'Revenue by Business Unit',
    };
    const llm: LlmCaller = async () =>
      JSON.stringify({
        ...prior,
        timeGrain: 'month',
        measureKeys: ['total_revenue_usd', 'gross_margin_pct'],
      });
    const result = await planEdit(
      'In the same chart, add gross margin percentage.',
      prior,
      model,
      llm,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.timeGrain).toBeUndefined();
  });

  it('treats average monthly salary as a metric name, not a time grouping', async () => {
    const salaryModel: SemanticModel = {
      ...model,
      measures: [
        ...model.measures,
        {
          key: 'average_monthly_salary',
          label: 'Average Monthly Salary',
          unit: 'USD',
          expr: { kind: 'avg', column: 'average_monthly_salary' },
        },
      ],
    };
    const prior: EngineChartSpec = {
      chartType: 'stacked_bar',
      measureKeys: ['total_revenue_usd'],
      dimensionKey: 'business_unit',
      breakdownKey: 'client_name',
      title: 'Headcount by Grade and Department',
    };
    const llm: LlmCaller = async () =>
      JSON.stringify({
        ...prior,
        timeGrain: 'month',
        measureKeys: ['total_revenue_usd', 'average_monthly_salary'],
      });
    const result = await planEdit(
      'In the same chart, add average monthly salary.',
      prior,
      salaryModel,
      llm,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.timeGrain).toBeUndefined();
    expect(result.spec.dimensionKey).toBe('business_unit');
  });

  it('replaces the slice measure for a share-of-total donut edit', async () => {
    const payrollModel: SemanticModel = {
      ...model,
      measures: [
        ...model.measures,
        {
          key: 'total_payroll_usd',
          label: 'Total Payroll',
          unit: 'USD',
          expr: { kind: 'sum', column: 'total_payroll_usd' },
        },
      ],
    };
    const prior: EngineChartSpec = {
      chartType: 'donut',
      measureKeys: ['total_revenue_usd'],
      dimensionKey: 'client_name',
      title: 'Headcount by client',
    };
    const result = await planEdit(
      "In the same chart, show each client's share of total payroll cost.",
      prior,
      payrollModel,
      async () =>
        JSON.stringify({
          ...prior,
          normalize: true,
          measureKeys: ['total_revenue_usd', 'total_payroll_usd'],
        }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.measureKeys).toEqual(['total_payroll_usd']);
    expect(result.spec.chartType).toBe('donut');
    expect(result.spec.normalize).toBe(true);
    expect(result.spec.title).toBe('Share of Total Payroll by Client');
  });

  it('highlights top N without filtering the chart to N rows', async () => {
    const prior: EngineChartSpec = {
      chartType: 'bar',
      measureKeys: ['total_revenue_usd'],
      dimensionKey: 'business_unit',
      title: 'Revenue by Business Unit',
    };
    const llm: LlmCaller = async () =>
      JSON.stringify({ ...prior, topN: 5, sort: 'desc' });
    const result = await planEdit(
      'In the same chart, highlight the top 5 business units.',
      prior,
      model,
      llm,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.topN).toBeUndefined();
    expect(result.spec.highlightTopN).toBe(5);
    expect(result.spec.sort).toBe('desc');
  });

  it('honors an explicitly requested chart type when the planner suggests another type', async () => {
    const llm: LlmCaller = async () =>
      JSON.stringify({
        chartType: 'line',
        measureKeys: ['total_revenue_usd'],
        dimensionKey: 'business_unit',
        title: 'Revenue by Business Unit',
      });
    const result = await planChart(
      'Create a bar chart showing revenue by business unit.',
      model,
      llm,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.chartType).toBe('bar');
  });

  it('refuses a metric-add edit that did not actually add a measure', async () => {
    const prior: EngineChartSpec = {
      chartType: 'bar',
      measureKeys: ['total_revenue_usd'],
      dimensionKey: 'business_unit',
      title: 'Revenue by Business Unit',
    };
    const llm: LlmCaller = async () =>
      JSON.stringify({
        ...prior,
        title: 'Revenue and Payroll Cost by Business Unit',
      });
    const result = await planEdit(
      'In the same chart, add payroll cost by business unit.',
      prior,
      model,
      llm,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/added measure is unavailable/);
  });

  it('treats a two-word metric name as explicit and overrides an unrelated LLM measure', async () => {
    const marginModel: SemanticModel = {
      ...model,
      measures: [
        ...model.measures,
        {
          key: 'ebitda_usd',
          label: 'EBITDA',
          unit: 'USD',
          sourceTable: 'v',
          expr: { kind: 'sum', column: 'ebitda_usd' },
        },
        {
          key: 'ebitda_margin_pct',
          label: 'EBITDA Margin %',
          unit: '%',
          sourceTable: 'v',
          expr: {
            kind: 'ratio_of_sums',
            numerator: 'ebitda_usd',
            denominator: 'total_revenue_usd',
          },
        },
        {
          key: 'debit_usd',
          label: 'Debit',
          unit: 'USD',
          sourceTable: 'v',
          expr: { kind: 'sum', column: 'debit_usd' },
        },
      ],
    };
    const prior: EngineChartSpec = {
      chartType: 'bar',
      measureKeys: ['ebitda_usd'],
      dimensionKey: 'business_unit',
      title: 'EBITDA by Business Unit',
    };
    const llm: LlmCaller = async () =>
      JSON.stringify({
        chartType: 'bar',
        measureKeys: ['ebitda_usd', 'debit_usd'],
        dimensionKey: 'business_unit',
        title: 'EBITDA and EBITDA Margin by Business Unit',
      });
    const result = await planEdit(
      'In the same chart, add EBITDA margin by business unit.',
      prior,
      marginModel,
      llm,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.measureKeys).toEqual([
      'ebitda_usd',
      'ebitda_margin_pct',
    ]);
  });

  it('does not plot a ratio denominator for an "as percentage of" edit', async () => {
    const sgaModel: SemanticModel = {
      ...model,
      measures: [
        {
          key: 'total_sga_usd',
          label: 'Total SG&A',
          unit: 'USD',
          sourceTable: 'v',
          expr: { kind: 'sum', column: 'total_sga_usd' },
        },
        {
          key: 'total_revenue_usd',
          label: 'Total Revenue',
          unit: 'USD',
          sourceTable: 'v',
          expr: { kind: 'sum', column: 'total_revenue_usd' },
        },
        {
          key: 'sga_pct_of_revenue',
          label: 'SG&A % Of Revenue',
          unit: '%',
          sourceTable: 'v',
          expr: {
            kind: 'ratio_of_sums',
            numerator: 'total_sga_usd',
            denominator: 'total_revenue_usd',
          },
        },
      ],
    };
    const prior: EngineChartSpec = {
      chartType: 'line',
      measureKeys: ['total_sga_usd'],
      timeGrain: 'month',
      title: 'Monthly SG&A Cost',
    };
    const llm: LlmCaller = async () =>
      JSON.stringify({
        ...prior,
        measureKeys: [
          'total_sga_usd',
          'total_revenue_usd',
          'sga_pct_of_revenue',
        ],
      });
    const result = await planEdit(
      'In the same chart, show SG&A as a percentage of revenue.',
      prior,
      sgaModel,
      llm,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.measureKeys).toEqual([
      'total_sga_usd',
      'sga_pct_of_revenue',
    ]);
  });

  it('expands stacked components and treats an added total as a label measure', async () => {
    const payrollModel: SemanticModel = {
      ...model,
      measures: [
        {
          key: 'basic_salary_usd',
          label: 'Basic Salary',
          unit: 'USD',
          sourceTable: 'v',
          expr: { kind: 'sum', column: 'basic_salary_usd' },
        },
        {
          key: 'overtime_usd',
          label: 'Overtime',
          unit: 'USD',
          sourceTable: 'v',
          expr: { kind: 'sum', column: 'overtime_usd' },
        },
        {
          key: 'total_payroll_usd',
          label: 'Total Payroll',
          unit: 'USD',
          sourceTable: 'v',
          expr: { kind: 'sum', column: 'total_payroll_usd' },
        },
        {
          key: 'average_payroll_cost_per_paid_hour',
          label: 'Average Payroll Cost Per Paid Hour',
          unit: 'USD',
          sourceTable: 'v',
          expr: { kind: 'mean', column: 'average_payroll_cost_per_paid_hour' },
        },
      ],
    };
    const createLlm: LlmCaller = async () =>
      JSON.stringify({
        chartType: 'stacked_bar',
        measureKeys: ['total_payroll_usd'],
        dimensionKey: 'business_unit',
        title: 'Payroll components',
      });
    const created = await planChart(
      'Create a stacked bar chart showing payroll components by business unit.',
      payrollModel,
      createLlm,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.spec.measureKeys).toEqual([
      'basic_salary_usd',
      'overtime_usd',
    ]);
    expect(created.spec.componentMode).toBe(true);

    const editLlm: LlmCaller = async () =>
      JSON.stringify({
        ...created.spec,
        measureKeys: [
          ...created.spec.measureKeys,
          'total_payroll_usd',
          'average_payroll_cost_per_paid_hour',
        ],
      });
    const edited = await planEdit(
      'In the same chart, add total payroll cost.',
      created.spec,
      payrollModel,
      editLlm,
    );
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    expect(edited.spec.measureKeys).toEqual([
      'basic_salary_usd',
      'overtime_usd',
      'total_payroll_usd',
    ]);
    expect(edited.spec.labelMeasureKey).toBe('total_payroll_usd');
  });

  it('REFUSES an invented dimension', () => {
    const r = parsePlannerResponse(
      JSON.stringify({
        chartType: 'bar',
        measureKeys: ['total_revenue_usd'],
        dimensionKey: 'country',
        title: 'x',
      }),
      model,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/unknown dimension/);
  });

  it('accepts a distinct second breakdown dimension', () => {
    const r = parsePlannerResponse(
      JSON.stringify({
        chartType: 'stacked_bar',
        measureKeys: ['total_revenue_usd'],
        dimensionKey: 'business_unit',
        breakdownKey: 'client_name',
        title: 'Revenue by business unit and client',
      }),
      model,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.spec.breakdownKey).toBe('client_name');
  });

  it('treats empty measureKeys as an honest refusal, surfacing the reason', () => {
    const r = parsePlannerResponse(
      JSON.stringify({
        chartType: 'table',
        measureKeys: [],
        title: 'No employee-level data exists',
      }),
      model,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/No employee-level data/);
  });

  it('rejects a time grain the dataset does not support', () => {
    const r = parsePlannerResponse(
      JSON.stringify({
        chartType: 'line',
        measureKeys: ['total_revenue_usd'],
        timeGrain: 'day',
        title: 'x',
      }),
      model,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/not available/);
  });

  it('handles non-JSON gibberish gracefully', () => {
    const r = parsePlannerResponse('I think you want revenue?', model);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/valid JSON/);
  });
});

describe('ChartPlanner.planChart (with a fake LLM)', () => {
  it('feeds the generated prompt to the LLM and validates its answer', async () => {
    let seenSystem = '';
    const fakeLlm = async (system: string, _user: string) => {
      seenSystem = system;
      return JSON.stringify({
        chartType: 'bar',
        measureKeys: ['total_revenue_usd'],
        dimensionKey: 'business_unit',
        title: 'Revenue by BU',
      });
    };
    const r = await planChart('revenue by business unit', model, fakeLlm);
    expect(r.ok).toBe(true);
    // The prompt must carry this client's real vocabulary.
    expect(seenSystem).toContain('total_revenue_usd');
    expect(seenSystem).toContain('business_unit');
  });

  it('fills an explicitly named entity dimension for a point chart', async () => {
    const employeeModel: SemanticModel = {
      ...model,
      dimensions: [
        ...model.dimensions,
        {
          key: 'employee_id',
          label: 'Employee ID',
          table: 'v',
          column: 'employee_id',
        },
      ],
    };
    const fakeLlm = async () =>
      JSON.stringify({
        chartType: 'scatter',
        measureKeys: ['total_revenue_usd', 'gross_margin_pct'],
        title: 'Employee performance',
      });
    const r = await planChart(
      'scatter employee revenue versus margin',
      employeeModel,
      fakeLlm,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.spec.dimensionKey).toBe('employee_id');
  });

  it('preserves an explicitly requested scorecard as a KPI visual', async () => {
    const fakeLlm = async () =>
      JSON.stringify({
        chartType: 'combo',
        measureKeys: ['total_revenue_usd', 'gross_margin_pct'],
        dimensionKey: 'client_name',
        title: 'Client scorecard',
      });
    const r = await planChart(
      'Create a client scorecard for revenue and margin',
      model,
      fakeLlm,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.spec.chartType).toBe('kpi');
  });

  it('uses revenue rather than a cancelling signed amount for biggest-client ranking', async () => {
    const fakeLlm = async () =>
      JSON.stringify({
        chartType: 'bar',
        measureKeys: ['gross_margin_pct'],
        dimensionKey: 'client_name',
        title: 'Biggest clients',
      });
    const r = await planChart('which are the biggest client', model, fakeLlm);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.spec.measureKeys).toEqual(['total_revenue_usd']);
      expect(r.spec.dimensionKey).toBe('client_name');
    }
  });
});

describe('ChartPlanner.planEdit (conversational refinement, fake LLM)', () => {
  const priorSpec = {
    chartType: 'line' as const,
    measureKeys: ['total_revenue_usd'],
    timeGrain: 'month' as const,
    title: 'Monthly Revenue',
  };

  it('passes the CURRENT spec + instruction to the LLM and validates the edited spec', async () => {
    let seenUser = '';
    const fakeLlm = async (_system: string, user: string) => {
      seenUser = user;
      // "add gross margin on another axis" → append the % measure.
      return JSON.stringify({
        chartType: 'line',
        measureKeys: ['total_revenue_usd', 'gross_margin_pct'],
        timeGrain: 'month',
        title: 'Revenue & Gross Margin',
      });
    };
    const r = await planEdit(
      'add gross margin on another axis',
      priorSpec,
      model,
      fakeLlm,
    );
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.spec.measureKeys).toEqual([
        'total_revenue_usd',
        'gross_margin_pct',
      ]);
    // The model must see the chart it's editing + the request.
    expect(seenUser).toContain('Monthly Revenue');
    expect(seenUser).toContain('add gross margin on another axis');
  });

  it('still REFUSES an edit that invents a measure', async () => {
    const fakeLlm = async () =>
      JSON.stringify({
        chartType: 'line',
        measureKeys: ['total_revenue_usd', 'ebitda'],
        title: 'x',
      });
    const r = await planEdit('add ebitda', priorSpec, model, fakeLlm);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/unknown measure/);
  });

  it('KEEPS the existing grouping when an edit adds a measure whose NAME matches a dimension', async () => {
    // Prior chart grouped by business_unit. "add the client revenue" contains
    // "client" (matches client_name) but does NOT ask to regroup — the chart must
    // stay grouped by business_unit (regression: Q2 "add employee headcount"
    // drifted department → employee).
    const prior = {
      chartType: 'bar' as const,
      measureKeys: ['total_revenue_usd'],
      dimensionKey: 'business_unit',
      title: 'Revenue by BU',
    };
    const fakeLlm = async () =>
      JSON.stringify({
        chartType: 'bar',
        measureKeys: ['total_revenue_usd', 'gross_margin_pct'],
        dimensionKey: 'client_name',
        title: 'x',
      });
    const r = await planEdit(
      'also add the client gross margin',
      prior,
      model,
      fakeLlm,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.spec.dimensionKey).toBe('business_unit');
  });

  it('DOES regroup when the edit explicitly names a new grouping ("break down by client")', async () => {
    const prior = {
      chartType: 'bar' as const,
      measureKeys: ['total_revenue_usd'],
      dimensionKey: 'business_unit',
      title: 'Revenue by BU',
    };
    const fakeLlm = async () =>
      JSON.stringify({
        chartType: 'bar',
        measureKeys: ['total_revenue_usd'],
        dimensionKey: 'client_name',
        title: 'x',
      });
    const r = await planEdit('break it down by client', prior, model, fakeLlm);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.spec.dimensionKey).toBe('client_name');
  });

  it('honors an explicit bubble-size edit even if the LLM leaves scatter type unchanged', async () => {
    const scatterPrior = {
      chartType: 'scatter' as const,
      measureKeys: ['total_revenue_usd', 'gross_margin_pct'],
      dimensionKey: 'client_name',
      title: 'Client performance',
    };
    const fakeLlm = async () =>
      JSON.stringify({
        ...scatterPrior,
        measureKeys: ['total_revenue_usd', 'gross_margin_pct'],
        chartType: 'scatter',
      });
    const r = await planEdit(
      'use margin as the bubble size',
      scatterPrior,
      model,
      fakeLlm,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.spec.chartType).toBe('bubble');
  });
});

describe('preferDistinctAxisMeasure (separate-axis guarantee)', () => {
  const axisModel = {
    ...model,
    measures: [
      {
        key: 'total_cost_usd',
        label: 'Total Cost',
        unit: 'USD',
        sourceTable: 'v',
        expr: { kind: 'sum' as const, column: 'total_cost_usd' },
      },
      {
        key: 'gross_margin_usd',
        label: 'Gross Margin',
        unit: 'USD',
        sourceTable: 'v',
        expr: { kind: 'sum' as const, column: 'gross_margin_usd' },
      },
      {
        key: 'gross_margin_pct',
        label: 'Gross Margin %',
        unit: '%',
        sourceTable: 'v',
        expr: {
          kind: 'ratio_of_sums' as const,
          numerator: 'gm',
          denominator: 'rev',
        },
      },
    ],
  };

  it('swaps a same-unit added measure for its different-unit sibling ($ → %)', () => {
    // LLM appended the $ variant; user explicitly wanted a second axis.
    const spec = {
      chartType: 'bar' as const,
      measureKeys: ['total_cost_usd', 'gross_margin_usd'],
      dimensionKey: 'business_unit',
      title: 'Cost & Gross Margin',
    };
    const out = preferDistinctAxisMeasure(spec, ['total_cost_usd'], axisModel);
    expect(out.measureKeys).toEqual(['total_cost_usd', 'gross_margin_pct']);
  });

  it('leaves an already-distinct-unit measure alone', () => {
    const spec = {
      chartType: 'bar' as const,
      measureKeys: ['total_cost_usd', 'gross_margin_pct'],
      dimensionKey: 'business_unit',
      title: 'x',
    };
    const out = preferDistinctAxisMeasure(spec, ['total_cost_usd'], axisModel);
    expect(out.measureKeys).toEqual(['total_cost_usd', 'gross_margin_pct']);
  });

  it('is a no-op when no different-unit sibling exists', () => {
    const spec = {
      chartType: 'bar' as const,
      measureKeys: ['total_cost_usd', 'gross_margin_usd'],
      dimensionKey: 'business_unit',
      title: 'x',
    };
    const noPct = {
      ...axisModel,
      measures: axisModel.measures.filter((m) => m.key !== 'gross_margin_pct'),
    };
    const out = preferDistinctAxisMeasure(spec, ['total_cost_usd'], noPct);
    expect(out.measureKeys).toEqual(['total_cost_usd', 'gross_margin_usd']);
  });
});
