import { parsePlannerResponse, planChart, planEdit, preferDistinctAxisMeasure } from './chart-planner';
import type { SemanticModel } from './semantic-model.types';

const model: SemanticModel = {
  datasetId: 'ebpo', version: 1, builtBy: 'auto', factGrain: 'one row per client per month',
  entities: [{ key: 'client', label: 'Client', table: 'v', nameColumn: 'client_name' }],
  dimensions: [
    { key: 'client_name', label: 'Client', table: 'v', column: 'client_name' },
    { key: 'business_unit', label: 'Business Unit', table: 'v', column: 'business_unit' },
  ],
  time: { table: 'v', column: 'period_date', grains: ['month', 'quarter', 'year'] },
  measures: [
    { key: 'total_revenue_usd', label: 'Revenue', unit: 'USD', sourceTable: 'v', expr: { kind: 'sum', column: 'total_revenue_usd' } },
    { key: 'gross_margin_pct', label: 'Gross Margin %', unit: '%', sourceTable: 'v', expr: { kind: 'ratio_of_sums', numerator: 'gm', denominator: 'rev' } },
  ],
};

describe('ChartPlanner.parsePlannerResponse', () => {
  it('accepts a valid spec referencing real measures/dimensions', () => {
    const r = parsePlannerResponse(JSON.stringify({ chartType: 'bar', measureKeys: ['total_revenue_usd'], dimensionKey: 'client_name', topN: 5, sort: 'desc', title: 'Top clients' }), model);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.spec.measureKeys).toEqual(['total_revenue_usd']);
  });

  it('tolerates ```json fences from the LLM', () => {
    const r = parsePlannerResponse('```json\n{"chartType":"line","measureKeys":["gross_margin_pct"],"timeGrain":"month","title":"Margin"}\n```', model);
    expect(r.ok).toBe(true);
  });

  it.each(['horizontal_bar', 'stacked_bar', 'stacked_area', 'combo', 'donut', 'treemap', 'waterfall', 'heatmap'] as const)(
    'accepts frontend-supported chart type %s',
    (chartType) => {
      const r = parsePlannerResponse(
        JSON.stringify({ chartType, measureKeys: ['total_revenue_usd'], dimensionKey: 'business_unit', title: 'x' }),
        model,
      );
      expect(r.ok).toBe(true);
    },
  );

  it('REFUSES an invented measure (no hallucination surface)', () => {
    const r = parsePlannerResponse(JSON.stringify({ chartType: 'bar', measureKeys: ['ebitda'], title: 'x' }), model);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/unknown measure/);
  });

  it('normalizes a catalog unit annotation echoed after a real measure key', () => {
    const r = parsePlannerResponse(
      JSON.stringify({ chartType: 'bar', measureKeys: ['gross_margin_pct (%)'], title: 'Margin' }),
      model,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.spec.measureKeys).toEqual(['gross_margin_pct']);
  });

  it('deduplicates a measure and accepts a previous-year comparison', () => {
    const r = parsePlannerResponse(
      JSON.stringify({
        chartType: 'line',
        measureKeys: ['total_revenue_usd', 'total_revenue_usd'],
        timeGrain: 'month',
        comparison: 'previous_year',
        title: 'Revenue vs previous year',
      }),
      model,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.spec.measureKeys).toEqual(['total_revenue_usd']);
      expect(r.spec.comparison).toBe('previous_year');
    }
  });

  it('REFUSES an invented dimension', () => {
    const r = parsePlannerResponse(JSON.stringify({ chartType: 'bar', measureKeys: ['total_revenue_usd'], dimensionKey: 'country', title: 'x' }), model);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/unknown dimension/);
  });

  it('accepts a distinct second breakdown dimension', () => {
    const r = parsePlannerResponse(
      JSON.stringify({
        chartType: 'stacked_bar',
        measureKeys: ['total_revenue_usd'],
        dimensionKey: 'business_unit',
        breakdownKey: 'client_name',
        title: 'Revenue by business unit and client',
      }),
      model,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.spec.breakdownKey).toBe('client_name');
  });

  it('treats empty measureKeys as an honest refusal, surfacing the reason', () => {
    const r = parsePlannerResponse(JSON.stringify({ chartType: 'table', measureKeys: [], title: 'No employee-level data exists' }), model);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/No employee-level data/);
  });

  it('rejects a time grain the dataset does not support', () => {
    const r = parsePlannerResponse(JSON.stringify({ chartType: 'line', measureKeys: ['total_revenue_usd'], timeGrain: 'day', title: 'x' }), model);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/not available/);
  });

  it('handles non-JSON gibberish gracefully', () => {
    const r = parsePlannerResponse('I think you want revenue?', model);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/valid JSON/);
  });
});

