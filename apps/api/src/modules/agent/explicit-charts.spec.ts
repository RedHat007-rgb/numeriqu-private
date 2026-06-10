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
    expect(donut?.type).toBe('pie');
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
});
