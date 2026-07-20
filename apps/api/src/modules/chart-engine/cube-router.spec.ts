import { planAcrossCubes, preselectCubes, stripUnrequestedGrouping, type Cube } from './cube-router';
import type { EngineChartSpec, SemanticModel } from './semantic-model.types';

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

  it('prefers the "Total Revenue" measure over a raw "Revenue" column for "total revenue"', async () => {
    // Regression: "total" must stay a meaningful word so total_revenue_usd (DAX
    // "Total Revenue", in the GL cube) beats revenue_usd (raw FactRevenue) — the
    // GL cube also carries gross_profit, which later lets a follow-up add it.
    const glCube: Cube = {
      view: 'v_gl',
      model: {
        datasetId: 'sfin', version: 1, builtBy: 'auto', factGrain: 'gl row', entities: [],
        time: { table: 'v_gl', column: 'period_date', grains: ['month'] },
        dimensions: [{ key: 'business_unit', label: 'Business Unit', table: 'v_gl', column: 'business_unit' }],
        measures: [{ key: 'total_revenue_usd', label: 'Total Revenue', unit: 'USD', sourceTable: 'v_gl', expr: { kind: 'sum', column: 'total_revenue_usd' } }],
      } satisfies SemanticModel,
    };
    const opsCube: Cube = {
      view: 'v_ops',
      model: {
        datasetId: 'sfin', version: 1, builtBy: 'auto', factGrain: 'ops row', entities: [],
        time: { table: 'v_ops', column: 'period_date', grains: ['month'] },
        dimensions: [{ key: 'business_unit', label: 'Business Unit', table: 'v_ops', column: 'business_unit' }],
        measures: [{ key: 'revenue_usd', label: 'Revenue', unit: 'USD', sourceTable: 'v_ops', expr: { kind: 'sum', column: 'revenue_usd' } }],
      } satisfies SemanticModel,
    };
    // Each cube's planner picks its own revenue measure.
    const llm = async (system: string) =>
      system.includes('total_revenue_usd')
        ? JSON.stringify({ chartType: 'bar', measureKeys: ['total_revenue_usd'], dimensionKey: 'business_unit', title: 'x' })
        : JSON.stringify({ chartType: 'bar', measureKeys: ['revenue_usd'], dimensionKey: 'business_unit', title: 'x' });
    const r = await planAcrossCubes('Create a bar chart showing total revenue by business unit', [opsCube, glCube], llm);
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.cube.view).toBe('v_gl'); expect(r.spec.measureKeys).toEqual(['total_revenue_usd']); }
  });

  it('does NOT split "monthly total revenue" by a dimension whose values merely contain "revenue"', async () => {
    // Regression: service_line values ("Voice Revenue"…) collide with the measure
    // word "revenue", which used to route a plain total into a per-service-line split.
    const scorecard: Cube = {
      view: 'v_service_line_scorecard',
      model: {
        datasetId: 'sfin', version: 1, builtBy: 'auto', factGrain: 'one row per month per service line',
        entities: [], time: { table: 'v_service_line_scorecard', column: 'period_date', grains: ['month', 'quarter', 'year'] },
        dimensions: [{ key: 'service_line', label: 'Service Line', table: 'v_service_line_scorecard', column: 'service_line', sampleValues: ['Voice Revenue', 'Chat Revenue', 'Email Revenue'] }],
        measures: [{ key: 'total_revenue_usd', label: 'Revenue', unit: 'USD', sourceTable: 'v_service_line_scorecard', expr: { kind: 'sum', column: 'total_revenue_usd' } }],
      } satisfies SemanticModel,
    };
    // The LLM (over-eagerly) groups by service_line even for a plain total.
    const groupingLlm = async () =>
      JSON.stringify({ chartType: 'line', measureKeys: ['total_revenue_usd'], dimensionKey: 'service_line', timeGrain: 'month', title: 'Monthly Total Revenue' });
    const r = await planAcrossCubes('Generate a line chart showing monthly total revenue', [scorecard], groupingLlm);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.spec.dimensionKey).toBeUndefined(); // spurious split removed
      expect(r.spec.measureKeys).toEqual(['total_revenue_usd']);
      expect(r.spec.timeGrain).toBe('month');
    }
  });
});

