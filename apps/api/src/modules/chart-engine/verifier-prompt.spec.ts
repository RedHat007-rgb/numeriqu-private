import { reconcileAdditive, reconcileRatio, verifyScoped, reconcileForExpr } from './result-verifier';
import { buildPlannerPrompt } from './prompt-generator';
import type { SemanticModel } from './semantic-model.types';

describe('ResultVerifier', () => {
  it('passes when the sum of parts equals the charted total', () => {
    const r = reconcileAdditive([100, 200, 300], 600);
    expect(r.ok).toBe(true);
    expect(r.recomputed).toBe(600);
  });

  it('fails when the charted total drifts from the parts', () => {
    const r = reconcileAdditive([100, 200, 300], 550);
    expect(r.ok).toBe(false);
    expect(r.relDelta).toBeGreaterThan(0.05);
  });

  it('reconciles a ratio as SUM/SUM, not the average of ratios', () => {
    // avg of per-row ratios (0.5, 0.1) = 0.30; true SUM/SUM = 60/300 = 0.20.
    const r = reconcileRatio(60, 300, 0.2);
    expect(r.ok).toBe(true);
    const wrongAvg = reconcileRatio(60, 300, 0.3);
    expect(wrongAvg.ok).toBe(false); // the avg-of-ratios answer is correctly rejected
  });

  it('flags SQL that is not tenant-scoped', () => {
    expect(verifyScoped('SELECT sum(x) FROM analytics.t WHERE tenant_id = {tenantId:String} AND org_id IN ({externalOrgIds:Array(String)})').ok).toBe(true);
    expect(verifyScoped('SELECT sum(x) FROM analytics.t').ok).toBe(false);
  });

  it('routes reconciliation by measure expr kind', () => {
    expect(reconcileForExpr({ kind: 'sum', column: 'x' }, { parts: [1, 2, 3], charted: 6 })).toMatchObject({ ok: true });
    expect(reconcileForExpr({ kind: 'ratio_of_sums', numerator: 'n', denominator: 'd' }, { sumNumerator: 1, sumDenominator: 4, charted: 0.25 })).toMatchObject({ ok: true });
    expect(reconcileForExpr({ kind: 'count_distinct', column: 'id' }, { charted: 5 })).toHaveProperty('skipped');
  });
});

const model: SemanticModel = {
  datasetId: 'ds', version: 1, builtBy: 'auto', factGrain: 'one row per client per month',
  entities: [{ key: 'client', label: 'Client', table: 'v_fact', nameColumn: 'client_name' }],
  dimensions: [{ key: 'business_unit', label: 'Business Unit', table: 'v_fact', column: 'business_unit' }],
  time: { table: 'v_fact', column: 'period_date', grains: ['month', 'quarter', 'year'] },
  measures: [
    { key: 'revenue', label: 'Revenue', unit: 'USD', sourceTable: 'v_fact', expr: { kind: 'sum', column: 'revenue_usd' } },
    { key: 'gross_margin_pct', label: 'Gross Margin %', unit: '%', sourceTable: 'v_fact', expr: { kind: 'ratio_of_sums', numerator: 'gp', denominator: 'rev' } },
  ],
};

describe('PromptGenerator', () => {
  const prompt = buildPlannerPrompt(model);

  it('lists only the model\'s measure/dimension keys', () => {
    expect(prompt).toContain('revenue (USD): Revenue');
    expect(prompt).toContain('gross_margin_pct');
    expect(prompt).toContain('business_unit: Business Unit');
  });

  it('describes ratio as SUM/SUM never averaged', () => {
    expect(prompt).toMatch(/ratio — computed as SUM\/SUM, never averaged/);
  });

  it('contains NO hardcoded dollar figures or client-specific facts', () => {
    // The exact failure mode we are eliminating: baked-in numbers like "$112M".
    expect(prompt).not.toMatch(/\$\s?\d/);
    expect(prompt).not.toMatch(/\d+\s?M\b/);
  });

  it('instructs an honest refusal path', () => {
    expect(prompt).toMatch(/refuse honestly, never guess/);
  });
});
