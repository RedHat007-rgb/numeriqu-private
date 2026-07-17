/**
 * ChartPlanner — turns a natural-language question into a validated
 * EngineChartSpec, using ONLY the auto-derived SemanticModel as vocabulary.
 * See docs/TARGET_ARCHITECTURE.md §4④.
 *
 * Split so the LLM call is injectable (`LlmCaller`) and the parse/validate step
 * is pure & unit-testable. Every key the model returns is checked against the
 * SemanticModel — the planner physically cannot reference a measure/dimension
 * that doesn't exist for this client, so there is no hallucination surface.
 */

import { buildPlannerPrompt } from './prompt-generator';
import type { EngineChartSpec, SemanticModel } from './semantic-model.types';

export type LlmCaller = (system: string, user: string) => Promise<string>;

export type PlanResult =
  | { ok: true; spec: EngineChartSpec }
  | { ok: false; reason: string; raw?: string };

const CHART_TYPES = [
  'bar',
  'horizontal_bar',
  'stacked_bar',
  'line',
  'area',
  'stacked_area',
  'combo',
  'pie',
  'donut',
  'treemap',
  'scatter',
  'bubble',
  'waterfall',
  'histogram',
  'box_plot',
  'radar',
  'funnel',
  'sankey',
  'heatmap',
  'matrix',
  'table',
  'kpi',
] as const;
const GRAINS = ['day', 'month', 'quarter', 'year'] as const;

