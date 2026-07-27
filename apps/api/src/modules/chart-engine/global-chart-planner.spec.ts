import { planAcrossCubes, type Cube } from './cube-router';
import { buildGlobalPlannerPrompt } from './global-chart-planner';
import type { SemanticModel } from './semantic-model.types';

function model(
  datasetId: string,
  measure: { key: string; label: string; unit?: string },
  dimension: { key: string; label: string },
): SemanticModel {
  return {
    datasetId,
    version: 1,
    entities: [],
    measures: [
      {
        ...measure,
        unit: measure.unit ?? 'count',
        sourceTable: datasetId,
        expr: { kind: 'sum', column: measure.key },
      },
    ],
    dimensions: [
      {
        ...dimension,
        table: datasetId,
        column: dimension.key,
        sampleValues: ['North', 'South'],
      },
    ],
    factGrain: 'one row per event',
    builtBy: 'auto',
  };
}

const cubes: Cube[] = [
  {
    view: 'support_events',
    model: model(
      'support',
      { key: 'resolved_tickets', label: 'Resolved Tickets' },
      { key: 'support_team', label: 'Support Team' },
    ),
  },
  {
    view: 'warehouse_shipments',
    model: model(
      'warehouse',
      { key: 'shipped_units', label: 'Shipped Units' },
      { key: 'warehouse_region', label: 'Warehouse Region' },
    ),
  },
];

