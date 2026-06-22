describe('AgentService.selectWidgetsForQuery (explicit chart lines)', () => {
  test('maps explicit "Create a ..." instructions into widgets with display hints', () => {
    // `AgentService` transitively imports `@repo/db`, which requires DATABASE_URL at module load.
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const fn = (AgentService.prototype as any).selectWidgetsForQuery as (
      query: string,
    ) => Array<any>;

    const ctx = {
      extractCompareClients: (AgentService.prototype as any).extractCompareClients,
    };

    const widgets = fn.call(ctx, [
      'Create a bar chart showing total revenue for each month and highlight the highest and lowest revenue months.',
      'Create a donut chart showing the split of total transaction value by invoice type.',
      'Create a waterfall chart showing net monthly financial position using total credits minus total debits.',
      'Create a waterfall chart showing monthly revenue, cost, and gross margin progression.',
      'Create a bar chart showing revenue, payroll, and gross margin by business unit.',
    ].join('\n'));

    expect(Array.isArray(widgets)).toBe(true);
    expect(widgets.length).toBeGreaterThanOrEqual(3);

    const revenue = widgets.find((w: any) => w.metric === 'revenue' && w.grouping === 'month');
    expect(revenue?.type).toBe('bar');
    expect(revenue?.display?.highlightMaxMin).toBe(true);

    const donut = widgets.find((w: any) => w.metric === 'invoice_value' && w.grouping === 'invoice_type');
    expect(donut?.type).toBe('donut');
    expect(donut?.display?.donut).toBe(true);

    const wf = widgets.find((w: any) => w.metric === 'net_position' && w.grouping === 'month');
    expect(wf?.type).toBe('waterfall');

    const monthlyGrossMargin = widgets.find(
      (w: any) => w.metric === 'gross_margin' && w.grouping === 'month',
    );
    expect(monthlyGrossMargin?.type).toBe('waterfall');

    const businessUnitFinancials = widgets.find(
      (w: any) => w.metric === 'bu_financials' && w.grouping === 'business_unit',
    );
    expect(businessUnitFinancials?.type).toBe('bar');
  });

  test('detects pure chart-type edit requests like "switch to bar charts"', () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const parser = AgentService.prototype as any;

    const explicit = parser.parseExplicitChartConstraints('switch to bar charts');
    expect(explicit?.requiredTypes).toContain('bar');

    const pureEdit = parser.detectPureChartTypeEditRequest('switch to bar charts');
    expect(pureEdit).toBe('bar');

    const mixedEdit = parser.detectPureChartTypeEditRequest(
      'switch to bar charts and add a monthly trend',
    );
    expect(mixedEdit).toBeNull();
  });

  test('treats chart refinements as edits when a dashboard already exists', () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const parser = AgentService.prototype as any;

    expect(parser.detectIntent('switch to bar charts', true)).toBe('EDIT_DASHBOARD');
    expect(parser.detectIntent('change the y axis from percentage to values', true)).toBe(
      'EDIT_DASHBOARD',
    );
    expect(parser.detectIntent('switch to bar charts', false)).toBe('CREATE_DASHBOARD');
  });

  test('recognizes CFO chart variants used by the new dataset prompts', () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const parser = AgentService.prototype as any;
    const cases: Array<[string, string]> = [
      ['Create a heat map showing gross margin percentage by business unit and month.', 'heatmap'],
      ['Create a Pareto chart showing clients ranked by outstanding receivables.', 'pareto'],
      ['Create a ranked bar chart showing top clients by gross margin.', 'horizontal_bar'],
      ['Create a clustered bar chart comparing revenue and cost by business unit.', 'bar'],
      ['Create a 100% stacked column chart showing monthly revenue mix by business unit.', 'stacked_bar'],
      ['Create a donut chart showing revenue share by contract type.', 'donut'],
      ['Create a waterfall chart showing revenue, cost, and gross margin by month.', 'waterfall'],
      ['Create a scatter plot showing revenue versus gross margin by client.', 'scatter'],
      ['Create a treemap showing revenue contribution by client.', 'treemap'],
    ];

    for (const [prompt, expectedType] of cases) {
      const explicit = parser.parseExplicitChartConstraints(prompt);
      expect(explicit?.requiredTypes).toContain(expectedType);
    }
  });

  test('gates unsupported chart and interactive feature asks', () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const parser = AgentService.prototype as any;
    const cases = [
      ['convert this to a sunburst chart', 'CHART_TYPE_UNSUPPORTED'],
      ['add sparklines inside each matrix row', 'CHART_TYPE_UNSUPPORTED'],
      ['add a dropdown filter control for department', 'INTERACTIVE_FEATURE_UNSUPPORTED'],
      ['animate this treemap over months', 'INTERACTIVE_FEATURE_UNSUPPORTED'],
    ];

    for (const [prompt, expectedReason] of cases) {
      const clarification = parser.detectUnsupportedOrAmbiguousAsk(prompt, false);
      expect(clarification?.reason).toBe(expectedReason);
    }

    expect(
      parser.detectUnsupportedOrAmbiguousAsk(
        'Create a box plot showing salary distribution by department.',
        true,
      ),
    ).toBeNull();
    expect(
      parser.detectUnsupportedOrAmbiguousAsk(
        'Create a box plot showing salary distribution by department.',
        false,
      )?.reason,
    ).toBe('CHART_TYPE_UNSUPPORTED');
  });

  test('refuses unsupported feature follow-ups instead of no-op editing', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;
    const plan = await svc.generateEditPlan(
      {
        id: 'dash',
        title: 'Dashboard',
        widgets: [
          {
            id: 'w1',
            title: 'Vendor Spend',
            chartType: 'treemap',
            queryConfig: { metric: 'expense', grouping: 'vendor' },
            displayOrder: 0,
          },
        ],
      },
      'Change this to a tree ring chart',
    );

    expect(plan.refusal).toContain('Sunburst / tree-ring charts');
    expect(plan.modify).toHaveLength(0);
    expect(plan.add).toHaveLength(0);
  });

  test('does not short-circuit delivery-center payroll-cost bubble follow-ups', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;
    svc.orgHasEbpoData = async () => true;

    const refusal = svc.detectUnavailableData(
      'In the same chart, size bubbles by payroll cost by delivery center.',
      true,
    );

    expect(refusal).toBeNull();
  });

  test('highlights the largest account mover without replacing opening/closing lines', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;
    svc.queryRows = async (sql: string) => {
      if (sql.includes('AS movement'))
        return [{ account_name: 'Accounts Payable', movement: 900 }];
      if (sql.includes(' AS v,'))
        return [
          { v: 'Cash', m: 100 },
          { v: 'Accounts Payable', m: -80 },
        ];
      return [];
    };
    svc.executeDynamicSqlChecked = async () => ({
      rows: [{ name: 'Jan 2026', 'Cash | Opening Balance': 10 }],
      error: null,
    });

    const plan = await svc.buildEbpoBalanceMovementHighlightPlan(
      [
        {
          index: 0,
          w: { chartType: 'line' },
          spec: {
            measure: 'opening_balance',
            measures: ['opening_balance', 'closing_balance'],
            dimension: 'month',
            breakdown: 'account',
            chartType: 'line',
          },
        },
      ],
      'In the same chart, highlight accounts with the largest balance movement.',
      { tenantId: 't', connectionIds: [], externalOrgIds: ['ebpo'] },
    );

    expect(plan.modify[0].type).toBe('line');
    expect(plan.modify[0].dynamicSql).toContain('Cash | Opening Balance');
    expect(plan.modify[0].display.showAllSeries).toBe(true);
    expect(plan.modify[0].display.highlightSeries).toEqual([
      'Accounts Payable | Opening Balance',
      'Accounts Payable | Closing Balance',
    ]);
  });

  test('builds a full CFO dashboard for financial position and operating performance', () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const fn = (AgentService.prototype as any).selectWidgetsForQuery as (
      query: string,
    ) => Array<any>;
    const ctx = {
      extractCompareClients: (AgentService.prototype as any).extractCompareClients,
    };

    const widgets = fn.call(
      ctx,
      'Build an executive summary dashboard focused on financial position and operating performance.',
    );

    expect(widgets.length).toBeGreaterThanOrEqual(5);
    expect(widgets.some((w) => w.type === 'kpi' && w.metric === 'summary')).toBe(true);
    expect(
      widgets.some((w) => w.metric === 'balance_sheet' && w.grouping === 'summary'),
    ).toBe(true);
    expect(widgets.some((w) => w.type === 'waterfall' && w.metric === 'pl')).toBe(true);
    expect(widgets.some((w) => w.metric === 'net_income' && w.grouping === 'month')).toBe(
      true,
    );
  });

  test('applies matrix totals and threshold highlighting as deterministic edit hints', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;
    const plan = await svc.generateEditPlan(
      {
        id: 'dash',
        title: 'Dashboard',
        widgets: [
          {
            id: 'w1',
            title: 'Department Vendor Matrix',
            chartType: 'matrix',
            queryConfig: { metric: 'expense', grouping: 'department_vendor' },
            displayOrder: 0,
          },
        ],
      },
      'Add row totals and column totals, and highlight cells above $10k in green.',
    );

    expect(plan.modify).toHaveLength(1);
    expect(plan.modify[0]?.display?.showTotals).toBe(true);
    expect(plan.modify[0]?.display?.conditionalThreshold).toBe(10_000);
    expect(plan.modify[0]?.display?.conditionalColor).toBe('green');
  });

  test('applies pure data-label follow-ups as deterministic display hints', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;
    const plan = await svc.generateEditPlan(
      {
        id: 'dash',
        title: 'Dashboard',
        widgets: [
          {
            id: 'w1',
            title: 'Monthly Revenue Growth',
            chartType: 'line',
            queryConfig: { metric: 'dynamic', grouping: 'dynamic', dynamicSql: 'SELECT 1 AS name, 1 AS value' },
            displayOrder: 0,
          },
        ],
      },
      'Show data labels on this chart.',
    );

    expect(plan.modify).toHaveLength(1);
    expect(plan.modify[0]?.display?.showDataLabels).toBe(true);
  });

  test('applies matrix highest/lowest highlighting as deterministic display hints', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;
    const plan = await svc.generateEditPlan(
      {
        id: 'dash',
        title: 'Dashboard',
        widgets: [
          {
            id: 'w1',
            title: 'Balance Heatmap',
            chartType: 'heatmap',
            queryConfig: { metric: 'dynamic', grouping: 'dynamic', dynamicSql: 'SELECT 1 AS name, 1 AS value' },
            displayOrder: 0,
          },
        ],
      },
      'In the same chart, highlight the highest and lowest balances.',
    );

    expect(plan.modify).toHaveLength(1);
    expect(plan.modify[0]?.display?.highlightExtremes).toBe('both');
  });

  test('keeps opening and closing balance by account as a line chart when building the plan', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;
    svc.queryRows = async (sql: string) => {
      if (sql.includes(' AS v,'))
        return [
          { v: 'Cash', m: 100 },
          { v: 'Accounts Payable', m: -80 },
        ];
      return [];
    };
    svc.executeDynamicSqlChecked = async () => ({
      rows: [{ name: 'Jan 2026', 'Cash | Opening Balance': 10, 'Cash | Closing Balance': 12 }],
      error: null,
    });

    const plan = await svc.specToPlan(
      {
        measure: 'opening_balance',
        measures: ['opening_balance', 'closing_balance'],
        dimension: 'month',
        breakdown: 'account',
        chartType: 'line',
      },
      'Monthly Opening and Closing Balance by Account',
      true,
      { tenantId: 't', connectionIds: [], externalOrgIds: ['ebpo'] },
      'Create a line chart showing monthly opening balance and closing balance by account.',
    );

    expect(plan?.kind).toBe('build');
    if (plan?.kind === 'build') {
      expect(plan.plan.dashboard.widgets[0]?.type).toBe('line');
    }
  });

  test('keeps EBPO revenue-cost-gross-margin waterfall shape when adding gross-margin-percent labels', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;
    svc.orgHasEbpoData = async () => true;
    svc.executeDynamicSqlChecked = async () => ({
      rows: [
        { name: 'Revenue', value: 100, is_total: 0, 'Gross Margin % Label': null },
        { name: 'Cost', value: -60, is_total: 0, 'Gross Margin % Label': null },
        { name: 'Gross Margin', value: 40, is_total: 1, 'Gross Margin % Label': 40 },
      ],
      error: null,
    });

    const plan = await svc.generateEditPlan(
      {
        id: 'dash',
        title: 'Dashboard',
        widgets: [
          {
            id: 'w1',
            title: 'Revenue → Cost → Gross Margin',
            chartType: 'waterfall',
            queryConfig: {
              metric: 'dynamic',
              grouping: 'dynamic',
              dynamicSql: 'SELECT name, value, is_total FROM bridge',
              spec: { measure: 'gross_margin', dimension: 'month', chartType: 'waterfall' },
              display: { valueFormat: 'currency' },
            },
            displayOrder: 0,
          },
        ],
      },
      'In the same chart, add gross margin percentage labels for each month.',
      { tenantId: 't', connectionIds: [], externalOrgIds: ['ebpo'] },
    );

    expect(plan.modify).toHaveLength(1);
    expect(plan.modify[0]?.type).toBe('waterfall');
    expect(plan.modify[0]?.display?.labelSeries).toBe('Gross Margin % Label');
    expect(plan.modify[0]?.display?.secondaryAxisFormat).toBe('percent');
  });

  test('adds only gross margin when the follow-up asks for gross margin, not gross margin percent', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;
    const spec = svc.buildEbpoComboEditSpec(
      { measure: 'total_revenue', dimension: 'client', chartType: 'bar' },
      'In the same chart, add gross margin by client to compare revenue quality.',
    );

    expect(spec?.measures).toEqual(['total_revenue', 'gross_margin']);
    expect(spec?.measures).not.toContain('gross_margin_pct');
  });

  test('adds only gross margin percentage when the follow-up explicitly asks for the percentage', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;
    const spec = svc.buildEbpoComboEditSpec(
      {
        measure: 'total_revenue',
        measures: ['total_revenue', 'total_cost'],
        dimension: 'business_unit',
        chartType: 'bar',
      },
      'In the same chart, add gross margin percentage for each business unit.',
    );

    expect(spec?.measures).toEqual(['total_revenue', 'total_cost', 'gross_margin_pct']);
    expect(spec?.measures).not.toContain('gross_margin');
  });

  test('adds only the derived payroll-to-revenue ratio without dragging in payroll and revenue amounts', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;
    const spec = svc.buildEbpoComboEditSpec(
      {
        measure: 'cost_to_income_pct',
        dimension: 'month',
        chartType: 'bar',
      },
      'In the same chart, add payroll-to-revenue ratio as a second line.',
    );

    expect(spec?.measures).toEqual(['cost_to_income_pct', 'payroll_to_revenue_pct']);
    expect(spec?.measures).not.toContain('total_payroll');
    expect(spec?.measures).not.toContain('total_revenue');
  });

  test('adds label-only revenue overlays on single-series EBPO bars', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;
    svc.queryRows = async () => [];
    svc.executeDynamicSqlChecked = async () => ({
      rows: [{ name: 'Client A', value: 40, 'Total Revenue Label': 100 }],
      error: null,
    });

    const plan = await svc.buildEbpoMetricEdit(
      {
        id: 'dash',
        title: 'Dashboard',
        widgets: [
          {
            id: 'w1',
            title: 'Gross Margin by Client',
            chartType: 'bar',
            queryConfig: {
              metric: 'dynamic',
              grouping: 'dynamic',
              spec: { measure: 'gross_margin', dimension: 'client', chartType: 'bar' },
              display: { valueFormat: 'currency' },
            },
            displayOrder: 0,
          },
        ],
      },
      'In the same chart, add revenue labels for each client.',
      { tenantId: 't', connectionIds: [], externalOrgIds: ['ebpo'] },
    );

    expect(plan.modify).toHaveLength(1);
    expect(plan.modify[0]?.type).toBe('bar');
    expect(plan.modify[0]?.display?.labelSeries).toBe('Total Revenue Label');
  });

  test('treats overall percent reference-line follow-ups as average reference lines', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;
    svc.orgHasEbpoData = async () => true;
    svc.executeDynamicSqlChecked = async () => ({
      rows: [{ name: 'Client A', value: 40, 'Gross Margin % Average': 38 }],
      error: null,
    });

    const plan = await svc.generateEditPlan(
      {
        id: 'dash',
        title: 'Dashboard',
        widgets: [
          {
            id: 'w1',
            title: 'Gross Margin % by Client',
            chartType: 'bar',
            queryConfig: {
              metric: 'dynamic',
              grouping: 'dynamic',
              spec: { measure: 'gross_margin_pct', dimension: 'client', chartType: 'bar' },
              display: { valueFormat: 'percent', valueDecimals: 1 },
            },
            displayOrder: 0,
          },
        ],
      },
      'In the same chart, add an overall gross margin percentage reference line.',
      { tenantId: 't', connectionIds: [], externalOrgIds: ['ebpo'] },
    );

    expect(plan.modify).toHaveLength(1);
    expect(plan.modify[0]?.type).toBe('bar');
    expect(plan.modify[0]?.display?.referenceSeries).toBe('Gross Margin % Average');
  });

  test('detects gross margin percentage without also adding gross margin dollars', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;

    expect(
      svc.detectEbpoMeasureMentions(
        'In the same chart, add gross margin percentage for each business unit.',
      ),
    ).toContain('gross_margin_pct');
    expect(
      svc.detectEbpoMeasureMentions(
        'In the same chart, add gross margin percentage for each business unit.',
      ),
    ).not.toContain('gross_margin');
  });

  test('adds average monthly salary to payroll-by-country without replacing the original bars', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;
    svc.executeDynamicSqlChecked = async () => ({
      rows: [{ name: 'USA', total_payroll: 1000, avg_monthly_salary: 2500 }],
      error: null,
    });

    const plan = await svc.buildEbpoMetricEdit(
      {
        id: 'dash',
        title: 'Dashboard',
        widgets: [
          {
            id: 'w1',
            title: 'Total Payroll by Country',
            chartType: 'bar',
            queryConfig: {
              metric: 'dynamic',
              grouping: 'dynamic',
              spec: { measure: 'total_payroll', dimension: 'country', chartType: 'bar' },
              display: { valueFormat: 'currency' },
            },
            displayOrder: 0,
          },
        ],
      },
      'In the same chart, add average monthly salary by country.',
      { tenantId: 't', connectionIds: [], externalOrgIds: ['ebpo'] },
    );

    expect(plan.modify).toHaveLength(1);
    expect(plan.modify[0]?.type).toBe('combo');
    expect(plan.modify[0]?.display?.secondaryLabel).toBe('Average monthly salary');
  });

  test('forces operations scatters to delivery center instead of a stray client grain', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;
    svc.executeDynamicSqlChecked = async () => ({
      rows: [{ name: 'Center A', x: 12, y: 88 }],
      error: null,
    });

    const plan = await svc.specToPlan(
      {
        measure: 'avg_aht_minutes',
        measures: ['avg_aht_minutes', 'csat_pct'],
        dimension: 'client',
        chartType: 'scatter',
      },
      'Handling Time vs CSAT',
      true,
      { tenantId: 't', connectionIds: [], externalOrgIds: ['ebpo'] },
      'Create a scatter plot showing average handling time versus CSAT percentage.',
    );

    expect(plan?.kind).toBe('build');
    if (plan?.kind === 'build') {
      expect(plan.plan.dashboard.widgets[0]?._spec?.dimension).toBe('delivery_center');
      expect(plan.plan.dashboard.widgets[0]?.type).toBe('scatter');
    }
  });

  test('forces utilization vs SLA scatters to both measures on delivery center grain', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;
    svc.executeDynamicSqlChecked = async () => ({
      rows: [{ name: 'Center A', x: 82, y: 95 }],
      error: null,
    });

    const plan = await svc.specToPlan(
      {
        measure: 'utilization_pct',
        dimension: 'sla_compliance_pct' as any,
        chartType: 'scatter',
      },
      'Utilization vs SLA',
      true,
      { tenantId: 't', connectionIds: [], externalOrgIds: ['ebpo'] },
      'Create a scatter plot showing utilization percentage versus SLA compliance percentage.',
    );

    expect(plan?.kind).toBe('build');
    if (plan?.kind === 'build') {
      expect(plan.plan.dashboard.widgets[0]?._spec?.dimension).toBe('delivery_center');
      expect(plan.plan.dashboard.widgets[0]?._spec?.measures).toEqual([
        'utilization_pct',
        'sla_compliance_pct',
      ]);
    }
  });

  test('builds EBPO salary distribution box plots from employee salary quartiles', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;
    svc.executeDynamicSqlChecked = async () => ({
      rows: [
        {
          name: 'Finance',
          min: 3000,
          q1: 4000,
          median: 5000,
          q3: 6500,
          max: 9000,
        },
      ],
      error: null,
    });

    const plan = await svc.specToPlan(
      {
        measure: 'avg_monthly_salary',
        dimension: 'department',
        chartType: 'box_plot',
      },
      'Salary Distribution by Department',
      true,
      { tenantId: 't', connectionIds: [], externalOrgIds: ['ebpo'] },
      'Create a box plot showing salary distribution by department.',
    );

    expect(plan?.kind).toBe('build');
    if (plan?.kind === 'build') {
      const widget = plan.plan.dashboard.widgets[0] as any;
      expect(widget.type).toBe('box_plot');
      expect(widget._sql).toContain('quantileExact(0.5)');
      expect(widget.display?.valueFormat).toBe('currency');
    }
  });

  test('routes EBPO salary box plots through the semantic extension before spec/free SQL', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;
    const semanticResult = {
      kind: 'build',
      plan: {
        tools_to_execute: [],
        should_generate_dashboard: true,
        dashboard: { title: 'Salary Distribution', description: '', widgets: [] },
        analysis_focus: 'salary distribution',
      },
    };
    svc.orgHasEbpoData = async () => true;
    svc.buildEbpoSemanticPlan = jest.fn(async () => semanticResult);
    svc.generateSpecPlan = jest.fn(async () => {
      throw new Error('generic spec planner should not run');
    });

    const result = await svc.generateSmartPlan(
      'Show salary distribution by department as a box chart.',
      { tenantId: 't', connectionIds: [], externalOrgIds: ['ebpo'] },
    );

    expect(result).toBe(semanticResult);
    expect(svc.buildEbpoSemanticPlan).toHaveBeenCalledTimes(1);
    expect(svc.generateSpecPlan).not.toHaveBeenCalled();
  });

  test('adds box-plot median markers without replacing quartile SQL', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;
    const quartileSql = 'SELECT name, min, q1, median, q3, max FROM salary_quartiles';
    const plan = await svc.generateEditPlan(
      {
        id: 'dash',
        title: 'Salary Distribution',
        widgets: [
          {
            id: 'w1',
            title: 'Salary Distribution by Department',
            chartType: 'box_plot',
            queryConfig: {
              metric: 'dynamic',
              grouping: 'dynamic',
              dynamicSql: quartileSql,
              spec: {
                measure: 'avg_monthly_salary',
                dimension: 'department',
                chartType: 'box_plot',
              },
              display: { valueFormat: 'currency', showDataLabels: false },
            },
            displayOrder: 0,
          },
        ],
      },
      'In the same chart, add median salary markers for each department.',
    );

    expect(plan.modify).toHaveLength(1);
    expect(plan.modify[0]?.dynamicSql).toBe(quartileSql);
    expect(plan.modify[0]?.type).toBe('box_plot');
    expect(plan.modify[0]?.display?.showDataLabels).toBe(true);
  });

  test('adds every available Q99 KPI and skips only unavailable current ratio', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;
    svc.orgHasEbpoData = async () => true;
    svc.executeDynamicSqlChecked = async () => ({
      rows: [{ name: 'Gross Margin %', label: 'Gross Margin %', value: 42, format: 'percent' }],
      error: null,
    });
    const originalMeasures = [
      'gross_margin',
      'total_revenue',
      'total_payroll',
      'free_cash_flow',
      'ar_outstanding',
      'ap_outstanding',
    ];
    const plan = await svc.generateEditPlan(
      {
        id: 'dash',
        title: 'CFO Scorecard',
        widgets: [
          {
            id: 'w1',
            title: 'CFO Scorecard',
            chartType: 'kpi',
            queryConfig: {
              metric: 'dynamic',
              grouping: 'dynamic',
              dynamicSql: 'SELECT name, value FROM existing_scorecard',
              spec: {
                measure: originalMeasures[0],
                measures: originalMeasures,
                dimension: '',
                chartType: 'kpi',
              },
              display: { valueFormat: 'currency' },
            },
            displayOrder: 0,
          },
        ],
      },
      'In the same chart, add KPI cards for current ratio, gross margin percentage, cost per employee, revenue per employee, and free cash flow margin.',
      { tenantId: 't', connectionIds: [], externalOrgIds: ['ebpo'] },
    );

    expect(plan?.refusal).toBeUndefined();
    expect(plan?.summary).toContain('Current Ratio was skipped');
    expect(plan?.modify[0]?.spec?.measures).toEqual([
      ...originalMeasures,
      'gross_margin_pct',
      'cost_per_employee',
      'revenue_per_employee',
      'fcf_margin_pct',
    ]);
    expect(plan?.modify[0]?.dynamicSql).toContain("'Gross Margin %' AS label");
    expect(plan?.modify[0]?.dynamicSql).toContain("'percent' AS format");
    expect(plan?.modify[0]?.dynamicSql).not.toContain('Current Ratio');
  });

  test('builds all four Q100 monthly semantic dashboard sections', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;
    svc.executeDynamicSqlChecked = async () => ({
      rows: [{ name: 'Jan 2025', value: 1 }],
      error: null,
    });
    const plan = await svc.buildEbpoSemanticPlan(
      'Create a dashboard showing monthly liquidity, profitability, employee efficiency, and cash conversion metrics.',
      { tenantId: 't', connectionIds: [], externalOrgIds: ['ebpo'] },
    );

    expect(plan?.kind).toBe('build');
    if (plan?.kind === 'build') {
      expect(plan.plan.dashboard.widgets).toHaveLength(4);
      expect(plan.plan.dashboard.widgets.map((widget: any) => widget.title)).toEqual([
        'Monthly Liquidity',
        'Monthly Profitability',
        'Monthly Employee Efficiency',
        'Monthly Cash Conversion',
      ]);
      expect(
        plan.plan.dashboard.widgets.every(
          (widget: any) => widget.type === 'line' && widget._spec?.dimension === 'month',
        ),
      ).toBe(true);
    }
  });

  test('adds per-series monthly averages to every Q100 dashboard widget atomically', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;
    svc.executeDynamicSqlChecked = async (sql: string) => ({
      rows: sql.includes('Monthly Average')
        ? [{ name: 'Jan 2025', value: 10, 'value | Monthly Average': 9 }]
        : [{ name: 'Jan 2025', value: 10 }],
      error: null,
    });
    const dashboard = {
      id: 'q100',
      title: 'EBPO Executive Dashboard',
      widgets: Array.from({ length: 4 }, (_, index) => ({
        id: `w${index}`,
        title: `Section ${index + 1}`,
        chartType: 'line',
        queryConfig: {
          metric: 'dynamic',
          grouping: 'dynamic',
          dynamicSql: `SELECT name, value FROM section_${index + 1}`,
          spec: { measure: 'total_revenue', dimension: 'month', chartType: 'line' },
          display: { valueFormat: 'currency' },
        },
        displayOrder: index,
      })),
    };
    const plan = await svc.generateEditPlan(
      dashboard,
      'In the same dashboard, add trend indicators comparing each metric against its monthly average.',
      { tenantId: 't', connectionIds: [], externalOrgIds: ['ebpo'] },
    );

    expect(plan.refusal).toBeUndefined();
    expect(plan.modify).toHaveLength(4);
    expect(plan.modify.every((edit: any) => edit.dynamicSql.includes('Monthly Average'))).toBe(
      true,
    );
  });

  test('preserves the Q35 waterfall bridge when adding gross-margin percentage labels', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;
    svc.orgHasEbpoData = async () => true;
    svc.executeDynamicSqlChecked = async () => ({
      rows: [{ name: 'Gross Margin', value: 40, is_total: 1, 'Gross Margin % Label': 40 }],
      error: null,
    });
    const bridgeSql = "SELECT 'Revenue' AS name, 100 AS value, 0 AS is_total";
    const plan = await svc.generateEditPlan(
      {
        id: 'q35',
        title: 'Revenue to Gross Margin',
        widgets: [
          {
            id: 'w1',
            title: 'Revenue to Gross Margin',
            chartType: 'waterfall',
            queryConfig: {
              metric: 'dynamic',
              grouping: 'dynamic',
              dynamicSql: bridgeSql,
              spec: { measure: 'gross_margin', dimension: 'month', chartType: 'waterfall' },
              display: { valueFormat: 'currency' },
            },
            displayOrder: 0,
          },
        ],
      },
      'In the same chart, add gross margin percentage labels for each month.',
      { tenantId: 't', connectionIds: [], externalOrgIds: ['ebpo'] },
    );

    expect(plan.modify[0]?.dynamicSql).toContain(bridgeSql);
    expect(plan.modify[0]?.dynamicSql).toContain('_base.*');
    expect(plan.modify[0]?.display?.labelSeries).toBe('Gross Margin % Label');
    expect(plan.modify[0]?.display?.secondaryAxisFormat).toBe('percent');
  });

  test('builds Q75 asset intensity and adds CSAT at delivery-center grain', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;
    svc.orgHasEbpoData = async () => true;
    svc.executeDynamicSqlChecked = async () => ({
      rows: [{ name: 'Center A', value: 12, asset_intensity: 12, csat_pct: 91 }],
      error: null,
    });
    const scope = { tenantId: 't', connectionIds: [], externalOrgIds: ['ebpo'] };
    const create = await svc.buildEbpoSemanticPlan(
      'Create a bar chart showing asset intensity by delivery center using net book value per call handled.',
      scope,
    );
    expect(create?.kind).toBe('build');
    if (create?.kind !== 'build') return;
    const widget = create.plan.dashboard.widgets[0] as any;
    expect(widget._sql).toContain('net_book_value / nullIf(_operations.calls_handled, 0)');
    expect(widget._spec?.measure).toBe('asset_intensity');

    const edit = await svc.generateEditPlan(
      {
        id: 'q75',
        title: create.plan.dashboard.title,
        widgets: [
          {
            id: 'w1',
            title: widget.title,
            chartType: widget.type,
            queryConfig: {
              metric: widget.metric,
              grouping: widget.grouping,
              dynamicSql: widget._sql,
              spec: widget._spec,
              display: widget.display,
            },
            displayOrder: 0,
          },
        ],
      },
      'In the same chart, add CSAT percentage as a line.',
      scope,
    );
    expect(edit.refusal).toBeUndefined();
    expect(edit.modify[0]?.type).toBe('combo');
    expect(edit.modify[0]?.dynamicSql).toContain('avg(csat_pct)');
    expect(edit.modify[0]?.display?.secondaryAxisFormat).toBe('percent');
  });

  test('sizes utilization-vs-employee bubbles by allocated payroll cost', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;
    svc.executeDynamicSqlChecked = async () => ({
      rows: [{ name: 'Center A', x: 82, y: 120, z: 900000 }],
      error: null,
    });

    const plan = await svc.buildEbpoMetricEdit(
      {
        id: 'dash',
        title: 'Dashboard',
        widgets: [
          {
            id: 'w1',
            title: 'Utilization vs Employee Count by Delivery Center',
            chartType: 'scatter',
            queryConfig: {
              metric: 'dynamic',
              grouping: 'dynamic',
              spec: {
                measure: 'utilization_pct',
                measures: ['utilization_pct', 'employee_count'],
                dimension: 'delivery_center',
                chartType: 'scatter',
              },
              display: { valueFormat: 'percent' },
            },
            displayOrder: 0,
          },
        ],
      },
      'In the same chart, size bubbles by payroll cost.',
      { tenantId: 't', connectionIds: [], externalOrgIds: ['ebpo'] },
    );

    expect(plan.modify).toHaveLength(1);
    expect(plan.modify[0]?.type).toBe('bubble');
    expect(plan.modify[0]?.spec?.measures).toEqual([
      'utilization_pct',
      'employee_count',
      'total_payroll',
    ]);
    expect(plan.modify[0]?.yAxisLabel).toBe('Employee Count');
  });

  test('resolves explicit chart deletion without invoking the model editor', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;
    const dashboard = {
      id: 'dash',
      title: 'Dashboard',
      widgets: [
        {
          id: 'w1',
          title: 'Monthly Revenue',
          chartType: 'bar',
          queryConfig: { metric: 'revenue', grouping: 'month' },
          displayOrder: 0,
        },
        {
          id: 'w2',
          title: 'Vendor Spend',
          chartType: 'treemap',
          queryConfig: { metric: 'expense', grouping: 'vendor' },
          displayOrder: 1,
        },
      ],
    };

    const latest = await svc.generateEditPlan(dashboard, 'delete the latest chart');
    expect(latest.remove_indices).toEqual([1]);
    expect(latest.summary).toContain('Vendor Spend');

    const byTitle = await svc.generateEditPlan(dashboard, 'remove the revenue chart');
    expect(byTitle.remove_indices).toEqual([0]);
    expect(byTitle.summary).toContain('Monthly Revenue');

    const byTitleWithoutChartWord = await svc.generateEditPlan(dashboard, 'delete Monthly Revenue');
    expect(byTitleWithoutChartWord.remove_indices).toEqual([0]);

    const byVersion = await svc.generateEditPlan(dashboard, 'delete v1');
    expect(byVersion.remove_indices).toEqual([0]);
  });

  test('refuses ambiguous chart deletion when multiple charts are active', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;
    const plan = await svc.generateEditPlan(
      {
        id: 'dash',
        title: 'Dashboard',
        widgets: [
          {
            id: 'w1',
            title: 'Monthly Revenue',
            chartType: 'bar',
            queryConfig: { metric: 'revenue', grouping: 'month' },
            displayOrder: 0,
          },
          {
            id: 'w2',
            title: 'Vendor Spend',
            chartType: 'treemap',
            queryConfig: { metric: 'expense', grouping: 'vendor' },
            displayOrder: 1,
          },
        ],
      },
      'delete this chart',
    );

    expect(plan.refusal).toContain('Which chart should I delete?');
    expect(plan.refusal).toContain('Monthly Revenue');
    expect(plan.refusal).toContain('Vendor Spend');
    expect(plan.remove_indices).toHaveLength(0);
  });

  test('explains delete requests when the live dashboard has no active charts', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;
    const plan = await svc.generateEditPlan(
      {
        id: 'dash',
        title: 'Dashboard',
        widgets: [],
      },
      'delete v1',
    );

    expect(plan.refusal).toContain('There are no active charts to delete');
    expect(plan.refusal).toContain('history only');
  });
});
