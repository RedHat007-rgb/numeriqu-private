/**
 * CubeRouter — "read all the views." Each ClickHouse view is treated as its own
 * self-contained cube (measures + its own dimensions + grain). A question is
 * planned against each cube; the router returns the first cube that can actually
 * answer it. This is how the engine spans many differently-shaped views WITHOUT
 * incorrectly mixing them (a merged flat model would join incompatible grains).
 * See docs/TARGET_ARCHITECTURE.md §4 (Phase 1, "read all views").
 *
 * Correctness: because a dimension only validates against the cube that actually
 * contains it, "revenue by country" naturally routes to the geography cube and
 * "revenue by business unit" to the BU cube — no heuristics, just validation.
 */

import { fieldMatchScore, planChart, type LlmCaller, type PlanResult } from './chart-planner';
import type { EngineChartSpec, SemanticModel } from './semantic-model.types';

export interface Cube {
  view: string;
  model: SemanticModel;
}

export type CubePlan =
  | { ok: true; cube: Cube; spec: EngineChartSpec }
  | { ok: false; reasons: string[] };

const tokens = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2));

/**
 * Score a plan against the question. A dimension whose words actually appear in
 * the question (e.g. "business_unit" for "by business unit") beats a loose
 * substitution (e.g. a cube that only has "org_name" mapping it to "business
 * unit") — which is exactly the mis-route we must avoid.
 */
function scorePlan(question: string, cube: Cube, spec: EngineChartSpec): number {
  const qt = tokens(question);
  let score = 0;
  if (spec.dimensionKey) {
    const dim = cube.model.dimensions.find((d) => d.key === spec.dimensionKey);
    score += dim
      ? 3 * fieldMatchScore(question, dim.key, dim.label, dim.sampleValues)
      : 0;
  }
  if (spec.timeGrain && [...qt].some((w) => ['month', 'monthly', 'trend', 'quarter', 'year', 'time', 'over'].includes(w))) {
    score += 2;
  }
  // Measures whose key words appear in the question are a mild positive signal.
  for (const mk of spec.measureKeys) {
    const measure = cube.model.measures.find((candidate) => candidate.key === mk);
    if (measure) score += fieldMatchScore(question, measure.key, measure.label);
  }
  // Flow charts need categorical endpoints. A totals-only cube may technically
  // validate a Sankey request, but it cannot produce links, so keep it behind a
  // cube that can supply source/category dimensions.
  if (spec.chartType === 'sankey') {
    score += spec.dimensionKey ? 8 : -100;
    score += spec.breakdownKey ? 8 : -20;
  }
  // A grouped/clustered visual is structurally multi-series. Prefer a cube that
  // can honor that shape with multiple measures or a categorical breakdown.
  if (/\b(?:grouped|clustered)\b/i.test(question)) {
    score += spec.measureKeys.length > 1 || !!spec.breakdownKey ? 12 : -12;
  }
  // On equal lexical coverage, prefer the narrower analytic cube. This breaks
  // ties in favor of a purpose-built summary view over a wide raw ledger without
  // encoding any dataset, question, measure, or dimension name.
  score += 1 / Math.max(1, cube.model.measures.length + cube.model.dimensions.length);
  return score;
}

/**
 * Plan the question against every cube, then pick the highest-scoring valid
 * plan. Order is only a tie-breaker, so a specific cube can no longer be
 * pre-empted by an earlier cube's loose match.
 */
export async function planAcrossCubes(
  question: string,
  cubes: Cube[],
  callLlm: LlmCaller,
): Promise<CubePlan> {
  const reasons: string[] = [];
  const candidates: Array<{ cube: Cube; spec: EngineChartSpec; score: number }> = [];

  for (const cube of cubes) {
    let r: PlanResult;
    try {
      r = await planChart(question, cube.model, callLlm);
    } catch (e) {
      reasons.push(`${cube.view}: ${(e as Error).message}`);
      continue;
    }
    if (!r.ok) {
      reasons.push(`${cube.view}: ${r.reason}`);
      continue;
    }
    candidates.push({ cube, spec: r.spec, score: scorePlan(question, cube, r.spec) });
  }

  if (!candidates.length) return { ok: false, reasons };
  candidates.sort((a, b) => b.score - a.score); // stable: keeps cube order on ties
  const best = candidates[0]!;
  return { ok: true, cube: best.cube, spec: best.spec };
}