describe('global chart planner', () => {
  it('shows OpenAI every runtime-derived cube and contains no finance dataset vocabulary', () => {
    const prompt = buildGlobalPlannerPrompt(cubes);
    expect(prompt).toContain('support_events');
    expect(prompt).toContain('resolved_tickets');
    expect(prompt).toContain('warehouse_shipments');
    expect(prompt).toContain('shipped_units');
    expect(prompt).not.toMatch(/\bEBPO\b|total_revenue_usd|gross_profit_usd/);
  });

  it('lets the model choose the semantically correct cube and validates its keys', async () => {
    const result = await planAcrossCubes(
      'Create a bar chart of shipped units by warehouse region',
      cubes,
      async () =>
        JSON.stringify({
          verdict: 'chart',
          cubeView: 'warehouse_shipments',
          confidence: 0.98,
          interpretation: 'Shipped units grouped by warehouse region',
          spec: {
            chartType: 'bar',
            measureKeys: ['shipped_units'],
            dimensionKey: 'warehouse_region',
            title: 'Shipped Units by Warehouse Region',
          },
        }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.cube.view).toBe('warehouse_shipments');
      expect(result.spec.measureKeys).toEqual(['shipped_units']);
      expect(result.spec.dimensionKey).toBe('warehouse_region');
    }
  });

  it('normalizes a lone breakdown into the primary chart grouping', async () => {
    const result = await planAcrossCubes(
      'Create a bar chart of shipped units by warehouse region',
      cubes,
      async () =>
        JSON.stringify({
          verdict: 'chart',
          cubeView: 'warehouse_shipments',
          spec: {
            chartType: 'bar',
            measureKeys: ['shipped_units'],
            breakdownKey: 'warehouse_region',
            title: 'Shipped Units by Warehouse Region',
          },
        }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.dimensionKey).toBe('warehouse_region');
      expect(result.spec.breakdownKey).toBeUndefined();
    }
  });

  it('surfaces model-generated clarification instead of guessing', async () => {
    const result = await planAcrossCubes(
      'Show performance by region',
      cubes,
      async () =>
        JSON.stringify({
          verdict: 'clarify',
          question: 'Which performance measure should I chart?',
          reason: 'The dataset has two different performance measures.',
          options: [
            { label: 'Resolved tickets', value: 'Use resolved tickets' },
            { label: 'Shipped units', value: 'Use shipped units' },
          ],
        }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.clarification?.question).toContain('Which performance');
      expect(result.clarification?.options).toHaveLength(2);
      expect(result.clarification?.originalQuestion).toBe(
        'Show performance by region',
      );
    }
  });

  it('repairs a one-option pseudo-clarification into a grounded chart', async () => {
    const responses = [
      {
        verdict: 'clarify',
        question: 'Should I use the available warehouse regions?',
        reason: 'Need confirmation.',
        options: [
          {
            label: 'Use available regions',
            value: 'Use North and South.',
          },
        ],
      },
      {
        verdict: 'chart',
        cubeView: 'warehouse_shipments',
        spec: {
          chartType: 'bar',
          measureKeys: ['shipped_units'],
          dimensionKey: 'warehouse_region',
          title: 'Shipped Units by Warehouse Region',
        },
      },
    ];
    const calls: string[] = [];
    const result = await planAcrossCubes(
      'Show shipped units by warehouse region',
      cubes,
      async (_system, user) => {
        calls.push(user);
        return JSON.stringify(responses[calls.length - 1]);
      },
    );

    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('only one option');
    expect(result.ok).toBe(true);
  });

  it('repairs a clarification that repeats members already named by the user', async () => {
    const responses = [
      {
        verdict: 'clarify',
        question: 'Which warehouse regions should be included?',
        reason: 'Need the region selection.',
        options: [
          {
            label: 'Use the requested regions',
            value: 'Use North and South.',
          },
          {
            label: 'Revise the regions',
            value: 'Use a different set of regions.',
          },
        ],
      },
      {
        verdict: 'chart',
        cubeView: 'warehouse_shipments',
        spec: {
          chartType: 'bar',
          measureKeys: ['shipped_units'],
          dimensionKey: 'warehouse_region',
          filters: [
            {
              dimensionKey: 'warehouse_region',
              operator: 'in',
              values: ['North', 'South'],
            },
          ],
          title: 'Shipped Units by Region',
        },
      },
    ];
    const calls: string[] = [];
    const result = await planAcrossCubes(
      'Show shipped units for North and South.',
      cubes,
      async (_system, user) => {
        calls.push(user);
        return JSON.stringify(responses[calls.length - 1]);
      },
    );

    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('members already named');
    expect(result.ok).toBe(true);
  });

  it('asks OpenAI to repair an invalid catalog reference and preserves explicit chart type', async () => {
    const responses = [
      JSON.stringify({
        verdict: 'chart',
        cubeView: 'warehouse_shipments',
        spec: {
          chartType: 'line',
          measureKeys: ['invented_units'],
          title: 'Wrong',
        },
      }),
      JSON.stringify({
        verdict: 'chart',
        cubeView: 'warehouse_shipments',
        spec: {
          chartType: 'line',
          measureKeys: ['shipped_units'],
          dimensionKey: 'warehouse_region',
          title: 'Shipped Units by Warehouse Region',
        },
      }),
    ];
    const calls: string[] = [];
    const result = await planAcrossCubes(
      'Create a bar chart of shipped units by warehouse region',
      cubes,
      async (_system, user) => {
        calls.push(user);
        return responses[calls.length - 1]!;
      },
    );
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('unknown measure');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.spec.chartType).toBe('bar');
  });

  it('supplies the structural annual grain required by a prior-year category comparison', async () => {
    const timedCube: Cube = {
      ...cubes[1]!,
      model: {
        ...cubes[1]!.model,
        time: {
          table: 'warehouse',
          column: 'event_date',
          grains: ['month', 'year'],
        },
      },
    };
    const result = await planAcrossCubes(
      'Show last year to this year shipped units by warehouse region',
      [timedCube],
      async () =>
        JSON.stringify({
          verdict: 'chart',
          cubeView: 'warehouse_shipments',
          spec: {
            chartType: 'waterfall',
            measureKeys: ['shipped_units'],
            dimensionKey: 'warehouse_region',
            comparison: 'previous_year',
            title: 'Shipment Change by Warehouse Region',
          },
        }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.spec.timeGrain).toBe('year');
  });

  it('repairs a plan that silently drops an explicitly named runtime dimension', async () => {
    const twoDimensional: Cube = {
      view: 'customer_operations',
      model: {
        ...model(
          'customer_operations',
          { key: 'revenue', label: 'Revenue', unit: 'USD' },
          { key: 'client_name', label: 'Client Name' },
        ),
        measures: [
          {
            key: 'revenue',
            label: 'Revenue',
            unit: 'USD',
            sourceTable: 'customer_operations',
            expr: { kind: 'sum', column: 'revenue' },
          },
          {
            key: 'labor_cost',
            label: 'Labor Cost',
            unit: 'USD',
            sourceTable: 'customer_operations',
            expr: { kind: 'sum', column: 'labor_cost' },
          },
        ],
        dimensions: [
          {
            key: 'client_name',
            label: 'Client Name',
            table: 'customer_operations',
            column: 'client_name',
          },
          {
            key: 'business_unit',
            label: 'Business Unit',
            table: 'customer_operations',
            column: 'business_unit',
          },
        ],
      },
    };
    const responses = [
      {
        verdict: 'chart',
        cubeView: 'customer_operations',
        spec: {
          chartType: 'scatter',
          measureKeys: ['revenue', 'labor_cost'],
          dimensionKey: 'client_name',
          title: 'Revenue vs Labor Cost by Client',
        },
      },
      {
        verdict: 'chart',
        cubeView: 'customer_operations',
        spec: {
          chartType: 'scatter',
          measureKeys: ['revenue', 'labor_cost'],
          dimensionKey: 'client_name',
          breakdownKey: 'business_unit',
          title: 'Revenue vs Labor Cost by Client and Business Unit',
        },
      },
    ];
    const calls: string[] = [];
    const result = await planAcrossCubes(
      'Show revenue versus labor cost by client and business unit',
      [twoDimensional],
      async (_system, user) => {
        calls.push(user);
        return JSON.stringify(responses[calls.length - 1]);
      },
    );
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('business_unit');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.spec.breakdownKey).toBe('business_unit');
  });

  it('repairs a clarification that asks the user to choose dimensions already requested together', async () => {
    const combined: Cube = {
      view: 'combined_metrics',
      model: {
        ...model(
          'combined_metrics',
          { key: 'revenue', label: 'Revenue', unit: 'USD' },
          { key: 'client_name', label: 'Client Name' },
        ),
        measures: [
          {
            key: 'revenue',
            label: 'Revenue',
            unit: 'USD',
            sourceTable: 'combined_metrics',
            expr: { kind: 'sum', column: 'revenue' },
          },
          {
            key: 'cost',
            label: 'Cost',
            unit: 'USD',
            sourceTable: 'combined_metrics',
            expr: { kind: 'sum', column: 'cost' },
          },
        ],
        dimensions: [
          {
            key: 'client_name',
            label: 'Client Name',
            table: 'combined_metrics',
            column: 'client_name',
          },
          {
            key: 'business_unit',
            label: 'Business Unit',
            table: 'combined_metrics',
            column: 'business_unit',
          },
        ],
      },
    };
    const responses = [
      {
        verdict: 'clarify',
        question: 'Should this be grouped by client or business unit?',
        options: [
          { label: 'By client', value: 'Use client' },
          { label: 'By business unit', value: 'Use business unit' },
        ],
      },
      {
        verdict: 'chart',
        cubeView: 'combined_metrics',
        spec: {
          chartType: 'scatter',
          measureKeys: ['revenue', 'cost'],
          dimensionKey: 'client_name',
          breakdownKey: 'business_unit',
          title: 'Revenue vs Cost by Client and Business Unit',
        },
      },
    ];
    const calls: string[] = [];
    const result = await planAcrossCubes(
      'Show revenue versus cost by client and business unit',
      [combined],
      async (_system, user) => {
        calls.push(user);
        return JSON.stringify(responses[calls.length - 1]);
      },
    );
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('redundantly asks');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.spec.breakdownKey).toBe('business_unit');
  });

  it('repairs a clarification that substitutes an available explicitly requested dimension', async () => {
    const revenueCube: Cube = {
      view: 'revenue_metrics',
      model: {
        ...model(
          'revenue_metrics',
          { key: 'revenue', label: 'Revenue', unit: 'USD' },
          { key: 'revenue_category', label: 'Revenue Category' },
        ),
        time: {
          table: 'revenue_metrics',
          column: 'period_date',
          grains: ['year'],
        },
      },
    };
    const responses = [
      {
        verdict: 'clarify',
        question:
          'Which revenue grouping would you like to use instead of revenue category?',
        options: [
          { label: 'Client', value: 'Use client' },
          { label: 'Business unit', value: 'Use business unit' },
        ],
      },
      {
        verdict: 'chart',
        cubeView: 'revenue_metrics',
        spec: {
          chartType: 'waterfall',
          measureKeys: ['revenue'],
          dimensionKey: 'revenue_category',
          timeGrain: 'year',
          comparison: 'previous_year',
          title: 'Revenue Change by Revenue Category',
        },
      },
    ];
    const calls: string[] = [];
    const result = await planAcrossCubes(
      "Show the change from last year's revenue to this year's revenue by revenue category",
      [revenueCube],
      async (_system, user) => {
        calls.push(user);
        return JSON.stringify(responses[calls.length - 1]);
      },
    );
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('redundantly asks');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.dimensionKey).toBe('revenue_category');
      expect(result.spec.chartType).toBe('waterfall');
    }
  });

  it('repairs a plan that drops requested measures from a complete cash-flow cube', async () => {
    const cashFlowCube: Cube = {
      view: 'cash_flow',
      model: {
        datasetId: 'cash_flow',
        version: 1,
        entities: [],
        measures: [
          {
            key: 'opening_cash_balance',
            label: 'Opening Cash Balance',
            unit: 'USD',
            sourceTable: 'cash_flow',
            expr: { kind: 'sum', column: 'opening_cash_balance' },
          },
          {
            key: 'closing_cash_balance',
            label: 'Closing Cash Balance',
            unit: 'USD',
            sourceTable: 'cash_flow',
            expr: { kind: 'sum', column: 'closing_cash_balance' },
          },
          {
            key: 'net_cash_flow',
            label: 'Net Cash Flow',
            unit: 'USD',
            sourceTable: 'cash_flow',
            expr: { kind: 'sum', column: 'net_cash_flow' },
          },
          {
            key: 'cash_balance',
            label: 'Cash Balance',
            unit: 'USD',
            sourceTable: 'cash_flow',
            expr: { kind: 'sum', column: 'closing_cash_balance' },
          },
        ],
        dimensions: [],
        time: {
          table: 'cash_flow',
          column: 'period_date',
          grains: ['month', 'year'],
        },
        factGrain: 'one row per cash-flow category and month',
        builtBy: 'auto+review',
      },
    };
    const responses = [
      {
        verdict: 'chart',
        cubeView: 'cash_flow',
        spec: {
          chartType: 'line',
          measureKeys: ['cash_balance'],
          timeGrain: 'month',
          title: 'Cash Balance by Month',
        },
      },
      {
        verdict: 'chart',
        cubeView: 'cash_flow',
        spec: {
          chartType: 'line',
          measureKeys: [
            'opening_cash_balance',
            'closing_cash_balance',
            'net_cash_flow',
            'cash_balance',
          ],
          timeGrain: 'month',
          title: 'Cash Flow Balances by Month',
        },
      },
    ];
    const calls: string[] = [];
    const result = await planAcrossCubes(
      'Create a line chart showing opening cash balance, closing cash balance, net cash flow, and cash balance by month.',
      [cashFlowCube],
      async (_system, user) => {
        calls.push(user);
        return JSON.stringify(responses[calls.length - 1]);
      },
    );

    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('omitted explicitly requested catalog measure');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.measureKeys).toEqual([
        'opening_cash_balance',
        'closing_cash_balance',
        'net_cash_flow',
        'cash_balance',
      ]);
    }
  });

  it('repairs an edit clarification that asks which chart to change', async () => {
    const responses = [
      {
        verdict: 'clarify',
        question: 'Which chart should I apply this change to?',
        options: [
          { label: 'Current chart', value: 'Use the current chart' },
          { label: 'Start a new chart', value: 'Start a new chart' },
        ],
      },
      {
        verdict: 'chart',
        cubeView: 'warehouse_shipments',
        spec: {
          chartType: 'bar',
          measureKeys: ['shipped_units'],
          dimensionKey: 'warehouse_region',
          title: 'Updated Shipments',
        },
      },
    ];
    const calls: string[] = [];
    const result = await planAcrossCubes(
      [
        'EDIT THE CURRENT CHART. CURRENT CHART STATE is authoritative.',
        'Current source cubeView: warehouse_shipments.',
        'User change request: highlight the highest result.',
      ].join('\n'),
      cubes,
      async (_system, user) => {
        calls.push(user);
        return JSON.stringify(responses[calls.length - 1]);
      },
    );
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('exact current chart state');
    expect(result.ok).toBe(true);
  });

  it('validates edit fidelity against the user instruction, not technical chart-state text', async () => {
    const clientCube: Cube = {
      view: 'client_performance',
      model: {
        ...model(
          'client_performance',
          { key: 'revenue', label: 'Revenue', unit: 'USD' },
          { key: 'client_name', label: 'Client Name' },
        ),
        dimensions: [
          {
            key: 'client_name',
            label: 'Client Name',
            table: 'client_performance',
            column: 'client_name',
          },
          {
            key: 'industry',
            label: 'Industry',
            table: 'client_performance',
            column: 'industry',
          },
        ],
      },
    };
    const result = await planAcrossCubes(
      [
        'EDIT THE CURRENT CHART. CURRENT CHART STATE is authoritative.',
        'Current source cubeView: client_performance.',
        'Current grouping: Industry.',
        'User change request: add revenue.',
      ].join('\n'),
      [clientCube],
      async () =>
        JSON.stringify({
          verdict: 'chart',
          cubeView: 'client_performance',
          spec: {
            chartType: 'bar',
            measureKeys: ['revenue'],
            dimensionKey: 'industry',
            title: 'Revenue by Industry',
          },
        }),
      'add revenue',
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.spec.dimensionKey).toBe('industry');
  });

  it('repairs a plan that collapses multiple named dimension members into a total', async () => {
    const responses = [
      {
        verdict: 'chart',
        cubeView: 'warehouse_shipments',
        spec: {
          chartType: 'stacked_area',
          measureKeys: ['shipped_units'],
          title: 'North and South Shipments',
        },
      },
      {
        verdict: 'chart',
        cubeView: 'warehouse_shipments',
        spec: {
          chartType: 'stacked_area',
          measureKeys: ['shipped_units'],
          dimensionKey: 'warehouse_region',
          title: 'North and South Shipments',
        },
      },
    ];
    const calls: string[] = [];
    const result = await planAcrossCubes(
      'Create a stacked area chart comparing North and South shipments.',
      cubes,
      async (_system, user) => {
        calls.push(user);
        return JSON.stringify(responses[calls.length - 1]);
      },
    );
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('omitted explicitly requested');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.spec.dimensionKey).toBe('warehouse_region');
  });

  it('repairs a bubble plan that misfiles its size measure as a label', async () => {
    const bubbleCube: Cube = {
      view: 'client_metrics',
      model: {
        ...model(
          'client_metrics',
          { key: 'revenue', label: 'Revenue', unit: 'USD' },
          { key: 'client_name', label: 'Client Name' },
        ),
        measures: [
          {
            key: 'revenue',
            label: 'Revenue',
            unit: 'USD',
            sourceTable: 'client_metrics',
            expr: { kind: 'sum', column: 'revenue' },
          },
          {
            key: 'cost',
            label: 'Cost',
            unit: 'USD',
            sourceTable: 'client_metrics',
            expr: { kind: 'sum', column: 'cost' },
          },
          {
            key: 'employee_headcount',
            label: 'Employee Headcount',
            unit: 'count',
            sourceTable: 'client_metrics',
            expr: { kind: 'sum', column: 'employee_headcount' },
          },
        ],
      },
    };
    const responses = [
      {
        verdict: 'chart',
        cubeView: 'client_metrics',
        spec: {
          chartType: 'bubble',
          measureKeys: ['revenue', 'cost'],
          labelMeasureKey: 'employee_headcount',
          dimensionKey: 'client_name',
          title: 'Revenue vs Cost',
        },
      },
      {
        verdict: 'chart',
        cubeView: 'client_metrics',
        spec: {
          chartType: 'bubble',
          measureKeys: ['revenue', 'cost', 'employee_headcount'],
          dimensionKey: 'client_name',
          title: 'Revenue vs Cost',
        },
      },
    ];
    const calls: string[] = [];
    const result = await planAcrossCubes(
      'Show Revenue versus Cost by Client Name and use Employee Headcount as bubble size.',
      [bubbleCube],
      async (_system, user) => {
        calls.push(user);
        return JSON.stringify(responses[calls.length - 1]);
      },
    );

    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('omitted explicitly requested catalog measure');
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.spec.measureKeys).toEqual([
        'revenue',
        'cost',
        'employee_headcount',
      ]);
  });

  it('does not confuse a specific growth measure with its shorter base measure', async () => {
    const growthCube: Cube = {
      view: 'growth_metrics',
      model: {
        ...model(
          'growth_metrics',
          { key: 'revenue', label: 'Revenue', unit: 'USD' },
          { key: 'business_unit', label: 'Business Unit' },
        ),
        measures: [
          {
            key: 'revenue',
            label: 'Revenue',
            unit: 'USD',
            sourceTable: 'growth_metrics',
            expr: { kind: 'sum', column: 'revenue' },
          },
          {
            key: 'revenue_growth_pct',
            label: 'Revenue Growth',
            unit: 'percent',
            sourceTable: 'growth_metrics',
            expr: { kind: 'mean', column: 'revenue_growth_pct' },
          },
          {
            key: 'ebitda_usd',
            label: 'EBITDA',
            unit: 'USD',
            sourceTable: 'growth_metrics',
            expr: { kind: 'sum', column: 'ebitda_usd' },
          },
          {
            key: 'ebitda_growth_pct',
            label: 'EBITDA Growth',
            unit: 'percent',
            sourceTable: 'growth_metrics',
            expr: { kind: 'mean', column: 'ebitda_growth_pct' },
          },
        ],
      },
    };
    const result = await planAcrossCubes(
      'Show Revenue Growth versus EBITDA Growth by Business Unit.',
      [growthCube],
      async () =>
        JSON.stringify({
          verdict: 'chart',
          cubeView: 'growth_metrics',
          spec: {
            chartType: 'scatter',
            measureKeys: ['revenue_growth_pct', 'ebitda_growth_pct'],
            dimensionKey: 'business_unit',
            title: 'Growth by Business Unit',
          },
        }),
    );

    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.spec.measureKeys).toEqual([
        'revenue_growth_pct',
        'ebitda_growth_pct',
      ]);
  });

  it('does not confuse account type or group with the shorter account dimension', async () => {
    const accountCube: Cube = {
      view: 'account_metrics',
      model: {
        ...model(
          'account_metrics',
          { key: 'closing_balance', label: 'Closing Balance', unit: 'USD' },
          { key: 'account_name', label: 'Account Name' },
        ),
        dimensions: [
          {
            key: 'account_name',
            label: 'Account Name',
            table: 'account_metrics',
            column: 'account_name',
          },
          {
            key: 'account_type',
            label: 'Account Type',
            table: 'account_metrics',
            column: 'account_type',
          },
          {
            key: 'fiscal_year',
            label: 'Fiscal Year',
            table: 'account_metrics',
            column: 'fiscal_year',
          },
        ],
      },
    };
    const result = await planAcrossCubes(
      'Show Closing Balance by Account Type and Fiscal Year.',
      [accountCube],
      async () =>
        JSON.stringify({
          verdict: 'chart',
          cubeView: 'account_metrics',
          spec: {
            chartType: 'bar',
            measureKeys: ['closing_balance'],
            dimensionKey: 'account_type',
            breakdownKey: 'fiscal_year',
            title: 'Closing Balance by Account Type and Fiscal Year',
          },
        }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.dimensionKey).toBe('account_type');
      expect(result.spec.breakdownKey).toBe('fiscal_year');
    }
  });

  it('repairs a raw amount plan when the request requires a catalog ratio', async () => {
    const costCube: Cube = {
      view: 'cost_metrics',
      model: {
        ...model(
          'cost_metrics',
          { key: 'total_cost', label: 'Total Cost', unit: 'USD' },
          { key: 'cost_family', label: 'Cost Family' },
        ),
        time: {
          table: 'cost_metrics',
          column: 'period_date',
          grains: ['month', 'year'],
        },
        measures: [
          {
            key: 'total_cost',
            label: 'Total Cost',
            unit: 'USD',
            sourceTable: 'cost_metrics',
            expr: { kind: 'sum', column: 'total_cost' },
          },
          {
            key: 'cost_pct_of_revenue',
            label: 'Cost % of Revenue',
            unit: 'percent',
            sourceTable: 'cost_metrics',
            expr: {
              kind: 'ratio_of_sums',
              numerator: 'total_cost',
              denominator: 'total_revenue',
            },
          },
        ],
      },
    };
    const responses = [
      {
        verdict: 'chart',
        cubeView: 'cost_metrics',
        spec: {
          chartType: 'stacked_area',
          measureKeys: ['total_cost'],
          dimensionKey: 'cost_family',
          title: 'Costs',
        },
      },
      {
        verdict: 'chart',
        cubeView: 'cost_metrics',
        spec: {
          chartType: 'stacked_area',
          measureKeys: ['cost_pct_of_revenue'],
          dimensionKey: 'cost_family',
          timeGrain: 'month',
          title: 'Costs as % of Revenue',
        },
      },
    ];
    const calls: string[] = [];
    const result = await planAcrossCubes(
      'Show each cost family as a percentage of revenue.',
      [costCube],
      async (_system, user) => {
        calls.push(user);
        return JSON.stringify(responses[calls.length - 1]);
      },
    );

    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('selected no catalog ratio measure');
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.spec.measureKeys).toEqual(['cost_pct_of_revenue']);
  });

  it('repairs an omitted requested series using generic catalog coverage', async () => {
    const payableCube: Cube = {
      view: 'monthly_payables',
      model: {
        ...model(
          'monthly_payables',
          { key: 'paid_amount_usd', label: 'Paid Amount', unit: 'USD' },
          { key: 'vendor_name', label: 'Vendor Name' },
        ),
        time: {
          table: 'monthly_payables',
          column: 'period_date',
          grains: ['month', 'quarter', 'year'],
        },
        measures: [
          {
            key: 'paid_amount_usd',
            label: 'Paid Amount',
            unit: 'USD',
            sourceTable: 'monthly_payables',
            expr: { kind: 'sum', column: 'paid_amount_usd' },
          },
          {
            key: 'cash_outflow_vendor_payments_usd',
            label: 'Cash Outflow Vendor Payments',
            unit: 'USD',
            sourceTable: 'monthly_payables',
            expr: {
              kind: 'sum',
              column: 'cash_outflow_vendor_payments_usd',
            },
          },
        ],
      },
    };
    const responses = [
      {
        verdict: 'chart',
        cubeView: 'monthly_payables',
        spec: {
          chartType: 'line',
          measureKeys: ['paid_amount_usd'],
          timeGrain: 'month',
          title: 'Vendor Payments',
        },
      },
      {
        verdict: 'chart',
        cubeView: 'monthly_payables',
        spec: {
          chartType: 'line',
          measureKeys: ['paid_amount_usd', 'cash_outflow_vendor_payments_usd'],
          timeGrain: 'month',
          title: 'Vendor Payments and Cash Outflow',
        },
      },
    ];
    const calls: string[] = [];
    const result = await planAcrossCubes(
      'Generate a line chart showing vendor payments and vendor cash outflow by month.',
      [payableCube],
      async (_system, user) => {
        calls.push(user);
        return JSON.stringify(responses[calls.length - 1]);
      },
    );

    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('omitted explicitly requested catalog measure');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.measureKeys).toEqual([
        'paid_amount_usd',
        'cash_outflow_vendor_payments_usd',
      ]);
    }
  });

  it('rejects unsupported when one runtime cube has every requested field', async () => {
    const growthCube: Cube = {
      view: 'executive_growth',
      model: {
        ...model(
          'executive_growth',
          { key: 'revenue_growth_pct', label: 'Revenue Growth', unit: '%' },
          { key: 'business_unit', label: 'Business Unit' },
        ),
        dimensions: [
          {
            key: 'business_unit',
            label: 'Business Unit',
            table: 'executive_growth',
            column: 'business_unit',
          },
          {
            key: 'client_name',
            label: 'Client Name',
            table: 'executive_growth',
            column: 'client_name',
          },
          {
            key: 'delivery_center',
            label: 'Delivery Center',
            table: 'executive_growth',
            column: 'delivery_center',
          },
        ],
        measures: [
          {
            key: 'revenue_growth_pct',
            label: 'Revenue Growth',
            unit: '%',
            sourceTable: 'executive_growth',
            expr: { kind: 'mean', column: 'revenue_growth_pct' },
          },
          {
            key: 'ebitda_growth_pct',
            label: 'EBITDA Growth',
            unit: '%',
            sourceTable: 'executive_growth',
            expr: { kind: 'mean', column: 'ebitda_growth_pct' },
          },
        ],
      },
    };
    const responses = [
      {
        verdict: 'unsupported',
        reason: 'The requested combination is unavailable.',
      },
      {
        verdict: 'chart',
        cubeView: 'executive_growth',
        spec: {
          chartType: 'scatter',
          measureKeys: ['revenue_growth_pct', 'ebitda_growth_pct'],
          hierarchyKeys: ['business_unit', 'client_name', 'delivery_center'],
          title: 'Growth by Business Unit, Client, and Delivery Center',
        },
      },
    ];
    const calls: string[] = [];
    const result = await planAcrossCubes(
      'Create a scatter chart showing revenue growth versus EBITDA growth by business unit, client, and delivery center.',
      [growthCube],
      async (_system, user) => {
        calls.push(user);
        return JSON.stringify(responses[calls.length - 1]);
      },
    );

    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain(
      'unsupported verdict contradicts complete runtime catalog candidate',
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.measureKeys).toEqual([
        'revenue_growth_pct',
        'ebitda_growth_pct',
      ]);
      expect(result.spec.hierarchyKeys).toEqual([
        'business_unit',
        'client_name',
        'delivery_center',
      ]);
    }
  });
});
