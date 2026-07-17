import { planAcrossCubes, type Cube } from './cube-router';
import type { SemanticModel } from './semantic-model.types';

const cube = (view: string, dimKeys: string[]): Cube => ({
  view,
  model: {
    datasetId: 'ebpo', version: 1, builtBy: 'auto', factGrain: `one row of ${view}`,
    entities: [], time: { table: view, column: 'period_date', grains: ['month', 'quarter', 'year'] },
    dimensions: dimKeys.map((k) => ({ key: k, label: k, table: view, column: k })),
    measures: [{ key: 'total_revenue_usd', label: 'Revenue', unit: 'USD', sourceTable: view, expr: { kind: 'sum', column: 'total_revenue_usd' } }],
  } satisfies SemanticModel,
});

const cubes: Cube[] = [
  cube('v_client', ['client_name']),
  cube('v_bu', ['business_unit', 'contract_type']),
  cube('v_geo', ['region', 'country', 'delivery_center']),
];

// Fake LLM: emits a spec using the dimension named in the question IF this cube's
// prompt exposes it; otherwise refuses (empty measureKeys). Mimics real routing.
const fakeLlmFor = (wantedDim: string) => async (system: string, _user: string) => {
  if (system.includes(wantedDim)) {
    return JSON.stringify({ chartType: 'bar', measureKeys: ['total_revenue_usd'], dimensionKey: wantedDim, title: 'x' });
  }
  return JSON.stringify({ chartType: 'table', measureKeys: [], title: `no ${wantedDim} here` });
};

describe('CubeRouter.planAcrossCubes', () => {
  it('routes "revenue by country" to the geography cube', async () => {
    const r = await planAcrossCubes('revenue by country', cubes, fakeLlmFor('country'));
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.cube.view).toBe('v_geo'); expect(r.spec.dimensionKey).toBe('country'); }
  });

  it('routes "revenue by business unit" to the BU cube', async () => {
    const r = await planAcrossCubes('revenue by business unit', cubes, fakeLlmFor('business_unit'));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.cube.view).toBe('v_bu');
  });

  it('collects reasons and fails when no cube can answer', async () => {
    const r = await planAcrossCubes('revenue by planet', cubes, fakeLlmFor('planet'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons.length).toBe(3);
  });

  it('prefers the specific cube over an earlier cube\'s loose substitution', async () => {
    // Regression: "revenue by business unit" must NOT be answered by an earlier
    // cube that only has org_name (a loose match). The BU cube must win.
    const clientFirst: Cube[] = [
      cube('v_client', ['client_name', 'org_name']), // earlier, has a loose "org_name"
      cube('v_bu', ['business_unit', 'contract_type']), // later, the real match
    ];
    const substitutingLlm = async (system: string) => {
      if (system.includes('business_unit')) return JSON.stringify({ chartType: 'bar', measureKeys: ['total_revenue_usd'], dimensionKey: 'business_unit', title: 'x' });
      if (system.includes('org_name')) return JSON.stringify({ chartType: 'bar', measureKeys: ['total_revenue_usd'], dimensionKey: 'org_name', title: 'x' });
      return JSON.stringify({ chartType: 'table', measureKeys: [], title: 'no' });
    };
    const r = await planAcrossCubes('revenue by business unit', clientFirst, substitutingLlm);
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.cube.view).toBe('v_bu'); expect(r.spec.dimensionKey).toBe('business_unit'); }
  });

  it('falls back to a dimensionless plan when the question needs no grouping', async () => {
    const totalLlm = async () => JSON.stringify({ chartType: 'kpi', measureKeys: ['total_revenue_usd'], title: 'Total revenue' });
    const r = await planAcrossCubes('total revenue', cubes, totalLlm);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.spec.dimensionKey).toBeUndefined();
  });
});