describe('ChartPlanner.planChart (with a fake LLM)', () => {
  it('feeds the generated prompt to the LLM and validates its answer', async () => {
    let seenSystem = '';
    const fakeLlm = async (system: string, _user: string) => {
      seenSystem = system;
      return JSON.stringify({ chartType: 'bar', measureKeys: ['total_revenue_usd'], dimensionKey: 'business_unit', title: 'Revenue by BU' });
    };
    const r = await planChart('revenue by business unit', model, fakeLlm);
    expect(r.ok).toBe(true);
    // The prompt must carry this client's real vocabulary.
    expect(seenSystem).toContain('total_revenue_usd');
    expect(seenSystem).toContain('business_unit');
  });

  it('fills an explicitly named entity dimension for a point chart', async () => {
    const employeeModel: SemanticModel = {
      ...model,
      dimensions: [
        ...model.dimensions,
        { key: 'employee_id', label: 'Employee ID', table: 'v', column: 'employee_id' },
      ],
    };
    const fakeLlm = async () => JSON.stringify({
      chartType: 'scatter',
      measureKeys: ['total_revenue_usd', 'gross_margin_pct'],
      title: 'Employee performance',
    });
    const r = await planChart('scatter employee revenue versus margin', employeeModel, fakeLlm);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.spec.dimensionKey).toBe('employee_id');
  });

  it('preserves an explicitly requested scorecard as a KPI visual', async () => {
    const fakeLlm = async () => JSON.stringify({
      chartType: 'combo',
      measureKeys: ['total_revenue_usd', 'gross_margin_pct'],
      dimensionKey: 'client_name',
      title: 'Client scorecard',
    });
    const r = await planChart('Create a client scorecard for revenue and margin', model, fakeLlm);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.spec.chartType).toBe('kpi');
  });

  it('uses revenue rather than a cancelling signed amount for biggest-client ranking', async () => {
    const fakeLlm = async () => JSON.stringify({
      chartType: 'bar',
      measureKeys: ['gross_margin_pct'],
      dimensionKey: 'client_name',
      title: 'Biggest clients',
    });
    const r = await planChart('which are the biggest client', model, fakeLlm);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.spec.measureKeys).toEqual(['total_revenue_usd']);
      expect(r.spec.dimensionKey).toBe('client_name');
    }
  });
});

describe('ChartPlanner.planEdit (conversational refinement, fake LLM)', () => {
  const priorSpec = { chartType: 'line' as const, measureKeys: ['total_revenue_usd'], timeGrain: 'month' as const, title: 'Monthly Revenue' };

  it('passes the CURRENT spec + instruction to the LLM and validates the edited spec', async () => {
    let seenUser = '';
    const fakeLlm = async (_system: string, user: string) => {
      seenUser = user;
      // "add gross margin on another axis" → append the % measure.
      return JSON.stringify({ chartType: 'line', measureKeys: ['total_revenue_usd', 'gross_margin_pct'], timeGrain: 'month', title: 'Revenue & Gross Margin' });
    };
    const r = await planEdit('add gross margin on another axis', priorSpec, model, fakeLlm);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.spec.measureKeys).toEqual(['total_revenue_usd', 'gross_margin_pct']);
    // The model must see the chart it's editing + the request.
    expect(seenUser).toContain('Monthly Revenue');
    expect(seenUser).toContain('add gross margin on another axis');
  });

  it('still REFUSES an edit that invents a measure', async () => {
    const fakeLlm = async () => JSON.stringify({ chartType: 'line', measureKeys: ['total_revenue_usd', 'ebitda'], title: 'x' });
    const r = await planEdit('add ebitda', priorSpec, model, fakeLlm);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/unknown measure/);
  });

  it('honors an explicit bubble-size edit even if the LLM leaves scatter type unchanged', async () => {
    const scatterPrior = {
      chartType: 'scatter' as const,
      measureKeys: ['total_revenue_usd', 'gross_margin_pct'],
      dimensionKey: 'client_name',
      title: 'Client performance',
    };
    const fakeLlm = async () => JSON.stringify({
      ...scatterPrior,
      measureKeys: ['total_revenue_usd', 'gross_margin_pct'],
      chartType: 'scatter',
    });
    const r = await planEdit('use margin as the bubble size', scatterPrior, model, fakeLlm);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.spec.chartType).toBe('bubble');
  });
});

describe('preferDistinctAxisMeasure (separate-axis guarantee)', () => {
  const axisModel = {
    ...model,
    measures: [
      { key: 'total_cost_usd', label: 'Total Cost', unit: 'USD', sourceTable: 'v', expr: { kind: 'sum' as const, column: 'total_cost_usd' } },
      { key: 'gross_margin_usd', label: 'Gross Margin', unit: 'USD', sourceTable: 'v', expr: { kind: 'sum' as const, column: 'gross_margin_usd' } },
      { key: 'gross_margin_pct', label: 'Gross Margin %', unit: '%', sourceTable: 'v', expr: { kind: 'ratio_of_sums' as const, numerator: 'gm', denominator: 'rev' } },
    ],
  };

  it('swaps a same-unit added measure for its different-unit sibling ($ → %)', () => {
    // LLM appended the $ variant; user explicitly wanted a second axis.
    const spec = { chartType: 'bar' as const, measureKeys: ['total_cost_usd', 'gross_margin_usd'], dimensionKey: 'business_unit', title: 'Cost & Gross Margin' };
    const out = preferDistinctAxisMeasure(spec, ['total_cost_usd'], axisModel);
    expect(out.measureKeys).toEqual(['total_cost_usd', 'gross_margin_pct']);
  });

  it('leaves an already-distinct-unit measure alone', () => {
    const spec = { chartType: 'bar' as const, measureKeys: ['total_cost_usd', 'gross_margin_pct'], dimensionKey: 'business_unit', title: 'x' };
    const out = preferDistinctAxisMeasure(spec, ['total_cost_usd'], axisModel);
    expect(out.measureKeys).toEqual(['total_cost_usd', 'gross_margin_pct']);
  });

  it('is a no-op when no different-unit sibling exists', () => {
    const spec = { chartType: 'bar' as const, measureKeys: ['total_cost_usd', 'gross_margin_usd'], dimensionKey: 'business_unit', title: 'x' };
    const noPct = { ...axisModel, measures: axisModel.measures.filter((m) => m.key !== 'gross_margin_pct') };
    const out = preferDistinctAxisMeasure(spec, ['total_cost_usd'], noPct);
    expect(out.measureKeys).toEqual(['total_cost_usd', 'gross_margin_usd']);
  });
});
