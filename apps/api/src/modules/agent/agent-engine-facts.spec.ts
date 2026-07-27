describe('AgentService engine narration facts', () => {
  it('binds each multi-series time-series label to its own values', () => {
    process.env.DATABASE_URL ??=
      'postgresql://test:test@localhost:5432/numeriqu_test';
    // Require after the test-only database URL is present because the shared
    // Prisma package validates its environment at module-load time.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { AgentService } = require('./agent.service') as {
      AgentService: { prototype: object };
    };
    const service = Object.create(AgentService.prototype);
    const result = (service as any).buildEngineFacts({
      ok: true,
      mode: 'create',
      title: 'Cash Flow Balances by Month',
      widgetChartType: 'line',
      valueFormat: 'currency',
      spec: {
        chartType: 'line',
        timeGrain: 'month',
        measureKeys: [
          'opening_cash_balance_usd',
          'closing_cash_balance_usd',
          'net_cash_flow_usd',
          'cash_balance_usd',
        ],
      },
      display: {
        series: [
          {
            key: 'Opening Cash Balance',
            axis: 'left',
            role: 'line',
            format: 'currency',
          },
          {
            key: 'Closing Cash Balance',
            axis: 'left',
            role: 'line',
            format: 'currency',
          },
          {
            key: 'Net Cash Flow',
            axis: 'left',
            role: 'line',
            format: 'currency',
          },
          {
            key: 'Cash Balance',
            axis: 'left',
            role: 'line',
            format: 'currency',
          },
        ],
      },
      rows: [
        {
          period: '2025-11-01',
          opening_cash_balance_usd: 310_000_000,
          closing_cash_balance_usd: 320_000_000,
          net_cash_flow_usd: 1_000_000,
          cash_balance_usd: 320_000_000,
        },
        {
          period: '2025-12-01',
          opening_cash_balance_usd: 320_023_236,
          closing_cash_balance_usd: 335_025_272.96,
          net_cash_flow_usd: 1_875_254.62,
          cash_balance_usd: 335_025_272.96,
        },
      ],
    });

    expect(result.sheet).toContain(
      'Opening Cash Balance: first Nov 2025 = $310.0M; last Dec 2025 = $320.0M',
    );
    expect(result.sheet).toContain(
      'Closing Cash Balance: first Nov 2025 = $320.0M; last Dec 2025 = $335.0M',
    );
    expect(result.sheet).toContain(
      'Net Cash Flow: first Nov 2025 = $1.0M; last Dec 2025 = $1.9M',
    );
    expect(result.sheet).toContain(
      'Cash Balance: first Nov 2025 = $320.0M; last Dec 2025 = $335.0M',
    );
    expect(result.fallback).toContain(
      'Opening Cash Balance = $320.0M (Dec 2025)',
    );
    expect(result.fallback).toContain(
      'Cash Balance = $335.0M (Dec 2025)',
    );
  });
});
