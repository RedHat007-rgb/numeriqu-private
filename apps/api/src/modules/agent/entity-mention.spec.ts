describe('AgentService.extractEntityMention', () => {
  test('parses underscores in explicit Use entity directive', () => {
    // `AgentService` transitively imports `@repo/db`, which requires DATABASE_URL at module load.
    // A dummy URL is enough for this unit test (no DB connection is attempted).
    process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentService } = require('./agent.service') as typeof import('./agent.service');

    const fn = (AgentService.prototype as any).extractEntityMention as (
      raw: string,
    ) => string | null;

    expect(fn.call({}, 'Use entity: test_data_xero')).toBe('test_data_xero');
    expect(fn.call({}, 'Use entity: test_data_quickbooks')).toBe(
      'test_data_quickbooks',
    );
  });
});
