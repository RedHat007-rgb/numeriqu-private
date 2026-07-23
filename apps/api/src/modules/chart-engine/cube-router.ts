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

import {
  fieldMatchScore,
  meaningfulWords,
  planChart,
  planExplicitPointChart,
  requestedChartType,
  type LlmCaller,
  type PlanResult,
} from './chart-planner';
import type { EngineChartSpec, SemanticModel } from './semantic-model.types';

export interface Cube {
  view: string;
  model: SemanticModel;
}

export type CubePlan =
  | { ok: true; cube: Cube; spec: EngineChartSpec }
  | { ok: false; reasons: string[] };

const tokens = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2),
  );

/**
 * Whether the user actually asked to group by this dimension. True when the
 * question names the dimension by identity (key/label words: "by service line",
 * "per country") OR names a SPECIFIC multi-word value of it ("for JP Morgan").
 * A lone measure-word collision with a sample value (e.g. "revenue" ⊂ the
 * service_line value "Voice Revenue") does NOT count — that is the false signal
 * that used to split a plain "total revenue" by service line.
 */
function dimensionRequested(
  question: string,
  model: SemanticModel,
  key: string,
  measureKeys: string[],
): boolean {
  const dim = model.dimensions.find((d) => d.key === key);
  if (!dim) return false;
  const qWords = new Set(meaningfulWords(question));
  const dimWords = meaningfulWords(`${dim.key} ${dim.label}`);
  const dimNamed = dimWords.some((w) => qWords.has(w));
  // EXPLICIT grouping phrase ("by cash flow activity", "per client", "for each
  // region"): if the dimension is named at all, the user clearly asked to group by
  // it — keep it, even if a selected measure coincidentally shares those words
  // (e.g. a "Net Activity Cash Flow" measure shares "activity/cash/flow" with the
  // cash_flow_activity dimension). The measure-word exclusion below is ONLY for the
  // ambiguous no-"by" case (e.g. "total revenue" must not split by revenue_category).
  const explicitGrouping =
    /\b(?:by|per|across|group(?:ed)?\s+by|broken\s+down\s+by|split\s+by|for\s+each)\b/i.test(
      question,
    );
  if (explicitGrouping && dimNamed) return true;
  // Words that belong to the SELECTED measure(s) — a dimension that merely shares
  // one of these ("revenue" in both "total revenue" and "revenue_category") is NOT
  // a real grouping request; the word is just the measure bleeding into the dim name.
  const measureWords = new Set(
    measureKeys.flatMap((mk) => {
      const m = model.measures.find((x) => x.key === mk);
      return m ? meaningfulWords(`${m.key} ${m.label}`) : [];
    }),
  );
  // A technical dimension such as cost_category must not be introduced merely
  // because the metric phrase contains "cost" ("monthly SG&A cost"). The user
  // must actually ask for categories, or name a concrete category value below.
  // This still preserves "rank cost categories" and "revenue by category".
  const categoryIdentityMissing =
    dimWords.includes('category') && !qWords.has('category');
  const distinctive = dimWords.filter(
    (w) => qWords.has(w) && !measureWords.has(w),
  );
  if (!categoryIdentityMissing && distinctive.length > 0) return true; // user named the dimension distinctly
  // Otherwise: only keep if the user named a SPECIFIC multi-word value of it
  // (e.g. "JP Morgan") — not a lone measure-word collision with a sample value.
  const nameOnly = fieldMatchScore(question, dim.key, dim.label);
  const withSamples = fieldMatchScore(
    question,
    dim.key,
    dim.label,
    dim.sampleValues,
  );
  return withSamples > nameOnly && withSamples >= 6;
}

/**
 * Deterministically drop a grouping the user never asked for. The planner LLM
 * often adds a dimensionKey/breakdownKey even for a plain total ("total
 * revenue"); the prompt discourages it but cannot guarantee it. This enforces
 * "give the user exactly what they asked" without any dataset/question-specific
 * hardcoding — a grouping survives only if the user named the dimension.
 */
