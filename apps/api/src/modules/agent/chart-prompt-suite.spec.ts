describe('AgentService explicit chart prompt suite', () => {
  type Case = {
    prompt: string;
    expectedType?: string;
    note?: string;
  };

  const cases: Case[] = [
    { prompt: 'Create a column chart showing monthly total revenue.', expectedType: 'bar' },
    { prompt: 'Create a line chart showing month-on-month revenue growth percentage.', expectedType: 'line' },
    { prompt: 'Create a stacked column chart showing monthly revenue by business unit.', expectedType: 'stacked_bar' },
    { prompt: 'Create a bar chart showing total revenue by client.', expectedType: 'bar' },
    { prompt: 'Create a donut chart showing revenue share by contract type.', expectedType: 'donut' },
    { prompt: 'Create a clustered bar chart comparing revenue and cost by business unit.', expectedType: 'bar' },
    { prompt: 'Create a line chart showing monthly gross margin trend.', expectedType: 'line' },
    { prompt: 'Create a combo chart with monthly revenue as columns and gross margin percentage as a line.', expectedType: 'combo' },
    { prompt: 'Create a heat map showing gross margin percentage by business unit and month.', expectedType: 'heatmap' },
    { prompt: 'Create a waterfall chart showing revenue, cost, and gross margin by month.', expectedType: 'waterfall' },
    { prompt: 'Create a column chart showing total cost by business unit.', expectedType: 'bar' },
    { prompt: 'Create a treemap showing revenue contribution by client.', expectedType: 'treemap' },
    { prompt: 'Create a scatter plot showing revenue versus gross margin by client.', expectedType: 'scatter' },
    { prompt: 'Create a bar chart showing average gross margin percentage by contract type.', expectedType: 'bar' },
    { prompt: 'Create a stacked area chart showing monthly revenue by contract type.', expectedType: 'area' },
    { prompt: 'Create a ranked bar chart showing top clients by gross margin.', expectedType: 'horizontal_bar' },
    { prompt: 'Create a 100% stacked column chart showing monthly revenue mix by business unit.', expectedType: 'stacked_bar' },
    { prompt: 'Create a line chart showing monthly cost as a percentage of revenue.', expectedType: 'line' },
    { prompt: 'Create a heat map showing revenue by client and contract type.', expectedType: 'heatmap' },
    { prompt: 'Create a bar chart showing gross margin percentage by client.', expectedType: 'bar' },
    { prompt: 'Create a line chart showing monthly cash balance.', expectedType: 'line' },
    { prompt: 'Create a column chart showing monthly operating cash flow.', expectedType: 'bar' },
    { prompt: 'Create a stacked column chart showing operating, investing, and financing cash flow by month.', expectedType: 'stacked_bar' },
    { prompt: 'Create a column chart showing monthly free cash flow.', expectedType: 'bar' },
    { prompt: 'Create a waterfall chart showing monthly movement from operating cash flow to free cash flow.', expectedType: 'waterfall' },
    { prompt: 'Create a line chart showing monthly opening balance and closing balance by account.', expectedType: 'line' },
    { prompt: 'Create a column chart showing debit movement and credit movement by account.', expectedType: 'bar' },
    { prompt: 'Create a heat map showing closing balance by account and month.', expectedType: 'heatmap' },
    { prompt: 'Create a bar chart showing total debit amount by account.', expectedType: 'bar' },
    { prompt: 'Create a waterfall chart showing net movement by account.', expectedType: 'waterfall' },
    { prompt: 'Create a bar chart showing outstanding receivables by client.', expectedType: 'bar' },
    { prompt: 'Create a stacked bar chart showing outstanding receivables by aging bucket.', expectedType: 'stacked_bar' },
    { prompt: 'Create a column chart showing invoice amount, collected amount, and outstanding receivables by month.', expectedType: 'bar' },
    { prompt: 'Create a heat map showing outstanding receivables by client and aging bucket.', expectedType: 'heatmap' },
    { prompt: 'Create a Pareto chart showing clients ranked by outstanding receivables.', expectedType: 'pareto' },
    { prompt: 'Create a bar chart showing outstanding payables by vendor.', expectedType: 'bar' },
    { prompt: 'Create a stacked bar chart showing outstanding payables by aging bucket.', expectedType: 'stacked_bar' },
    { prompt: 'Create a column chart showing payable invoice amount, paid amount, and outstanding payables by month.', expectedType: 'bar' },
    { prompt: 'Create a heat map showing outstanding payables by vendor and aging bucket.', expectedType: 'heatmap' },
    { prompt: 'Create a Pareto chart showing vendors ranked by outstanding payables.', expectedType: 'pareto' },
    { prompt: 'Create a column chart showing monthly total payroll.', expectedType: 'bar' },
    { prompt: 'Create a stacked bar chart showing total payroll by department.', expectedType: 'stacked_bar' },
    { prompt: 'Create a bar chart showing total payroll by country.', expectedType: 'bar' },
    { prompt: 'Create a line chart showing monthly overtime cost.', expectedType: 'line' },
    { prompt: 'Create a column chart showing total bonus by department.', expectedType: 'bar' },
    { prompt: 'Create a stacked column chart showing monthly payroll composition.', expectedType: 'stacked_bar' },
    { prompt: 'Create a heat map showing payroll by department and country.', expectedType: 'heatmap' },
    { prompt: 'Create a bar chart showing average salary by employee grade.', expectedType: 'bar' },
    { prompt: 'Create a box plot showing salary distribution by department.', note: 'box plot is explicitly unsupported by current chart vocabulary' },
    { prompt: 'Create a column chart showing employee count by department.', expectedType: 'bar' },
    { prompt: 'Create a bar chart showing employee count by country and delivery center.', expectedType: 'bar' },
    { prompt: 'Create a Pareto chart showing departments ranked by total payroll.', expectedType: 'pareto' },
    { prompt: 'Create a column chart showing overtime cost by department.', expectedType: 'bar' },
    { prompt: 'Create a bar chart showing benefits cost by country.', expectedType: 'bar' },
    { prompt: 'Create a column chart showing payroll cost per employee by country.', expectedType: 'bar' },
    { prompt: 'Create a line chart showing monthly calls handled by delivery center.', expectedType: 'line' },
    { prompt: 'Create a column chart showing average SLA compliance by delivery center.', expectedType: 'bar' },
    { prompt: 'Create a scatter plot showing average handling time versus CSAT percentage.', expectedType: 'scatter' },
    { prompt: 'Create a heat map showing SLA compliance by delivery center and month.', expectedType: 'heatmap' },
    { prompt: 'Create a line chart showing monthly utilization percentage by delivery center.', expectedType: 'line' },
    { prompt: 'Create a bar chart showing total tickets resolved by delivery center.', expectedType: 'bar' },
    { prompt: 'Create a combo chart showing calls handled as columns and CSAT percentage as a line.', expectedType: 'combo' },
    { prompt: 'Create a ranked bar chart showing delivery centers by average CSAT percentage.', expectedType: 'horizontal_bar' },
    { prompt: 'Create a column chart showing monthly average handling time.', expectedType: 'bar' },
    { prompt: 'Create a scatter plot showing utilization percentage versus SLA compliance percentage.', expectedType: 'scatter' },
    { prompt: 'Create a bar chart showing net book value by delivery center.', expectedType: 'bar' },
    { prompt: 'Create a stacked bar chart showing net book value by asset type and delivery center.', expectedType: 'stacked_bar' },
    { prompt: 'Create a donut chart showing asset cost share by asset type.', expectedType: 'donut' },
    { prompt: 'Create a bar chart showing accumulated depreciation by asset type.', expectedType: 'bar' },
    { prompt: 'Create a treemap showing net book value by delivery center and asset type.', expectedType: 'treemap' },
    { prompt: 'Create a scatter plot showing asset cost versus net book value by asset type.', expectedType: 'scatter' },
    { prompt: 'Create a ranked bar chart showing delivery centers by depreciation percentage.', expectedType: 'horizontal_bar' },
    { prompt: 'Create a column chart comparing asset cost, accumulated depreciation, and net book value by asset type.', expectedType: 'bar' },
    { prompt: 'Create a heat map showing net book value by asset type and delivery center.', expectedType: 'heatmap' },
    { prompt: 'Create a bar chart showing asset intensity by delivery center using net book value per call handled.', expectedType: 'bar' },
    { prompt: 'Create a line chart showing monthly current ratio.', expectedType: 'line' },
    { prompt: 'Create a column chart showing monthly quick ratio.', expectedType: 'bar' },
    { prompt: 'Create a line chart showing monthly working capital.', expectedType: 'line' },
    { prompt: 'Create a column chart showing cost per employee by month.', expectedType: 'bar' },
    { prompt: 'Create a bar chart showing cost per employee by department.', expectedType: 'bar' },
    { prompt: 'Create a scatter plot showing revenue per employee versus cost per employee by department.', expectedType: 'scatter' },
    { prompt: 'Create a combo chart showing monthly revenue as columns and payroll as a percentage of revenue as a line.', expectedType: 'combo' },
    { prompt: 'Create a line chart showing monthly free cash flow margin.', expectedType: 'line' },
    { prompt: 'Create a bar chart showing revenue per employee by business unit.', expectedType: 'bar' },
    { prompt: 'Create a column chart showing operating cash flow as a percentage of revenue by month.', expectedType: 'bar' },
    { prompt: 'Create a line chart showing receivables as a percentage of revenue by month.', expectedType: 'line' },
    { prompt: 'Create a bar chart showing collection rate by client.', expectedType: 'bar' },
    { prompt: 'Create a scatter plot showing client revenue versus collection rate.', expectedType: 'scatter' },
    { prompt: 'Create a scatter plot showing client gross margin percentage versus collection rate.', expectedType: 'scatter' },
    { prompt: 'Create a line chart showing monthly cash conversion using operating cash flow divided by revenue.', expectedType: 'line' },
    { prompt: 'Create a bar chart showing revenue, payroll, and gross margin by business unit.', expectedType: 'bar' },
    { prompt: 'Create a heat map showing revenue per employee by department and month.', expectedType: 'heatmap' },
    { prompt: 'Create a column chart showing monthly EBITDA-style margin using revenue minus cost minus payroll.', expectedType: 'bar' },
    { prompt: 'Create a line chart showing monthly net working capital.', expectedType: 'line' },
    { prompt: 'Create a bar chart showing revenue per delivery center.', expectedType: 'bar' },
    { prompt: 'Create a scatter plot showing utilization percentage versus revenue per employee by delivery center.', expectedType: 'scatter' },
    { prompt: 'Create a column chart showing monthly cost-to-income ratio using total cost divided by revenue.', expectedType: 'bar' },
    { prompt: 'Create a line chart showing monthly cash balance and outstanding receivables.', expectedType: 'line' },
    { prompt: 'Create a CFO scorecard chart showing revenue, gross margin, payroll, free cash flow, receivables, and payables by month.', note: 'scorecard is a KPI/dashboard composition, not a single first-class ChartType' },
    { prompt: 'Create a dashboard showing monthly liquidity, profitability, employee efficiency, and cash conversion metrics.', note: 'dashboard is multi-widget composition, not a single first-class ChartType' },
  ];

  test.each(cases)('$prompt', ({ prompt, expectedType, note }) => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');
    const parser = AgentService.prototype as any;
    const explicit = parser.parseExplicitChartConstraints(prompt);

    if (expectedType) {
      expect(explicit?.requiredTypes).toContain(expectedType);
      return;
    }

    expect(note).toBeTruthy();
    expect(explicit?.requiredTypes ?? []).not.toContain('box_plot');
    expect(explicit?.requiredTypes ?? []).not.toContain('combo');
  });

  test('closing balance heatmap by account and month does not trigger clarification', () => {
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');
    const svc = AgentService.prototype as any;
    expect(
      svc.getClarificationPrompt(
        'Create a heat map showing closing balance by account and month.',
        'CREATE_DASHBOARD',
      ),
    ).toBeNull();
  });
});
