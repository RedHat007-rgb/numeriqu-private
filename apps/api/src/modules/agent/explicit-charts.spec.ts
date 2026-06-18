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