/** Strip ```json fences and parse. Returns null on failure. */
function safeJson(raw: string): any {
  const cleaned = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // Last resort: grab the first {...} block.
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * Validate the planner's raw output against the model. Pure. An empty
 * measureKeys array is treated as an intentional, honest refusal (the prompt
 * instructs the planner to return that when a question can't be answered).
 */
export function parsePlannerResponse(raw: string, model: SemanticModel): PlanResult {
  const obj = safeJson(raw);
  if (!obj || typeof obj !== 'object') return { ok: false, reason: 'planner did not return valid JSON', raw };

  const chartType = obj.chartType;
  if (!CHART_TYPES.includes(chartType)) return { ok: false, reason: `invalid chartType: ${chartType}`, raw };

  const measureKeysRaw: unknown = obj.measureKeys;
  if (!Array.isArray(measureKeysRaw)) return { ok: false, reason: 'measureKeys must be an array', raw };

  // Honest refusal path: no measures ⇒ the planner is saying it can't answer.
  if (measureKeysRaw.length === 0) {
    return { ok: false, reason: obj.title || 'the question cannot be answered with this dataset' };
  }

  const validMeasures = new Set(model.measures.map((m) => m.key));
  // Models occasionally echo the unit annotation shown in the catalog
  // (`sla_compliance_pct (%)`) as part of the key. Resolve that harmless syntax
  // deterministically; still reject anything that does not map to a real key.
  const measureKeys = measureKeysRaw.map((key) =>
    typeof key === 'string' && !validMeasures.has(key)
      ? key.replace(/\s*\([^)]*\)\s*$/, '').trim()
      : key,
  );
  const badMeasure = measureKeys.find((k) => typeof k !== 'string' || !validMeasures.has(k));
  if (badMeasure !== undefined) return { ok: false, reason: `unknown measure: ${String(badMeasure)}`, raw };
  const uniqueMeasureKeys = Array.from(new Set(measureKeys as string[]));

  if (obj.dimensionKey != null) {
    const validDims = new Set(model.dimensions.map((d) => d.key));
    if (typeof obj.dimensionKey !== 'string' || !validDims.has(obj.dimensionKey)) {
      return { ok: false, reason: `unknown dimension: ${obj.dimensionKey}`, raw };
    }
  }

  if (obj.breakdownKey != null) {
    const validDims = new Set(model.dimensions.map((d) => d.key));
    if (typeof obj.breakdownKey !== 'string' || !validDims.has(obj.breakdownKey)) {
      return { ok: false, reason: `unknown breakdown dimension: ${obj.breakdownKey}`, raw };
    }
    if (obj.breakdownKey === obj.dimensionKey) {
      return { ok: false, reason: 'breakdownKey must differ from dimensionKey', raw };
    }
  }

  if (obj.timeGrain != null) {
    if (!GRAINS.includes(obj.timeGrain)) return { ok: false, reason: `invalid timeGrain: ${obj.timeGrain}`, raw };
    if (!model.time || !model.time.grains.includes(obj.timeGrain)) {
      return { ok: false, reason: `time grain ${obj.timeGrain} not available for this dataset`, raw };
    }
  }

  let topN: number | undefined;
  if (obj.topN != null) {
    const n = Number(obj.topN);
    if (!Number.isInteger(n) || n <= 0) return { ok: false, reason: `invalid topN: ${obj.topN}`, raw };
    topN = n;
  }

  const sort = obj.sort === 'asc' || obj.sort === 'desc' ? obj.sort : undefined;
  if (obj.comparison != null && obj.comparison !== 'previous_year') {
    return { ok: false, reason: `invalid comparison: ${obj.comparison}`, raw };
  }

  const spec: EngineChartSpec = {
    chartType,
    measureKeys: uniqueMeasureKeys,
    title: typeof obj.title === 'string' && obj.title ? obj.title : 'Chart',
    ...(obj.dimensionKey ? { dimensionKey: obj.dimensionKey } : {}),
    ...(obj.breakdownKey ? { breakdownKey: obj.breakdownKey } : {}),
    ...(obj.timeGrain ? { timeGrain: obj.timeGrain } : {}),
    ...(obj.comparison === 'previous_year' ? { comparison: 'previous_year' as const } : {}),
    ...(topN ? { topN } : {}),
    ...(sort ? { sort } : {}),
  };
  return { ok: true, spec };
}

/**
 * When the user EXPLICITLY asked to put a measure on a separate/second axis, a
 * dual-axis chart only makes sense if the added measure has a DIFFERENT unit from
 * what's already plotted. LLMs often resolve an ambiguous name ("gross margin")
 * to the dollar variant, which just shares the axis. This deterministically swaps
 * a just-added, same-unit measure for a same-named sibling with a different unit
 * (e.g. "Gross Margin" $ → "Gross Margin %") when one exists in the model. No-op
 * otherwise. Pure + unit-tested; it's a guarantee the flaky prompt can't give.
 */
export function preferDistinctAxisMeasure(
  spec: EngineChartSpec,
  priorMeasureKeys: string[],
  model: SemanticModel,
): EngineChartSpec {
  if (spec.measureKeys.length < 2) return spec;
  const byKey = new Map(model.measures.map((m) => [m.key, m]));
  const primary = byKey.get(spec.measureKeys[0]!);
  if (!primary) return spec;
  const prior = new Set(priorMeasureKeys);
  const STOP = new Set(['the', 'and', 'per', 'usd', 'total', 'net', 'gross']);
  const tokens = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9 ]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 2 && !STOP.has(w)),
    );
  let changed = false;
  const newKeys = spec.measureKeys.map((k, i) => {
    if (i === 0 || prior.has(k)) return k; // only reconsider a NEWLY-added, non-primary measure
    const m = byKey.get(k);
    if (!m || m.unit !== primary.unit) return k; // already differs in unit → genuine second axis
    const mt = tokens(m.label);
    const sibling = model.measures.find(
      (cand) =>
        cand.key !== k &&
        !spec.measureKeys.includes(cand.key) &&
        cand.unit !== primary.unit &&
        [...tokens(cand.label)].some((t) => mt.has(t)),
    );
    if (sibling) {
      changed = true;
      return sibling.key;
    }
    return k;
  });
  return changed ? { ...spec, measureKeys: newKeys } : spec;
}
const INTENT_STOP_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'by', 'chart', 'create', 'dashboard', 'for', 'from',
  'in', 'of', 'on', 'same', 'show', 'the', 'to', 'total', 'visual', 'with',
  'amount', 'average', 'balance', 'count', 'days', 'number', 'percent', 'percentage',
  'pct', 'ratio', 'usd', 'value',
]);

