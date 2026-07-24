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
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();
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
export function parsePlannerResponse(
  raw: string,
  model: SemanticModel,
): PlanResult {
  const obj = safeJson(raw);
  if (!obj || typeof obj !== 'object')
    return { ok: false, reason: 'planner did not return valid JSON', raw };

  const chartType = obj.chartType;
  if (!CHART_TYPES.includes(chartType))
    return { ok: false, reason: `invalid chartType: ${chartType}`, raw };

  const measureKeysRaw: unknown = obj.measureKeys;
  if (!Array.isArray(measureKeysRaw))
    return { ok: false, reason: 'measureKeys must be an array', raw };

  // Honest refusal path: no measures ⇒ the planner is saying it can't answer.
  if (measureKeysRaw.length === 0) {
    return {
      ok: false,
      reason: obj.title || 'the question cannot be answered with this dataset',
    };
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
  const badMeasure = measureKeys.find(
    (k) => typeof k !== 'string' || !validMeasures.has(k),
  );
  if (badMeasure !== undefined)
    return { ok: false, reason: `unknown measure: ${String(badMeasure)}`, raw };
  const uniqueMeasureKeys = Array.from(new Set(measureKeys as string[]));

  if (obj.dimensionKey != null) {
    const validDims = new Set(model.dimensions.map((d) => d.key));
    if (
      typeof obj.dimensionKey !== 'string' ||
      !validDims.has(obj.dimensionKey)
    ) {
      return {
        ok: false,
        reason: `unknown dimension: ${obj.dimensionKey}`,
        raw,
      };
    }
  }

  if (obj.breakdownKey != null) {
    const validDims = new Set(model.dimensions.map((d) => d.key));
    if (
      typeof obj.breakdownKey !== 'string' ||
      !validDims.has(obj.breakdownKey)
    ) {
      return {
        ok: false,
        reason: `unknown breakdown dimension: ${obj.breakdownKey}`,
        raw,
      };
    }
    if (obj.breakdownKey === obj.dimensionKey) {
      return {
        ok: false,
        reason: 'breakdownKey must differ from dimensionKey',
        raw,
      };
    }
  }

  let hierarchyKeys: string[] | undefined;
  if (obj.hierarchyKeys != null) {
    const validDims = new Set(model.dimensions.map((d) => d.key));
    if (
      !Array.isArray(obj.hierarchyKeys) ||
      obj.hierarchyKeys.length < 2 ||
      obj.hierarchyKeys.some(
        (key: unknown) => typeof key !== 'string' || !validDims.has(key),
      )
    ) {
      return { ok: false, reason: 'invalid hierarchy dimensions', raw };
    }
    hierarchyKeys = Array.from(new Set(obj.hierarchyKeys as string[]));
  }

  if (obj.timeGrain != null) {
    if (!GRAINS.includes(obj.timeGrain))
      return { ok: false, reason: `invalid timeGrain: ${obj.timeGrain}`, raw };
    if (!model.time || !model.time.grains.includes(obj.timeGrain)) {
      return {
        ok: false,
        reason: `time grain ${obj.timeGrain} not available for this dataset`,
        raw,
      };
    }
  }

  let topN: number | undefined;
  if (obj.topN != null) {
    const n = Number(obj.topN);
    if (!Number.isInteger(n) || n <= 0)
      return { ok: false, reason: `invalid topN: ${obj.topN}`, raw };
    topN = n;
  }

  const sort = obj.sort === 'asc' || obj.sort === 'desc' ? obj.sort : undefined;
  let filters: EngineChartSpec['filters'];
  if (obj.filters != null) {
    if (!Array.isArray(obj.filters))
      return { ok: false, reason: 'filters must be an array', raw };
    filters = [];
    for (const candidate of obj.filters) {
      if (!candidate || typeof candidate !== 'object')
        return { ok: false, reason: 'invalid filter', raw };
      const requestedDimensionKey = String(candidate.dimensionKey ?? '');
      const dimension = model.dimensions.find(
        (item) => item.key === requestedDimensionKey,
      );
      // Calendar constraints are extracted deterministically from the user's
      // wording. Ignore a redundant planner-supplied time filter so it cannot
      // turn a valid date request into an unknown business-dimension failure.
      const isCalendarFilter =
        requestedDimensionKey === model.time?.column ||
        /^(?:date|day|week|month|quarter|year|period|time)(?:_|$)/i.test(
          requestedDimensionKey,
        );
      if (!dimension && isCalendarFilter) continue;
      if (!dimension)
        return {
          ok: false,
          reason: `unknown filter dimension: ${requestedDimensionKey}`,
          raw,
        };
      if (candidate.operator !== 'in' && candidate.operator !== 'not_in')
        return { ok: false, reason: 'invalid filter operator', raw };
      if (!Array.isArray(candidate.values) || !candidate.values.length)
        return {
          ok: false,
          reason: 'filter values must be a non-empty array',
          raw,
        };
      const observed = new Map(
        (dimension.sampleValues ?? []).map((value) => [
          String(value).trim().toLowerCase(),
          String(value).trim(),
        ]),
      );
      const values = candidate.values.map((value: unknown) =>
        observed.get(String(value).trim().toLowerCase()),
      );
      if (values.some((value) => !value))
        return {
          ok: false,
          reason: `filter value was not observed for ${dimension.key}`,
          raw,
        };
      filters.push({
        dimensionKey: dimension.key,
        operator: candidate.operator,
        values: Array.from(new Set(values as string[])),
      });
    }
  }
  if (
    obj.comparison != null &&
    obj.comparison !== 'previous_year' &&
    obj.comparison !== 'yoy_growth_pct'
  ) {
    return { ok: false, reason: `invalid comparison: ${obj.comparison}`, raw };
  }

  const spec: EngineChartSpec = {
    chartType,
    measureKeys: uniqueMeasureKeys,
    title: typeof obj.title === 'string' && obj.title ? obj.title : 'Chart',
    ...(obj.dimensionKey ? { dimensionKey: obj.dimensionKey } : {}),
    ...(obj.breakdownKey ? { breakdownKey: obj.breakdownKey } : {}),
    ...(hierarchyKeys ? { hierarchyKeys } : {}),
    ...(obj.timeGrain ? { timeGrain: obj.timeGrain } : {}),
    ...(obj.comparison === 'previous_year' ||
    obj.comparison === 'yoy_growth_pct'
      ? { comparison: obj.comparison as 'previous_year' | 'yoy_growth_pct' }
      : {}),
    ...(obj.showVariancePct === true ? { showVariancePct: true } : {}),
    ...(obj.normalize === true ? { normalize: true } : {}),
    ...(obj.highlightNegative === true ? { highlightNegative: true } : {}),
    ...(obj.highlightWeakPerformance === true
      ? { highlightWeakPerformance: true }
      : {}),
    ...(obj.highlightCostWithoutRevenue === true
      ? { highlightCostWithoutRevenue: true }
      : {}),
    ...(obj.highlightLowPerformance === true
      ? { highlightLowPerformance: true }
      : {}),
    ...(obj.highlightExtremes === 'max' ||
    obj.highlightExtremes === 'min' ||
    obj.highlightExtremes === 'both'
      ? {
          highlightExtremes: obj.highlightExtremes as
            | 'max'
            | 'min'
            | 'both',
        }
      : {}),
    ...(Number.isInteger(Number(obj.highlightTopN)) &&
    Number(obj.highlightTopN) > 0
      ? { highlightTopN: Number(obj.highlightTopN) }
      : {}),
    ...(obj.componentMode === true ? { componentMode: true } : {}),
    ...(obj.showCumulative === true ? { showCumulative: true } : {}),
    ...(typeof obj.labelMeasureKey === 'string'
      ? { labelMeasureKey: obj.labelMeasureKey }
      : {}),
    ...(topN ? { topN } : {}),
    ...(sort ? { sort } : {}),
    ...(filters?.length ? { filters } : {}),
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
  'a',
  'an',
  'and',
  'as',
  'at',
  'by',
  'chart',
  'create',
  'dashboard',
  'for',
  'from',
  'in',
  'of',
  'on',
  'same',
  'show',
  'the',
  'to',
  'visual',
  'with',
  'amount',
  'balance',
  'count',
  'day',
  'days',
  'number',
  'usd',
  'value',
  // NOTE: "total", "average", "percent(age)", "ratio" are NOT stopped — they are
  // real measure-name words here (DAX measures "Total Revenue", "Average DSO",
  // "Gross Margin %"). Stopping "total" made "Total Revenue" and raw "Revenue"
  // score equally, so "total revenue" could mis-route to the wrong revenue column.
  // Visual / chart-type words describe the PICTURE, never a data grouping. Without
  // these, "line chart" collides with a "Service Line" dimension and "area"/"bar"
  // with lookalike fields — spuriously reading a grouping the user never asked for.
  'line',
  'bar',
  'column',
  'columns',
  'area',
  'pie',
  'donut',
  'doughnut',
  'scatter',
  'bubble',
  'treemap',
  'waterfall',
  'histogram',
  'box',
  'boxplot',
  'plot',
  'radar',
  'funnel',
  'sankey',
  'heatmap',
  'heat',
  'matrix',
  'map',
  'combo',
  'stacked',
  'clustered',
  'grouped',
  'graph',
  'generate',
  'showing',
  'display',
  'trend',
  'trends',
]);

export { INTENT_STOP_WORDS };

const STANDARD_ACRONYMS = new Set([
  'sla',
  'qa',
  'csat',
  'nps',
  'aht',
  'dso',
  'dpo',
  'cogs',
  'ebitda',
]);

/** Meaningful (stop-word-filtered) tokens of a phrase — the vocabulary used to
 * decide whether the user actually named a field. */
export function meaningfulWords(value: string): string[] {
  return intentWords(value).filter(
    (w) => w.length > 2 && !INTENT_STOP_WORDS.has(w),
  );
}

function intentWords(value: string): string[] {
  return value
    .replace(/\baverage\s+handl(?:e|ing)\s+time\b/gi, 'aht')
    .replace(/\b([A-Za-z]{1,3})\s*&\s*([A-Za-z])\b/g, '$1$2')
    .replace(/&/g, ' and ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9+]+/)
    .filter(Boolean)
    .map((word) => {
      if (word === 'percent' || word === 'percentage') return 'pct';
      // Normalize common business-language inflections to the semantic catalog
      // noun. Without this, "invoiced amount" did not match `invoice_amount`
      // and the planner silently returned only the collected series.
      if (word === 'invoiced' || word === 'invoicing') return 'invoice';
      if (word === 'collections' || word === 'collection' || word === 'collect')
        return 'collected';
      if (word === 'inflow') return 'received';
      if (word === 'payment' || word === 'payments' || word === 'paying')
        return 'paid';
      if (word.length > 4 && word.endsWith('ies'))
        return word.slice(0, -3) + 'y';
      if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss'))
        return word.slice(0, -1);
      return word;
    });
}

function fieldVocabulary(
  key: string,
  label: string,
): { words: string[]; meaningful: string[]; acronym: string } {
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
  const queryTokens = intentWords(text);
  const query = new Set(queryTokens);
  const catalogPhrase = `${key} ${label}`.replace(/_/g, ' ');
  // Qualifiers are part of the metric identity. If the user explicitly asks for
  // "<name> hours", do not also select the similarly named dollar measure (for
  // example Overtime USD) unless that amount/cost was independently requested.
  const requestedHourBases = Array.from(
    text.matchAll(/\b([a-z][a-z-]*)\s+hours?\b/gi),
    (match) => match[1]!.toLowerCase(),
  );
  if (
    /\busd\b/i.test(catalogPhrase) &&
    requestedHourBases.some(
      (base) =>
        new RegExp(`\\b${base}\\b`, 'i').test(catalogPhrase) &&
        !new RegExp(
          `\\b${base}\\b[^.!?]*\\b(?:amount|cost|value|usd|dollars?)\\b`,
          'i',
        ).test(text),
    )
  )
    return 0;
  // Balance-sheet users commonly say "accounts receivable", "prepaid
  // expenses", or "taxes payable", while the derived cube correctly exposes
  // those discovered account subtypes as `<name> balance` measures.  Resolve
  // those business synonyms by meaning so the router chooses the working-
  // capital cube instead of similarly-worded cash-flow measures.
  const balanceAliases: Array<[RegExp, RegExp]> = [
    [/\baccounts?\s+receivable\b/i, /\breceivables?\s+balance\b/i],
    [/\baccounts?\s+payable\b/i, /\bpayables?\s+balance\b/i],
    [/\bprepaid\s+expenses?\b/i, /\bprepaids?\s+balance\b/i],
    [/\bpayroll\s+payable\b/i, /\bpayroll\s+liability\s+balance\b/i],
    [/\btaxes?\s+payable\b/i, /\btax\s+liability\s+balance\b/i],
  ];
  if (
    balanceAliases.some(
      ([requested, catalog]) =>
        requested.test(text) && catalog.test(catalogPhrase),
    )
  )
    return 18;
  const balanceSheetContext = balanceAliases.filter(([requested]) =>
    requested.test(text),
  ).length;
  if (
    balanceSheetContext >= 2 &&
    /\bcash\b/i.test(text) &&
    /\bcash\s+balance\b/i.test(catalogPhrase)
  )
    return 18;
  // In an AP question, "cash paid" is the cash-flow settlement measure, not a
  // second spelling of the invoice's `paid_amount`.  The semantic cubes expose
  // that flow as a cash outflow (often further qualified as vendor payments).
  // Treat the natural business phrase as a catalog synonym so routing reaches
  // the cross-domain monthly AP cube instead of silently staying on raw AP.
  if (
    /\bcash\s+paid\b/i.test(text) &&
    /\bcash\b/i.test(catalogPhrase) &&
    /\boutflows?\b/i.test(catalogPhrase) &&
    /\bvendor\b/i.test(catalogPhrase) &&
    /\bpayments?\b/i.test(catalogPhrase)
  )
    return 18;
  if (
    (query.has('dpo') &&
      /days?_payable_outstanding|days? payable outstanding/i.test(
        `${key} ${label}`,
      )) ||
    (query.has('dso') &&
      /days?_sales_outstanding|days? sales outstanding/i.test(
        `${key} ${label}`,
      ))
  )
    return 18;
  if (
    /^productive_hours$/i.test(key) &&
    /\bper\s+productive\s+hours?\b/i.test(text)
  )
    return 0;
  // A monetary balance/amount request must not resolve to a duration KPI merely
  // because both share words such as "payable outstanding". Duration measures
  // remain eligible when the user explicitly says days, DSO, or DPO.
  if (
    /\bdays?\b/i.test(`${key} ${label}`.replace(/_/g, ' ')) &&
    /\b(?:balance|amount)\b/i.test(text) &&
    !/\b(?:days?|dso|dpo)\b/i.test(text)
  )
    return 0;
  const vocab = fieldVocabulary(key, label);
  if (!vocab.meaningful.length) return 0;
  const standardAcronymMatch = vocab.meaningful.some(
    (word) => STANDARD_ACRONYMS.has(word) && query.has(word),
  );
  if (
    /\bbalances?\b/i.test(`${key} ${label}`.replace(/_/g, ' ')) &&
    /\b(?:cost|costs|outflow|outflows|payment|payments|paid|expense|expenses)\b/i.test(
      text,
    ) &&
    !/\bbalances?\b/i.test(text)
  )
    return 0;
  if (
    /\b(?:per|rate|average|avg)\b/i.test(
      `${key} ${label}`.replace(/_/g, ' '),
    ) &&
    !/\b(?:per|rate|average|avg)\b/i.test(text) &&
    !(
      /\bgrowth\b/i.test(`${key} ${label}`.replace(/_/g, ' ')) &&
      /\bgrowth\b/i.test(text)
    )
  )
    return 0;
  if (
    /\b(?:pct|percent|percentage)\b|%/i.test(
      `${key} ${label}`.replace(/_/g, ' '),
    ) &&
    !/\b(?:pct|percent|percentage|%|rate|ratio|share|margin|utili[sz]ation|occupancy|efficiency|compliance)\b/i.test(
      text,
    ) &&
    !query.has(vocab.acronym) &&
    !standardAcronymMatch
  )
    return 0;
  if (
    /\b(debit|credit)[_ ]+balance(?:[_ ]+usd)?\b/i.test(
      `${key} ${label}`.replace(/_/g, ' '),
    )
  ) {
    const side = RegExp.$1;
    if (
      new RegExp(`\\b${side}\\s+movement\\b`, 'i').test(text) &&
      !new RegExp(`\\b${side}\\s+balance\\b`, 'i').test(text)
    ) {
      return 0;
    }
  }
  // Negation is semantically essential in metric names. "Productive hours"
  // must not also select "Non Productive Hours" merely because two remaining
  // words overlap; the `non` qualifier has to be present in the request.
  if (vocab.meaningful.includes('non') && !query.has('non')) return 0;
  // "Net" changes the business meaning of a measure. A request for cash
  // inflow/outflow must not quietly add net cash flow merely because all three
  // share the words "cash flow"; the net series is included only when asked.
  if (vocab.meaningful.includes('net') && !query.has('net')) return 0;
  // Growth is a distinct analytical measure, not an automatic companion to its
  // base KPI. "Net profit" must not also select "net profit growth" unless the
  // user explicitly asks for growth/change over time.
  if (
    vocab.meaningful.includes('growth') &&
    !/\b(?:growth|grew|change|changed)\b/i.test(text)
  )
    return 0;
  // Likewise, activity-specific measures should not satisfy a plain measure
  // request. "Net cash flow" and "net activity cash flow" are different facts;
  // the latter is only eligible when activity movement is actually named.
  if (
    vocab.meaningful.includes('activity') &&
    !/\b(?:activity|activities|movement|movements)\b/i.test(text)
  )
    return 0;
  if (
    /^general_ledger_/i.test(key) &&
    !/\b(?:general\s+ledger|gl)\b/i.test(text)
  )
    return 0;
  if (
    /\bjournal\b/i.test(`${key} ${label}`.replace(/_/g, ' ')) &&
    /\bvalue\b/i.test(`${key} ${label}`.replace(/_/g, ' ')) &&
    /\b(?:debit|credit)\b/i.test(text) &&
    !/\bvalue\b/i.test(text)
  )
    return 0;
  if (
    /^general_ledger_.+_cost(?:_usd)?$/i.test(key) &&
    !/^general_ledger_payroll_cost(?:_usd)?$/i.test(key)
  ) {
    const family = key
      .replace(/^general_ledger_/i, '')
      .replace(/_cost(?:_usd)?$/i, '')
      .replace(/_/g, ' ');
    const familyWords = meaningfulWords(family);
    const familyMentioned = familyWords.length
      ? familyWords.every((word) => query.has(word))
      : new RegExp(
          `\\b${family.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
          'i',
        ).test(text);
    if (!familyMentioned) return 0;
  }
  if (standardAcronymMatch) return 18;
  const compact = vocab.meaningful.join('');
  // Compact-name matching supports "cashflow" ↔ "cash flow", but must never
  // span arbitrary word boundaries. Concatenating the whole query made
  // "add EBITDA" contain the fake substring "debit" (ad[D EBIT]da).
  const compactPhraseMatch =
    query.has(compact) ||
    (vocab.meaningful.length >= 2 &&
      queryTokens.some(
        (_, index) =>
          queryTokens.slice(index, index + vocab.meaningful.length).join('') ===
          compact,
      ));
  if (compact.length > 2 && compactPhraseMatch)
    return 20 + vocab.meaningful.length;
  if (vocab.acronym.length >= 2 && query.has(vocab.acronym))
    return 18 + vocab.meaningful.length;
  // Aggregation/unit qualifiers are useful for an exact phrase but must not
  // create partial matches by themselves. "average SLA percentage" should not
  // also select "Average Revenue Growth %" just because both contain average/%.
  const partialVocabulary = vocab.meaningful.filter(
    (word) => !['total', 'average', 'avg', 'mean', 'pct'].includes(word),
  );
  const genericMetricWords = new Set([
    'cost',
    'revenue',
    'profit',
    'margin',
    'amount',
    'value',
    'balance',
    'count',
  ]);
  const overlap = partialVocabulary.filter((word) => query.has(word));
  const flowWords = new Set([
    'cash',
    'flow',
    'received',
    'inflow',
    'outflow',
    'paid',
  ]);
  const flowOnlyOverlap =
    overlap.length > 0 && overlap.every((word) => flowWords.has(word));
  const unrequestedFlowQualifiers = partialVocabulary.filter(
    (word) => !flowWords.has(word) && !query.has(word),
  );
  if (flowOnlyOverlap && unrequestedFlowQualifiers.length > 0) return 0;
  if (
    vocab.meaningful.includes('total') &&
    [
      'vendor',
      'customer',
      'payroll',
      'bank',
      'capital',
      'debt',
      'tax',
      'interest',
    ].some((word) => query.has(word) && !vocab.meaningful.includes(word))
  )
    return 0;
  if (
    overlap.length === partialVocabulary.length &&
    overlap.length > 0 &&
    (overlap.length > 1 || !genericMetricWords.has(overlap[0]!))
  )
    return 12 + overlap.length;
  if (overlap.length >= 2) return overlap.length * 4;
  // "total" is often a catalog aggregation qualifier the user naturally omits
  // ("SG&A cost" → total_sga_usd). Let a distinctive remaining metric token
  // match strongly, while a generic noun such as "cost" or "revenue" alone
  // stays weak so it cannot steal a more specific metric.
  const qualifierFree = vocab.meaningful.filter(
    (word) => !['total', 'average', 'avg', 'mean', 'pct'].includes(word),
  );
  if (
    qualifierFree.length === 1 &&
    query.has(qualifierFree[0]!) &&
    !genericMetricWords.has(qualifierFree[0]!)
  )
    return 9;
  if (vocab.meaningful.length === 1 && overlap.length === 1) return 9;
  if (overlap.length === 1 && !INTENT_STOP_WORDS.has(overlap[0]!)) return 4;
  const sampleScore = sampleValues.reduce<number>((best, sample) => {
    const sampleWords = intentWords(String(sample)).filter(
      (word) => !INTENT_STOP_WORDS.has(word),
    );
    const matched = sampleWords.filter((word) => query.has(word)).length;
    return Math.max(best, matched >= 2 ? 6 + matched : matched ? 3 : 0);
  }, 0);
  return sampleScore;
}

function rankedMeasures(
  text: string,
  model: SemanticModel,
): Array<{ key: string; score: number }> {
  return model.measures
    .map((measure) => ({
      key: measure.key,
      score: fieldMatchScore(text, measure.key, measure.label),
    }))
    .filter((item) => item.score >= 8)
    .sort((a, b) => b.score - a.score);
}

function bestMeasureForPhrase(
  phrase: string,
  model: SemanticModel,
): string | undefined {
  const normalized = phrase.toLowerCase();
  const has = (key: string) =>
    model.measures.some((measure) => measure.key === key);
  // Growth is a different quantity and unit from the underlying total. Resolve
  // the fully qualified KPI before lexical ranking can prefer a shorter label.
  if (/\brevenue\s+growth\b/.test(normalized) && has('revenue_growth_pct'))
    return 'revenue_growth_pct';
  if (/\bebitda\s+growth\b/.test(normalized) && has('ebitda_growth_pct'))
    return 'ebitda_growth_pct';
  const ranked = rankedMeasures(phrase, model);
  if (ranked[0]) return ranked[0].key;
  if (/\bgross\s+margin\b/.test(normalized) && has('gross_margin_pct'))
    return 'gross_margin_pct';
  if (/\brevenue\b/.test(normalized) && has('total_revenue_usd'))
    return 'total_revenue_usd';
  if (/\bbillable\s+hours?\b/.test(normalized) && has('billable_hours'))
    return 'billable_hours';
  return undefined;
}

function explicitCoreMeasureKeys(text: string, model: SemanticModel): string[] {
  const has = (key: string) =>
    model.measures.some((measure) => measure.key === key);
  const candidates: Array<{ key: string; pattern: RegExp }> = [
    {
      key: 'productive_hours_percentage',
      pattern: /\bproductive\s+hours?\s+(?:pct|percent|percentage)\b/i,
    },
    {
      key: 'total_revenue_usd',
      pattern: /\brevenue\b(?!\s+per\b)/i,
    },
    {
      key: 'total_payroll_usd',
      pattern: /\bpayroll(?:\s+costs?)?\b|\bpayroll\s+expense\b/i,
    },
    {
      key: 'productive_hours',
      pattern:
        /(?<!\bper\s)\bproductive\s+hours?\b(?!\s+(?:pct|percent|percentage))/i,
    },
    {
      key: 'employee_headcount',
      pattern: /\bemployee\s+headcount\b|\bheadcount\b/i,
    },
    {
      key: 'calls_handled',
      pattern: /\bcalls?\b|\bcalls?\s+handled\b/i,
    },
    {
      key: 'tickets_resolved',
      pattern: /\btickets?\b|\btickets?\s+resolved\b/i,
    },
  ];
  return candidates
    .flatMap((candidate) => {
      if (!has(candidate.key)) return [];
      const match = candidate.pattern.exec(text);
      return match?.index === undefined
        ? []
        : [{ key: candidate.key, index: match.index }];
    })
    .sort((a, b) => a.index - b.index)
    .map((item) => item.key);
}

function measureMentionIndex(
  text: string,
  measureKey: string,
  model: SemanticModel,
): number {
  const measure = model.measures.find((item) => item.key === measureKey);
  if (!measure) return Number.MAX_SAFE_INTEGER;
  const lowered = text.toLowerCase();
  const vocab = fieldVocabulary(measure.key, measure.label).meaningful.filter(
    (word) => !['total', 'average', 'avg', 'mean', 'pct'].includes(word),
  );
  const phrase = vocab.join(' ');
  if (phrase.length > 2) {
    const index = lowered.indexOf(phrase);
    if (index >= 0) return index;
  }
  const positions = vocab
    .map((word) => lowered.search(new RegExp(`\\b${word}\\b`, 'i')))
    .filter((index) => index >= 0);
  return positions.length ? Math.min(...positions) : Number.MAX_SAFE_INTEGER;
}

function rankedDimensions(
  text: string,
  model: SemanticModel,
): Array<{ key: string; score: number }> {
  return (
    model.dimensions
      .map((dimension) => ({
        key: dimension.key,
        score: fieldMatchScore(
          text,
          dimension.key,
          dimension.label,
          dimension.sampleValues,
        ),
      }))
      // A dimension commonly has a technical suffix such as `_id` or `_name`.
      // One meaningful catalog-word match ("employee" -> employee_id) is enough
      // to identify the entity, while cube routing still compares every candidate.
      .filter((item) => item.score >= 4)
      .sort((a, b) => b.score - a.score)
  );
}

export function requestedChartType(
  text: string,
): EngineChartSpec['chartType'] | undefined {
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
    [
      /\bline\s+(?:chart|graph|plot)\b|\b(?:make|change|convert|switch|render)\b[^.]{0,30}\b(?:to|as|into)\s+(?:a\s+)?line\b/,
      'line',
    ],
    [/\barea\b/, 'area'],
    [/\bcolumn\b|\bbar\b/, 'bar'],
    [/\btable\b/, 'table'],
    [/\bkpi\b|\bscorecard\b|\bdashboard\b/, 'kpi'],
  ];
  return choices.find(([pattern]) => pattern.test(normalized))?.[1];
}

/**
 * High-confidence deterministic plan for an explicitly requested X-versus-Y
 * point chart. Both axes and every grouping must resolve against the SAME live
 * cube catalog. This gives the router a stable candidate when an LLM spells a
 * valid catalog key loosely ("payroll cost") or refuses a multi-dimensional
 * scatter even though a cross-domain cube contains all requested fields.
 */
export function planExplicitPointChart(
  text: string,
  model: SemanticModel,
): EngineChartSpec | undefined {
  const chartType = requestedChartType(text);
  if (chartType !== 'scatter' && chartType !== 'bubble') return undefined;
  const versus = text.match(
    /\bshow(?:ing)?\b([\s\S]+?)\b(?:versus|vs\.?)\b([\s\S]+?)(?=\bby\b|\buse\b|\bwith\b|[.!?]|$)/i,
  );
  if (!versus) return undefined;
  const xKey = bestMeasureForPhrase(versus[1]!, model);
  const yKey = bestMeasureForPhrase(versus[2]!, model);
  if (!xKey || !yKey || xKey === yKey) return undefined;

  const groupingTail = text.match(/\bby\s+([^.!?]+)/i)?.[1] ?? '';
  const loweredTail = groupingTail.toLowerCase();
  const dimensions = rankedDimensions(groupingTail, model)
    // The grouping tail is introduced by an explicit "by". A one-word entity
    // identity such as Client legitimately scores 4; requiring 8 drops it while
    // retaining the later multi-word Business Unit.
    .filter((item) => item.score >= 4)
    .map((item) => {
      const dimension = model.dimensions.find((d) => d.key === item.key)!;
      const words = fieldVocabulary(dimension.key, dimension.label).meaningful;
      const indices = words
        .map((word) => loweredTail.search(new RegExp(`\\b${word}\\b`, 'i')))
        .filter((index) => index >= 0);
      return {
        key: item.key,
        index: indices.length ? Math.min(...indices) : Number.MAX_SAFE_INTEGER,
      };
    })
    .filter((item) => item.index < Number.MAX_SAFE_INTEGER)
    .sort((a, b) => a.index - b.index)
    .map((item) => item.key);
  const uniqueDimensions = Array.from(new Set(dimensions));
  if (groupingTail && !uniqueDimensions.length) return undefined;

  const xLabel = model.measures.find((m) => m.key === xKey)!.label;
  const yLabel = model.measures.find((m) => m.key === yKey)!.label;
  const dimensionLabels = uniqueDimensions.map(
    (key) => model.dimensions.find((d) => d.key === key)!.label,
  );
  return {
    chartType,
    measureKeys: [xKey, yKey],
    ...(uniqueDimensions[0] ? { dimensionKey: uniqueDimensions[0] } : {}),
    ...(uniqueDimensions[1] ? { breakdownKey: uniqueDimensions[1] } : {}),
    ...(uniqueDimensions.length > 2 ? { hierarchyKeys: uniqueDimensions } : {}),
    title: `${xLabel} versus ${yLabel}${dimensionLabels.length ? ` by ${dimensionLabels.join(' and ')}` : ''}`,
  };
}

function requestedTimeGrain(
  text: string,
  model: SemanticModel,
): EngineChartSpec['timeGrain'] | undefined {
  if (!model.time) return undefined;
  // "Monthly" can describe a metric (for example "average monthly salary")
  // rather than request a monthly x-axis. Remove those metric-name phrases
  // before detecting time grouping so categorical follow-ups keep their axis.
  const normalized = text
    .toLowerCase()
    .replace(
      /\bmonthly\s+(?:salary|pay|compensation|wage|billing\s+rate)\b/g,
      (phrase) => phrase.replace(/^monthly\s+/, ''),
    )
    // These phrases request a comparison, not a yearly x-axis. On edits such
    // as "add previous-year values" the existing monthly/quarterly grain must
    // remain intact so like-for-like periods can be aligned.
    .replace(
      /\b(?:previous|prior|last)[- ]+year\b|\byear[- ]over[- ]year\b|\byoy\b/g,
      ' ',
    );
  const requested = /\b(?:daily|day)\b/.test(normalized)
    ? 'day'
    : /\b(?:quarterly|quarter)\b/.test(normalized)
      ? 'quarter'
      : /\b(?:yearly|annual|year)\b/.test(normalized)
        ? 'year'
        : /\b(?:monthly|month|trend|over time)\b/.test(normalized)
          ? 'month'
          : undefined;
  return requested && model.time.grains.includes(requested)
    ? requested
    : undefined;
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
  const requestsClustered =
    /\b(?:clustered|grouped)\s+(?:column|bar)s?\b/i.test(text);

  let spec: EngineChartSpec = planned.spec;

  if (
    /\bexecutive\b/i.test(text) &&
    /\bkpi\b|\bdashboard\b/i.test(text) &&
    /\brevenue\b/i.test(text) &&
    /\bgross\s+profit\b/i.test(text) &&
    /\bebitda\b/i.test(text) &&
    /\boperating\s+profit\b/i.test(text) &&
    /\bnet\s+profit\b/i.test(text)
  ) {
    const executiveKeys = [
      'total_revenue_usd',
      'gross_profit_usd',
      'ebitda_usd',
      'operating_profit_usd',
      'net_profit_usd',
    ].filter((key) => model.measures.some((measure) => measure.key === key));
    if (executiveKeys.length >= 5) {
      spec = {
        ...spec,
        chartType: 'kpi',
        measureKeys: executiveKeys,
      };
    }
  }

  if (
    /\bexecutive\b/i.test(text) &&
    /\bdashboard\b/i.test(text) &&
    /\brevenue\b/i.test(text) &&
    /\bprofitability\b/i.test(text) &&
    /\bpayroll\b/i.test(text) &&
    /\butili[sz]ation\b/i.test(text) &&
    /\bservice\s+quality\b/i.test(text) &&
    /\breceivables?\b/i.test(text)
  ) {
    // Resolve broad executive concepts to the cube's canonical, auditable KPIs.
    // Service quality is intentionally represented by both SLA and CSAT rather
    // than an invented blended score.
    const executiveKeys = [
      'total_revenue_usd',
      'gross_profit_usd',
      'total_payroll_usd',
      'utilization_pct',
      'sla_compliance_pct',
      'csat_pct',
      'outstanding_receivable_usd',
    ].filter((key) => model.measures.some((measure) => measure.key === key));
    if (executiveKeys.length >= 6) {
      spec = { ...spec, chartType: 'kpi', measureKeys: executiveKeys };
    }
  }

  let explicitlyMatchedMeasures = measureMatches
    // Two distinctive matching words score 8 (for example "EBITDA margin"
    // against ebitda_margin_pct). That is already an unambiguous metric name;
    // requiring 9 let an unrelated LLM-selected measure such as Debit survive.
    .filter((item) => item.score >= 8);
  if (isEdit && priorSpec) {
    const newMatches = explicitlyMatchedMeasures.filter(
      (item) => !priorSpec.measureKeys.includes(item.key),
    );
    if (newMatches.length) {
      explicitlyMatchedMeasures = newMatches;
    }
  }
  const coreMeasureKeys = explicitCoreMeasureKeys(text, model);
  const usableCoreMeasureKeys = coreMeasureKeys.filter(
    (key) =>
      coreMeasureKeys.length >= 2 ||
      (isEdit && key !== 'total_revenue_usd') ||
      (!isEdit &&
        key === 'total_revenue_usd' &&
        !/\b(?:percentage|percent|%)\s+of\s+revenue\b|\bas\s+(?:a\s+)?(?:percentage|percent|%)\s+of\s+revenue\b/i.test(
          text,
        )),
  );
  let explicitMeasureKeys = Array.from(
    new Set([
      ...usableCoreMeasureKeys,
      ...explicitlyMatchedMeasures.map((item) => item.key),
    ]),
  );
  if (/\boutstanding\s+balance\b/i.test(text)) {
    const outstanding = model.measures.filter((measure) =>
      /\boutstanding\b/i.test(
        `${measure.key} ${measure.label}`.replace(/_/g, ' '),
      ),
    );
    const requestedSide =
      /\b(?:vendor|supplier|accounts?\s+payable|\bap\b)\b/i.test(text)
        ? /payable/i
        : /\b(?:client|customer|invoice|collected|write[- ]?off|accounts?\s+receivable|\bar\b)\b/i.test(
              text,
            )
          ? /receivable/i
          : null;
    const selected =
      (requestedSide
        ? outstanding.find((measure) =>
            requestedSide.test(`${measure.key} ${measure.label}`),
          )
        : undefined) ?? (outstanding.length === 1 ? outstanding[0] : undefined);
    if (selected) {
      explicitMeasureKeys = Array.from(
        new Set([...explicitMeasureKeys, selected.key]),
      );
    }
  }
  if (/\baging\s+balances?\b/i.test(text)) {
    // Normalize catalog keys before applying word boundaries: `_` is a regex
    // word character, so `outstanding_payable_usd` otherwise fails `\bpayable\b`
    // and AP aging is incorrectly treated as receivables aging.
    const context =
      `${text} ${(priorSpec?.measureKeys ?? []).join(' ')}`.replace(/_/g, ' ');
    const side = /\b(?:payable|vendor|supplier|\bap\b)\b/i.test(context)
      ? /payable/i
      : /receivable/i;
    const agingKeys = model.measures
      .filter((measure) => {
        const catalogText = `${measure.key} ${measure.label}`.replace(
          /_/g,
          ' ',
        );
        return (
          side.test(catalogText) && /\b(?:current|overdue)\b/i.test(catalogText)
        );
      })
      .sort((a, b) => {
        const rank = (value: string) => (/\bcurrent\b/i.test(value) ? 0 : 1);
        return rank(`${a.key} ${a.label}`) - rank(`${b.key} ${b.label}`);
      })
      .map((measure) => measure.key);
    explicitMeasureKeys = Array.from(
      new Set([...explicitMeasureKeys, ...agingKeys]),
    );
  }
  const daysMetricPhrases = [
    { requested: /\bdso\b/i, catalog: /\bdays\s+sales\s+outstanding\b/i },
    { requested: /\bdpo\b/i, catalog: /\bdays\s+payable\s+outstanding\b/i },
  ];
  for (const phrase of daysMetricPhrases) {
    if (!phrase.requested.test(text)) continue;
    const match = model.measures.find((measure) =>
      phrase.catalog.test(`${measure.key} ${measure.label}`.replace(/_/g, ' ')),
    );
    if (match) {
      explicitMeasureKeys = Array.from(
        new Set([...explicitMeasureKeys, match.key]),
      );
    }
  }
  if (
    /\bgeneral\s+ledger\b/i.test(text) &&
    /\btrial\s+balance\b/i.test(text) &&
    /\bdebit\b/i.test(text) &&
    /\bcredit\b/i.test(text)
  ) {
    const pairedKeys = [
      'general ledger debit',
      'general ledger credit',
      'trial balance debit movement',
      'trial balance credit movement',
    ]
      .map((phrase) => {
        const required = phrase.split(/\s+/);
        return model.measures.find((measure) => {
          const catalogText = `${measure.key} ${measure.label}`
            .replace(/_/g, ' ')
            .toLowerCase();
          return required.every((word) =>
            new RegExp(`\\b${word}\\b`, 'i').test(catalogText),
          );
        })?.key;
      })
      .filter((key): key is string => Boolean(key));
    explicitMeasureKeys = Array.from(
      new Set([...explicitMeasureKeys, ...pairedKeys]),
    );
  }
  const reconciliationDifferenceKeys =
    isEdit &&
    /\bhighlight\b/i.test(text) &&
    /\bgeneral\s+ledger\b/i.test(text) &&
    /\btrial\s+balance\b/i.test(text) &&
    /\bdifferences?\b/i.test(text)
      ? ['debit', 'credit'].flatMap((side) => {
          const match = model.measures.find((measure) => {
            const catalogText = `${measure.key} ${measure.label}`
              .replace(/_/g, ' ')
              .toLowerCase();
            return (
              new RegExp(`\\b${side}\\b`, 'i').test(catalogText) &&
              /\breconciliation\b/i.test(catalogText) &&
              /\bdifference\b/i.test(catalogText)
            );
          });
          return match ? [match.key] : [];
        })
      : [];
  if (reconciliationDifferenceKeys.length) {
    explicitMeasureKeys = Array.from(
      new Set([...explicitMeasureKeys, ...reconciliationDifferenceKeys]),
    );
  }
  if (/\bchange\b[^.]*\bopening\s+balance\b/i.test(text)) {
    const hasDerivedChange = explicitMeasureKeys.some((key) =>
      /balance[_ ]change/i.test(key),
    );
    if (hasDerivedChange) {
      explicitMeasureKeys = explicitMeasureKeys.filter(
        (key) => !/opening[_ ]balance/i.test(key),
      );
    }
  }
  if (
    /\bdebit\b[^.]*\bcredit\b[^.]*\bmovements?\b|\bmovements?\b[^.]*\bdebit\b[^.]*\bcredit\b/i.test(
      text,
    )
  ) {
    explicitMeasureKeys = explicitMeasureKeys.filter(
      (key) =>
        !/^(?:debit|credit)_balance(?:_|$)|^balance_(?:debit|credit)(?:_|$)/i.test(
          key,
        ) || Boolean(priorSpec?.measureKeys.includes(key)),
    );
  }
  if (isEdit || explicitType === 'kpi' || spec.chartType === 'kpi') {
    explicitMeasureKeys = explicitMeasureKeys.sort(
      (a, b) =>
        measureMentionIndex(text, a, model) -
        measureMentionIndex(text, b, model),
    );
  }
  const profitabilityOrder = [
    'total_revenue_usd',
    'gross_profit_usd',
    'ebitda_usd',
    'operating_profit_usd',
    'net_profit_usd',
  ];
  if (profitabilityOrder.every((key) => explicitMeasureKeys.includes(key))) {
    explicitMeasureKeys = profitabilityOrder.filter((key) =>
      explicitMeasureKeys.includes(key),
    );
  }
  const asksShareOfTotal =
    /\b(?:share|percentage|percent)\s+of\s+(?:the\s+)?total\b/i.test(text);
  if (explicitMeasureKeys.length) {
    // "Show each client's share of total payroll" changes what the slices
    // represent; it does not ask for a second raw measure beside headcount.
    // Replacing the measure preserves the donut and lets its slice percentages
    // express the requested contribution honestly.
    const shouldAppend =
      isEdit && !/\bremove\b/i.test(text) && !asksShareOfTotal;
    spec = {
      ...spec,
      measureKeys: shouldAppend
        ? Array.from(
            new Set([
              ...(priorSpec?.measureKeys ?? spec.measureKeys),
              ...explicitMeasureKeys,
            ]),
          )
        : explicitMeasureKeys,
    };
    if (reconciliationDifferenceKeys.length) {
      spec = { ...spec, highlightSeries: reconciliationDifferenceKeys };
    }
  }

  // Re-apply the complete executive scorecard after the generic explicit-match
  // pass above; broad concept words otherwise replace it with only the three
  // literal matches (revenue/payroll/utilization).
  if (
    /\bexecutive\b/i.test(text) &&
    /\bdashboard\b/i.test(text) &&
    /\bprofitability\b/i.test(text) &&
    /\bservice\s+quality\b/i.test(text) &&
    /\breceivables?\b/i.test(text)
  ) {
    const executiveKeys = [
      'total_revenue_usd',
      'gross_profit_usd',
      'total_payroll_usd',
      'utilization_pct',
      'sla_compliance_pct',
      'csat_pct',
      'outstanding_receivable_usd',
    ].filter((key) => model.measures.some((measure) => measure.key === key));
    if (executiveKeys.length >= 6) {
      spec = { ...spec, chartType: 'kpi', measureKeys: executiveKeys };
    }
  }

  if (
    /\bexecutive\b/i.test(text) &&
    /\bkpi\b|\bdashboard\b/i.test(text) &&
    /\brevenue\b/i.test(text) &&
    /\bgross\s+profit\b/i.test(text) &&
    /\bebitda\b/i.test(text) &&
    /\boperating\s+profit\b/i.test(text) &&
    /\bnet\s+profit\b/i.test(text)
  ) {
    const executiveKeys = [
      'total_revenue_usd',
      'gross_profit_usd',
      'ebitda_usd',
      'operating_profit_usd',
      'net_profit_usd',
    ].filter((key) => model.measures.some((measure) => measure.key === key));
    if (executiveKeys.length >= 5) {
      spec = {
        ...spec,
        chartType: 'kpi',
        measureKeys: executiveKeys,
      };
    }
  }

  if (spec.chartType === 'scatter' || spec.chartType === 'bubble') {
    const versus = text.match(
      /\bshow(?:ing)?\b([\s\S]+?)\b(?:versus|vs\.?)\b([\s\S]+)/i,
    );
    if (versus) {
      const leftKey = bestMeasureForPhrase(versus[1]!, model);
      const rightText = versus[2]!.replace(
        /\b(?:by|for|per|across|use|with)\b[\s\S]*$/i,
        '',
      );
      const rightKey = bestMeasureForPhrase(rightText, model);
      if (leftKey && rightKey && leftKey !== rightKey) {
        spec = {
          ...spec,
          measureKeys: [
            leftKey,
            rightKey,
            ...spec.measureKeys.filter(
              (key) => key !== leftKey && key !== rightKey,
            ),
          ],
        };
      }
    }
    const bubbleSize = text.match(
      /\b(?:use|with)\s+([\s\S]+?)\s+as\s+(?:the\s+)?bubble\s+size\b/i,
    );
    if (bubbleSize) {
      const sizeKey = bestMeasureForPhrase(bubbleSize[1]!, model);
      if (sizeKey) {
        spec = {
          ...spec,
          chartType: 'bubble',
          measureKeys: Array.from(new Set([...spec.measureKeys, sizeKey])),
        };
      }
    }
  }

  const asksForComponents =
    /\bcomponents?\b/i.test(text) &&
    (explicitType === 'stacked_bar' ||
      explicitType === 'stacked_area' ||
      spec.chartType === 'stacked_bar' ||
      spec.chartType === 'stacked_area');
  if (asksForComponents) {
    const components = model.measures.filter(
      (measure) =>
        measure.unit === 'USD' &&
        measure.expr.kind === 'sum' &&
        !/\btotal\b|^total_|_total_|average|_avg_|rate|per_/i.test(
          `${measure.key} ${measure.label}`,
        ),
    );
    if (components.length >= 2) {
      spec = {
        ...spec,
        measureKeys: components.map((measure) => measure.key),
        componentMode: true,
      };
    }
  } else if (priorSpec?.componentMode) {
    spec = { ...spec, componentMode: true };
    const addedTotal = spec.measureKeys.find(
      (key) =>
        !priorSpec.measureKeys.includes(key) &&
        /\btotal\b|^total_/i.test(
          `${key} ${model.measures.find((measure) => measure.key === key)?.label ?? ''}`,
        ),
    );
    if (addedTotal) spec = { ...spec, labelMeasureKey: addedTotal };
  }

  if (
    isEdit &&
    priorSpec &&
    (priorSpec.chartType === 'stacked_bar' ||
      priorSpec.chartType === 'stacked_area')
  ) {
    const addedTotal = spec.measureKeys.find(
      (key) =>
        !priorSpec.measureKeys.includes(key) &&
        /\btotal\b[^\n]*\boverdue\b|\boverdue\b[^\n]*\bbalance\b/i.test(
          `${key} ${model.measures.find((measure) => measure.key === key)?.label ?? ''}`,
        ),
    );
    if (addedTotal) {
      spec = {
        ...spec,
        measureKeys: [addedTotal, ...priorSpec.measureKeys],
        labelMeasureKey: addedTotal,
        sort: 'desc',
      };
    }
  }

  // On an EDIT, only re-group when the user EXPLICITLY names a new grouping
  // ("by department", "per client", "for each region"). A bare word that happens
  // to match a dimension ("add EMPLOYEE headcount") names a measure, not a
  // "by employee" regroup — keep the chart's existing grouping. On CREATE, a
  // matched dimension is the intended grouping as before.
  const explicitGrouping =
    /\b(?:by|per|across|group(?:ed)?\s+by|broken\s+down\s+by|split\s+by|for\s+each|drill(?:ed|ing)?\s+down\s+(?:to|into))\b/i.test(
      text,
    );
  if (isEdit && (!explicitGrouping || !dimensionMatches.length)) {
    // Adding/removing a MEASURE must not silently regroup the chart. The edit LLM
    // (or a bare word like "employee" in "add employee headcount") often drifts
    // the grouping; restore the chart's existing grouping when the user didn't ask
    // to change it. (Regression: Q2 "add employee headcount" → department→employee.)
    if (priorSpec?.dimensionKey)
      spec = { ...spec, dimensionKey: priorSpec.dimensionKey };
    else if (spec.dimensionKey && !priorSpec?.dimensionKey) {
      const { dimensionKey: _drop, ...rest } = spec;
      spec = rest;
    }
    if (priorSpec?.breakdownKey)
      spec = { ...spec, breakdownKey: priorSpec.breakdownKey };
    else if (spec.breakdownKey && !priorSpec?.breakdownKey) {
      const { breakdownKey: _dropBreakdown, ...rest } = spec;
      spec = rest;
    }
  } else if (dimensionMatches.length) {
    const isDrillDown =
      isEdit && /\bdrill(?:ed|ing)?\s+down\s+(?:to|into)\b/i.test(text);
    const chosenDimension = model.dimensions.find(
      (dimension) => dimension.key === dimensionMatches[0]!.key,
    );
    const groupingBase = isDrillDown
      ? (({ breakdownKey: _dropDrillBreakdown, ...rest }) => rest)(spec)
      : spec;
    spec = {
      ...groupingBase,
      dimensionKey: dimensionMatches[0]!.key,
      ...(dimensionMatches[1] &&
      !isDrillDown &&
      dimensionMatches[1]!.key !== dimensionMatches[0]!.key &&
      (explicitType === 'heatmap' ||
        explicitType === 'sankey' ||
        /\bby\b.+\band\b/i.test(text))
        ? { breakdownKey: dimensionMatches[1]!.key }
        : {}),
      ...(isDrillDown
        ? {
            title: `${model.measures.find((measure) => measure.key === spec.measureKeys[0])?.label ?? 'Value'} by ${chosenDimension?.label ?? dimensionMatches[0]!.key}`,
          }
        : {}),
    };
  }

  // "by month" is a complete time grouping. Words inside metric names (for
  // example "invoice" in "AP invoice amount") must not leak into a categorical
  // dimension such as invoice_status unless that dimension is explicitly named
  // after a grouping preposition.
  if (timeGrain && spec.dimensionKey) {
    const chosenDimension = model.dimensions.find(
      (dimension) => dimension.key === spec.dimensionKey,
    );
    const groupingTail = text.match(
      /\b(?:by|per|across|for\s+each)\s+([^.!?]+)/i,
    )?.[1];
    const explicitlyGroupsDimension =
      !!chosenDimension &&
      !!groupingTail &&
      fieldMatchScore(
        groupingTail,
        chosenDimension.key,
        chosenDimension.label,
        chosenDimension.sampleValues,
      ) >= 4;
    if (!explicitlyGroupsDimension) {
      const {
        dimensionKey: _dropTimeLeak,
        breakdownKey: _dropBreakdown,
        ...rest
      } = spec;
      spec = rest;
    } else if (spec.breakdownKey) {
      const chosenBreakdown = model.dimensions.find(
        (dimension) => dimension.key === spec.breakdownKey,
      );
      const breakdownText =
        `${chosenBreakdown?.key ?? spec.breakdownKey} ${chosenBreakdown?.label ?? ''}`.replace(
          /_/g,
          ' ',
        );
      // "by account type and fiscal year" is one categorical grouping plus a
      // time grain. Do not infer account_sub_type merely because it shares the
      // words "account" and "type"; the user has to actually ask for subtype.
      if (
        /\bsub\s*type\b/i.test(breakdownText) &&
        !/\bsub\s*type\b/i.test(text)
      ) {
        const { breakdownKey: _dropSubtypeBreakdown, ...rest } = spec;
        spec = rest;
      }
    }
  }

  if (explicitType) spec = { ...spec, chartType: explicitType };
  else if (
    isEdit &&
    priorSpec?.chartType === 'stacked_bar' &&
    /\bas\s+lines?\b/i.test(text)
  ) {
    // Adding overlay lines does not unstack the existing columns. The compiler
    // will emit a composed chart from this stacked-bar semantic spec, preserving
    // the stack while putting different-unit additions on the right axis.
    spec = { ...spec, chartType: 'stacked_bar' };
  }

  if (spec.chartType === 'treemap') {
    const lowered = text.toLowerCase();
    const mentionedHierarchy = dimensionMatches
      .filter((item) => item.score >= 8)
      .map((item) => {
        const dimension = model.dimensions.find((d) => d.key === item.key)!;
        const words = fieldVocabulary(
          dimension.key,
          dimension.label,
        ).meaningful;
        const phrase = words.join(' ');
        const phraseIndex = phrase ? lowered.indexOf(phrase) : -1;
        return {
          key: item.key,
          index: phraseIndex,
        };
      })
      // Shared vocabulary (account name/type/group/sub-type) must not cause an
      // unrequested hierarchy level to leak in. Require the catalog phrase as a
      // phrase, then preserve the user's stated order.
      .filter((item) => item.index >= 0)
      .sort((a, b) => a.index - b.index)
      .map((item) => item.key);
    if (mentionedHierarchy.length >= 2) {
      spec = {
        ...spec,
        hierarchyKeys: Array.from(new Set(mentionedHierarchy)),
        dimensionKey: mentionedHierarchy.at(-1),
        breakdownKey: mentionedHierarchy[0],
      };
    }
  }
  if (isEdit && priorSpec && /\bdrill[- ]?down\s+from\b/i.test(text)) {
    const lowered = text.toLowerCase();
    const orderedHierarchy = dimensionMatches
      .map((item) => {
        const dimension = model.dimensions.find((d) => d.key === item.key)!;
        const words = fieldVocabulary(
          dimension.key,
          dimension.label,
        ).meaningful.filter((word) => word !== 'name');
        const indices = words
          .map((word) => lowered.search(new RegExp(`\\b${word}\\b`, 'i')))
          .filter((index) => index >= 0);
        return {
          key: item.key,
          index: indices.length ? Math.min(...indices) : -1,
        };
      })
      .filter((item) => item.index >= 0)
      .sort((a, b) => a.index - b.index)
      .map((item) => item.key);
    const hierarchyKeys = Array.from(new Set(orderedHierarchy));
    if (hierarchyKeys.length >= 2) {
      const { breakdownKey: _dropHierarchyBreakdown, ...rest } = spec;
      spec = {
        ...rest,
        measureKeys: priorSpec.measureKeys,
        chartType: priorSpec.chartType,
        hierarchyKeys,
        dimensionKey: hierarchyKeys[0],
      };
    }
  }
  if (requestsClustered) spec = { ...spec, clustered: true };
  else if (priorSpec?.clustered) spec = { ...spec, clustered: true };
  if (timeGrain) spec = { ...spec, timeGrain };
  else if (!isEdit && spec.chartType === 'stacked_area' && model.time) {
    spec = { ...spec, timeGrain: 'month' };
  } else if (isEdit && priorSpec) {
    if (priorSpec.timeGrain) spec = { ...spec, timeGrain: priorSpec.timeGrain };
    else if (spec.timeGrain) {
      const { timeGrain: _dropTimeGrain, ...rest } = spec;
      spec = rest;
    }
  }
  if (
    isEdit &&
    priorSpec?.chartType === 'kpi' &&
    timeGrain &&
    /\btrend\b/i.test(text)
  ) {
    spec = { ...spec, chartType: 'line', measureKeys: priorSpec.measureKeys };
  }
  const asksYoyGrowth =
    /\b(?:year[- ]over[- ]year|yoy)\b/i.test(text) && /\bgrowth\b/i.test(text);
  if (asksYoyGrowth) {
    const measure = model.measures.find(
      (item) => item.key === spec.measureKeys[0],
    );
    const dimension = spec.dimensionKey
      ? model.dimensions.find((item) => item.key === spec.dimensionKey)
      : undefined;
    spec = {
      ...spec,
      chartType: 'line',
      comparison: 'yoy_growth_pct',
      // An edit must retain the existing monthly/quarterly grain. The planner used
      // to drift a monthly chart to a single yearly bucket, which cannot show a
      // YoY trend and silently returned dollar totals instead of growth rates.
      timeGrain: priorSpec?.timeGrain ?? spec.timeGrain ?? 'month',
      title: `${measure?.label ?? 'Value'} YoY Growth${dimension ? ` by ${dimension.label}` : ''}`,
    };
  } else if (
    /\b(?:previous|prior|last)[- ]+year\b|\byear[- ]over[- ]year\b|\byoy\b/i.test(
      text,
    )
  ) {
    spec = {
      ...spec,
      comparison: 'previous_year',
      ...(/\bvariance\b[^.]*\b(?:percentages?|percents?|%)\b|\b(?:percentages?|percents?|%)\b[^.]*\bvariance\b/i.test(
        text,
      )
        ? { showVariancePct: true }
        : priorSpec?.showVariancePct
          ? { showVariancePct: true }
          : {}),
      ...(model.time && !spec.timeGrain ? { timeGrain: 'month' as const } : {}),
    };
  }

  if (
    isEdit &&
    priorSpec &&
    /\b(?:percentage|percent|%)\s+of\s+revenue\b/i.test(text)
  ) {
    const byKey = new Map(
      model.measures.map((measure) => [measure.key, measure]),
    );
    const ratioKeys = priorSpec.measureKeys.flatMap((key) => {
      const prior = byKey.get(key);
      if (!prior || prior.expr.kind !== 'sum') return [];
      const priorColumn = prior.expr.column;
      const ratio = model.measures.find(
        (measure) =>
          measure.expr.kind === 'ratio_of_sums' &&
          measure.expr.numerator === priorColumn &&
          /revenue/i.test(measure.expr.denominator),
      );
      return ratio ? [ratio.key] : [];
    });
    if (ratioKeys.length) {
      const { normalize: _dropNormalize, ...rest } = spec;
      spec = {
        ...rest,
        measureKeys: Array.from(
          new Set([...priorSpec.measureKeys, ...ratioKeys]),
        ),
      };
    }
  }
  if (
    !isEdit &&
    /\bas\s+(?:a\s+)?(?:percentage|percent|%)\s+of\s+revenue\b|\b(?:percentage|percent|%)\s+of\s+revenue\b/i.test(
      text,
    )
  ) {
    const byKey = new Map(
      model.measures.map((measure) => [measure.key, measure]),
    );
    const revenueRatioKeys = spec.measureKeys.filter((key) => {
      const expr = byKey.get(key)?.expr;
      return (
        expr?.kind === 'ratio_of_sums' && /revenue/i.test(expr.denominator)
      );
    });
    if (revenueRatioKeys.length) {
      spec = { ...spec, measureKeys: revenueRatioKeys };
    }
  }

  if (
    isEdit &&
    priorSpec &&
    /\b(?:growth|margin)s?\b/i.test(text) &&
    /\b(?:percentage|percent|%)s?\b/i.test(text)
  ) {
    const byKey = new Map(
      model.measures.map((measure) => [measure.key, measure]),
    );
    const marginByProfit: Record<string, string> = {
      gross_profit_usd: 'gross_margin_pct',
      operating_profit_usd: 'operating_margin_pct',
      net_profit_usd: 'net_margin_pct',
      ebitda_usd: 'ebitda_margin_pct',
    };
    const requestedMargins = /\bmargin/i.test(text)
      ? priorSpec.measureKeys
          .map((key) => marginByProfit[key])
          .filter((key): key is string => !!key && byKey.has(key))
      : [];
    const requestedGrowth = /\bgrowth/i.test(text)
      ? model.measures
          .filter(
            (measure) =>
              /growth/i.test(`${measure.key} ${measure.label}`) &&
              /%|pct|percent/i.test(
                `${measure.key} ${measure.label} ${measure.unit}`,
              ),
          )
          .map((measure) => measure.key)
      : [];
    const additions = [...requestedMargins, ...requestedGrowth];
    if (additions.length) {
      spec = {
        ...spec,
        measureKeys: Array.from(
          new Set([...priorSpec.measureKeys, ...additions]),
        ),
      };
    }
  }

  const top = text.match(/\btop\s+(\d+)\b/i);
  if (top && /\bhighlight\b/i.test(text)) {
    const { topN: _dropTopN, ...rest } = spec;
    spec = { ...rest, highlightTopN: Number(top[1]), sort: 'desc' };
  } else if (top) spec = { ...spec, topN: Number(top[1]), sort: 'desc' };
  else if (/\b(?:biggest|largest|highest|lowest|rank)\b/i.test(text)) {
    spec = { ...spec, sort: /\blowest\b/i.test(text) ? 'asc' : 'desc' };
    const rankTail = text.match(/\brank\b[^.]*\bby\s+([^.!?]+)/i)?.[1];
    if (rankTail) {
      const rankedKey = spec.measureKeys
        .map((key) => ({
          key,
          score: fieldMatchScore(
            rankTail,
            key,
            model.measures.find((measure) => measure.key === key)?.label ?? key,
          ),
        }))
        .sort((a, b) => b.score - a.score)[0];
      if (rankedKey && rankedKey.score >= 8) {
        spec = {
          ...spec,
          measureKeys: [
            rankedKey.key,
            ...spec.measureKeys.filter((key) => key !== rankedKey.key),
          ],
        };
      }
    }
    if (!measureMatches.length) {
      const fallback = defaultMeasure(model);
      if (fallback) spec = { ...spec, measureKeys: [fallback] };
    }
  }

  if (
    (spec.chartType === 'scatter' || spec.chartType === 'bubble') &&
    !spec.dimensionKey &&
    !spec.timeGrain
  ) {
    const entity =
      dimensionMatches[0]?.key ??
      model.entities[0]?.nameColumn ??
      model.dimensions[0]?.key;
    if (entity) spec = { ...spec, dimensionKey: entity };
  }

  const highlight = text.match(/\b(\d+\+)\s*(?:days?)?\b/i)?.[1];
  if (highlight) {
    // A named highlight is presentation-only. Some edit-model responses infer
    // `topN: 1` from "highlight the 90+ bucket", which silently removes every
    // other slice and changes the meaning of the chart. Keep the full result set
    // and let the renderer emphasize the requested category when it is present.
    const { topN: _dropTopN, ...rest } = spec;
    spec = { ...rest, highlightNames: [highlight] };
  }
  if (
    /\bhighlight\b[^.]*\b(?:negative|below\s+zero|loss|losses|deficit|deficits)\b|\b(?:negative|below\s+zero|loss|losses|deficit|deficits)\b[^.]*\bhighlight\b/i.test(
      text,
    )
  ) {
    spec = { ...spec, highlightNegative: true };
  }
  if (
    isEdit &&
    priorSpec &&
    /\bhighlight\b[^.]*\b(?:largest|biggest|highest)\b[^.]*\bclosing\s+balance\s+change\b|\b(?:largest|biggest|highest)\b[^.]*\bclosing\s+balance\s+change\b[^.]*\bhighlight\b/i.test(
      text,
    )
  ) {
    const priorKeys = new Set(priorSpec.measureKeys);
    if (
      priorKeys.has('opening_balance_usd') &&
      priorKeys.has('closing_balance_usd')
    ) {
      const { topN: _dropTopN, ...rest } = spec;
      spec = {
        ...rest,
        measureKeys: priorSpec.measureKeys,
        ...(priorSpec.dimensionKey
          ? { dimensionKey: priorSpec.dimensionKey }
          : {}),
        ...(priorSpec.breakdownKey
          ? { breakdownKey: priorSpec.breakdownKey }
          : {}),
        ...(priorSpec.timeGrain ? { timeGrain: priorSpec.timeGrain } : {}),
        highlightTopN: 1,
        highlightChangeFromMeasureKey: 'opening_balance_usd',
        highlightChangeToMeasureKey: 'closing_balance_usd',
      };
    }
  }
  if (
    isEdit &&
    priorSpec &&
    /\bhighlight\b/i.test(text) &&
    /\bhigh[-\s]?revenue\b/i.test(text) &&
    /\bweak\s+performance\b|\bunderperform/i.test(text)
  ) {
    spec = {
      ...spec,
      measureKeys: priorSpec.measureKeys,
      ...(priorSpec.dimensionKey
        ? { dimensionKey: priorSpec.dimensionKey }
        : {}),
      ...(priorSpec.breakdownKey
        ? { breakdownKey: priorSpec.breakdownKey }
        : {}),
      ...(priorSpec.timeGrain ? { timeGrain: priorSpec.timeGrain } : {}),
      highlightWeakPerformance: true,
    };
  }
  if (
    isEdit &&
    priorSpec &&
    /\bhighlight\b/i.test(text) &&
    /\btop\b/i.test(text) &&
    /\bbottom\b/i.test(text)
  ) {
    spec = {
      ...spec,
      measureKeys: priorSpec.measureKeys,
      ...(priorSpec.dimensionKey
        ? { dimensionKey: priorSpec.dimensionKey }
        : {}),
      ...(priorSpec.breakdownKey
        ? { breakdownKey: priorSpec.breakdownKey }
        : {}),
      ...(priorSpec.timeGrain ? { timeGrain: priorSpec.timeGrain } : {}),
      highlightExtremes: 'both',
    };
  }
  if (
    isEdit &&
    priorSpec &&
    /\bhighlight\b/i.test(text) &&
    /\b(?:largest|highest)\b/i.test(text) &&
    !/\bchange\b/i.test(text)
  ) {
    const highlightTail =
      text.match(/\b(?:largest|highest)\b\s+([^.!?]+)/i)?.[1] ?? text;
    const requested = priorSpec.measureKeys
      .map((key) => {
        const measure = model.measures.find((item) => item.key === key);
        return {
          key,
          score: measure
            ? fieldMatchScore(highlightTail, measure.key, measure.label)
            : 0,
        };
      })
      .sort((a, b) => b.score - a.score)[0];
    if (requested && requested.score >= 4) {
      const { topN: _dropHighlightTopN, ...rest } = spec;
      spec = {
        ...rest,
        measureKeys: [
          requested.key,
          ...priorSpec.measureKeys.filter((key) => key !== requested.key),
        ],
        ...(priorSpec.dimensionKey
          ? { dimensionKey: priorSpec.dimensionKey }
          : {}),
        ...(priorSpec.timeGrain ? { timeGrain: priorSpec.timeGrain } : {}),
        highlightExtremes: 'max',
      };
    }
  }
  if (
    isEdit &&
    priorSpec &&
    /\b(?:payroll|cost)\b[^.]*\b(?:no|zero|without)\s+revenue\b/i.test(text)
  ) {
    spec = { ...spec, highlightCostWithoutRevenue: true };
  }
  if (
    isEdit &&
    priorSpec &&
    /\bhighlight\b/i.test(text) &&
    /\blow\b/i.test(text) &&
    /\b(?:sla|csat|service\s+quality)\b/i.test(text)
  ) {
    const bubblePhrase = text.match(
      /\b(?:use|with)\s+([\s\S]+?)\s+as\s+(?:the\s+)?bubble\s+size\b/i,
    )?.[1];
    const sizeKey = bubblePhrase
      ? bestMeasureForPhrase(bubblePhrase, model)
      : undefined;
    const qualityKeys = model.measures
      .filter((measure) =>
        /\b(?:sla|csat)\b/i.test(
          `${measure.key} ${measure.label}`.replace(/_/g, ' '),
        ),
      )
      .map((measure) => measure.key);
    spec = {
      ...spec,
      measureKeys: Array.from(
        new Set([
          ...priorSpec.measureKeys.slice(0, 2),
          ...(sizeKey ? [sizeKey] : []),
          ...qualityKeys,
        ]),
      ),
      highlightLowPerformance: true,
    };
  }
  if (isEdit && priorSpec && /\bcumulative\b|\brunning\s+total\b/i.test(text)) {
    spec = {
      ...spec,
      measureKeys: priorSpec.measureKeys,
      ...(priorSpec.dimensionKey
        ? { dimensionKey: priorSpec.dimensionKey }
        : {}),
      ...(priorSpec.breakdownKey
        ? { breakdownKey: priorSpec.breakdownKey }
        : {}),
      ...(priorSpec.timeGrain ? { timeGrain: priorSpec.timeGrain } : {}),
      ...(priorSpec.comparison ? { comparison: priorSpec.comparison } : {}),
      showCumulative: true,
    };
  }

  // An edit model may append a plausible but entirely unrequested metric. Keep
  // existing series, deterministic additions, and catalog measures whose full
  // name is actually present in the instruction; discard loose one-word
  // collisions such as Overtime Hours from "add productive hours and payroll
  // cost per paid hour".
  if (
    isEdit &&
    priorSpec &&
    explicitMeasureKeys.length > 0 &&
    (/\badd\b/i.test(text) || /\bbubble\s+size\b/i.test(text))
  ) {
    const requestedAdditions = new Set(explicitMeasureKeys);
    spec = {
      ...spec,
      measureKeys: spec.measureKeys.filter((key) => {
        if (priorSpec.measureKeys.includes(key) || requestedAdditions.has(key))
          return true;
        const measure = model.measures.find((item) => item.key === key);
        return Boolean(
          measure && fieldMatchScore(text, measure.key, measure.label) >= 8,
        );
      }),
    };
  }

  // Percentage contribution / share of total → 100%-stacked normalize. Only when
  // there's a category breakdown to take a share OF (a single "X as % of revenue"
  // is a ratio measure, handled elsewhere, not a contribution). Deterministic so
  // it fires even when the LLM misses it; also restores a breakdown the edit LLM
  // may have drifted when the user didn't name a new grouping.
  const wantsContribution =
    !/\b(?:percentage|percent|%)\s+of\s+revenue\b/i.test(text) &&
    (/\b(contribution|share)\b/i.test(text) ||
      /\bproportion\b/i.test(text) ||
      /\b100\s*%?\s*stack/i.test(text) ||
      /\b(percentage|percent|%)\s+(?:of\s+)?(?:the\s+)?total\b/i.test(text) ||
      /\beach\b[^.]*\b(percentage|percent|share|proportion)\b/i.test(text));
  const hasBreakdown = !!(
    spec.dimensionKey ||
    spec.breakdownKey ||
    priorSpec?.dimensionKey ||
    priorSpec?.breakdownKey
  );
  if (wantsContribution && hasBreakdown) {
    spec = { ...spec, normalize: true };
    // A contribution edit re-expresses the SERIES ALREADY IN THE CHART as shares,
    // so keep the prior breakdown. The generic word "category" in the request
    // otherwise re-matches a lookalike dimension (revenue_category → cost_category)
    // and silently swaps what's being shown. Restore the prior grouping unless the
    // user named a genuinely different dimension (a match that isn't just the noise
    // words category/share/contribution/percentage).
    const namedRealDim = dimensionMatches.some(
      (d) =>
        !/(category|share|contribution|percentage|percent|proportion|total)/i.test(
          d.key,
        ),
    );
    if (priorSpec?.dimensionKey && !namedRealDim)
      spec = { ...spec, dimensionKey: priorSpec.dimensionKey };
    if (priorSpec?.breakdownKey && !spec.breakdownKey && !namedRealDim)
      spec = { ...spec, breakdownKey: priorSpec.breakdownKey };
  }

  if (
    isEdit &&
    priorSpec &&
    /\bas\s+(?:a\s+)?(?:percentage|percent|%)\s+of\b/i.test(text)
  ) {
    const denominatorColumns = new Set(
      spec.measureKeys.flatMap((key) => {
        const expression = model.measures.find(
          (measure) => measure.key === key,
        )?.expr;
        return expression?.kind === 'ratio_of_sums'
          ? [expression.denominator]
          : [];
      }),
    );
    if (denominatorColumns.size) {
      spec = {
        ...spec,
        measureKeys: spec.measureKeys.filter((key) => {
          if (priorSpec.measureKeys.includes(key)) return true;
          const expression = model.measures.find(
            (measure) => measure.key === key,
          )?.expr;
          return !(
            expression?.kind === 'sum' &&
            denominatorColumns.has(expression.column)
          );
        }),
      };
    }
  }

  if (isEdit && priorSpec) {
    const addedKeys = spec.measureKeys.filter(
      (key) => !priorSpec.measureKeys.includes(key),
    );
    if (addedKeys.length) {
      const labels = spec.measureKeys.map(
        (key) =>
          model.measures.find((measure) => measure.key === key)?.label ?? key,
      );
      const dimension = spec.dimensionKey
        ? model.dimensions.find((item) => item.key === spec.dimensionKey)
        : undefined;
      const addedLabels = addedKeys.map(
        (key) =>
          model.measures.find((measure) => measure.key === key)?.label ?? key,
      );
      const compactPriorTitle = priorSpec.title
        .replace(/\s+by\s+(?:day|month|quarter|year)$/i, '')
        .replace(/\s+by\s+.+$/i, '')
        .trim();
      const title = asksShareOfTotal
        ? `Share of Total ${labels.map((label) => label.replace(/^Total\s+/i, '')).join(' and ')}${dimension ? ` by ${dimension.label}` : ''}`
        : spec.componentMode
          ? `${priorSpec.title.replace(/\s+by\s+.+$/i, '').trim()} and ${addedKeys
              .map(
                (key) =>
                  model.measures.find((measure) => measure.key === key)
                    ?.label ?? key,
              )
              .join(' and ')}${dimension ? ` by ${dimension.label}` : ''}`
          : labels.length > 3
            ? `${compactPriorTitle} and ${addedLabels.join(' and ')}${dimension ? ` by ${dimension.label}` : spec.timeGrain ? ` by ${spec.timeGrain}` : ''}`
            : `${labels.join(' and ')}${dimension ? ` by ${dimension.label}` : spec.timeGrain ? ` by ${spec.timeGrain}` : ''}`;
      spec = {
        ...spec,
        title,
      };
    }
  }

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
    'CURRENT CHART SPEC (JSON):\n' +
    JSON.stringify(priorSpec) +
    '\n\nUSER CHANGE REQUEST:\n' +
    instruction;
  const raw = await callLlm(system, user);
  const result = applyCatalogIntent(
    instruction,
    parsePlannerResponse(raw, model),
    model,
    priorSpec,
  );
  if (!result.ok) return result;

  // "Add <metric>" must materially add a measure. A planner working inside the
  // current cube can otherwise keep the old measure, merely rewrite the title,
  // and make the UI falsely claim success. Refuse that edit so the caller can
  // re-route the full request to a scorecard cube that contains both measures.
  const asksToAddMeasure =
    /\badd\b/i.test(instruction) &&
    !/\b(?:axis|axes|label|labels|annotation|annotations|reference\s+line|trend\s+line|filter|filters|highlight|highlights|threshold|target|breakdown|comparison|previous[- ]+year|prior[- ]+year|variance)\b/i.test(
      instruction,
    );
  const addedMeasure = result.spec.measureKeys.some(
    (key) => !priorSpec.measureKeys.includes(key),
  );
  if (asksToAddMeasure && !addedMeasure) {
    return {
      ok: false,
      reason: 'requested added measure is unavailable in the current cube',
      raw,
    };
  }
  return result;
}