export function stripUnrequestedGrouping(
  question: string,
  spec: EngineChartSpec,
  model: SemanticModel,
): EngineChartSpec {
  let next = spec;
  if (
    next.dimensionKey &&
    !dimensionRequested(question, model, next.dimensionKey, spec.measureKeys)
  ) {
    const { dimensionKey: _drop, ...rest } = next;
    next = rest;
  }
  if (
    next.breakdownKey &&
    !dimensionRequested(question, model, next.breakdownKey, spec.measureKeys)
  ) {
    const { breakdownKey: _drop, ...rest } = next;
    next = rest;
  }
  return next;
}

/**
 * Score a plan against the question. A dimension whose words actually appear in
 * the question (e.g. "business_unit" for "by business unit") beats a loose
 * substitution (e.g. a cube that only has "org_name" mapping it to "business
 * unit") — which is exactly the mis-route we must avoid.
 */
function scorePlan(
  question: string,
  cube: Cube,
  spec: EngineChartSpec,
): number {
  const qt = tokens(question);
  let score = 0;
  score += fieldMatchScore(question, cube.view, cube.view);
  if (spec.dimensionKey) {
    const dim = cube.model.dimensions.find((d) => d.key === spec.dimensionKey);
    if (dim) {
      // Reward a grouping ONLY when the user actually named the dimension by its
      // identity (key/label words: "by service line", "per country"). Matching a
      // dimension's SAMPLE VALUES is a false signal here — e.g. the measure word
      // "revenue" collides with service_line values like "Voice Revenue", which
      // used to route a plain "total revenue" into a spurious per-service-line
      // split. A specific multi-word value match (e.g. "JP Morgan") stays neutral;
      // an unrequested grouping is penalized so the faithful, ungrouped plan wins.
      const nameScore = fieldMatchScore(question, dim.key, dim.label);
      const withSamples = fieldMatchScore(
        question,
        dim.key,
        dim.label,
        dim.sampleValues,
      );
      if (nameScore > 0) score += 3 * nameScore;
      else if (withSamples >= 6)
        score += 0; // user named a specific value → legitimate filter/group
      else score -= 6; // grouping the user never asked for → discourage
    }
  }
  if (
    spec.timeGrain &&
    [...qt].some((w) =>
      ['month', 'monthly', 'trend', 'quarter', 'year', 'time', 'over'].includes(
        w,
      ),
    )
  ) {
    score += 2;
  }
  // Measures whose key words appear in the question are a mild positive signal.
  for (const mk of spec.measureKeys) {
    const measure = cube.model.measures.find(
      (candidate) => candidate.key === mk,
    );
    if (measure) score += fieldMatchScore(question, measure.key, measure.label);
  }
  // Strongly prefer a cube that actually CONTAINS a dimension the user named by
  // identity ("… by cash flow activity" → a cash_flow_activity dimension). Without
  // this, a cube that merely has lookalike measure COLUMNS (e.g. AP cube carrying
  // stray cash_outflow_* columns) can out-score the cube that owns the requested
  // grouping. Uses the cube's own dimensions, so it's dataset-agnostic.
  const namedDimBonus = cube.model.dimensions.reduce(
    (best, d) => Math.max(best, fieldMatchScore(question, d.key, d.label)),
    0,
  );
  score += 2 * namedDimBonus;
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
  score +=
    1 / Math.max(1, cube.model.measures.length + cube.model.dimensions.length);
  return score;
}

/**
 * Cheap lexical relevance of a cube to the question (no LLM): does any of its
 * measures/dimensions/name share words with the question? Used only to shortlist
 * cubes before the expensive per-cube LLM planning pass.
 */
function cubeLexScore(question: string, cube: Cube): number {
  let s = fieldMatchScore(question, cube.view, cube.view);
  for (const m of cube.model.measures)
    s += fieldMatchScore(question, m.key, m.label);
  for (const d of cube.model.dimensions)
    s += fieldMatchScore(question, d.key, d.label, d.sampleValues);
  return s;
}

/**
 * Shortlist the cubes worth LLM-planning. Planning every cube means one OpenAI
 * call PER cube (~20 for the sfin dataset) — the dominant latency. When enough
 * cubes lexically match the question we plan only those (fast); when the match is
 * ambiguous (<MIN) we fall back to ALL cubes so a semantically-right-but-lexically
 * -silent cube is never dropped. Pure/deterministic — safe to unit-test.
 */