function intentWords(value: string): string[] {
  return value
    .replace(/&/g, ' and ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9+]+/)
    .filter(Boolean)
    .map((word) => {
      if (word.length > 4 && word.endsWith('ies')) return word.slice(0, -3) + 'y';
      if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
      return word;
    });
}

function fieldVocabulary(key: string, label: string): { words: string[]; meaningful: string[]; acronym: string } {
  const words = Array.from(new Set(intentWords(key + ' ' + label)));
  const meaningful = words.filter((word) => !INTENT_STOP_WORDS.has(word));
  const acronym = meaningful.map((word) => word[0]).join('');
  return { words, meaningful, acronym };
}

export function fieldMatchScore(
  text: string,
  key: string,
  label: string,
  sampleValues: Array<string | number> = [],
): number {
  const query = new Set(intentWords(text));
  const queryCompact = [...query].join('');
  const vocab = fieldVocabulary(key, label);
  if (!vocab.meaningful.length) return 0;
  const compact = vocab.meaningful.join('');
  if (compact.length > 2 && queryCompact.includes(compact)) return 20 + vocab.meaningful.length;
  if (vocab.acronym.length >= 2 && query.has(vocab.acronym)) return 18 + vocab.meaningful.length;
  const overlap = vocab.meaningful.filter((word) => query.has(word));
  if (overlap.length === vocab.meaningful.length) return 12 + overlap.length;
  if (overlap.length >= 2) return overlap.length * 4;
  if (vocab.meaningful.length === 1 && overlap.length === 1) return 9;
  if (overlap.length === 1 && !INTENT_STOP_WORDS.has(overlap[0]!)) return 4;
  const sampleScore = sampleValues.reduce<number>((best, sample) => {
    const sampleWords = intentWords(String(sample)).filter((word) => !INTENT_STOP_WORDS.has(word));
    const matched = sampleWords.filter((word) => query.has(word)).length;
    return Math.max(best, matched >= 2 ? 6 + matched : matched ? 3 : 0);
  }, 0);
  return sampleScore;
}

function rankedMeasures(text: string, model: SemanticModel): Array<{ key: string; score: number }> {
  return model.measures
    .map((measure) => ({ key: measure.key, score: fieldMatchScore(text, measure.key, measure.label) }))
    .filter((item) => item.score >= 8)
    .sort((a, b) => b.score - a.score);
}

function rankedDimensions(text: string, model: SemanticModel): Array<{ key: string; score: number }> {
  return model.dimensions
    .map((dimension) => ({
      key: dimension.key,
      score: fieldMatchScore(text, dimension.key, dimension.label, dimension.sampleValues),
    }))
    // A dimension commonly has a technical suffix such as `_id` or `_name`.
    // One meaningful catalog-word match ("employee" -> employee_id) is enough
    // to identify the entity, while cube routing still compares every candidate.
    .filter((item) => item.score >= 4)
    .sort((a, b) => b.score - a.score);
}

function requestedChartType(text: string): EngineChartSpec['chartType'] | undefined {
  const normalized = text.toLowerCase();
  const choices: Array<[RegExp, EngineChartSpec['chartType']]> = [
    [/\bhorizontal\s+bar\b/, 'horizontal_bar'],
    [/\bstacked\s+(?:column|bar)\b/, 'stacked_bar'],
    [/\bstacked\s+area\b/, 'stacked_area'],
    [/\bclustered\s+(?:column|bar)\b|\bgrouped\s+(?:column|bar)\b/, 'bar'],
    [/\bbox\s*plot\b/, 'box_plot'],
    [/\bheat\s*map\b|\bheatmap\b/, 'heatmap'],
    [/\bwaterfall\b/, 'waterfall'],
    [/\bhistogram\b/, 'histogram'],
    [/\btreemap\b/, 'treemap'],
    [/\bsankey\b/, 'sankey'],
    [/\bfunnel\b/, 'funnel'],
    [/\bradar\b/, 'radar'],
    [/\bbubble\b/, 'bubble'],
    [/\bscatter\b/, 'scatter'],
    [/\bdonut\b/, 'donut'],
    [/\bpie\b/, 'pie'],
    [/\bcombo\b|\bdual[- ]axis\b/, 'combo'],
    [/\bline\b/, 'line'],
    [/\barea\b/, 'area'],
    [/\bcolumn\b|\bbar\b/, 'bar'],
    [/\btable\b/, 'table'],
    [/\bkpi\b|\bscorecard\b|\bdashboard\b/, 'kpi'],
  ];
  return choices.find(([pattern]) => pattern.test(normalized))?.[1];
}

function requestedTimeGrain(text: string, model: SemanticModel): EngineChartSpec['timeGrain'] | undefined {
  if (!model.time) return undefined;
  const normalized = text.toLowerCase();
  const requested =
    /\b(?:daily|day)\b/.test(normalized) ? 'day'
      : /\b(?:quarterly|quarter)\b/.test(normalized) ? 'quarter'
        : /\b(?:yearly|annual|year)\b/.test(normalized) ? 'year'
          : /\b(?:monthly|month|trend|over time)\b/.test(normalized) ? 'month'
            : undefined;
  return requested && model.time.grains.includes(requested) ? requested : undefined;
}

function defaultMeasure(model: SemanticModel): string | undefined {
  const additiveMoney = model.measures.find(
    (measure) => measure.unit === 'USD' && measure.expr.kind === 'sum',
  );
  return additiveMoney?.key ?? model.measures[0]?.key;
}

function genericTitle(text: string): string {
  const cleaned = text
    .replace(/^(?:please\s+)?(?:create|generate|show|make)\s+(?:an?\s+)?/i, '')
    .replace(/[.?!]+$/, '')
    .trim();
  return cleaned || 'Chart';
}

function applyCatalogIntent(
  text: string,
  planned: PlanResult,
  model: SemanticModel,
  priorSpec?: EngineChartSpec,
): PlanResult {
  // Never turn an invalid/unknown LLM response into a fabricated chart. The
  // deterministic layer may refine only a response that already validates
  // against this cube's live catalog.
  if (!planned.ok) return planned;
  const measureMatches = rankedMeasures(text, model);
  const dimensionMatches = rankedDimensions(text, model);
  const explicitType = requestedChartType(text);
  const timeGrain = requestedTimeGrain(text, model);
  const isEdit = !!priorSpec;

  let spec: EngineChartSpec = planned.spec;

  const explicitlyMatchedMeasures = measureMatches
    .filter((item) => item.score >= 9)
    .map((item) => item.key);
  if (explicitlyMatchedMeasures.length) {
    const shouldAppend = isEdit && !/\bremove\b/i.test(text);
    spec = {
      ...spec,
      measureKeys: shouldAppend
        ? Array.from(new Set([...(priorSpec?.measureKeys ?? spec.measureKeys), ...explicitlyMatchedMeasures]))
        : explicitlyMatchedMeasures,
    };
  }

  if (dimensionMatches.length) {
    spec = {
      ...spec,
      dimensionKey: dimensionMatches[0]!.key,
      ...(dimensionMatches[1] && (explicitType === 'heatmap' || explicitType === 'sankey' || /\bby\b.+\band\b/i.test(text))
        ? { breakdownKey: dimensionMatches[1]!.key }
        : {}),
    };
  }

  if (explicitType) spec = { ...spec, chartType: explicitType };
  if (timeGrain) spec = { ...spec, timeGrain };
  if (/\b(?:previous|prior|last)\s+year\b|\byear[- ]over[- ]year\b|\byoy\b/i.test(text)) {
    spec = {
      ...spec,
      comparison: 'previous_year',
      ...(model.time && !spec.timeGrain ? { timeGrain: 'month' as const } : {}),
    };
  }

  const top = text.match(/\btop\s+(\d+)\b/i);
  if (top) spec = { ...spec, topN: Number(top[1]), sort: 'desc' };
  else if (/\b(?:biggest|largest|highest|lowest|rank)\b/i.test(text)) {
    spec = { ...spec, sort: /\blowest\b/i.test(text) ? 'asc' : 'desc' };
    if (!measureMatches.length) {
      const fallback = defaultMeasure(model);
      if (fallback) spec = { ...spec, measureKeys: [fallback] };
    }
  }

  if ((spec.chartType === 'scatter' || spec.chartType === 'bubble') && !spec.dimensionKey && !spec.timeGrain) {
    const entity = dimensionMatches[0]?.key ?? model.entities[0]?.nameColumn ?? model.dimensions[0]?.key;
    if (entity) spec = { ...spec, dimensionKey: entity };
  }

  const highlight = text.match(/\b(\d+\+)\s*(?:days?)?\b/i)?.[1];
  if (highlight) spec = { ...spec, highlightNames: [highlight] };

  if (!spec.measureKeys.length) return planned;
  return { ok: true, spec };
}

export async function planChart(
  question: string,
  model: SemanticModel,
  callLlm: LlmCaller,
): Promise<PlanResult> {
  const raw = await callLlm(buildPlannerPrompt(model), question);
  return applyCatalogIntent(question, parsePlannerResponse(raw, model), model);
}

export async function planEdit(
  instruction: string,
  priorSpec: EngineChartSpec,
  model: SemanticModel,
  callLlm: LlmCaller,
): Promise<PlanResult> {
  const system =
    buildPlannerPrompt(model) +
    '\n\nYou are editing an existing chart. Return the COMPLETE updated spec, not a diff. ' +
    'Copy unchanged fields, append requested measures, replace a grouping only when the user names one, ' +
    'and return an empty measureKeys array when the catalog cannot satisfy the request.';
  const user =
    'CURRENT CHART SPEC (JSON):\n' + JSON.stringify(priorSpec) +
    '\n\nUSER CHANGE REQUEST:\n' + instruction;
  const raw = await callLlm(system, user);
  return applyCatalogIntent(instruction, parsePlannerResponse(raw, model), model, priorSpec);
}
