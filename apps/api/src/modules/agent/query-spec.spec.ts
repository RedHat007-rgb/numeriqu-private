import { parseQuerySpec, parseTimeRange } from './query-spec';

describe('query-spec', () => {
  test('detects payment-days intent', () => {
    const spec = parseQuerySpec(
      'Can you tell me for Umixity LLC as to how many days after the invoice date was each invoice paid after the invoice date',
    );
    expect(spec.paymentDaysIntent).toBe('LIST');
  });

  test('treats issued→paid line chart as payment-days trend', () => {
    const spec = parseQuerySpec(
      'What is the average time taken to convert an invoice from issued → paid in line chart',
    );
    expect(spec.paymentDaysIntent).toBe('TREND');
    expect(spec.wantsTrend).toBe(true);
  });

  test('parses "six months" as last 6 months', () => {
    const r = parseTimeRange('six months');
    expect(r).toEqual({ kind: 'LAST_N_MONTHS', months: 6 });
  });

  test('parses "for 6 months" as last 6 months', () => {
    const r = parseTimeRange('for 6 months');
    expect(r).toEqual({ kind: 'LAST_N_MONTHS', months: 6 });
  });

  test('selection carryover keeps time range', () => {
    const base = parseQuerySpec('give me six months info about umixity LLC in barchart');
    const follow = parseQuerySpec(`${base.raw}\nUse entity: cee02719-84eb-4d49-af55-e373ec763e58`);
    expect(base.timeRange).toEqual({ kind: 'LAST_N_MONTHS', months: 6 });
    expect(follow.timeRange).toEqual({ kind: 'LAST_N_MONTHS', months: 6 });
  });

  test('parses last N months', () => {
    const r = parseTimeRange('last 6 months');
    expect(r).toEqual({ kind: 'LAST_N_MONTHS', months: 6 });
  });

  test('parses a concrete year as that calendar year', () => {
    const r = parseTimeRange('show revenue trend for 2024');
    expect(r).toEqual({ kind: 'BETWEEN_DATES', start: '2024-01-01', end: '2024-12-31' });
  });

  test('keeps explicit year comparisons multi-year', () => {
    const r = parseTimeRange('compare revenue 2023 vs 2024 by year');
    expect(r).toBeNull();
  });

  test('parses between month and now', () => {
    const r = parseTimeRange('from Dec 2024 to now');
    expect(r?.kind).toBe('BETWEEN_DATES');
    expect((r as any).start).toBe('2024-12-01');
    // End is time-dependent; just assert the shape.
    expect(typeof (r as any).end).toBe('string');
  });

  test('detects top-N clients intent and parses N', () => {
    const spec = parseQuerySpec('give me month wise revenue for top 2 clients for last six months');
    expect(spec.wantsTopClients).toBe(true);
    expect(spec.topN).toBe(2);
  });

  test('detects top-N clients intent with number-words', () => {
    const spec = parseQuerySpec('compare top two clients revenue for last six months in arvion services sdn bhd');
    expect(spec.wantsTopClients).toBe(true);
    expect(spec.topN).toBe(2);
    expect(spec.timeRange?.kind).toBe('LAST_N_MONTHS');
  });
});
