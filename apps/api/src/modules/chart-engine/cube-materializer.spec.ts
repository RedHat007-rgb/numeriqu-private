import { materializeCubes, type CubeMaterializerClient } from './cube-materializer';
import type { CubeBlueprint } from './cube-builder';

/** A scriptable fake CH client that records executed DDL. */
function fakeClient(opts: {
  present: string[];
  taxonomy?: Record<string, Record<string, string[]>>;
  failOn?: string;
}): CubeMaterializerClient & { ddls: string[] } {
  const present = new Set(opts.present);
  const ddls: string[] = [];
  return {
    ddls,
    async tableExists(name: string) {
      return present.has(name);
    },
    async distinct(table: string, column: string) {
      return opts.taxonomy?.[table]?.[column] ?? [];
    },
    async exec(ddl: string) {
      if (opts.failOn && ddl.includes(opts.failOn)) throw new Error('boom: bad ddl');
      ddls.push(ddl);
    },
  };
}

const plBlueprint: CubeBlueprint = {
  view: 'v_ds_pl',
  factTable: 'ds_fact_gl',
  dateColumn: 'posting_date',
  pivots: [{ valueColumn: 'pl_amount_usd', categoryColumn: 'account_type', discover: true, canonical: { Revenue: 'total_revenue_usd' } }],
};

describe('materializeCubes', () => {
  it('discovers pivot taxonomy live and materializes the view', async () => {
    const client = fakeClient({
      present: ['ds_fact_gl'],
      taxonomy: { ds_fact_gl: { account_type: ['Revenue', 'SG&A'] } },
    });
    const r = await materializeCubes('analytics', [plBlueprint], client);
    expect(r.created).toEqual(['v_ds_pl']);
    expect(r.skipped).toEqual([]);
    // taxonomy was pivoted from the DISTINCT result, not hardcoded
    expect(client.ddls[0]).toContain("sumIf(f.pl_amount_usd, f.account_type = 'Revenue') AS total_revenue_usd");
    expect(client.ddls[0]).toContain("sumIf(f.pl_amount_usd, f.account_type = 'SG&A') AS sg_a");
  });

  it('skips a blueprint whose fact table is not loaded (no fake cubes)', async () => {
    const client = fakeClient({ present: [] });
    const r = await materializeCubes('analytics', [plBlueprint], client);
    expect(r.created).toEqual([]);
    expect(r.skipped[0].reason).toMatch(/fact table not loaded/);
    expect(client.ddls).toHaveLength(0);
  });

  it('drops a join whose dim is absent rather than emitting broken SQL', async () => {
    const bp: CubeBlueprint = {
      view: 'v_ds_rev_client',
      factTable: 'ds_fact_revenue',
      measures: [{ column: 'revenue_usd', alias: 'revenue', agg: 'sum' }],
      joins: [{ dimTable: 'ds_dim_client', factKey: 'client_key', dimKey: 'client_key', selects: [{ column: 'client_name', alias: 'client_name' }] }],
    };
    const client = fakeClient({ present: ['ds_fact_revenue'] }); // dim missing
    const r = await materializeCubes('analytics', [bp], client);
    expect(r.created).toEqual(['v_ds_rev_client']);
    expect(r.skipped.some((s) => /dim not loaded/.test(s.reason))).toBe(true);
    expect(client.ddls[0]).not.toContain('LEFT JOIN');
  });

  it('records a DDL failure as skipped without aborting the batch', async () => {
    const good: CubeBlueprint = { view: 'v_good', factTable: 'ds_fact_gl', measures: [{ column: 'x', alias: 'x', agg: 'sum' }] };
    const bad: CubeBlueprint = { view: 'v_bad', factTable: 'ds_fact_gl', measures: [{ column: 'y', alias: 'y', agg: 'sum' }] };
    const client = fakeClient({ present: ['ds_fact_gl'], failOn: 'v_bad' });
    const r = await materializeCubes('analytics', [bad, good], client);
    expect(r.created).toEqual(['v_good']);
    expect(r.skipped.some((s) => s.view === 'v_bad' && /boom/.test(s.reason))).toBe(true);
  });

  it('is idempotent-friendly: emits CREATE OR REPLACE so re-running is safe', async () => {
    const client = fakeClient({ present: ['ds_fact_gl'], taxonomy: { ds_fact_gl: { account_type: ['Revenue'] } } });
    await materializeCubes('analytics', [plBlueprint], client);
    expect(client.ddls[0].startsWith('CREATE OR REPLACE VIEW analytics.v_ds_pl AS')).toBe(true);
  });
});
