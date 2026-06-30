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

  test('does not treat non-time largest-client distribution asks as implicit 8-month trends', () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const parser = AgentService.prototype as any;

    expect(
      parser.superlativeClientAskImpliesTimeAxis(
        'create a donut chart showing expense distribution for the largest client',
        'donut',
        'client',
      ),
    ).toBe(false);

    expect(
      parser.superlativeClientAskImpliesTimeAxis(
        'create a line chart showing monthly revenue trend for the largest client',
        'line',
        'client',
      ),
    ).toBe(true);
  });

  test('keeps top-N client revenue-vs-expense comparisons categorical when the time window is only a filter', () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const parser = AgentService.prototype as any;

    expect(
      parser.topNClientComparisonShouldStayCategorical(
        'generate a clustered column chart comparing revenue and expenses for the top 10 clients over the last 8 months',
        {
          measure: 'total_revenue',
          measures: ['total_revenue', 'total_cost'],
          dimension: 'month',
          breakdown: 'client',
          topN: 10,
          chartType: 'bar',
          recentMonths: 8,
        },
      ),
    ).toBe(true);

    expect(
      parser.topNClientComparisonShouldStayCategorical(
        'generate a line chart comparing revenue and expenses for the top 10 clients by month over the last 8 months',
        {
          measure: 'total_revenue',
          measures: ['total_revenue', 'total_cost'],
          dimension: 'month',
          breakdown: 'client',
          topN: 10,
          chartType: 'line',
          recentMonths: 8,
        },
      ),
    ).toBe(false);
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

  test('detects EBPO data when the revenue monthly probe is empty but another EBPO view has rows', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;
    const probedViews: string[] = [];
    svc.queryRows = async (sql: string) => {
      probedViews.push(sql);
      if (sql.includes('v_ebpo_revenue_monthly')) return [{ n: 0 }];
      if (sql.includes('v_ebpo_operations_monthly')) return [{ n: 9 }];
      return [{ n: 0 }];
    };

    await expect(
      svc.orgHasEbpoData({ tenantId: 'tenant-1', externalOrgIds: ['org-1'] }),
    ).resolves.toBe(true);
    expect(probedViews.some((sql) => sql.includes('v_ebpo_operations_monthly'))).toBe(true);
  });

  test('prefers overtime percentage over raw payroll for overtime-per-payroll follow-ups', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const parser = AgentService.prototype as any;
    const next = parser.buildEbpoComboEditSpec(
      {
        measure: 'total_overtime',
        measures: null,
        dimension: 'department',
        chartType: 'bar',
      },
      'In the same chart, add overtime as a percentage of total payroll.',
    );

    expect(next?.chartType).toBe('combo');
    expect(next?.measures).toContain('overtime_to_payroll_pct');
    expect(next?.measures).not.toContain('total_payroll');
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

  test('highlights the largest client on grouped revenue-vs-expense bars using row categories', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;
    svc.executeDynamicSqlChecked = async () => ({
      rows: [
        { name: 'AT&T', 'Total Revenue': 4843090, 'Total Cost': 3009796.24 },
        { name: 'Dell', 'Total Revenue': 4473155, 'Total Cost': 2997605.14 },
        { name: 'United Health Group', 'Total Revenue': 4285161, 'Total Cost': 2801613.21 },
      ],
      error: null,
    });

    const plan = await svc.buildNamedHighlightEditPlan(
      [
        {
          index: 0,
          w: {
            chartType: 'bar',
            queryConfig: {
              dynamicSql: 'SELECT name, "Total Revenue", "Total Cost" FROM fake',
              display: { valueFormat: 'currency' },
            },
          },
          spec: {
            measure: 'total_revenue',
            measures: ['total_revenue', 'total_cost'],
            dimension: 'client',
            chartType: 'bar',
          },
        },
      ],
      'In the same chart, highlight the largest client.',
      { tenantId: 't', connectionIds: [], externalOrgIds: ['ebpo'] },
    );

    expect(plan?.modify).toHaveLength(1);
    expect(plan?.modify[0]?.display?.highlightNames).toEqual(['AT&T']);
    expect(plan?.summary).toContain('AT&T');
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

  test('treats treemap contribution follow-ups as percent label edits', () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const parser = AgentService.prototype as any;
    expect(parser.detectLabelModeEdit('In the same chart, show contribution percentages.')).toBe(
      'percent',
    );
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

  test('combo follow-ups reuse semantic ratio-of-sums math for payroll-to-revenue', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;
    svc.executeDynamicSqlChecked = async () => ({
      rows: [{ name: 'Jan 2024', total_revenue: 1000, payroll_to_revenue_pct: 85.1 }],
      error: null,
    });

    const plan = await svc.buildEbpoMetricEdit(
      {
        id: 'dash',
        title: 'Dashboard',
        widgets: [
          {
            id: 'w1',
            title: 'Total Revenue by Month',
            chartType: 'bar',
            queryConfig: {
              metric: 'dynamic',
              grouping: 'dynamic',
              spec: { measure: 'total_revenue', dimension: 'month', chartType: 'bar' },
              display: { valueFormat: 'currency' },
            },
            displayOrder: 0,
          },
        ],
      },
      'In the same chart, add payroll-to-revenue ratio as a second line.',
      { tenantId: 't', connectionIds: [], externalOrgIds: ['ebpo'] },
    );

    expect(plan.modify).toHaveLength(1);
    expect(plan.modify[0]?.type).toBe('line');
    expect(plan.modify[0]?.dynamicSql).toContain(
      'sum(total_payroll_usd) / nullIf(sum(total_revenue_usd), 0) * 100',
    );
    expect(plan.modify[0]?.dynamicSql).not.toContain('avg(payroll_to_revenue_pct)');
  });

  test('combo follow-ups reuse semantic ratio-of-sums math for collection rate', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;
    svc.executeDynamicSqlChecked = async () => ({
      rows: [{ name: 'Client A', total_revenue: 1000, collection_rate_pct: 84.3 }],
      error: null,
    });

    const plan = await svc.buildEbpoMetricEdit(
      {
        id: 'dash',
        title: 'Dashboard',
        widgets: [
          {
            id: 'w1',
            title: 'Total Revenue by Client',
            chartType: 'bar',
            queryConfig: {
              metric: 'dynamic',
              grouping: 'dynamic',
              spec: { measure: 'total_revenue', dimension: 'client', chartType: 'bar' },
              display: { valueFormat: 'currency' },
            },
            displayOrder: 0,
          },
        ],
      },
      'In the same chart, add collection rate as a second line.',
      { tenantId: 't', connectionIds: [], externalOrgIds: ['ebpo'] },
    );

    expect(plan.modify).toHaveLength(1);
    expect(plan.modify[0]?.type).toBe('line');
    expect(plan.modify[0]?.dynamicSql).toContain(
      'sum(collected_amount_usd) / nullIf(sum(invoice_amount_usd), 0) * 100',
    );
    expect(plan.modify[0]?.dynamicSql).not.toContain('avg(collection_rate_pct)');
  });

  test('combo follow-ups reuse semantic ratio-of-sums math for DSO', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;
    svc.executeDynamicSqlChecked = async () => ({
      rows: [{ name: 'Jan 2024', total_revenue: 1000, dso_days: 37.0 }],
      error: null,
    });

    const plan = await svc.buildEbpoMetricEdit(
      {
        id: 'dash',
        title: 'Dashboard',
        widgets: [
          {
            id: 'w1',
            title: 'Total Revenue by Month',
            chartType: 'bar',
            queryConfig: {
              metric: 'dynamic',
              grouping: 'dynamic',
              spec: { measure: 'total_revenue', dimension: 'month', chartType: 'bar' },
              display: { valueFormat: 'currency' },
            },
            displayOrder: 0,
          },
        ],
      },
      'In the same chart, add DSO as a second line.',
      { tenantId: 't', connectionIds: [], externalOrgIds: ['ebpo'] },
    );

    expect(plan.modify).toHaveLength(1);
    expect(plan.modify[0]?.type).toBe('line');
    expect(plan.modify[0]?.dynamicSql).toContain(
      'sum(ar_outstanding_usd) / nullIf(sum(total_revenue_usd), 0) * 365',
    );
    expect(plan.modify[0]?.dynamicSql).not.toContain('avg(dso_days)');
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

  test('rebuilds cash-flow component percentage follow-ups as a real component-share chart', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;
    svc.executeDynamicSqlChecked = async () => ({
      rows: [
        {
          name: 'Jan 2025',
          'Operating Cash Flow %': 52.4,
          'Investing Cash Flow %': 21.1,
          'Financing Cash Flow %': 26.5,
        },
      ],
      error: null,
    });

    const plan = await svc.buildEbpoComboEditPlan(
      [
        {
          index: 0,
          w: { chartType: 'stacked_bar', title: 'Financing Cash Flow', queryConfig: {} },
          spec: { measure: 'financing_cf', dimension: 'month', chartType: 'stacked_bar' },
        },
      ],
      'In the same chart, display contribution percentages of each cash flow component.',
      { tenantId: 't', connectionIds: [], externalOrgIds: ['ebpo'] },
    );

    expect(plan?.modify).toHaveLength(1);
    expect(plan?.modify[0]?.type).toBe('stacked_bar');
    expect(plan?.modify[0]?.title).toBe('Cash Flow Component Contribution by Month');
    expect(plan?.modify[0]?.display).toEqual(
      expect.objectContaining({ valueFormat: 'percent', valueDecimals: 1 }),
    );
    expect(plan?.modify[0]?.dynamicSql ?? '').toContain('Operating Cash Flow %');
    expect(plan?.modify[0]?.dynamicSql ?? '').toContain('Investing Cash Flow %');
    expect(plan?.modify[0]?.dynamicSql ?? '').toContain('Financing Cash Flow %');
  });

  test('rebuilds gross-margin-by-industry follow-ups with revenue yoy growth from the monthly client industry view', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;
    svc.executeDynamicSqlChecked = async () => ({
      rows: [
        {
          name: 'Banking BPO',
          'Gross Margin': 1200000,
          'Revenue YoY Growth %': 24.5,
        },
      ],
      error: null,
    });

    const plan = await svc.buildEbpoComboEditPlan(
      [
        {
          index: 0,
          w: { chartType: 'stacked_bar', title: 'Gross Margin by Industry', queryConfig: {} },
          spec: { measure: 'gross_margin', dimension: 'industry', chartType: 'stacked_bar' },
        },
      ],
      'In the same chart, add revenue YoY growth.',
      { tenantId: 't', connectionIds: [], externalOrgIds: ['ebpo'] },
    );

    expect(plan?.modify).toHaveLength(1);
    expect(plan?.modify[0]?.type).toBe('combo');
    expect(plan?.modify[0]?.display).toEqual(
      expect.objectContaining({
        valueFormat: 'currency',
        secondaryAxisFormat: 'percent',
        secondaryLabel: 'Revenue YoY Growth %',
      }),
    );
    expect(plan?.modify[0]?.dynamicSql ?? '').toContain('v_ebpo_revenue_expense_by_client_monthly');
    expect(plan?.modify[0]?.dynamicSql ?? '').toContain('Revenue YoY Growth %');
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

  test('prefers the existing percent series for payroll percentage reference-line follow-ups', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;
    svc.orgHasEbpoData = async () => true;
    svc.executeDynamicSqlChecked = async () => ({
      rows: [
        {
          name: 'Jan 2025',
          'Total Revenue': 1000,
          'Payroll / Revenue %': 84.1,
          'Payroll / Revenue % Average': 82.7,
        },
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
            title: 'Monthly Revenue and Payroll % of Revenue',
            chartType: 'combo',
            queryConfig: {
              metric: 'dynamic',
              grouping: 'dynamic',
              spec: {
                measure: 'total_revenue',
                measures: ['total_revenue', 'payroll_to_revenue_pct'],
                dimension: 'month',
                chartType: 'combo',
              },
              display: {
                valueFormat: 'currency',
                series: [
                  { key: 'Total Revenue', role: 'bar', axis: 'left', format: 'currency' },
                  { key: 'Payroll / Revenue %', role: 'line', axis: 'right', format: 'percent' },
                ],
                secondaryAxisFormat: 'percent',
                secondaryLabel: 'Payroll / Revenue %',
              },
            },
            displayOrder: 0,
          },
        ],
      },
      'In the same chart, add an average payroll percentage reference line.',
      { tenantId: 't', connectionIds: [], externalOrgIds: ['ebpo'] },
    );

    expect(plan.modify).toHaveLength(1);
    expect(plan.summary).toContain('average payroll / revenue %');
    expect(plan.modify[0]?.display?.referenceSeries).toBe('Payroll / Revenue % Average');
    expect(plan.modify[0]?.dynamicSql).toContain('Payroll / Revenue % Average');
    expect(plan.modify[0]?.dynamicSql).toContain('avg(_base."Payroll / Revenue %")');
  });

  test('falls back to display series when a combo chart spec only stores the primary measure', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;
    svc.orgHasEbpoData = async () => true;
    svc.executeDynamicSqlChecked = async () => ({
      rows: [
        {
          name: 'Jan 2025',
          'Total Revenue': 1000,
          'Payroll / Revenue %': 84.1,
          'Payroll / Revenue % Average': 82.7,
        },
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
            title: 'Monthly Revenue and Payroll % of Revenue',
            chartType: 'combo',
            queryConfig: {
              metric: 'dynamic',
              grouping: 'dynamic',
              spec: {
                measure: 'total_revenue',
                dimension: 'month',
                chartType: 'combo',
              },
              display: {
                valueFormat: 'currency',
                series: [
                  { key: 'Total Revenue', role: 'bar', axis: 'left', format: 'currency' },
                  { key: 'Payroll / Revenue %', role: 'line', axis: 'right', format: 'percent' },
                ],
                secondaryAxisFormat: 'percent',
                secondaryLabel: 'Payroll / Revenue %',
              },
            },
            displayOrder: 0,
          },
        ],
      },
      'In the same chart, add an average payroll percentage reference line.',
      { tenantId: 't', connectionIds: [], externalOrgIds: ['ebpo'] },
    );

    expect(plan.modify).toHaveLength(1);
    expect(plan.summary).toContain('average payroll / revenue %');
    expect(plan.modify[0]?.display?.referenceSeries).toBe('Payroll / Revenue % Average');
  });

  test('breaks department payroll into payroll components instead of a fake month regroup', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;
    svc.orgHasEbpoData = async () => true;
    svc.specToPlan = async (_spec: any) => ({
      kind: 'build',
      plan: {
        dashboard: {
          widgets: [
            {
              type: 'stacked_bar',
              _sql: 'SELECT name, `Base Salary`, `Overtime`, `Bonus`, `Benefits` FROM payroll_breakdown',
            },
          ],
        },
      },
    });

    const plan = await svc.generateEditPlan(
      {
        id: 'dash',
        title: 'Dashboard',
        widgets: [
          {
            id: 'w1',
            title: 'Total Payroll Cost by Department',
            chartType: 'bar',
            queryConfig: {
              metric: 'dynamic',
              grouping: 'dynamic',
              spec: { measure: 'total_payroll', dimension: 'department', chartType: 'bar' },
              display: { valueFormat: 'currency' },
            },
            displayOrder: 0,
          },
        ],
      },
      'Can you break down each department’s payroll cost',
      { tenantId: 't', connectionIds: [], externalOrgIds: ['ebpo'] },
    );

    expect(plan.modify).toHaveLength(1);
    expect(plan.summary).toContain('base salary, overtime, bonus, and benefits');
    expect(plan.modify[0]?.type).toBe('stacked_bar');
    expect(plan.modify[0]?.spec?.measures).toEqual([
      'total_base_salary',
      'total_overtime',
      'total_bonus',
      'total_benefits',
    ]);
  }, 10000);

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
    expect(plan.modify[0]?.dynamicSql).toContain(
      'sum(total_monthly_salary_usd) / nullIf(sum(employee_count), 0)',
    );
    expect(plan.modify[0]?.dynamicSql).not.toContain('avg(avg_monthly_salary_usd)');
  });

  test('refuses named average reference lines when the requested measure is unavailable at the current grouping', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;

    const plan = await svc.buildEbpoMetricEdit(
      {
        id: 'dash',
        title: 'Dashboard',
        widgets: [
          {
            id: 'w1',
            title: 'Calls Handled by Country',
            chartType: 'bar',
            queryConfig: {
              metric: 'dynamic',
              grouping: 'dynamic',
              // a genuinely valid operations-by-geography chart; gross margin is NOT
              // available at this grouping (revenue/margin have no geography relationship)
              spec: { measure: 'calls_handled', dimension: 'country', chartType: 'bar' },
              display: { valueFormat: 'number' },
            },
            displayOrder: 0,
          },
        ],
      },
      'In the same chart, add an average gross margin line.',
      { tenantId: 't', connectionIds: [], externalOrgIds: ['ebpo'] },
    );

    expect(plan?.modify ?? []).toHaveLength(0);
    expect(plan?.refusal).toMatch(/gross margin/i);
  });

  test('normalizes asset-type share follow-ups instead of plotting raw currency bars', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;
    svc.executeDynamicSqlChecked = async () => ({
      rows: [
        { name: 'Server', 'Asset Cost': 29.1, 'Net Book Value': 24.6 },
        { name: 'Laptop', 'Asset Cost': 18.5, 'Net Book Value': 15.0 },
      ],
      error: null,
    });

    const plan = await svc.buildEbpoMetricEdit(
      {
        id: 'dash',
        title: 'Dashboard',
        widgets: [
          {
            id: 'w1',
            title: 'Asset Cost Share by Asset Type',
            chartType: 'donut',
            queryConfig: {
              metric: 'dynamic',
              grouping: 'dynamic',
              spec: { measure: 'asset_cost', dimension: 'asset_type', chartType: 'donut' },
              display: { valueFormat: 'currency' },
            },
            displayOrder: 0,
          },
        ],
      },
      'In the same chart, add net book value share by asset type.',
      { tenantId: 't', connectionIds: [], externalOrgIds: ['ebpo'] },
    );

    expect(plan.modify).toHaveLength(1);
    expect(plan.modify[0]?.type).toBe('combo');
    expect(plan.modify[0]?.dynamicSql).toContain('sum(asset_cost) OVER ()');
    expect(plan.modify[0]?.dynamicSql).toContain('sum(net_book_value) OVER ()');
    expect(plan.modify[0]?.yAxisLabel).toBe('% share');
    expect(plan.modify[0]?.display?.valueFormat).toBe('percent');
    expect(plan.modify[0]?.display?.series).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'Asset Cost', format: 'percent' }),
        expect.objectContaining({ key: 'Net Book Value', format: 'percent' }),
      ]),
    );
  });

  test('rings the highest slice on donut highlight follow-ups instead of using a hidden name highlight', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;
    svc.executeDynamicSqlChecked = async () => ({
      rows: [
        { name: 'Telecom Support', value: 27.3 },
        { name: 'IT Helpdesk', value: 19.5 },
        { name: 'Banking BPO', value: 18.0 },
      ],
      error: null,
    });

    const plan = await svc.buildNamedHighlightEditPlan(
      [
        {
          index: 0,
          w: {
            chartType: 'donut',
            queryConfig: {
              dynamicSql: 'SELECT name, value FROM t',
              display: {},
            },
          },
          spec: { dimension: 'business_unit', chartType: 'donut' },
        },
      ],
      'In the same chart, highlight the highest gross margin.',
      { tenantId: 't', connectionIds: [], externalOrgIds: ['ebpo'] },
    );

    expect(plan?.modify).toHaveLength(1);
    expect(plan?.modify[0]?.display).toEqual(
      expect.objectContaining({ highlightExtremes: 'max' }),
    );
  });

  test('rebuilds same-chart country comparisons as a monthly country trend', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;
    let capturedSpec: any = null;
    svc.specToPlan = async (spec: any) => {
      capturedSpec = spec;
      return {
        kind: 'build',
        plan: {
          dashboard: {
            widgets: [
              {
                type: 'line',
                _sql: 'SELECT 1 AS name, 1 AS value',
                display: {},
              },
            ],
          },
        },
      };
    };

    const plan = await svc.buildEbpoMetricEdit(
      {
        id: 'dash',
        title: 'Dashboard',
        widgets: [
          {
            id: 'w1',
            title: 'Utilization by Delivery Center',
            chartType: 'line',
            queryConfig: {
              metric: 'dynamic',
              grouping: 'dynamic',
              spec: {
                measure: 'utilization_pct',
                dimension: 'delivery_center',
                chartType: 'line',
              },
              display: { valueFormat: 'percent' },
            },
            displayOrder: 0,
          },
        ],
      },
      'In the same chart, compare countries.',
      { tenantId: 't', connectionIds: [], externalOrgIds: ['ebpo'] },
    );

    expect(plan?.modify).toHaveLength(1);
    expect(capturedSpec).toEqual(
      expect.objectContaining({
        dimension: 'month',
        breakdown: 'country',
        recentMonths: 8,
      }),
    );
  });

  test('preserves pie or donut label-mode follow-ups across deterministic edit paths', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;
    svc.orgHasEbpoData = async () => true;
    svc.buildEbpoMetricEdit = async () => ({
      summary: 'Updated the donut chart.',
      add: [],
      remove_indices: [],
      modify: [
        {
          index: 0,
          dynamicSql: 'SELECT category AS name, amount AS value FROM some_view',
          type: 'donut',
          display: { valueFormat: 'currency' },
        },
      ],
    });

    const plan = await svc.generateEditPlan(
      {
        id: 'dash',
        title: 'Dashboard',
        widgets: [
          {
            id: 'w1',
            title: 'Asset Mix',
            chartType: 'donut',
            queryConfig: {
              metric: 'dynamic',
              grouping: 'query',
              dynamicSql: 'SELECT category AS name, amount AS value FROM some_view',
              display: { labelMode: 'percent', valueFormat: 'currency' },
            },
            displayOrder: 0,
          },
        ],
      },
      'show values instead of percentages',
      { tenantId: 't', connectionIds: [], externalOrgIds: ['ebpo'] },
    );

    expect(plan.modify).toHaveLength(1);
    expect(plan.modify[0]?.display).toEqual(
      expect.objectContaining({
        valueFormat: 'currency',
        labelMode: 'value',
      }),
    );
  });

  test('colors fixed-asset treemaps by depreciation percentage without changing size metric', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;
    svc.executeDynamicSqlChecked = async () => ({
      rows: [
        { name: 'Mumbai Delivery Center / Server', value: 35800, depreciation_pct: 52.4 },
        { name: 'Warsaw SSC / Laptop', value: 32100, depreciation_pct: 34.1 },
      ],
      error: null,
    });

    const plan = await svc.buildEbpoMetricEdit(
      {
        id: 'dash',
        title: 'Dashboard',
        widgets: [
          {
            id: 'w1',
            title: 'Net Book Value by Delivery Center and Asset Type',
            chartType: 'treemap',
            queryConfig: {
              metric: 'dynamic',
              grouping: 'dynamic',
              spec: {
                measure: 'net_book_value',
                dimension: 'delivery_center',
                breakdown: 'asset_type',
                chartType: 'treemap',
              },
              display: { valueFormat: 'currency' },
            },
            displayOrder: 0,
          },
        ],
      },
      'In the same chart, color the treemap by depreciation percentage.',
      { tenantId: 't', connectionIds: [], externalOrgIds: ['ebpo'] },
    );

    expect(plan.modify).toHaveLength(1);
    expect(plan.modify[0]?.type).toBe('treemap');
    expect(plan.modify[0]?.dynamicSql).toContain('AS value');
    expect(plan.modify[0]?.dynamicSql).toContain('AS depreciation_pct');
    expect(plan.modify[0]?.dynamicSql).toContain('GROUP BY delivery_center, asset_type');
    expect(plan.modify[0]?.display).toMatchObject({
      valueFormat: 'currency',
      colorMetric: 'depreciation_pct',
      colorMetricLabel: 'Depreciation %',
      colorMetricFormat: 'percent',
    });
  });

  test('adds net book value labels to depreciation bars without replacing the percent bars', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;
    svc.executeDynamicSqlChecked = async (_sql: string, _scope: unknown, expectedType: string) => ({
      rows: [
        { name: 'NY HQ', value: 31.8, 'Net Book Value Label': 24300 },
        { name: 'LA Delivery Center', value: 29.5, 'Net Book Value Label': 24700 },
      ],
      error: null,
      expectedType,
    });

    const plan = await svc.buildEbpoMetricEdit(
      {
        id: 'dash',
        title: 'Dashboard',
        widgets: [
          {
            id: 'w1',
            title: 'Delivery Centers by Depreciation %',
            chartType: 'bar',
            queryConfig: {
              metric: 'dynamic',
              grouping: 'dynamic',
              spec: { measure: 'depreciation_pct', dimension: 'delivery_center', chartType: 'bar' },
              display: { valueFormat: 'percent', valueDecimals: 1 },
            },
            displayOrder: 0,
          },
        ],
      },
      'In the same chart, add net book value labels.',
      { tenantId: 't', connectionIds: [], externalOrgIds: ['ebpo'] },
    );

    expect(plan.modify).toHaveLength(1);
    expect(plan.modify[0]?.type).toBe('bar');
    expect(plan.modify[0]?.dynamicSql).toContain('_labels.value AS "Net Book Value Label"');
    expect(plan.modify[0]?.display).toMatchObject({
      valueFormat: 'percent',
      labelSeries: 'Net Book Value Label',
      labelFormat: 'currency',
    });
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

  test('does NOT route revenue-by-geography anywhere (no geography relationship)', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const parser = AgentService.prototype as any;
    const regionWidgets = parser.selectWidgetsForQuery(
      'Generate a stacked column chart showing revenue by region',
    );
    const countryWidgets = parser.selectWidgetsForQuery(
      'Generate a stacked column chart showing revenue by country',
    );

    // FactRevenue has no geography key. No widget may be a revenue (or fabricated
    // allocated_revenue) measure grouped by a geography dimension.
    const geoGroupings = ['region', 'country', 'city', 'delivery_center'];
    const hasGeoRevenue = (widgets: any[]) =>
      (widgets ?? []).some(
        (w) =>
          (w?.metric === 'allocated_revenue' ||
            (w?.metric === 'revenue' && geoGroupings.includes(w?.grouping))) ,
      );
    expect(hasGeoRevenue(regionWidgets)).toBe(false);
    expect(hasGeoRevenue(countryWidgets)).toBe(false);
  });

  test('does not detect a revenue measure for revenue-by-geography (allocated_revenue removed)', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;
    expect(
      svc.detectEbpoMeasureMentions('Create a stacked column chart showing revenue by country'),
    ).not.toContain('allocated_revenue');
    expect(
      svc.detectEbpoMeasureMentions('Generate a bar chart showing revenue by region'),
    ).not.toContain('allocated_revenue');
  });

  test('detects cumulative revenue follow-ups as the YTD overlay series', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;
    expect(
      svc.detectEbpoMeasureMentions('In the same chart, show cumulative revenue.'),
    ).toContain('revenue_ytd');
  });

  test('treats same-chart show follow-ups as additive combo edits', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;

    expect(
      svc.buildEbpoComboEditSpec(
        {
          measure: 'total_revenue',
          dimension: 'month',
          chartType: 'area',
        },
        'In the same chart, show cumulative revenue.',
      ),
    ).toEqual(
      expect.objectContaining({
        measure: 'total_revenue',
        measures: expect.arrayContaining(['total_revenue', 'revenue_ytd']),
      }),
    );

    expect(
      svc.buildEbpoComboEditSpec(
        {
          measure: 'total_revenue',
          measures: ['total_revenue', 'gross_margin'],
          dimension: 'month',
          chartType: 'combo',
        },
        'In the same chart, show YoY growth percentage.',
      ),
    ).toEqual(
      expect.objectContaining({
        measure: 'total_revenue',
        measures: expect.arrayContaining([
          'total_revenue',
          'gross_margin',
          'revenue_yoy_pct',
        ]),
      }),
    );
  });

  test('does not add cumulative revenue when the chart already uses revenue YTD', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;

    expect(
      svc.buildEbpoComboEditSpec(
        {
          measure: 'revenue_ytd',
          dimension: 'month',
          chartType: 'area',
        },
        'In the same chart, show cumulative revenue.',
      ),
    ).toBeNull();
  });

  test('builds a real cumulative trend for a non-cumulative chart follow-up', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;
    svc.executeDynamicSqlChecked = async () => ({
      rows: [
        { name: 'Client A', gross_margin: 100 },
        { name: 'Client B', gross_margin: 200 },
      ],
      error: null,
    });

    const plan = await svc.buildEbpoMetricEdit(
      {
        id: 'dash',
        title: 'Gross Margin by Client',
        widgets: [
          {
            id: 'w1',
            title: 'Gross Margin by Client',
            chartType: 'scatter',
            queryConfig: {
              metric: 'dynamic',
              grouping: 'dynamic',
              spec: { measure: 'gross_margin_pct', dimension: 'client', chartType: 'scatter' },
              display: { valueFormat: 'percent' },
            },
            displayOrder: 0,
          },
        ],
      },
      'In the same chart, display cumulative gross margin.',
      { tenantId: 't', connectionIds: [], externalOrgIds: ['ebpo'] },
    );

    expect(plan.modify).toHaveLength(1);
    expect(plan.modify[0]?.type).toBe('line');
    expect(plan.modify[0]?.dynamicSql).toContain('sum(_b.`value`) OVER');
    expect(plan.modify[0]?.title).toContain('Cumulative Gross Margin');
  });

  test('recognizes same-chart follow-ups that require an existing live chart', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;

    expect(
      svc.referencesExistingChart('In the same chart, add average SLA as a benchmark line.'),
    ).toBe(true);
    expect(
      svc.referencesExistingChart('Generate a bar chart showing SLA by country.'),
    ).toBe(false);
  });

  test('refuses EBITDA by business unit because payroll has no business-unit grain', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;
    svc.orgHasEbpoData = async () => true;
    const plan = await svc.generateSmartPlan(
      'Generate a bar chart showing EBITDA by business unit',
      { tenantId: 't', connectionIds: [], externalOrgIds: ['ebpo'] },
    );

    expect(plan?.kind).toBe('no_data');
    expect((plan as any)?.message ?? '').toContain('payroll is not booked by business unit');
  });

  test('offers truthful alternatives for largest-client department expense asks instead of a dead-end refusal', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;
    svc.orgHasEbpoData = async () => true;

    const plan = await svc.generateSmartPlan(
      'Create a stacked bar chart showing expense breakdown for the largest client by department',
      { tenantId: 't', connectionIds: [], externalOrgIds: ['ebpo'] },
    );

    expect(plan?.kind).toBe('clarify');
    expect(plan?.clarification?.question ?? '').toContain("can't scope department expenses");
    expect(plan?.clarification?.options?.map((o: any) => o.label)).toEqual([
      'Company expenses by department',
      'Payroll by department',
      'Largest client revenue and cost',
    ]);
  });

  test('refuses revenue-versus-expenses by client instead of plotting total cost as expenses', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;
    svc.executeDynamicSqlChecked = async () => ({
      rows: [{ name: 'Dell', x: 54132993.54, y: 1056451 }],
      error: null,
    });

    const plan = await svc.specToPlan(
      {
        measure: 'total_revenue',
        measures: ['total_revenue', 'total_cost'],
        dimension: 'client',
        chartType: 'scatter',
        recentMonths: 8,
      },
      'Revenue vs Expenses by Client',
      true,
      { tenantId: 't', connectionIds: [], externalOrgIds: ['ebpo'] },
      'Generate a scatter chart showing revenue versus expenses for all clients over the last 8 months',
    );

    expect(plan?.kind).toBe('build');
    if (plan?.kind !== 'build') return;
    const widget = plan.plan.dashboard.widgets[0] as any;
    expect(widget._spec?.measures).toEqual(['total_revenue', 'total_expenses']);
    expect(widget._sql).toContain('v_ebpo_revenue_expense_by_client_monthly');
    expect(widget._sql).toContain('sum(total_expenses_usd)');
  });

  test('refuses largest-client monthly revenue and expenses instead of substituting total cost', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;
    svc.listTopClientsForScope = async () => ['AT&T'];
    svc.executeDynamicSqlChecked = async () => ({
      rows: [{ name: 'Jan 2025', TotalRevenue: 1000, TotalExpenses: 5000 }],
      error: null,
    });

    const plan = await svc.specToPlan(
      {
        measure: 'total_revenue',
        measures: ['total_revenue', 'total_cost'],
        dimension: 'month',
        chartType: 'stacked_bar',
        filters: [{ dimension: 'client', op: 'in', values: ['largest client'] }],
      },
      'Monthly Revenue and Expenses — Largest Client',
      true,
      { tenantId: 't', connectionIds: [], externalOrgIds: ['ebpo'] },
      'Create a stacked column chart showing monthly revenue and expenses for the largest client',
    );

    expect(plan?.kind).toBe('build');
    if (plan?.kind !== 'build') return;
    const widget = plan.plan.dashboard.widgets[0] as any;
    expect(widget._spec?.measures).toEqual(['total_revenue', 'total_expenses']);
    expect(widget._sql).toContain('v_ebpo_revenue_expense_by_client_monthly');
    expect(widget._sql).toContain('sum(total_expenses_usd)');
    expect(widget._spec?.recentMonths).toBeUndefined();
  });

  test('does not force an 8-month window onto largest-client gross-profit-vs-expenses trends', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;
    svc.listTopClientsForScope = async () => ['JP Morgan'];
    svc.executeDynamicSqlChecked = async () => ({
      rows: [{ name: 'Jan 2025', GrossMargin: 4000, TotalExpenses: 7000 }],
      error: null,
    });

    const plan = await svc.specToPlan(
      {
        measure: 'gross_margin',
        measures: ['gross_margin', 'total_expenses'],
        dimension: 'month',
        chartType: 'bar',
        filters: [{ dimension: 'client', op: 'in', values: ['largest client'] }],
      },
      'Gross Profit vs Expenses by Month — Largest Client',
      true,
      { tenantId: 't', connectionIds: [], externalOrgIds: ['ebpo'] },
      'Generate a bar chart showing gross profit by month for the largest client. In the same chart, compare with monthly expenses.',
    );

    expect(plan?.kind).toBe('build');
    if (plan?.kind !== 'build') return;
    const widget = plan.plan.dashboard.widgets[0] as any;
    expect(widget._spec?.recentMonths).toBeUndefined();
  });

  test('keeps explicit recent windows for largest-client monthly finance matrices', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;
    svc.listTopClientsForScope = async () => ['JP Morgan'];
    svc.executeDynamicSqlChecked = async () => ({
      rows: [{ name: 'Jan 2025', TotalRevenue: 1000, TotalExpenses: 700, GrossMargin: 300 }],
      error: null,
    });

    const plan = await svc.specToPlan(
      {
        measure: 'total_revenue',
        measures: ['total_revenue', 'total_expenses', 'gross_margin'],
        dimension: 'month',
        chartType: 'matrix',
        recentMonths: 8,
        filters: [{ dimension: 'client', op: 'in', values: ['largest client'] }],
      },
      'Monthly Revenue, Expenses, and Gross Profit — Largest Client',
      true,
      { tenantId: 't', connectionIds: [], externalOrgIds: ['ebpo'] },
      'Create a matrix showing monthly revenue, expenses, and gross profit for the largest client over the last 8 months. In the same chart, display row totals and grand totals.',
    );

    expect(plan?.kind).toBe('build');
    if (plan?.kind !== 'build') return;
    const widget = plan.plan.dashboard.widgets[0] as any;
    expect(widget._spec?.recentMonths).toBe(8);
  });

  test('does not force an 8-month window onto largest-client combo charts unless asked', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;
    svc.listTopClientsForScope = async () => ['JP Morgan'];
    svc.executeDynamicSqlChecked = async () => ({
      rows: [{ name: 'Jan 2025', TotalRevenue: 1000, TotalExpenses: 700, GrossMargin: 300 }],
      error: null,
    });

    const plan = await svc.specToPlan(
      {
        measure: 'total_revenue',
        measures: ['total_revenue', 'total_expenses', 'gross_margin'],
        dimension: 'month',
        chartType: 'combo',
        filters: [{ dimension: 'client', op: 'in', values: ['largest client'] }],
      },
      'Revenue, Expenses & Gross Margin — Largest Client',
      true,
      { tenantId: 't', connectionIds: [], externalOrgIds: ['ebpo'] },
      'Generate a combo chart showing revenue, expenses, and gross margin for the largest client',
    );

    expect(plan?.kind).toBe('build');
    if (plan?.kind !== 'build') return;
    const widget = plan.plan.dashboard.widgets[0] as any;
    expect(widget._spec?.measures).toEqual(['total_revenue', 'total_expenses', 'gross_margin']);
    expect(widget._spec?.recentMonths).toBeUndefined();
  });

  test('refuses client-level EBITDA asks with the real missing-grain explanation', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;
    svc.orgHasEbpoData = async () => true;

    const plan = await svc.generateSmartPlan(
      'Create a line chart showing EBITDA trend for the largest client over the last 8 months',
      { tenantId: 't', connectionIds: [], externalOrgIds: ['ebpo'] },
    );

    expect(plan?.kind).toBe('no_data');
    expect((plan as any)?.message ?? '').toContain("can’t calculate EBITDA for a specific client");
    expect((plan as any)?.message ?? '').toContain('payroll is not booked by client');
  });

  test('still allows EBITDA trend over time at company grain', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;
    svc.executeDynamicSqlChecked = async () => ({
      rows: [{ name: 'Jan 2025', value: -1200000 }],
      error: null,
    });
    const plan = await svc.buildEbpoSemanticPlan(
      'Create a line chart showing operating profit trend',
      { tenantId: 't', connectionIds: [], externalOrgIds: ['ebpo'] },
    );

    expect(plan?.kind).toBe('build');
    if (plan?.kind !== 'build') return;
    const widget = plan.plan.dashboard.widgets[0] as any;
    expect(widget._spec?.measure).toBe('ebitda');
    expect(widget._spec?.dimension).toBe('month');
    expect(widget.title).toBe('Operating Profit (EBITDA-style) Trend');
  });

  test('reports explicit pie/donut refusal when negatives are present', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;

    const message = svc.negativePieDonutMessage('pie', [
      { name: 'Operating Cash Flow', value: 83500000 },
      { name: 'Investing Cash Flow', value: -31000000 },
      { name: 'Financing Cash Flow', value: -3800000 },
    ]);

    expect(message).toContain("can't build this as a pie chart");
    expect(message).toContain('Investing Cash Flow');
    expect(
      svc.negativePieDonutMessage('bar', [
        { name: 'Operating Cash Flow', value: 83500000 },
        { name: 'Investing Cash Flow', value: -31000000 },
      ]),
    ).toBeNull();
    expect(
      svc.negativePieDonutMessage('donut', [
        { name: 'Operating Cash Flow', value: 83500000 },
        { name: 'Financing Cash Flow', value: 3800000 },
      ]),
    ).toBeNull();
    expect(
      svc.negativePieDonutMessage('donut', [
        { name: 'Jan 2025', value: 31000000, raw_value: -31000000 },
        { name: 'Feb 2025', value: 18000000, raw_value: -18000000 },
      ]),
    ).toBeNull();
  });

  test('flags incompatible same-chart axis swaps like city to client', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;

    expect(
      svc.sameChartAxisConflict(
        {
          id: 'dash',
          title: 'Revenue by city',
          widgets: [
            {
              id: 'w1',
              title: 'Revenue by city',
              chartType: 'bar',
              queryConfig: {
                spec: {
                  measure: 'total_revenue',
                  dimension: 'city',
                  chartType: 'bar',
                },
              },
              displayOrder: 0,
            },
          ],
        },
        'In the same chart, rank clients by revenue.',
      ),
    ).toContain('change the grouping from city to client');
  });

  test('allows same-chart breakdown additions on a time-series chart', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;

    expect(
      svc.sameChartAxisConflict(
        {
          id: 'dash',
          title: 'Monthly revenue trend',
          widgets: [
            {
              id: 'w1',
              title: 'Monthly revenue trend',
              chartType: 'line',
              queryConfig: {
                spec: {
                  measure: 'total_revenue',
                  dimension: 'month',
                  chartType: 'line',
                },
              },
              displayOrder: 0,
            },
          ],
        },
        'In the same chart, show vendor breakdown.',
      ),
    ).toBeNull();
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

  test('routes client finance scatter comparisons through the EBPO semantic extension', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;
    const semanticResult = {
      kind: 'build',
      plan: {
        tools_to_execute: [],
        should_generate_dashboard: true,
        dashboard: { title: 'Gross Margin % vs Revenue by Client', description: '', widgets: [] },
        analysis_focus: 'scatter',
      },
    };
    svc.orgHasEbpoData = async () => true;
    svc.buildEbpoSemanticPlan = jest.fn(async () => semanticResult);
    svc.generateSpecPlan = jest.fn(async () => {
      throw new Error('generic spec planner should not run');
    });

    const result = await svc.generateSmartPlan(
      'Create a scatter chart showing gross margin percentage versus revenue by client',
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

  test('resolves SLA by geography to a real geography-grained chart', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;
    svc.executeDynamicSqlChecked = async () => ({
      rows: [{ name: 'USA', value: 92.7 }],
      error: null,
    });
    const plan = await svc.buildEbpoSemanticPlan(
      'Generate a clustered bar chart showing SLA by geography',
      { tenantId: 't', connectionIds: [], externalOrgIds: ['ebpo'] },
    );

    expect(plan?.kind).toBe('build');
    if (plan?.kind !== 'build') return;
    const widget = plan.plan.dashboard.widgets[0] as any;
    expect(widget.type).toBe('bar');
    expect(widget._spec?.measure).toBe('sla_compliance_pct');
    expect(widget._spec?.dimension).toBe('country');
  });

  test('treats CSAT movement asks as a monthly waterfall instead of refusing on a stray dimension', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;
    svc.executeDynamicSqlChecked = async () => ({
      rows: [{ name: 'Jan 2025', value: 82.1 }],
      error: null,
    });
    const plan = await svc.buildEbpoSemanticPlan(
      'Create a waterfall chart showing CSAT movement',
      { tenantId: 't', connectionIds: [], externalOrgIds: ['ebpo'] },
    );

    expect(plan?.kind).toBe('build');
    if (plan?.kind !== 'build') return;
    const widget = plan.plan.dashboard.widgets[0] as any;
    expect(widget.type).toBe('waterfall');
    expect(widget._spec?.measure).toBe('csat_pct');
    expect(widget._spec?.dimension).toBe('month');
  });

  test('refuses monthly expense-by-account heatmaps as inconsistent trial-balance data', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;
    svc.executeDynamicSqlChecked = async () => ({
      rows: [{ name: 'Jan 2025', 'Payroll Expense': 586052 }],
      error: null,
    });
    svc.queryRows = async () => [
      { v: 'Payroll Expense', m: 586052 },
      { v: 'Rent Expense', m: 352658 },
    ];
    // The trial-balance account expense doesn't reconcile with the authoritative payroll/
    // cost facts (its Payroll Expense ≪ actual Total Payroll), so an expense-by-account
    // chart would show contradictory numbers → refuse rather than build.
    const plan = await svc.buildEbpoSemanticPlan(
      'Generate a heatmap showing monthly expense trends by account category',
      { tenantId: 't', connectionIds: [], externalOrgIds: ['ebpo'] },
    );

    // The semantic builder declines (returns null); the user-facing refusal message is
    // surfaced by the downstream compile and asserted in chart-spec-ebpo.spec.ts.
    expect(plan?.kind).not.toBe('build');
  });

  test('defaults SLA vs CSAT scatter comparisons to delivery center when no entity is named', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;
    svc.executeDynamicSqlChecked = async () => ({
      rows: [{ name: 'LA Delivery Center', x: 92.7, y: 84.1 }],
      error: null,
    });
    const plan = await svc.buildEbpoSemanticPlan(
      'Generate a scatter chart comparing SLA and CSAT',
      { tenantId: 't', connectionIds: [], externalOrgIds: ['ebpo'] },
    );

    expect(plan?.kind).toBe('build');
    if (plan?.kind !== 'build') return;
    const widget = plan.plan.dashboard.widgets[0] as any;
    expect(widget.type).toBe('scatter');
    expect(widget._spec?.measure).toBe('sla_compliance_pct');
    expect(widget._spec?.measures).toEqual(['sla_compliance_pct', 'csat_pct']);
    expect(widget._spec?.dimension).toBe('delivery_center');
  });

  test('refuses CSAT distribution donuts because ratio averages are not pie slices', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;
    const plan = await svc.buildEbpoSemanticPlan(
      'Generate a donut chart showing CSAT distribution',
      { tenantId: 't', connectionIds: [], externalOrgIds: ['ebpo'] },
    );

    expect(plan?.kind).toBe('no_data');
    expect((plan as any)?.message ?? '').toContain('not additive parts of a whole');
  });

  test('builds SLA by department from the department operations bridge', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;
    svc.executeDynamicSqlChecked = async () => ({
      rows: [{ name: 'Operations', value: 92.7 }],
      error: null,
    });
    const plan = await svc.buildEbpoSemanticPlan(
      'Generate a bar chart showing SLA compliance by department',
      { tenantId: 't', connectionIds: [], externalOrgIds: ['ebpo'] },
    );

    expect(plan?.kind).toBe('build');
    if (plan?.kind !== 'build') return;
    const widget = plan.plan.dashboard.widgets[0] as any;
    expect(widget._spec?.measure).toBe('sla_compliance_pct');
    expect(widget._spec?.dimension).toBe('department');
    expect(widget._sql).toContain('department');
    expect(widget._sql).toContain('delivery_center');
  });

  test('refuses SG&A distribution because account-level (trial-balance) expense is inconsistent', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;
    svc.executeDynamicSqlChecked = async () => ({
      rows: [{ name: 'Payroll Expense', value: 1200 }],
      error: null,
    });
    // SG&A maps to the trial-balance account expense, which doesn't reconcile with the
    // authoritative figures — refuse rather than present a contradictory breakdown.
    const plan = await svc.buildEbpoSemanticPlan(
      'Generate a donut chart showing SG&A expense distribution',
      { tenantId: 't', connectionIds: [], externalOrgIds: ['ebpo'] },
    );

    // Declines to build the inconsistent account-level breakdown.
    expect(plan?.kind).not.toBe('build');
  });

  test('rebuilds same-chart SLA vs CSAT follow-ups as monthly trends instead of refusing on axis change', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;
    svc.orgHasEbpoData = async () => true;
    svc.specToPlan = async (spec: any) => ({
      kind: 'build',
      plan: {
        dashboard: {
          widgets: [
            {
              title: 'Monthly SLA Compliance % and CSAT %',
              type: 'line',
              _sql: 'SELECT name, "SLA Compliance %", "CSAT %" FROM monthly_ops',
              _spec: spec,
              display: {
                valueFormat: 'percent',
                series: [
                  { key: 'SLA Compliance %', role: 'line', axis: 'left', format: 'percent' },
                  { key: 'CSAT %', role: 'line', axis: 'left', format: 'percent' },
                ],
              },
            },
          ],
        },
      },
    });

    const plan = await svc.generateEditPlan(
      {
        id: 'dash',
        title: 'Dashboard',
        widgets: [
          {
            id: 'w1',
            title: 'SLA Compliance % vs CSAT % by Delivery Center',
            chartType: 'scatter',
            queryConfig: {
              metric: 'dynamic',
              grouping: 'dynamic',
              spec: {
                measure: 'sla_compliance_pct',
                measures: ['sla_compliance_pct', 'csat_pct'],
                dimension: 'delivery_center',
                chartType: 'scatter',
              },
              display: { valueFormat: 'percent' },
            },
            displayOrder: 0,
          },
        ],
      },
      'In the same chart, show monthly trends.',
      { tenantId: 't', connectionIds: [], externalOrgIds: ['ebpo'] },
    );

    expect(plan.refusal).toBeUndefined();
    expect(plan.modify).toHaveLength(1);
    expect(plan.summary).toContain('monthly trend');
    expect(plan.modify[0]?.type).toBe('line');
    expect(plan.modify[0]?.spec?.dimension).toBe('month');
    expect(plan.modify[0]?.dynamicSql).toContain('monthly_ops');
  });

  test('normalizes EBPO operations SQL that uses stale sla_pct aliases', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;
    const fixed = svc.repairClickHouseSql(`
      SELECT
        formatDateTime(period_date, '%b %Y') AS name,
        round(sla_pct, 1) AS sla_pct,
        round(csat_pct, 1) AS csat_pct
      FROM analytics.v_ebpo_operations_monthly
    `);

    expect(fixed).toContain('sla_compliance_pct');
    expect(fixed).not.toContain('sla_pct');
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

  test('leaves an existing revenue YTD chart unchanged for cumulative follow-ups', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;
    svc.orgHasEbpoData = async () => true;
    svc.executeDynamicSqlChecked = async (sql: string) => ({
      rows: sql.includes('cumulative_value')
        ? [
            { name: 'Jul 2025', value: 18.0, cumulative_value: 118.0 },
            { name: 'Aug 2025', value: 20.3, cumulative_value: 120.3 },
          ]
        : [
            { name: 'Jul 2025', value: 18.0 },
            { name: 'Aug 2025', value: 20.3 },
          ],
      error: null,
    });

    const plan = await svc.generateEditPlan(
      {
        id: 'dash',
        title: 'Revenue YTD Trend',
        widgets: [
          {
            id: 'w1',
            title: 'Revenue YTD Trend',
            chartType: 'area',
            queryConfig: {
              metric: 'dynamic',
              grouping: 'query',
              dynamicSql:
                "SELECT formatDateTime(period_date, '%b %Y') AS name, round(sum(total_revenue_usd), 2) AS value FROM analytics.v_ebpo_revenue_monthly GROUP BY period_date ORDER BY period_date ASC",
              display: { valueFormat: 'currency' },
            },
            displayOrder: 0,
          },
        ],
      },
      'In the same chart, show cumulative revenue.',
      { tenantId: 't', connectionIds: [], externalOrgIds: ['ebpo'] },
    );

    expect(plan.modify).toHaveLength(0);
    expect(plan.refusal).toContain('already shows revenue YTD');
  });

  test('labels cumulative cash-flow follow-ups with the requested metric instead of revenue', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;
    svc.orgHasEbpoData = async () => true;
    svc.executeDynamicSqlChecked = async (sql: string) => ({
      rows: sql.includes('Cumulative Cash Flow')
        ? [{ name: 'Jan 2025', value: 12.5, 'Cumulative Cash Flow': 12.5 }]
        : [{ name: 'Jan 2025', value: 12.5 }],
      error: null,
    });

    const plan = await svc.generateEditPlan(
      {
        id: 'dash',
        title: 'Monthly Net Cash Flow Trend',
        widgets: [
          {
            id: 'w1',
            title: 'Monthly Net Cash Flow Trend',
            chartType: 'line',
            queryConfig: {
              metric: 'dynamic',
              grouping: 'dynamic',
              dynamicSql:
                "SELECT formatDateTime(period_date, '%b %Y') AS name, round(sum(free_cash_flow_usd), 2) AS value FROM analytics.v_ebpo_cashflow_monthly GROUP BY period_date ORDER BY period_date ASC",
              spec: {
                measure: 'free_cash_flow',
                dimension: 'month',
                chartType: 'line',
              },
              display: { valueFormat: 'currency' },
            },
            displayOrder: 0,
          },
        ],
      },
      'In the same chart, add cumulative cash flow as another line.',
      { tenantId: 't', connectionIds: [], externalOrgIds: ['ebpo'] },
    );

    expect(plan.modify).toHaveLength(1);
    expect(plan.summary).toContain('cumulative cash flow');
    expect(plan.modify[0]?.dynamicSql).toContain('AS "Cumulative Cash Flow"');
  });

  test('refuses same-chart client ranking on a city chart instead of swapping the axis', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;
    svc.orgHasEbpoData = async () => true;

    const plan = await svc.generateEditPlan(
      {
        id: 'dash',
        title: 'Revenue by city',
        widgets: [
          {
            id: 'w1',
            title: 'Revenue by city',
            chartType: 'bar',
            queryConfig: {
              spec: {
                measure: 'total_revenue',
                dimension: 'city',
                chartType: 'bar',
              },
            },
            displayOrder: 0,
          },
        ],
      },
      'In the same chart, rank clients by revenue.',
      { tenantId: 't', connectionIds: [], externalOrgIds: ['ebpo'] },
    );

    expect(plan.modify).toHaveLength(0);
    expect(plan.refusal).toContain('change the grouping from city to client');
  });

  test('refuses same-chart client ranking on an AP monthly trend instead of replacing the chart', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;

    const plan = await svc.generateEditPlan(
      {
        id: 'dash',
        title: 'AP Trend',
        widgets: [
          {
            id: 'w1',
            title: 'AP Trend',
            chartType: 'bar',
            queryConfig: {
              spec: {
                measure: 'ap_outstanding',
                dimension: 'month',
                chartType: 'bar',
              },
            },
            displayOrder: 0,
          },
        ],
      },
      'In the same chart, rank clients by receivables.',
      { tenantId: 't', connectionIds: [], externalOrgIds: ['ebpo'] },
    );

    expect(plan.modify).toHaveLength(0);
    expect(plan.refusal).toBeTruthy();
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

  test('treats unchanged follow-up edits as no-ops instead of successful updates', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;
    const widget = {
      id: 'w1',
      title: 'Monthly Revenue',
      chartType: 'bar',
      queryConfig: {
        metric: 'dynamic',
        grouping: 'query',
        dynamicSql: 'SELECT month AS name, revenue AS value FROM revenue_view',
        display: { valueFormat: 'currency' },
      },
      displayOrder: 0,
    };

    expect(
      svc.widgetEditHasMaterialChange(widget, {
        index: 0,
        title: 'Monthly Revenue',
        type: 'bar',
        dynamicSql: 'SELECT month AS name, revenue AS value FROM revenue_view',
        display: { valueFormat: 'currency' },
      }),
    ).toBe(false);

    expect(
      svc.widgetEditHasMaterialChange(widget, {
        index: 0,
        dynamicSql: 'SELECT month AS name, revenue AS value FROM revenue_view ORDER BY month ASC',
      }),
    ).toBe(true);
  });

  test('detects display-format changes as material follow-up edits', async () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const svc = new AgentService({} as any, {} as any, {} as any) as any;
    const widget = {
      id: 'w1',
      title: 'Collection Rate',
      chartType: 'line',
      queryConfig: {
        metric: 'dynamic',
        grouping: 'query',
        dynamicSql: 'SELECT month AS name, collection_rate_pct AS value FROM rates_view',
        display: { valueFormat: 'percent', valueDecimals: 1 },
      },
      displayOrder: 0,
    };

    expect(
      svc.widgetEditHasMaterialChange(widget, {
        index: 0,
        display: { valueFormat: 'number', valueDecimals: 0 },
      }),
    ).toBe(true);
  });
});