export function preselectCubes(
  question: string,
  cubes: Cube[],
  max = 12,
  min = 3,
): Cube[] {
  if (cubes.length <= min) return cubes;
  const positive = cubes
    .map((cube) => ({ cube, s: cubeLexScore(question, cube) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);
  if (positive.length < min) return cubes; // too ambiguous to shortlist safely
  return positive.slice(0, max).map((x) => x.cube);
}

/**
 * Plan the question against every (shortlisted) cube, then pick the
 * highest-scoring valid plan. Order is only a tie-breaker, so a specific cube can
 * no longer be pre-empted by an earlier cube's loose match.
 */
export async function planAcrossCubes(
  question: string,
  cubes: Cube[],
  callLlm: LlmCaller,
): Promise<CubePlan> {
  const reasons: string[] = [];
  const candidates: Array<{
    cube: Cube;
    spec: EngineChartSpec;
    score: number;
  }> = [];

  // Only LLM-plan the cubes lexically relevant to the question — the per-cube LLM
  // call is the dominant cost. Falls back to all cubes when the match is ambiguous.
  // Keep the model-facing surface bounded. Four independently validated cubes
  // are enough to resolve lexical ties without multiplying latency and spend by
  // every dataset view. A question with no catalog overlap is unsupported; do
  // not ask a model to invent a mapping across the entire physical schema.
  const shortlist = preselectCubes(question, cubes, 4, 1).filter(
    (cube) => cubeLexScore(question, cube) > 0,
  );

  // Exact X-versus-Y plans are cheap and catalog-validated, so evaluate them
  // across every cube before lexical shortlisting. A wide cross-domain cube can
  // otherwise rank just outside the top-N shortlist even though it is the only
  // cube that contains both measures and all requested groupings.
  const deterministicViews = new Set<string>();
  for (const cube of cubes) {
    const deterministicPointPlan = planExplicitPointChart(question, cube.model);
    if (!deterministicPointPlan) continue;
    deterministicViews.add(cube.view);
    candidates.push({
      cube,
      spec: deterministicPointPlan,
      score: scorePlan(question, cube, deterministicPointPlan) + 20,
    });
  }

  // When at least one exact catalog-backed point plan exists, do not let a
  // loosely related LLM plan (for example invoice/outstanding-payable for a
  // revenue/payroll request) compete on dimension vocabulary and win. The
  // deterministic candidates already satisfy both axes and all groupings.
  const plannedCubes = deterministicViews.size
    ? []
    : shortlist.filter((cube) => !deterministicViews.has(cube.view));
  const planned = await Promise.all(
    plannedCubes.map(async (cube) => {
      try {
        return {
          ok: true as const,
          cube,
          result: await planChart(question, cube.model, callLlm),
        };
      } catch (error) {
        return { ok: false as const, cube, error: error as Error };
      }
    }),
  );

  for (const item of planned) {
    const cube = item.cube;
    if (!item.ok) {
      reasons.push(`${cube.view}: ${item.error.message}`);
      continue;
    }
    const r: PlanResult = item.result;
    if (!r.ok) {
      reasons.push(`${cube.view}: ${r.reason}`);
      continue;
    }
    if (
      (r.spec.chartType === 'scatter' || r.spec.chartType === 'bubble') &&
      r.spec.measureKeys.length < 2
    ) {
      reasons.push(
        `${cube.view}: point chart requires at least two catalog measures`,
      );
      continue;
    }
    // Enforce "only group when the user asked": drop a spurious dimension/breakdown
    // the LLM added on its own, so a plain "total revenue" is a single total, not a
    // per-category split.
    const spec = stripUnrequestedGrouping(question, r.spec, cube.model);
    candidates.push({ cube, spec, score: scorePlan(question, cube, spec) });
  }

  if (!candidates.length) return { ok: false, reasons };
  candidates.sort((a, b) => b.score - a.score); // stable: keeps cube order on ties
  const best = candidates[0]!;
  // Presentation words are a hard user constraint. Re-apply them at the final
  // routing boundary so no candidate selection or future router refinement can
  // return a different chart type than an explicitly requested bar/line/etc.
  const explicitType = requestedChartType(question);
  const spec = explicitType
    ? { ...best.spec, chartType: explicitType }
    : best.spec;
  return { ok: true, cube: best.cube, spec };
}
