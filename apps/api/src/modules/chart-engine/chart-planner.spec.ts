import {
  parsePlannerResponse,
  fieldMatchScore,
  planChart,
  planEdit,
  planExplicitPointChart,
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
  it('does not add an unrequested growth metric to its base KPI', () => {
    expect(
      fieldMatchScore(
        'What were net profit and net margin in 2025?',
        'net_profit_growth_pct',
        'Net Profit Growth %',
      ),
    ).toBe(0);
    expect(
      fieldMatchScore(
        'What was net profit growth percentage in 2025?',
        'net_profit_growth_pct',
        'Net Profit Growth %',
      ),
    ).toBeGreaterThanOrEqual(8);
  });

  it('deterministically plans an explicit multi-dimensional point chart', () => {
    const pointModel: SemanticModel = {
      ...model,
      measures: [
        ...model.measures,
        {
          key: 'total_payroll_usd',
          label: 'Total Payroll',
          unit: 'USD',
          sourceTable: 'v',
          expr: { kind: 'sum', column: 'total_payroll_usd' },
        },
      ],
    };
    expect(
      planExplicitPointChart(
        'Create a scatter chart showing revenue versus payroll cost by client and business unit.',
        pointModel,
      ),
    ).toEqual(
      expect.objectContaining({
        chartType: 'scatter',
        measureKeys: ['total_revenue_usd', 'total_payroll_usd'],
        dimensionKey: 'client_name',
        breakdownKey: 'business_unit',
      }),
    );
  });

  it('matches a one-word attendance metric when its Days suffix is generic', () => {
    const question =
      'Create a stacked column chart showing Present, Paid Leave, Sick Leave, and Unpaid Absent by month.';
    expect(
      fieldMatchScore(question, 'present_days', 'Present Days'),
    ).toBeGreaterThanOrEqual(8);
  });

  it('does not match a non-productive metric from a productive-hours request', () => {
    const question =
      'Create a bar chart showing productive hours by department.';
    expect(
      fieldMatchScore(question, 'productive_hours', 'Productive Hours'),
    ).toBeGreaterThanOrEqual(8);
    expect(
      fieldMatchScore(question, 'non_productive_hours', 'Non Productive Hours'),
    ).toBe(0);
  });

  it('does not select a net metric until net is explicitly requested', () => {
    expect(
      fieldMatchScore(
        'cash inflow and cash outflow by activity',
        'net_cash_flow_usd',
        'Net Cash Flow',
      ),
    ).toBe(0);
    expect(
      fieldMatchScore(
        'add net cash flow',
        'net_cash_flow_usd',
        'Net Cash Flow',
      ),
    ).toBeGreaterThanOrEqual(8);
  });

  it('does not select net activity cash flow from a plain net cash flow request', () => {
    expect(
      fieldMatchScore(
        'closing cash balance and net cash flow by month',
        'net_activity_cash_flow_usd',
        'Net Activity Cash Flow',
      ),
    ).toBe(0);
    expect(
      fieldMatchScore(
        'net activity cash flow by cash flow activity',
        'net_activity_cash_flow_usd',
        'Net Activity Cash Flow',
      ),
    ).toBeGreaterThanOrEqual(8);
  });

  it('strongly matches standard KPI acronyms and percentage wording', () => {
    expect(
      fieldMatchScore('SLA', 'sla_attainment_pct', 'SLA Attainment %'),
    ).toBeGreaterThanOrEqual(8);
    expect(
      fieldMatchScore('occupancy percentage', 'occupancy_pct', 'Occupancy %'),
    ).toBeGreaterThanOrEqual(8);
    expect(
      fieldMatchScore('average handle time', 'aht_minutes', 'AHT Minutes'),
    ).toBeGreaterThanOrEqual(8);
  });

  it('matches invoiced wording to the invoice amount catalog measure', () => {
    expect(
      fieldMatchScore(
        'monthly invoiced amount and collected amount',
        'invoice_amount_usd',
        'Invoice Amount',
      ),
    ).toBeGreaterThanOrEqual(8);
  });

  it('matches customer collections and cash inflow to AR/monthly finance wording', () => {
    expect(
      fieldMatchScore(
        'customer collections by month',
        'collected_amount_usd',
        'Collected Amount',
      ),
    ).toBeGreaterThanOrEqual(8);
    expect(
      fieldMatchScore(
        'customer cash inflow by month',
        'cash_received_usd',
        'Cash Received',
      ),
    ).toBeGreaterThanOrEqual(8);
  });

  it('does not select unrelated cash outflow components for a vendor outflow request', () => {
    const question = 'vendor payments and vendor cash outflow by month';
    expect(
      fieldMatchScore(question, 'paid_amount_usd', 'Paid Amount'),
    ).toBeGreaterThanOrEqual(8);
    expect(
      fieldMatchScore(
        question,
        'cash_outflow_vendor_payments_usd',
        'Cash Outflow Vendor Payments',
      ),
    ).toBeGreaterThanOrEqual(8);
    expect(
      fieldMatchScore(
        question,
        'cash_outflow_bank_charges_usd',
        'Cash Outflow Bank Charges',
      ),
    ).toBe(0);
    expect(
      fieldMatchScore(question, 'total_cash_outflow_usd', 'Total Cash Outflow'),
    ).toBe(0);
    expect(
      fieldMatchScore(
        question,
        'cash_outflow_income_taxes_paid_usd',
        'Cash Outflow Income Taxes Paid',
      ),
    ).toBe(0);
  });

  it('routes payroll cost/outflow wording away from balance snapshots', () => {
    const question = 'monthly payroll cost and payroll cash outflow';
    expect(
      fieldMatchScore(question, 'payroll_balance_usd', 'Payroll Balance'),
    ).toBe(0);
    expect(fieldMatchScore(question, 'cash_balance_usd', 'Cash Balance')).toBe(
      0,
    );
    expect(
      fieldMatchScore(question, 'payroll_cost_usd', 'Payroll Cost'),
    ).toBeGreaterThanOrEqual(8);
    expect(
      fieldMatchScore(
        question,
        'cash_outflow_payroll_paid_usd',
        'Cash Outflow Payroll Paid',
      ),
    ).toBeGreaterThanOrEqual(8);
    expect(
      fieldMatchScore(
        question,
        'general_ledger_payroll_cost_usd',
        'General Ledger Payroll Cost',
      ),
    ).toBe(0);
    expect(
      fieldMatchScore(
        'add payroll cost from the general ledger',
        'general_ledger_payroll_cost_usd',
        'General Ledger Payroll Cost',
      ),
    ).toBeGreaterThanOrEqual(8);
    expect(
      fieldMatchScore(
        'add payroll cost from the general ledger',
        'general_ledger_bankcharges_cost_usd',
        'General Ledger Bankcharges Cost',
      ),
    ).toBe(0);
    expect(
      fieldMatchScore(
        'add payroll cost from the general ledger',
        'general_ledger_hr_cost_usd',
        'General Ledger HR Cost',
      ),
    ).toBe(0);
  });

  it('does not add journal value to a debit and credit amount request', () => {
    const question = 'debit and credit amounts by journal type';
    expect(
      fieldMatchScore(question, 'debit_usd', 'Debit'),
    ).toBeGreaterThanOrEqual(8);
    expect(
      fieldMatchScore(question, 'credit_usd', 'Credit'),
    ).toBeGreaterThanOrEqual(8);
    expect(
      fieldMatchScore(question, 'journal_value_usd', 'Journal Value'),
    ).toBe(0);
  });

  it('does not match a days KPI for a payable balance request', () => {
    expect(
      fieldMatchScore(
        'add monthly payable outstanding balance',
        'days_payable_outstanding',
        'Days Payable Outstanding',
      ),
    ).toBe(0);
    expect(
      fieldMatchScore(
        'add average DPO by vendor',
        'days_payable_outstanding',
        'Days Payable Outstanding',
      ),
    ).toBeGreaterThanOrEqual(8);
  });

  it('resolves AP cash paid to the vendor cash-outflow measure', () => {
    const question =
      'Show AP invoice amount, paid amount, cash paid, and outstanding payables by month';
    expect(
      fieldMatchScore(
        question,
        'cash_outflow_vendor_payments_usd',
        'Cash Outflow Vendor Payments',
      ),
    ).toBeGreaterThanOrEqual(18);
  });

  it('resolves balance-sheet business phrases to discovered balance measures', () => {
    const question =
      'Show cash, accounts receivable, accounts payable, prepaid expenses, payroll payable, and taxes payable by month';
    const expected: Array<[string, string]> = [
      ['cash_balance_usd', 'Cash Balance'],
      ['receivables_balance_usd', 'Receivables Balance'],
      ['payables_balance_usd', 'Payables Balance'],
      ['prepaids_balance_usd', 'Prepaids Balance'],
      ['payroll_liability_balance_usd', 'Payroll Liability Balance'],
      ['tax_liability_balance_usd', 'Tax Liability Balance'],
    ];
    for (const [key, label] of expected) {
      expect(fieldMatchScore(question, key, label)).toBeGreaterThanOrEqual(18);
    }
  });

  it('does not select an unrelated average percentage from aggregation words alone', () => {
    const question =
      'Create a bar chart showing average SLA compliance percentage by client.';
    expect(
      fieldMatchScore(
        question,
        'average_revenue_growth_pct',
        'Average Revenue Growth %',
      ),
    ).toBeLessThan(8);
  });

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
      requestedChartType('Create a bar chart showing revenue by service line.'),
    ).toBe('bar');
    expect(
      requestedChartType(
        'Create a line chart showing revenue by service line.',
      ),
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

  it('treats clustered trial-balance movement by account type plus fiscal year as one category plus time', async () => {
    const trialBalanceModel: SemanticModel = {
      ...model,
      dimensions: [
        ...model.dimensions,
        {
          key: 'account_type',
          label: 'Account Type',
          table: 'v',
          column: 'account_type',
        },
        {
          key: 'account_sub_type',
          label: 'Account Sub Type',
          table: 'v',
          column: 'account_sub_type',
        },
      ],
      measures: [
        {
          key: 'opening_balance_usd',
          label: 'Opening Balance',
          unit: 'USD',
          sourceTable: 'v',
          expr: {
            kind: 'last_value',
            column: 'opening_balance_usd',
            orderBy: 'period_date',
          },
        },
        {
          key: 'debit_balance_usd',
          label: 'Debit Balance',
          unit: 'USD',
          sourceTable: 'v',
          expr: {
            kind: 'last_value',
            column: 'debit_balance_usd',
            orderBy: 'period_date',
          },
        },
        {
          key: 'credit_balance_usd',
          label: 'Credit Balance',
          unit: 'USD',
          sourceTable: 'v',
          expr: {
            kind: 'last_value',
            column: 'credit_balance_usd',
            orderBy: 'period_date',
          },
        },
        {
          key: 'closing_balance_usd',
          label: 'Closing Balance',
          unit: 'USD',
          sourceTable: 'v',
          expr: {
            kind: 'last_value',
            column: 'closing_balance_usd',
            orderBy: 'period_date',
          },
        },
        {
          key: 'debit_movement_usd',
          label: 'Debit Movement',
          unit: 'USD',
          sourceTable: 'v',
          expr: { kind: 'sum', column: 'debit_movement_usd' },
        },
        {
          key: 'credit_movement_usd',
          label: 'Credit Movement',
          unit: 'USD',
          sourceTable: 'v',
          expr: { kind: 'sum', column: 'credit_movement_usd' },
        },
      ],
    };
    const result = await planChart(
      'Create a clustered column chart showing opening balance, debit movement, credit movement, and closing balance by account type and fiscal year.',
      trialBalanceModel,
      async () =>
        JSON.stringify({
          chartType: 'bar',
          clustered: true,
          measureKeys: [
            'opening_balance_usd',
            'closing_balance_usd',
            'debit_movement_usd',
            'credit_movement_usd',
            'debit_balance_usd',
            'credit_balance_usd',
          ],
          dimensionKey: 'account_type',
          breakdownKey: 'account_sub_type',
          timeGrain: 'year',
          title:
            'Opening, Debit, Credit, and Closing Balance by Account Type and Fiscal Year',
        }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.chartType).toBe('bar');
    expect(result.spec.clustered).toBe(true);
    expect(result.spec.measureKeys).toEqual([
      'debit_movement_usd',
      'credit_movement_usd',
      'opening_balance_usd',
      'closing_balance_usd',
    ]);
    expect(result.spec.dimensionKey).toBe('account_type');
    expect(result.spec.timeGrain).toBe('year');
    expect(result.spec.breakdownKey).toBeUndefined();
  });

  it('highlights the account type with the largest closing balance change without adding a new plotted measure', async () => {
    const trialBalanceModel: SemanticModel = {
      ...model,
      dimensions: [
        ...model.dimensions,
        {
          key: 'account_type',
          label: 'Account Type',
          table: 'v',
          column: 'account_type',
        },
        {
          key: 'account_sub_type',
          label: 'Account Sub Type',
          table: 'v',
          column: 'account_sub_type',
        },
      ],
      measures: [
        {
          key: 'opening_balance_usd',
          label: 'Opening Balance',
          unit: 'USD',
          sourceTable: 'v',
          expr: {
            kind: 'last_value',
            column: 'opening_balance_usd',
            orderBy: 'period_date',
          },
        },
        {
          key: 'debit_balance_usd',
          label: 'Debit Balance',
          unit: 'USD',
          sourceTable: 'v',
          expr: {
            kind: 'last_value',
            column: 'debit_balance_usd',
            orderBy: 'period_date',
          },
        },
        {
          key: 'credit_balance_usd',
          label: 'Credit Balance',
          unit: 'USD',
          sourceTable: 'v',
          expr: {
            kind: 'last_value',
            column: 'credit_balance_usd',
            orderBy: 'period_date',
          },
        },
        {
          key: 'closing_balance_usd',
          label: 'Closing Balance',
          unit: 'USD',
          sourceTable: 'v',
          expr: {
            kind: 'last_value',
            column: 'closing_balance_usd',
            orderBy: 'period_date',
          },
        },
        {
          key: 'debit_movement_usd',
          label: 'Debit Movement',
          unit: 'USD',
          sourceTable: 'v',
          expr: { kind: 'sum', column: 'debit_movement_usd' },
        },
        {
          key: 'credit_movement_usd',
          label: 'Credit Movement',
          unit: 'USD',
          sourceTable: 'v',
          expr: { kind: 'sum', column: 'credit_movement_usd' },
        },
        {
          key: 'closing_balance_change_usd',
          label: 'Closing Balance Change',
          unit: 'USD',
          sourceTable: 'v',
          expr: { kind: 'sum', column: 'closing_balance_change_usd' },
        },
      ],
    };
    const prior: EngineChartSpec = {
      chartType: 'line',
      measureKeys: [
        'opening_balance_usd',
        'closing_balance_usd',
        'debit_movement_usd',
        'credit_movement_usd',
      ],
      dimensionKey: 'account_type',
      timeGrain: 'year',
      title:
        'Opening, Debit, Credit, and Closing Balance by Account Type and Fiscal Year',
    };
    const result = await planEdit(
      'In the same chart, highlight the account type with the largest closing balance change.',
      prior,
      trialBalanceModel,
      async () =>
        JSON.stringify({
          ...prior,
          measureKeys: [...prior.measureKeys, 'closing_balance_change_usd'],
          breakdownKey: 'account_sub_type',
        }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.measureKeys).toEqual(prior.measureKeys);
    expect(result.spec.breakdownKey).toBeUndefined();
    expect(result.spec.highlightTopN).toBe(1);
    expect(result.spec.highlightChangeFromMeasureKey).toBe(
      'opening_balance_usd',
    );
    expect(result.spec.highlightChangeToMeasureKey).toBe('closing_balance_usd');
  });

  it('selects the exact five executive dollar KPIs before adding real margin percentages', async () => {
    const executiveModel: SemanticModel = {
      ...model,
      measures: [
        ...model.measures,
        ...[
          'gross_profit_usd',
          'ebitda_usd',
          'operating_profit_usd',
          'net_profit_usd',
        ].map((key) => ({
          key,
          label: key
            .replace(/_usd$/, '')
            .replace(/_/g, ' ')
            .replace(/\b\w/g, (c) => c.toUpperCase()),
          unit: 'USD',
          sourceTable: 'v',
          expr: { kind: 'sum' as const, column: key },
        })),
        {
          key: 'operating_margin_pct',
          label: 'Operating Margin %',
          unit: '%',
          sourceTable: 'v',
          expr: {
            kind: 'ratio_of_sums',
            numerator: 'operating_profit_usd',
            denominator: 'total_revenue_usd',
          },
        },
        {
          key: 'net_margin_pct',
          label: 'Net Margin %',
          unit: '%',
          sourceTable: 'v',
          expr: {
            kind: 'ratio_of_sums',
            numerator: 'net_profit_usd',
            denominator: 'total_revenue_usd',
          },
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
      ],
    };
    const main = await planChart(
      'Create an executive KPI dashboard showing revenue, gross profit, EBITDA, operating profit, and net profit.',
      executiveModel,
      async () =>
        JSON.stringify({
          chartType: 'kpi',
          measureKeys: [
            'gross_profit_usd',
            'operating_profit_usd',
            'net_profit_usd',
            'ebitda_usd',
            'ebitda_margin_pct',
          ],
          title: 'Executive KPI Dashboard',
        }),
    );
    expect(main.ok).toBe(true);
    if (!main.ok) return;
    expect(main.spec.measureKeys).toEqual([
      'total_revenue_usd',
      'gross_profit_usd',
      'ebitda_usd',
      'operating_profit_usd',
      'net_profit_usd',
    ]);

    const follow = await planEdit(
      'In the same dashboard, add growth and margin percentages.',
      main.spec,
      executiveModel,
      async () =>
        JSON.stringify({
          ...main.spec,
          measureKeys: ['gross_profit_usd', 'gross_margin_pct'],
        }),
    );
    expect(follow.ok).toBe(true);
    if (!follow.ok) return;
    expect(follow.spec.measureKeys).toEqual([
      'total_revenue_usd',
      'gross_profit_usd',
      'ebitda_usd',
      'operating_profit_usd',
      'net_profit_usd',
      'gross_margin_pct',
      'ebitda_margin_pct',
      'operating_margin_pct',
      'net_margin_pct',
    ]);
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
    if (!edited.ok) throw new Error(edited.reason);
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

  it('plans a full client scorecard and preserves it for weak-performance highlighting', async () => {
    const scorecardModel: SemanticModel = {
      ...model,
      measures: [
        {
          key: 'total_revenue_usd',
          label: 'Total Revenue',
          unit: 'USD',
          sourceTable: 'v',
          expr: { kind: 'sum', column: 'total_revenue_usd' },
        },
        {
          key: 'average_revenue_growth_pct',
          label: 'Revenue Growth %',
          unit: '%',
          sourceTable: 'v',
          expr: {
            kind: 'last_value',
            column: 'average_revenue_growth_pct',
            orderBy: 'period_date',
          },
        },
        {
          key: 'gross_margin_pct',
          label: 'Gross Margin %',
          unit: '%',
          sourceTable: 'v',
          expr: {
            kind: 'ratio_of_sums',
            numerator: 'gross_profit_usd',
            denominator: 'total_revenue_usd',
          },
        },
        {
          key: 'sla_compliance_pct',
          label: 'SLA Compliance %',
          unit: '%',
          sourceTable: 'v',
          expr: { kind: 'mean', column: 'sla_compliance_pct' },
        },
        {
          key: 'csat_pct',
          label: 'CSAT %',
          unit: '%',
          sourceTable: 'v',
          expr: { kind: 'mean', column: 'csat_pct' },
        },
        {
          key: 'days_sales_outstanding',
          label: 'DSO',
          unit: 'days',
          sourceTable: 'v',
          expr: { kind: 'mean', column: 'days_sales_outstanding' },
        },
        {
          key: 'collection_efficiency_pct',
          label: 'Collection Efficiency %',
          unit: '%',
          sourceTable: 'v',
          expr: {
            kind: 'ratio_of_sums',
            numerator: 'collected_amount_usd',
            denominator: 'invoice_amount_usd',
          },
        },
      ],
    };
    const created = await planChart(
      'Create a client scorecard showing revenue, revenue growth, gross margin, SLA, CSAT, DSO, and collection efficiency.',
      scorecardModel,
      async () =>
        JSON.stringify({
          chartType: 'combo',
          measureKeys: ['total_revenue_usd', 'gross_margin_pct'],
          title: 'Client scorecard',
        }),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.spec.chartType).toBe('kpi');
    expect(created.spec.dimensionKey).toBe('client_name');
    expect(created.spec.measureKeys).toEqual([
      'total_revenue_usd',
      'average_revenue_growth_pct',
      'gross_margin_pct',
      'sla_compliance_pct',
      'csat_pct',
      'days_sales_outstanding',
      'collection_efficiency_pct',
    ]);

    const edited = await planEdit(
      'In the same scorecard, highlight high-revenue clients with weak performance.',
      created.spec,
      scorecardModel,
      async () =>
        JSON.stringify({
          ...created.spec,
          title: 'Client scorecard with weak performance highlights',
        }),
    );
    expect(edited.ok).toBe(true);
    if (edited.ok) {
      expect(edited.spec.measureKeys).toEqual(created.spec.measureKeys);
      expect(edited.spec.dimensionKey).toBe('client_name');
      expect(edited.spec.highlightWeakPerformance).toBe(true);
    }
  });

  it('keeps revenue with outstanding receivables by industry and adds margin/DSO/bad-debt percentage', async () => {
    const industryModel: SemanticModel = {
      ...model,
      dimensions: [
        ...model.dimensions,
        {
          key: 'industry',
          label: 'Industry',
          table: 'v',
          column: 'industry',
        },
      ],
      measures: [
        {
          key: 'total_revenue_usd',
          label: 'Total Revenue',
          unit: 'USD',
          sourceTable: 'v',
          expr: { kind: 'sum', column: 'total_revenue_usd' },
        },
        {
          key: 'outstanding_receivable_usd',
          label: 'Outstanding Receivables',
          unit: 'USD',
          sourceTable: 'v',
          expr: {
            kind: 'last_value',
            column: 'outstanding_receivable_usd',
            orderBy: 'period_date',
          },
        },
        {
          key: 'gross_margin_pct',
          label: 'Gross Margin %',
          unit: '%',
          sourceTable: 'v',
          expr: {
            kind: 'ratio_of_sums',
            numerator: 'gross_profit_usd',
            denominator: 'total_revenue_usd',
          },
        },
        {
          key: 'days_sales_outstanding',
          label: 'DSO',
          unit: 'days',
          sourceTable: 'v',
          expr: { kind: 'mean', column: 'days_sales_outstanding' },
        },
        {
          key: 'bad_debt_pct',
          label: 'Bad Debt %',
          unit: '%',
          sourceTable: 'v',
          expr: {
            kind: 'ratio_of_sums',
            numerator: 'write_off_amount_usd',
            denominator: 'invoice_amount_usd',
          },
        },
      ],
    };
    const created = await planChart(
      'Create a clustered bar chart showing revenue and outstanding receivables by industry.',
      industryModel,
      async () =>
        JSON.stringify({
          chartType: 'bar',
          measureKeys: ['outstanding_receivable_usd'],
          dimensionKey: 'industry',
          title: 'Outstanding Receivables by Industry',
        }),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.spec.clustered).toBe(true);
    expect(created.spec.dimensionKey).toBe('industry');
    expect(created.spec.measureKeys).toEqual([
      'total_revenue_usd',
      'outstanding_receivable_usd',
    ]);

    const edited = await planEdit(
      'In the same chart, add gross margin, DSO, and bad debt percentage.',
      created.spec,
      industryModel,
      async () =>
        JSON.stringify({
          ...created.spec,
          measureKeys: [
            ...created.spec.measureKeys,
            'gross_margin_pct',
            'days_sales_outstanding',
          ],
        }),
    );
    expect(edited.ok).toBe(true);
    if (edited.ok) {
      expect(edited.spec.dimensionKey).toBe('industry');
      expect(edited.spec.measureKeys).toEqual([
        'total_revenue_usd',
        'outstanding_receivable_usd',
        'gross_margin_pct',
        'days_sales_outstanding',
        'bad_debt_pct',
      ]);
    }
  });

  it('plans a delivery-center scorecard and preserves it for top/bottom highlighting', async () => {
    const deliveryModel: SemanticModel = {
      ...model,
      dimensions: [
        ...model.dimensions,
        {
          key: 'delivery_center',
          label: 'Delivery Center',
          table: 'v',
          column: 'delivery_center',
        },
      ],
      measures: [
        {
          key: 'total_revenue_usd',
          label: 'Total Revenue',
          unit: 'USD',
          sourceTable: 'v',
          expr: { kind: 'sum', column: 'total_revenue_usd' },
        },
        {
          key: 'total_payroll_usd',
          label: 'Payroll Cost',
          unit: 'USD',
          sourceTable: 'v',
          expr: { kind: 'sum', column: 'total_payroll_usd' },
        },
        {
          key: 'employee_headcount',
          label: 'Headcount',
          unit: 'count',
          sourceTable: 'v',
          expr: {
            kind: 'last_value',
            column: 'employee_headcount',
            orderBy: 'period_date',
          },
        },
        {
          key: 'utilization_pct',
          label: 'Utilization %',
          unit: '%',
          sourceTable: 'v',
          expr: { kind: 'mean', column: 'utilization_pct' },
        },
        {
          key: 'sla_compliance_pct',
          label: 'SLA Compliance %',
          unit: '%',
          sourceTable: 'v',
          expr: { kind: 'mean', column: 'sla_compliance_pct' },
        },
        {
          key: 'csat_pct',
          label: 'CSAT %',
          unit: '%',
          sourceTable: 'v',
          expr: { kind: 'mean', column: 'csat_pct' },
        },
      ],
    };
    const created = await planChart(
      'Create a scorecard showing revenue, payroll cost, headcount, utilization, SLA, and CSAT by delivery center.',
      deliveryModel,
      async () =>
        JSON.stringify({
          chartType: 'bar',
          measureKeys: ['total_revenue_usd'],
          title: 'Delivery Center Scorecard',
        }),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.spec.chartType).toBe('kpi');
    expect(created.spec.dimensionKey).toBe('delivery_center');
    expect(created.spec.measureKeys).toEqual([
      'total_revenue_usd',
      'total_payroll_usd',
      'employee_headcount',
      'utilization_pct',
      'sla_compliance_pct',
      'csat_pct',
    ]);

    const edited = await planEdit(
      'In the same scorecard, highlight the top and bottom delivery centers.',
      created.spec,
      deliveryModel,
      async () => JSON.stringify(created.spec),
    );
    expect(edited.ok).toBe(true);
    if (edited.ok) {
      expect(edited.spec.measureKeys).toEqual(created.spec.measureKeys);
      expect(edited.spec.dimensionKey).toBe('delivery_center');
      expect(edited.spec.highlightExtremes).toBe('both');
    }
  });

  it('uses per-productive-hour measures as scatter axes and raw productive hours only as bubble size', async () => {
    const deliveryModel: SemanticModel = {
      ...model,
      dimensions: [
        ...model.dimensions,
        {
          key: 'delivery_center',
          label: 'Delivery Center',
          table: 'v',
          column: 'delivery_center',
        },
      ],
      measures: [
        {
          key: 'total_revenue_usd',
          label: 'Total Revenue',
          unit: 'USD',
          sourceTable: 'v',
          expr: { kind: 'sum', column: 'total_revenue_usd' },
        },
        {
          key: 'average_revenue_per_productive_hour',
          label: 'Revenue Per Productive Hour',
          unit: 'USD',
          sourceTable: 'v',
          expr: { kind: 'mean', column: 'average_revenue_per_productive_hour' },
        },
        {
          key: 'average_cost_per_productive_hour',
          label: 'Cost Per Productive Hour',
          unit: 'USD',
          sourceTable: 'v',
          expr: { kind: 'mean', column: 'average_cost_per_productive_hour' },
        },
        {
          key: 'productive_hours',
          label: 'Productive Hours',
          unit: 'hours',
          sourceTable: 'v',
          expr: { kind: 'sum', column: 'productive_hours' },
        },
      ],
    };
    const created = await planChart(
      'Create a scatter chart showing revenue per productive hour versus cost per productive hour by delivery center.',
      deliveryModel,
      async () =>
        JSON.stringify({
          chartType: 'scatter',
          measureKeys: ['productive_hours', 'total_revenue_usd'],
          dimensionKey: 'delivery_center',
          title: 'Revenue vs Cost by Delivery Center',
        }),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.spec.chartType).toBe('scatter');
    expect(created.spec.dimensionKey).toBe('delivery_center');
    expect(created.spec.measureKeys).toEqual([
      'average_revenue_per_productive_hour',
      'average_cost_per_productive_hour',
    ]);

    const edited = await planEdit(
      'In the same chart, use productive hours as the bubble size.',
      created.spec,
      deliveryModel,
      async () => JSON.stringify(created.spec),
    );
    expect(edited.ok).toBe(true);
    if (edited.ok) {
      expect(edited.spec.chartType).toBe('bubble');
      expect(edited.spec.measureKeys).toEqual([
        'average_revenue_per_productive_hour',
        'average_cost_per_productive_hour',
        'productive_hours',
      ]);
    }
  });

  it('plans a complete service-line dashboard and appends quality metrics', async () => {
    const serviceModel: SemanticModel = {
      ...model,
      dimensions: [
        ...model.dimensions,
        {
          key: 'service_line',
          label: 'Service Line',
          table: 'v',
          column: 'service_line',
        },
      ],
      measures: [
        {
          key: 'total_revenue_usd',
          label: 'Total Revenue',
          unit: 'USD',
          sourceTable: 'v',
          expr: { kind: 'sum', column: 'total_revenue_usd' },
        },
        {
          key: 'gross_margin_pct',
          label: 'Gross Margin %',
          unit: '%',
          sourceTable: 'v',
          expr: {
            kind: 'ratio_of_sums',
            numerator: 'gross_profit_usd',
            denominator: 'total_revenue_usd',
          },
        },
        {
          key: 'billable_hours',
          label: 'Billable Hours',
          unit: 'hours',
          sourceTable: 'v',
          expr: { kind: 'sum', column: 'billable_hours' },
        },
        {
          key: 'average_billing_rate',
          label: 'Average Billing Rate',
          unit: 'USD',
          sourceTable: 'v',
          expr: { kind: 'mean', column: 'average_billing_rate' },
        },
        {
          key: 'calls_handled',
          label: 'Calls Handled',
          unit: 'count',
          sourceTable: 'v',
          expr: { kind: 'sum', column: 'calls_handled' },
        },
        {
          key: 'tickets_resolved',
          label: 'Tickets Resolved',
          unit: 'count',
          sourceTable: 'v',
          expr: { kind: 'sum', column: 'tickets_resolved' },
        },
        {
          key: 'aht_minutes',
          label: 'Average Handling Time',
          unit: 'minutes',
          sourceTable: 'v',
          expr: { kind: 'mean', column: 'aht_minutes' },
        },
        {
          key: 'sla_compliance_pct',
          label: 'SLA Compliance %',
          unit: '%',
          sourceTable: 'v',
          expr: { kind: 'mean', column: 'sla_compliance_pct' },
        },
        {
          key: 'qa_score_pct',
          label: 'QA Score %',
          unit: '%',
          sourceTable: 'v',
          expr: { kind: 'mean', column: 'qa_score_pct' },
        },
        {
          key: 'csat_pct',
          label: 'CSAT %',
          unit: '%',
          sourceTable: 'v',
          expr: { kind: 'mean', column: 'csat_pct' },
        },
        {
          key: 'nps',
          label: 'NPS',
          unit: 'score',
          sourceTable: 'v',
          expr: { kind: 'mean', column: 'nps' },
        },
      ],
    };
    const created = await planChart(
      'Create a service line dashboard showing revenue, gross margin, billable hours, billing rate, calls, tickets, and average handling time.',
      serviceModel,
      async () =>
        JSON.stringify({
          chartType: 'kpi',
          measureKeys: ['total_revenue_usd', 'gross_margin_pct'],
          title: 'Service Line Dashboard',
        }),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.spec.chartType).toBe('kpi');
    expect(created.spec.dimensionKey).toBe('service_line');
    expect(created.spec.measureKeys).toEqual([
      'total_revenue_usd',
      'gross_margin_pct',
      'billable_hours',
      'average_billing_rate',
      'calls_handled',
      'tickets_resolved',
      'aht_minutes',
    ]);

    const edited = await planEdit(
      'In the same dashboard, add SLA, QA score, CSAT, and NPS.',
      created.spec,
      serviceModel,
      async () => JSON.stringify(created.spec),
    );
    expect(edited.ok).toBe(true);
    if (edited.ok) {
      expect(edited.spec.measureKeys).toEqual([
        'total_revenue_usd',
        'gross_margin_pct',
        'billable_hours',
        'average_billing_rate',
        'calls_handled',
        'tickets_resolved',
        'aht_minutes',
        'sla_compliance_pct',
        'qa_score_pct',
        'csat_pct',
        'nps',
      ]);
      expect(edited.spec.dimensionKey).toBe('service_line');
    }
  });

  it('compares revenue/gross profit by contract type and appends operations metrics', async () => {
    const contractModel: SemanticModel = {
      ...model,
      dimensions: [
        ...model.dimensions,
        {
          key: 'contract_type',
          label: 'Contract Type',
          table: 'v',
          column: 'contract_type',
        },
      ],
      measures: [
        {
          key: 'total_revenue_usd',
          label: 'Total Revenue',
          unit: 'USD',
          sourceTable: 'v',
          expr: { kind: 'sum', column: 'total_revenue_usd' },
        },
        {
          key: 'gross_profit_usd',
          label: 'Gross Profit',
          unit: 'USD',
          sourceTable: 'v',
          expr: { kind: 'sum', column: 'gross_profit_usd' },
        },
        {
          key: 'billable_hours',
          label: 'Billable Hours',
          unit: 'hours',
          sourceTable: 'v',
          expr: { kind: 'sum', column: 'billable_hours' },
        },
        {
          key: 'average_billing_rate',
          label: 'Average Billing Rate',
          unit: 'USD',
          sourceTable: 'v',
          expr: { kind: 'mean', column: 'average_billing_rate' },
        },
        {
          key: 'utilization_pct',
          label: 'Utilization %',
          unit: '%',
          sourceTable: 'v',
          expr: { kind: 'mean', column: 'utilization_pct' },
        },
        {
          key: 'sla_compliance_pct',
          label: 'SLA Compliance %',
          unit: '%',
          sourceTable: 'v',
          expr: { kind: 'mean', column: 'sla_compliance_pct' },
        },
        {
          key: 'csat_pct',
          label: 'CSAT %',
          unit: '%',
          sourceTable: 'v',
          expr: { kind: 'mean', column: 'csat_pct' },
        },
      ],
    };
    const created = await planChart(
      'Create a clustered bar chart comparing revenue and gross profit by contract type.',
      contractModel,
      async () =>
        JSON.stringify({
          chartType: 'bar',
          measureKeys: ['gross_profit_usd'],
          dimensionKey: 'contract_type',
          title: 'Gross Profit by Contract Type',
        }),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.spec.clustered).toBe(true);
    expect(created.spec.dimensionKey).toBe('contract_type');
    expect(created.spec.measureKeys).toEqual([
      'total_revenue_usd',
      'gross_profit_usd',
    ]);

    const edited = await planEdit(
      'In the same chart, add billable hours, billing rate, utilization, SLA, and CSAT.',
      created.spec,
      contractModel,
      async () => JSON.stringify(created.spec),
    );
    expect(edited.ok).toBe(true);
    if (edited.ok) {
      expect(edited.spec.measureKeys).toEqual([
        'total_revenue_usd',
        'gross_profit_usd',
        'billable_hours',
        'average_billing_rate',
        'utilization_pct',
        'sla_compliance_pct',
        'csat_pct',
      ]);
      expect(edited.spec.dimensionKey).toBe('contract_type');
    }
  });

  it('plans a previous-year revenue-category waterfall and preserves cumulative follow-up', async () => {
    const revenueCategoryModel: SemanticModel = {
      ...model,
      dimensions: [
        ...model.dimensions,
        {
          key: 'revenue_category',
          label: 'Revenue Category',
          table: 'v',
          column: 'revenue_category',
        },
      ],
      measures: [
        {
          key: 'total_revenue_usd',
          label: 'Total Revenue',
          unit: 'USD',
          sourceTable: 'v',
          expr: { kind: 'sum', column: 'total_revenue_usd' },
        },
      ],
    };
    const created = await planChart(
      "Generate a waterfall chart showing the change from last year's revenue to this year's revenue by revenue category.",
      revenueCategoryModel,
      async () =>
        JSON.stringify({
          chartType: 'bar',
          measureKeys: ['total_revenue_usd'],
          dimensionKey: 'revenue_category',
          title: 'Revenue by Category',
        }),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.spec.chartType).toBe('waterfall');
    expect(created.spec.measureKeys).toEqual(['total_revenue_usd']);
    expect(created.spec.dimensionKey).toBe('revenue_category');
    expect(created.spec.comparison).toBe('previous_year');

    const edited = await planEdit(
      'In the same chart, show cumulative revenue change.',
      created.spec,
      revenueCategoryModel,
      async () => JSON.stringify(created.spec),
    );
    expect(edited.ok).toBe(true);
    if (edited.ok) {
      expect(edited.spec.measureKeys).toEqual(['total_revenue_usd']);
      expect(edited.spec.dimensionKey).toBe('revenue_category');
      expect(edited.spec.comparison).toBe('previous_year');
      expect(edited.spec.showCumulative).toBe(true);
    }
  });

  it('uses cost percent-of-revenue for stacked area and appends monthly EBITDA margin', async () => {
    const costModel: SemanticModel = {
      ...model,
      dimensions: [
        ...model.dimensions,
        {
          key: 'cost_family',
          label: 'Cost Family',
          table: 'v',
          column: 'cost_family',
          sampleValues: [
            'Labor',
            'People',
            'Technology',
            'Facility',
            'Third-party',
            'SG&A',
          ],
        },
      ],
      measures: [
        {
          key: 'total_cost_usd',
          label: 'Total Cost',
          unit: 'USD',
          sourceTable: 'v',
          expr: { kind: 'sum', column: 'total_cost_usd' },
        },
        {
          key: 'cost_pct_of_revenue',
          label: 'Cost % of Revenue',
          unit: '%',
          sourceTable: 'v',
          expr: {
            kind: 'ratio_of_sums',
            numerator: 'total_cost_usd',
            denominator: 'total_revenue_usd',
          },
        },
        {
          key: 'total_sga_usd',
          label: 'SG&A Cost',
          unit: 'USD',
          sourceTable: 'v',
          expr: { kind: 'sum', column: 'total_sga_usd' },
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
      ],
    };
    const created = await planChart(
      'Create a stacked area chart showing labor, people, technology, facility, third-party, and SG&A costs as a percentage of revenue.',
      costModel,
      async () =>
        JSON.stringify({
          chartType: 'stacked_area',
          measureKeys: ['total_cost_usd', 'total_sga_usd'],
          dimensionKey: 'cost_family',
          title: 'Costs by Family',
        }),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.spec.chartType).toBe('stacked_area');
    expect(created.spec.timeGrain).toBe('month');
    expect(created.spec.dimensionKey).toBe('cost_family');
    expect(created.spec.measureKeys).toEqual(['cost_pct_of_revenue']);

    const edited = await planEdit(
      'In the same chart, add the monthly EBITDA margin percentage.',
      created.spec,
      costModel,
      async () => JSON.stringify(created.spec),
    );
    expect(edited.ok).toBe(true);
    if (edited.ok) {
      expect(edited.spec.timeGrain).toBe('month');
      expect(edited.spec.measureKeys).toEqual([
        'cost_pct_of_revenue',
        'ebitda_margin_pct',
      ]);
    }
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

  it('adds a true percentage-of-revenue ratio instead of normalizing raw dollars', async () => {
    const plModel: SemanticModel = {
      ...model,
      measures: [
        ...model.measures,
        {
          key: 'pl_amount_usd',
          label: 'P&L Amount',
          unit: 'USD',
          sourceTable: 'v',
          expr: { kind: 'sum', column: 'pl_amount_usd' },
        },
        {
          key: 'pl_amount_pct_of_revenue',
          label: 'P&L Amount % of Revenue',
          unit: '%',
          sourceTable: 'v',
          expr: {
            kind: 'ratio_of_sums',
            numerator: 'pl_amount_usd',
            denominator: 'total_revenue_usd',
          },
        },
      ],
    };
    const prior = {
      chartType: 'bar' as const,
      measureKeys: ['pl_amount_usd'],
      dimensionKey: 'business_unit',
      normalize: true,
      title: 'P&L Amount by Account Group',
    };
    const fakeLlm = async () => JSON.stringify(prior);
    const r = await planEdit(
      "show each account group's percentage of revenue",
      prior,
      plModel,
      fakeLlm,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.spec.normalize).toBeUndefined();
      expect(r.spec.measureKeys).toEqual([
        'pl_amount_usd',
        'pl_amount_pct_of_revenue',
      ]);
    }
  });

  it('keeps all donut slices when a named aging bucket is highlighted', async () => {
    const prior = {
      chartType: 'donut' as const,
      measureKeys: ['total_revenue_usd'],
      dimensionKey: 'client_name',
      title: 'Receivables by aging bucket',
    };
    const fakeLlm = async () =>
      JSON.stringify({
        ...prior,
        topN: 1,
        highlightNames: ['90+'],
      });
    const r = await planEdit(
      'In the same chart, highlight the 90+ days bucket.',
      prior,
      model,
      fakeLlm,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.spec.topN).toBeUndefined();
      expect(r.spec.highlightNames).toEqual(['90+']);
    }
  });

  it('changes the grouping for an explicit drill-down edit', async () => {
    const prior = {
      chartType: 'treemap' as const,
      measureKeys: ['total_revenue_usd'],
      dimensionKey: 'business_unit',
      title: 'Revenue by Business Unit',
    };
    const fakeLlm = async () => JSON.stringify(prior);
    const r = await planEdit(
      'In the same visual, drill down to client.',
      prior,
      model,
      fakeLlm,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.spec.dimensionKey).toBe('client_name');
      expect(r.spec.breakdownKey).toBeUndefined();
      expect(r.spec.title).toBe('Revenue by Client');
    }
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
    const pointModel: SemanticModel = {
      ...model,
      measures: [
        ...model.measures,
        {
          key: 'billable_hours',
          label: 'Billable Hours',
          unit: 'hours',
          sourceTable: 'v',
          expr: { kind: 'sum', column: 'billable_hours' },
        },
      ],
    };
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
      'use billable hours as the bubble size',
      scatterPrior,
      pointModel,
      fakeLlm,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.spec.chartType).toBe('bubble');
      expect(r.spec.measureKeys).toEqual([
        'total_revenue_usd',
        'gross_margin_pct',
        'billable_hours',
      ]);
    }
  });

  it('keeps both axes for a revenue versus gross-margin scatter', async () => {
    const r = await planChart(
      'Create a scatter chart showing client revenue versus gross margin percentage.',
      model,
      async () =>
        JSON.stringify({
          chartType: 'scatter',
          measureKeys: ['gross_margin_pct'],
          dimensionKey: 'client_name',
          title: 'Client Revenue vs Gross Margin %',
        }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.spec.chartType).toBe('scatter');
      expect(r.spec.measureKeys).toEqual([
        'total_revenue_usd',
        'gross_margin_pct',
      ]);
      expect(r.spec.dimensionKey).toBe('client_name');
    }
  });

  it('keeps plain payroll cost separate from per-hour average payroll cost', async () => {
    const workforceModel: SemanticModel = {
      ...model,
      dimensions: [
        ...model.dimensions,
        {
          key: 'department',
          label: 'Department',
          table: 'v',
          column: 'department',
        },
      ],
      measures: [
        {
          key: 'total_revenue_usd',
          label: 'Revenue',
          unit: 'USD',
          sourceTable: 'v',
          expr: { kind: 'sum', column: 'total_revenue_usd' },
        },
        {
          key: 'total_payroll_usd',
          label: 'Payroll Cost',
          unit: 'USD',
          sourceTable: 'v',
          expr: { kind: 'sum', column: 'total_payroll_usd' },
        },
        {
          key: 'productive_hours',
          label: 'Productive Hours',
          unit: 'hours',
          sourceTable: 'v',
          expr: { kind: 'sum', column: 'productive_hours' },
        },
        {
          key: 'average_payroll_cost_per_paid_hour',
          label: 'Average Payroll Cost Per Paid Hour',
          unit: 'USD',
          sourceTable: 'v',
          expr: { kind: 'mean', column: 'average_payroll_cost_per_paid_hour' },
        },
        {
          key: 'employee_headcount',
          label: 'Employee Headcount',
          unit: 'count',
          sourceTable: 'v',
          expr: {
            kind: 'last_value',
            column: 'employee_headcount',
            orderBy: 'period_date',
          },
        },
        {
          key: 'productive_hours_percentage',
          label: 'Productive Hours Percentage',
          unit: '%',
          sourceTable: 'v',
          expr: {
            kind: 'ratio_of_sums',
            numerator: 'productive_hours',
            denominator: 'paid_hours',
          },
        },
      ],
    };
    const created = await planChart(
      'Create a combo chart showing revenue, payroll cost, and productive hours by department.',
      workforceModel,
      async () =>
        JSON.stringify({
          chartType: 'combo',
          measureKeys: [
            'productive_hours',
            'total_payroll_usd',
            'average_payroll_cost_per_paid_hour',
          ],
          dimensionKey: 'department',
          title: 'Payroll Cost and Productive Hours by Department',
        }),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.spec.measureKeys).toEqual([
      'total_revenue_usd',
      'total_payroll_usd',
      'productive_hours',
    ]);
    expect(created.spec.measureKeys).not.toContain(
      'average_payroll_cost_per_paid_hour',
    );

    const edited = await planEdit(
      'In the same chart, add employee headcount and productive hours percentage.',
      created.spec,
      workforceModel,
      async () =>
        JSON.stringify({
          ...created.spec,
          measureKeys: [
            ...created.spec.measureKeys,
            'average_payroll_cost_per_paid_hour',
            'employee_headcount',
          ],
        }),
    );
    expect(edited.ok).toBe(true);
    if (edited.ok) {
      expect(edited.spec.measureKeys).toEqual([
        'total_revenue_usd',
        'total_payroll_usd',
        'productive_hours',
        'employee_headcount',
        'productive_hours_percentage',
      ]);
      expect(edited.spec.measureKeys).not.toContain(
        'average_payroll_cost_per_paid_hour',
      );
    }
  });

  it('keeps all five monthly profit measures and adds prior-year values plus variance percentages', async () => {
    const profitKeys = [
      'total_revenue_usd',
      'gross_profit_usd',
      'ebitda_usd',
      'operating_profit_usd',
      'net_profit_usd',
    ];
    const profitModel: SemanticModel = {
      ...model,
      measures: profitKeys.map((key) => ({
        key,
        label: key.replace(/_usd$/, '').replace(/_/g, ' '),
        unit: 'USD',
        sourceTable: 'v',
        expr: { kind: 'sum' as const, column: key },
      })),
    };
    const created = await planChart(
      'Create a line chart showing monthly revenue, gross profit, EBITDA, operating profit, and net profit.',
      profitModel,
      async () =>
        JSON.stringify({
          chartType: 'line',
          measureKeys: ['total_revenue_usd'],
          timeGrain: 'month',
          title: 'Monthly Profitability',
        }),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.spec.measureKeys).toEqual(profitKeys);
    expect(created.spec.timeGrain).toBe('month');

    const edited = await planEdit(
      'In the same chart, add previous-year values and variance percentages.',
      created.spec,
      profitModel,
      async () => JSON.stringify(created.spec),
    );
    if (!edited.ok) throw new Error(edited.reason);
    expect(edited.ok).toBe(true);
    if (edited.ok) {
      expect(edited.spec.measureKeys).toEqual(profitKeys);
      expect(edited.spec.comparison).toBe('previous_year');
      expect(edited.spec.showVariancePct).toBe(true);
      expect(edited.spec.timeGrain).toBe('month');
    }
  });

  it('turns the Q57 ratio scorecard into quarterly ratio trends without changing units', async () => {
    const ratioKeys = [
      'average_debt_to_equity_ratio',
      'average_return_on_assets_pct',
      'average_return_on_equity_pct',
      'average_asset_turnover_ratio',
      'average_debt_ratio_pct',
      'average_equity_ratio_pct',
    ];
    const ratioModel: SemanticModel = {
      ...model,
      measures: ratioKeys.map((key) => ({
        key,
        label: key.replace(/^average_/, '').replace(/_/g, ' '),
        unit: key.endsWith('_pct') ? '%' : 'ratio',
        sourceTable: 'v',
        expr: { kind: 'mean' as const, column: key },
      })),
    };
    const prior = {
      chartType: 'kpi' as const,
      measureKeys: ratioKeys,
      title: 'Balance Sheet Ratios',
    };
    const edited = await planEdit(
      'In the same dashboard, show the quarterly trend for each ratio.',
      prior,
      ratioModel,
      async () => JSON.stringify(prior),
    );
    expect(edited.ok).toBe(true);
    if (edited.ok) {
      expect(edited.spec.chartType).toBe('line');
      expect(edited.spec.timeGrain).toBe('quarter');
      expect(edited.spec.measureKeys).toEqual(ratioKeys);
    }
  });

  it('expands Q64/Q65 aging balances into current and overdue measures', async () => {
    const agingModel: SemanticModel = {
      ...model,
      measures: [
        {
          key: 'outstanding_receivable_usd',
          label: 'Outstanding Receivable',
          unit: 'USD',
          sourceTable: 'v',
          expr: { kind: 'sum', column: 'outstanding_receivable_usd' },
        },
        {
          key: 'average_days_sales_outstanding',
          label: 'Average Days Sales Outstanding',
          unit: 'days',
          sourceTable: 'v',
          expr: { kind: 'mean', column: 'average_days_sales_outstanding' },
        },
        {
          key: 'current_receivable_usd',
          label: 'Current Receivable',
          unit: 'USD',
          sourceTable: 'v',
          expr: {
            kind: 'last_value',
            column: 'current_receivable_usd',
            orderBy: 'period_date',
          },
        },
        {
          key: 'overdue_receivable_usd',
          label: 'Overdue Receivable',
          unit: 'USD',
          sourceTable: 'v',
          expr: { kind: 'sum', column: 'overdue_receivable_usd' },
        },
      ],
    };
    const prior = {
      chartType: 'kpi' as const,
      measureKeys: ['outstanding_receivable_usd'],
      timeGrain: 'month' as const,
      title: 'Receivables dashboard',
    };
    const edited = await planEdit(
      'In the same dashboard, add DSO and aging balances.',
      prior,
      agingModel,
      async () => JSON.stringify(prior),
    );
    expect(edited.ok).toBe(true);
    if (edited.ok) {
      expect(edited.spec.measureKeys).toEqual(
        expect.arrayContaining([
          'average_days_sales_outstanding',
          'current_receivable_usd',
          'overdue_receivable_usd',
        ]),
      );
    }
  });

  it('expands AP aging balances into current and overdue payable measures', async () => {
    const payableModel: SemanticModel = {
      ...model,
      measures: [
        {
          key: 'invoice_amount_usd',
          label: 'Invoice Amount',
          unit: 'USD',
          sourceTable: 'v',
          expr: { kind: 'sum', column: 'invoice_amount_usd' },
        },
        {
          key: 'paid_amount_usd',
          label: 'Paid Amount',
          unit: 'USD',
          sourceTable: 'v',
          expr: { kind: 'sum', column: 'paid_amount_usd' },
        },
        {
          key: 'cash_outflow_vendor_payments_usd',
          label: 'Cash Outflow Vendor Payments',
          unit: 'USD',
          sourceTable: 'v',
          expr: { kind: 'sum', column: 'cash_outflow_vendor_payments_usd' },
        },
        {
          key: 'outstanding_payable_usd',
          label: 'Outstanding Payable',
          unit: 'USD',
          sourceTable: 'v',
          expr: {
            kind: 'last_value',
            column: 'outstanding_payable_usd',
            orderBy: 'period_date',
          },
        },
        {
          key: 'average_days_payable_outstanding',
          label: 'Average Days Payable Outstanding',
          unit: 'days',
          sourceTable: 'v',
          expr: { kind: 'mean', column: 'average_days_payable_outstanding' },
        },
        {
          key: 'current_payable_usd',
          label: 'Current Payable',
          unit: 'USD',
          sourceTable: 'v',
          expr: {
            kind: 'last_value',
            column: 'current_payable_usd',
            orderBy: 'period_date',
          },
        },
        {
          key: 'overdue_payable_usd',
          label: 'Overdue Payable',
          unit: 'USD',
          sourceTable: 'v',
          expr: { kind: 'sum', column: 'overdue_payable_usd' },
        },
      ],
    };
    const prior = {
      chartType: 'kpi' as const,
      measureKeys: [
        'invoice_amount_usd',
        'paid_amount_usd',
        'cash_outflow_vendor_payments_usd',
        'outstanding_payable_usd',
      ],
      timeGrain: 'month' as const,
      title: 'AP dashboard',
    };
    const edited = await planEdit(
      'In the same dashboard, add DPO and aging balances.',
      prior,
      payableModel,
      async () => JSON.stringify(prior),
    );
    expect(edited.ok).toBe(true);
    if (edited.ok) {
      expect(edited.spec.measureKeys).toEqual(
        expect.arrayContaining([
          'average_days_payable_outstanding',
          'current_payable_usd',
          'overdue_payable_usd',
        ]),
      );
    }
  });

  it('handles Q61/Q68/Q72 data-driven highlighting without entity-name hardcoding', async () => {
    const highlightModel: SemanticModel = {
      ...model,
      dimensions: [
        ...model.dimensions,
        {
          key: 'delivery_center',
          label: 'Delivery Center',
          table: 'v',
          column: 'delivery_center',
        },
      ],
      measures: [
        ...model.measures,
        {
          key: 'invoice_amount_usd',
          label: 'Invoice Amount',
          unit: 'USD',
          sourceTable: 'v',
          expr: { kind: 'sum', column: 'invoice_amount_usd' },
        },
        {
          key: 'collected_amount_usd',
          label: 'Collected Amount',
          unit: 'USD',
          sourceTable: 'v',
          expr: { kind: 'sum', column: 'collected_amount_usd' },
        },
        {
          key: 'write_off_amount_usd',
          label: 'Write-off Amount',
          unit: 'USD',
          sourceTable: 'v',
          expr: { kind: 'sum', column: 'write_off_amount_usd' },
        },
        {
          key: 'outstanding_receivable_usd',
          label: 'Outstanding Balance',
          unit: 'USD',
          sourceTable: 'v',
          expr: { kind: 'sum', column: 'outstanding_receivable_usd' },
        },
        {
          key: 'total_payroll_usd',
          label: 'Payroll Cost',
          unit: 'USD',
          sourceTable: 'v',
          expr: { kind: 'sum', column: 'total_payroll_usd' },
        },
        {
          key: 'employee_headcount',
          label: 'Employee Headcount',
          unit: 'count',
          sourceTable: 'v',
          expr: { kind: 'max', column: 'employee_headcount' },
        },
        {
          key: 'revenue_growth_pct',
          label: 'Revenue Growth %',
          unit: '%',
          sourceTable: 'v',
          expr: { kind: 'mean', column: 'revenue_growth_pct' },
        },
        {
          key: 'ebitda_growth_pct',
          label: 'EBITDA Growth %',
          unit: '%',
          sourceTable: 'v',
          expr: { kind: 'mean', column: 'ebitda_growth_pct' },
        },
        {
          key: 'sla_compliance_pct',
          label: 'SLA %',
          unit: '%',
          sourceTable: 'v',
          expr: { kind: 'mean', column: 'sla_compliance_pct' },
        },
        {
          key: 'csat_pct',
          label: 'CSAT %',
          unit: '%',
          sourceTable: 'v',
          expr: { kind: 'mean', column: 'csat_pct' },
        },
      ],
    };
    const arPrior = {
      chartType: 'stacked_bar' as const,
      measureKeys: [
        'invoice_amount_usd',
        'collected_amount_usd',
        'write_off_amount_usd',
        'outstanding_receivable_usd',
      ],
      dimensionKey: 'client_name',
      title: 'AR by Client',
    };
    const arCreate = await planChart(
      'Create a stacked column chart showing invoice amount, collected amount, write-off amount, and outstanding balance by client.',
      highlightModel,
      async () =>
        JSON.stringify({
          ...arPrior,
          measureKeys: [
            'invoice_amount_usd',
            'collected_amount_usd',
            'write_off_amount_usd',
          ],
        }),
    );
    expect(arCreate.ok).toBe(true);
    if (arCreate.ok) {
      expect(arCreate.spec.measureKeys).toEqual(
        expect.arrayContaining([
          'invoice_amount_usd',
          'collected_amount_usd',
          'write_off_amount_usd',
          'outstanding_receivable_usd',
        ]),
      );
    }
    const ar = await planEdit(
      'In the same chart, highlight the client with the largest outstanding balance.',
      arPrior,
      highlightModel,
      async () => JSON.stringify({ ...arPrior, topN: 1 }),
    );
    expect(ar.ok).toBe(true);
    if (ar.ok) {
      expect(ar.spec.measureKeys[0]).toBe('outstanding_receivable_usd');
      expect(ar.spec.highlightExtremes).toBe('max');
      expect(ar.spec.highlightNames).toBeUndefined();
      expect(ar.spec.topN).toBeUndefined();
    }

    const workforcePrior = {
      chartType: 'bubble' as const,
      measureKeys: [
        'total_revenue_usd',
        'total_payroll_usd',
        'employee_headcount',
      ],
      dimensionKey: 'business_unit',
      breakdownKey: 'client_name',
      title: 'Revenue vs Payroll',
    };
    const workforce = await planEdit(
      'In the same chart, use employee headcount as bubble size and highlight combinations with payroll cost but no revenue.',
      workforcePrior,
      highlightModel,
      async () => JSON.stringify(workforcePrior),
    );
    expect(workforce.ok).toBe(true);
    if (workforce.ok)
      expect(workforce.spec.highlightCostWithoutRevenue).toBe(true);

    const growthPrior = {
      chartType: 'bubble' as const,
      measureKeys: [
        'revenue_growth_pct',
        'ebitda_growth_pct',
        'gross_margin_pct',
      ],
      dimensionKey: 'delivery_center',
      title: 'Growth vs Growth',
    };
    const growth = await planEdit(
      'In the same chart, use gross margin as the bubble size and highlight combinations with low SLA or CSAT.',
      growthPrior,
      highlightModel,
      async () =>
        JSON.stringify({
          ...growthPrior,
          measureKeys: [
            ...growthPrior.measureKeys,
            'sla_compliance_pct',
            'csat_pct',
          ],
        }),
    );
    expect(growth.ok).toBe(true);
    if (growth.ok) {
      expect(growth.spec.measureKeys).toEqual(
        expect.arrayContaining(['sla_compliance_pct', 'csat_pct']),
      );
      expect(growth.spec.highlightLowPerformance).toBe(true);
    }
  });

  it('does not append an unrequested loose-match hours metric in Q62', async () => {
    const payrollModel: SemanticModel = {
      ...model,
      measures: [
        {
          key: 'total_payroll_usd',
          label: 'Total Payroll',
          unit: 'USD',
          sourceTable: 'v',
          expr: { kind: 'sum', column: 'total_payroll_usd' },
        },
        {
          key: 'paid_hours',
          label: 'Paid Hours',
          unit: 'hours',
          sourceTable: 'v',
          expr: { kind: 'sum', column: 'paid_hours' },
        },
        {
          key: 'productive_hours',
          label: 'Productive Hours',
          unit: 'hours',
          sourceTable: 'v',
          expr: { kind: 'sum', column: 'productive_hours' },
        },
        {
          key: 'average_payroll_cost_per_paid_hour',
          label: 'Average Payroll Cost Per Paid Hour',
          unit: 'USD',
          sourceTable: 'v',
          expr: { kind: 'mean', column: 'average_payroll_cost_per_paid_hour' },
        },
        {
          key: 'overtime_hours',
          label: 'Overtime Hours',
          unit: 'hours',
          sourceTable: 'v',
          expr: { kind: 'sum', column: 'overtime_hours' },
        },
      ],
    };
    const prior = {
      chartType: 'combo' as const,
      measureKeys: ['total_payroll_usd', 'paid_hours'],
      dimensionKey: 'client_name',
      timeGrain: 'month' as const,
      title: 'Monthly payroll and paid hours by client',
    };
    const result = await planEdit(
      'In the same chart, add productive hours and payroll cost per paid hour.',
      prior,
      payrollModel,
      async () =>
        JSON.stringify({
          ...prior,
          measureKeys: [
            ...prior.measureKeys,
            'productive_hours',
            'average_payroll_cost_per_paid_hour',
            'overtime_hours',
          ],
        }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.measureKeys).toEqual([
        'total_payroll_usd',
        'paid_hours',
        'productive_hours',
        'average_payroll_cost_per_paid_hour',
      ]);
    }
  });

  it('keeps only the requested hours measure for Q67 bubble size', async () => {
    const bubbleModel: SemanticModel = {
      ...model,
      measures: [
        {
          key: 'total_payroll_usd',
          label: 'Total Payroll',
          unit: 'USD',
          sourceTable: 'v',
          expr: { kind: 'sum', column: 'total_payroll_usd' },
        },
        {
          key: 'productive_hours',
          label: 'Productive Hours',
          unit: 'hours',
          sourceTable: 'v',
          expr: { kind: 'sum', column: 'productive_hours' },
        },
        {
          key: 'overtime_hours',
          label: 'Overtime Hours',
          unit: 'hours',
          sourceTable: 'v',
          expr: { kind: 'sum', column: 'overtime_hours' },
        },
        {
          key: 'overtime_usd',
          label: 'Overtime',
          unit: 'USD',
          sourceTable: 'v',
          expr: { kind: 'sum', column: 'overtime_usd' },
        },
      ],
    };
    const prior = {
      chartType: 'scatter' as const,
      measureKeys: ['total_payroll_usd', 'productive_hours'],
      dimensionKey: 'client_name',
      title: 'Payroll versus productive hours',
    };
    const result = await planEdit(
      'In the same chart, use overtime hours as the bubble size.',
      prior,
      bubbleModel,
      async () =>
        JSON.stringify({
          ...prior,
          chartType: 'bubble',
          measureKeys: [...prior.measureKeys, 'overtime_hours', 'overtime_usd'],
        }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.measureKeys).toEqual([
        'total_payroll_usd',
        'productive_hours',
        'overtime_hours',
      ]);
    }
  });

  it('keeps stacked columns when Q70 adds percentage lines', async () => {
    const operationsModel: SemanticModel = {
      ...model,
      measures: [
        {
          key: 'capacity_hours',
          label: 'Capacity Hours',
          unit: 'hours',
          sourceTable: 'v',
          expr: { kind: 'sum', column: 'capacity_hours' },
        },
        {
          key: 'working_hours',
          label: 'Working Hours',
          unit: 'hours',
          sourceTable: 'v',
          expr: { kind: 'sum', column: 'working_hours' },
        },
        {
          key: 'occupancy_pct',
          label: 'Occupancy %',
          unit: '%',
          sourceTable: 'v',
          expr: { kind: 'mean', column: 'occupancy_pct' },
        },
        {
          key: 'utilization_pct',
          label: 'Utilization %',
          unit: '%',
          sourceTable: 'v',
          expr: { kind: 'mean', column: 'utilization_pct' },
        },
      ],
    };
    const prior = {
      chartType: 'stacked_bar' as const,
      measureKeys: ['capacity_hours', 'working_hours'],
      dimensionKey: 'business_unit',
      title: 'Hours by business unit',
    };
    const result = await planEdit(
      'In the same chart, add occupancy and utilization percentages as lines.',
      prior,
      operationsModel,
      async () =>
        JSON.stringify({
          ...prior,
          chartType: 'combo',
          measureKeys: [
            ...prior.measureKeys,
            'occupancy_pct',
            'utilization_pct',
          ],
        }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.spec.chartType).toBe('stacked_bar');
  });

  it('expands Q71 executive concepts and starts its ordered drill hierarchy at region', async () => {
    const executiveModel: SemanticModel = {
      ...model,
      dimensions: [
        ...model.dimensions,
        { key: 'region', label: 'Region', table: 'v', column: 'region' },
        {
          key: 'service_line',
          label: 'Service Line',
          table: 'v',
          column: 'service_line',
        },
      ],
      measures: [
        ...model.measures,
        {
          key: 'gross_profit_usd',
          label: 'Gross Profit',
          unit: 'USD',
          sourceTable: 'v',
          expr: { kind: 'sum', column: 'gross_profit_usd' },
        },
        {
          key: 'total_payroll_usd',
          label: 'Total Payroll',
          unit: 'USD',
          sourceTable: 'v',
          expr: { kind: 'sum', column: 'total_payroll_usd' },
        },
        {
          key: 'utilization_pct',
          label: 'Utilization %',
          unit: '%',
          sourceTable: 'v',
          expr: { kind: 'mean', column: 'utilization_pct' },
        },
        {
          key: 'sla_compliance_pct',
          label: 'SLA Compliance %',
          unit: '%',
          sourceTable: 'v',
          expr: { kind: 'mean', column: 'sla_compliance_pct' },
        },
        {
          key: 'csat_pct',
          label: 'CSAT %',
          unit: '%',
          sourceTable: 'v',
          expr: { kind: 'mean', column: 'csat_pct' },
        },
        {
          key: 'outstanding_receivable_usd',
          label: 'Outstanding Receivable',
          unit: 'USD',
          sourceTable: 'v',
          expr: { kind: 'sum', column: 'outstanding_receivable_usd' },
        },
      ],
    };
    const created = await planChart(
      'Create an executive drill-down dashboard showing revenue, profitability, payroll, utilization, service quality, and receivables.',
      executiveModel,
      async () =>
        JSON.stringify({
          chartType: 'kpi',
          measureKeys: ['total_revenue_usd'],
          title: 'Executive dashboard',
        }),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.spec.measureKeys).toEqual(
      expect.arrayContaining([
        'total_revenue_usd',
        'gross_profit_usd',
        'total_payroll_usd',
        'utilization_pct',
        'sla_compliance_pct',
        'csat_pct',
        'outstanding_receivable_usd',
      ]),
    );
    const edited = await planEdit(
      'In the same dashboard, enable drill-down from region to client and service line.',
      created.spec,
      executiveModel,
      async () =>
        JSON.stringify({ ...created.spec, dimensionKey: 'service_line' }),
    );
    expect(edited.ok).toBe(true);
    if (edited.ok) {
      expect(edited.spec.hierarchyKeys).toEqual([
        'region',
        'client_name',
        'service_line',
      ]);
      expect(edited.spec.dimensionKey).toBe('region');
      expect(edited.spec.measureKeys).toEqual(created.spec.measureKeys);
    }
  });

  it('keeps both general-ledger and trial-balance debit/credit measures for Q60', async () => {
    const reconciliationModel: SemanticModel = {
      ...model,
      measures: [
        {
          key: 'general_ledger_debit_usd',
          label: 'General Ledger Debit Usd',
          unit: 'USD',
          sourceTable: 'v',
          expr: { kind: 'sum', column: 'general_ledger_debit_usd' },
        },
        {
          key: 'general_ledger_credit_usd',
          label: 'General Ledger Credit Usd',
          unit: 'USD',
          sourceTable: 'v',
          expr: { kind: 'sum', column: 'general_ledger_credit_usd' },
        },
        {
          key: 'trial_balance_debit_movement_usd',
          label: 'Trial Balance Debit Movement Usd',
          unit: 'USD',
          sourceTable: 'v',
          expr: { kind: 'sum', column: 'trial_balance_debit_movement_usd' },
        },
        {
          key: 'trial_balance_credit_movement_usd',
          label: 'Trial Balance Credit Movement Usd',
          unit: 'USD',
          sourceTable: 'v',
          expr: { kind: 'sum', column: 'trial_balance_credit_movement_usd' },
        },
        {
          key: 'debit_reconciliation_difference_usd',
          label: 'Debit Reconciliation Difference Usd',
          unit: 'USD',
          sourceTable: 'v',
          expr: { kind: 'sum', column: 'debit_reconciliation_difference_usd' },
        },
        {
          key: 'credit_reconciliation_difference_usd',
          label: 'Credit Reconciliation Difference Usd',
          unit: 'USD',
          sourceTable: 'v',
          expr: { kind: 'sum', column: 'credit_reconciliation_difference_usd' },
        },
      ],
    };
    const question =
      'Create a clustered column chart comparing general ledger debit and credit amounts with trial balance debit and credit movements.';
    const planned = await planChart(question, reconciliationModel, async () =>
      JSON.stringify({
        chartType: 'bar',
        measureKeys: ['general_ledger_debit_usd', 'general_ledger_credit_usd'],
        title: 'Ledger reconciliation',
      }),
    );
    expect(planned.ok).toBe(true);
    if (planned.ok) {
      expect(planned.spec.measureKeys).toEqual([
        'general_ledger_debit_usd',
        'general_ledger_credit_usd',
        'trial_balance_debit_movement_usd',
        'trial_balance_credit_movement_usd',
      ]);

      const followup = await planEdit(
        'In the same chart, highlight general ledger and trial balance differences.',
        planned.spec,
        reconciliationModel,
        async () => JSON.stringify(planned.spec),
      );
      expect(followup.ok).toBe(true);
      if (followup.ok) {
        expect(followup.spec.measureKeys).toEqual([
          ...planned.spec.measureKeys,
          'debit_reconciliation_difference_usd',
          'credit_reconciliation_difference_usd',
        ]);
        expect(followup.spec.highlightSeries).toEqual([
          'debit_reconciliation_difference_usd',
          'credit_reconciliation_difference_usd',
        ]);
      }
    }
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