describe('preselectCubes', () => {
  // Build many cubes; only some are lexically relevant to a revenue question.
  const many: Cube[] = [
    cube('v_client', ['client_name']),
    cube('v_bu', ['business_unit']),
    cube('v_geo', ['region', 'country']),
    cube('v_ap', ['vendor_name']),
    cube('v_cash', ['cash_flow_activity']),
    cube('v_ops', ['service_line']),
  ];

  it('shortlists only lexically-relevant cubes when enough match', () => {
    // All cubes carry a "Revenue" measure (see cube()), so a revenue+BU question
    // should still shortlist, and the BU cube must be included.
    const short = preselectCubes('revenue by business unit', many, 12, 3);
    expect(short.length).toBeLessThanOrEqual(many.length);
    expect(short.some((c) => c.view === 'v_bu')).toBe(true);
  });

  it('falls back to ALL cubes when too few lexically match (never drops the answer)', () => {
    const short = preselectCubes('xyzzy plugh', many, 12, 3);
    expect(short.length).toBe(many.length);
  });

  it('returns all cubes when the set is already small', () => {
    const few = many.slice(0, 2);
    expect(preselectCubes('revenue', few, 12, 3)).toHaveLength(2);
  });
});

describe('stripUnrequestedGrouping', () => {
  const model: SemanticModel = {
    datasetId: 'sfin', version: 1, builtBy: 'auto', factGrain: 'x', entities: [],
    time: { table: 'v', column: 'period_date', grains: ['month'] },
    dimensions: [
      { key: 'service_line', label: 'Service Line', table: 'v', column: 'service_line', sampleValues: ['Voice Revenue', 'Chat Revenue'] },
      { key: 'client_name', label: 'Client', table: 'v', column: 'client_name', sampleValues: ['JP Morgan', 'Walmart'] },
      { key: 'cost_category', label: 'Cost Category', table: 'v', column: 'cost_category' },
    ],
    measures: [
      { key: 'total_revenue_usd', label: 'Revenue', unit: 'USD', sourceTable: 'v', expr: { kind: 'sum', column: 'total_revenue_usd' } },
      { key: 'total_sga_usd', label: 'Total SG&A', unit: 'USD', sourceTable: 'v', expr: { kind: 'sum', column: 'total_sga_usd' } },
    ],
  };
  const base: EngineChartSpec = { chartType: 'line', measureKeys: ['total_revenue_usd'], timeGrain: 'month', title: 't' };

  it('drops a grouping the user never named (sample-value collision)', () => {
    const out = stripUnrequestedGrouping('monthly total revenue', { ...base, dimensionKey: 'service_line' }, model);
    expect(out.dimensionKey).toBeUndefined();
  });

  it('keeps a grouping the user named by dimension identity', () => {
    const out = stripUnrequestedGrouping('revenue by service line', { ...base, dimensionKey: 'service_line' }, model);
    expect(out.dimensionKey).toBe('service_line');
  });

  it('keeps a grouping the user named by a specific value', () => {
    const out = stripUnrequestedGrouping('revenue for JP Morgan', { ...base, dimensionKey: 'client_name' }, model);
    expect(out.dimensionKey).toBe('client_name');
  });

  it('does not treat the word cost as a request for cost categories', () => {
    const out = stripUnrequestedGrouping(
      'Create a line chart showing monthly SG&A cost.',
      { ...base, measureKeys: ['total_sga_usd'], dimensionKey: 'cost_category' },
      model,
    );
    expect(out.dimensionKey).toBeUndefined();
  });

  it('keeps cost_category when the user explicitly asks for cost categories', () => {
    const out = stripUnrequestedGrouping(
      'Rank cost categories by total cost.',
      { ...base, measureKeys: ['total_sga_usd'], dimensionKey: 'cost_category' },
      model,
    );
    expect(out.dimensionKey).toBe('cost_category');
  });
});
