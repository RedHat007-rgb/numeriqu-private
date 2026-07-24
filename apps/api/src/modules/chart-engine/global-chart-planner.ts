/**
 * One model-facing planning boundary for every dataset.
 *
 * The previous router asked the model to plan independently inside several
 * partial cubes and then used lexical application heuristics to pick a winner.
 * That hid the competing meanings from the model and made a nearby term win
 * over the user's complete intent. This planner gives OpenAI the compact,
 * auto-derived catalog for every available cube in one request. Application
 * code validates the selected cube/spec; it never chooses business metrics.
 */

import { parsePlannerResponse, type LlmCaller } from './chart-planner';
import type { Cube, CubePlan } from './cube-router';
import type { SemanticModel } from './semantic-model.types';

export interface PlannerClarification {
  question: string;
  options: Array<{ label: string; value: string }>;
  reason: string;
  originalQuestion: string;
}

type ModelDecision =
  | {
      verdict: 'chart';
      cubeView: string;
      confidence?: number;
      interpretation?: string;
      spec: unknown;
    }
  | {
      verdict: 'clarify';
      question: string;
      options?: Array<{ label?: string; value?: string }>;
      reason?: string;
    }
  | { verdict: 'unsupported'; reason?: string };

// Keep enough runtime-discovered members for OpenAI to ground ordinary business
// enumerations without falsely declaring a real category missing. This remains
// a bounded catalog sample rather than a dataset-specific member list.
const MAX_SAMPLE_VALUES = 20;
const MAX_CLARIFICATION_OPTIONS = 4;
const MAX_REPAIR_ATTEMPTS = 2;

function cleanJson(raw: string): unknown {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const object = cleaned.match(/\{[\s\S]*\}/)?.[0];
    if (!object) return null;
    try {
      return JSON.parse(object);
    } catch {
      return null;
    }
  }
}

function modelCatalog(model: SemanticModel): object {
  return {
    grain: model.factGrain,
    time: model.time
      ? { column: model.time.column, grains: model.time.grains }
      : null,
    measures: model.measures.map((measure) => ({
      key: measure.key,
      label: measure.label,
      unit: measure.unit,
      aggregation: measure.expr.kind,
      ...(measure.expr.kind === 'ratio_of_sums'
        ? {
            numerator: measure.expr.numerator,
            denominator: measure.expr.denominator,
          }
        : {}),
    })),
    dimensions: model.dimensions.map((dimension) => ({
      key: dimension.key,
      label: dimension.label,
      observedValues: (dimension.sampleValues ?? []).slice(
        0,
        MAX_SAMPLE_VALUES,
      ),
    })),
  };
}

function normalizedPhrase(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function phraseAppears(text: string, phrase: string): boolean {
  if (!phrase) return false;
  return ` ${normalizedPhrase(text)} `.includes(` ${phrase} `);
}

/**
 * Exact catalog-language fidelity guard. OpenAI still interprets synonyms and
 * chooses the cube, but it may not silently omit a dimension the user named
 * verbatim. Keys/labels come entirely from runtime metadata.
 */
function explicitlyNamedDimensions(question: string, cubes: Cube[]): Set<string> {
  const named = new Set<string>();
  for (const cube of cubes) {
    const matches = cube.model.dimensions.flatMap((dimension) => {
      const keyPhrase = normalizedPhrase(dimension.key);
      const labelPhrase = normalizedPhrase(dimension.label);
      const conciseKey = keyPhrase.replace(/\s+(?:name|id|code)$/, '');
      const phrases = [keyPhrase, labelPhrase, conciseKey].filter(
        (phrase, index, all) =>
          phraseAppears(question, phrase) && all.indexOf(phrase) === index,
      );
      return phrases.length
        ? [
            {
              key: dimension.key,
              phrase: phrases.sort((a, b) => b.length - a.length)[0]!,
            },
          ]
        : [];
    });
    for (const match of matches) {
      const shadowedByMoreSpecificDimension = matches.some(
        (other) =>
          other.key !== match.key &&
          other.phrase.length > match.phrase.length &&
          phraseAppears(other.phrase, match.phrase),
      );
      if (!shadowedByMoreSpecificDimension) named.add(match.key);
    }
  }
  return named;
}

/**
 * Two or more observed members from the same runtime dimension are strong
 * evidence that the user is asking for a categorical comparison/component
 * breakdown. Requiring that dimension prevents a stacked/area request from
 * collapsing into one grand total merely because the user named members
 * ("Labor, Technology, SG&A") instead of the catalog label ("Cost Family").
 */
function dimensionsNamedThroughMembers(
  question: string,
  cubes: Cube[],
): Set<string> {
  const named = new Set<string>();
  for (const cube of cubes) {
    for (const dimension of cube.model.dimensions) {
      const matches = new Set(
        (dimension.sampleValues ?? [])
          .map((value) => normalizedPhrase(String(value)))
          .filter((phrase) => phrase && phraseAppears(question, phrase)),
      );
      if (matches.size >= 2) named.add(dimension.key);
    }
  }
  return named;
}

/**
 * OpenAI owns semantic matching, while exact catalog names are a hard fidelity
 * boundary: a measure named by key or label cannot be silently dropped or
 * moved into a non-series presentation field.
 */
function explicitlyNamedMeasures(question: string, cubes: Cube[]): Set<string> {
  const named = new Set<string>();
  for (const cube of cubes) {
    const matches = cube.model.measures.flatMap((measure) => {
      const phrases = [
        normalizedPhrase(measure.key),
        normalizedPhrase(measure.label),
      ].filter((phrase) => phraseAppears(question, phrase));
      return phrases.length
        ? [{ key: measure.key, phrase: phrases.sort((a, b) => b.length - a.length)[0]! }]
        : [];
    });
    for (const match of matches) {
      const shadowedByMoreSpecificMeasure = matches.some(
        (other) =>
          other.key !== match.key &&
          other.phrase.length > match.phrase.length &&
          phraseAppears(other.phrase, match.phrase),
      );
      if (!shadowedByMoreSpecificMeasure) named.add(match.key);
    }
  }
  return named;
}

function requiresCatalogRatio(question: string): boolean {
  const percentageOf = normalizedPhrase(question).match(
    /\b(?:as (?:a )?)?(?:percentage|percent|pct) of (?:the )?([a-z0-9][a-z0-9 ]*)/,
  );
  if (!percentageOf) return false;
  return !/^total(?:\b|$)/.test(percentageOf[1]!.trim());
}

function clarificationRepeatsNamedDimensionChoice(
  question: string,
  decision: Extract<ModelDecision, { verdict: 'clarify' }>,
  cubes: Cube[],
): boolean {
  const named = explicitlyNamedDimensions(question, cubes);
  if (named.size < 2) return false;
  const optionText = (decision.options ?? [])
    .map((option) => `${option?.label ?? ''} ${option?.value ?? ''}`)
    .join(' ');
  let matched = 0;
  for (const key of named) {
    const dimension = cubes
      .flatMap((cube) => cube.model.dimensions)
      .find((candidate) => candidate.key === key);
    if (!dimension) continue;
    const keyPhrase = normalizedPhrase(key);
    const labelPhrase = normalizedPhrase(dimension.label);
    const conciseKey = keyPhrase.replace(/\s+(?:name|id|code)$/, '');
    if (
      phraseAppears(optionText, keyPhrase) ||
      phraseAppears(optionText, labelPhrase) ||
      phraseAppears(optionText, conciseKey)
    ) {
      matched += 1;
    }
  }
  return matched >= 2;
}

function clarificationRepeatsNamedMemberSelection(
  question: string,
  decision: Extract<ModelDecision, { verdict: 'clarify' }>,
  cubes: Cube[],
): boolean {
  const optionTexts = (decision.options ?? []).map((option) =>
    `${option?.label ?? ''} ${option?.value ?? ''}`,
  );
  for (const cube of cubes) {
    for (const dimension of cube.model.dimensions) {
      const requestedMembers = (dimension.sampleValues ?? [])
        .map((value) => normalizedPhrase(String(value)))
        .filter((phrase) => phrase && phraseAppears(question, phrase));
      if (
        requestedMembers.length >= 2 &&
        optionTexts.some((option) =>
          requestedMembers.every((member) => phraseAppears(option, member)),
        )
      )
        return true;
    }
  }
  return false;
}

function clarificationRedundantlyChoosesCurrentChart(
  question: string,
  decision: Extract<ModelDecision, { verdict: 'clarify' }>,
): boolean {
  if (!/\bEDIT THE CURRENT CHART\b/.test(question)) return false;
  const clarificationText = [
    decision.question,
    ...(decision.options ?? []).flatMap((option) => [
      option?.label ?? '',
      option?.value ?? '',
    ]),
  ].join(' ');
  return (
    /\bwhich\b[^?]{0,50}\bchart\b/i.test(clarificationText) ||
    /\bapply\b[^?]{0,50}\bchange\b[^?]{0,25}\bto\b/i.test(
      clarificationText,
    ) ||
    /\bstart (?:a )?new chart\b/i.test(clarificationText)
  );
}

export function buildGlobalPlannerPrompt(cubes: Cube[]): string {
  const catalog = cubes.map((cube) => ({
    cubeView: cube.view,
    ...modelCatalog(cube.model),
  }));

  return [
    'You are Astra, a schema-grounded analytics planner.',
    'Understand the complete user request, choose the ONE cube that can faithfully answer it, and produce a chart specification using only keys from that cube.',
    'The catalog below was discovered from the active customer dataset at runtime. Never invent a field, value, number, formula, or business synonym.',
    '',
    'DECISION POLICY:',
    '- Return "chart" when one interpretation is clearly supported by one cube. Prefer the cube with the most exact requested measures and groupings; the user must never choose a cube, view, field, or other implementation detail.',
    '- The request itself is authoritative. If it says employee, client, account group, service line, month, or another catalog-backed grouping, use that grouping without asking which level to use.',
    '- The grammar "by X" explicitly selects X as the grouping. "Change from A to B by X" means compute the A-to-B comparison for each X; do not ask whether X should be used per category or overall.',
    '- "By X and Y" (or any longer "by X, Y, and Z" list) explicitly requests every named grouping. Use dimensionKey plus breakdownKey for two groupings, or hierarchyKeys for the complete ordered list; never drop one or ask the user to choose only one.',
    '- "Last year to this year" and equivalent wording explicitly requests a previous-year comparison across the full available scope unless another scope is named.',
    '- Equivalent-looking measures in several cubes are not ambiguity when one cube contains the complete requested measure-and-dimension combination. Choose that complete match.',
    '- When a user names several quantities to appear as chart series, prefer a cube where those concepts are separate measures. Do not reinterpret named series as filter values of one generic measure when a complete measure set exists.',
    '- Natural-language wording may be semantically matched to catalog labels (for example, a shorter business phrase to a more precise measure label), but the returned specification must always use exact catalog keys and observed filter values.',
    '- Ordinary grammatical and conventional business paraphrases do not require clarification when one cube has a corresponding measure for every requested series.',
    '- If one cube has a semantically corresponding measure for every named series plus the requested time/grouping dimension, return a chart. Do not ask the user to confirm catalog naming.',
    '- For an unqualified request, use the full available company/date scope. Do not ask for a company, period, threshold, Top N, or subset unless the user explicitly indicates that such a choice is required.',
    '- Return "clarify" only when a MATERIAL BUSINESS CHOICE is absent and different answers would produce meaningfully different results. Do not clarify merely because several cubes contain similar fields, because optional presentation details are unspecified, or because the chart could be improved.',
    '- Clarification questions and options must be phrased entirely in the user’s business language. Never expose cubeView names, field keys, schemas, catalogs, or technical limitations.',
    '- Return "unsupported" when the requested data is absent. Never substitute a nearby metric.',
    '- Consider the full phrase, units, aggregation meaning, named groupings, requested chart type, and conversation clarification together. A lexical overlap alone is not sufficient.',
    '- For an edit containing CURRENT CHART STATE, preserve that exact source cube, keys, grouping, filters, comparison, and presentation unless the user explicitly changes them. If requested additions exist in that source cube, add them there without asking to reconfirm the chart.',
    '- For a follow-up embedded after "User clarification", resolve the original request with that answer.',
    '- A dashboard/scorecard request may use a KPI chart with all requested measures when a single cube contains them.',
    '- Prefer an exact catalog growth/variance measure when the user names it. Use comparison="previous_year" or "yoy_growth_pct" only for an explicitly temporal prior-year/YoY calculation that is not already represented by an exact requested catalog measure. Do not duplicate measure keys.',
    '- Use normalize=true only for share/percentage contribution of categories.',
    '- Use componentMode=true for requested additive components in a stacked chart.',
    '- For a bubble chart, measureKeys must contain the X measure, Y measure, and bubble-size measure in that order. labelMeasureKey controls text labels only and must never be used for bubble size.',
    '- Use highlightTopN, highlightNegative, highlightExtremes, highlightWeakPerformance, highlightCostWithoutRevenue, highlightLowPerformance, or showCumulative only when the user asks for that presentation behavior.',
    '',
    'Return ONLY one JSON object in exactly one of these shapes:',
    '{"verdict":"chart","cubeView":"<exact cubeView>","confidence":0.0,"interpretation":"<short paraphrase>","spec":{"chartType":"bar|horizontal_bar|stacked_bar|line|area|stacked_area|combo|pie|donut|treemap|scatter|bubble|waterfall|histogram|box_plot|radar|funnel|sankey|heatmap|matrix|table|kpi","measureKeys":["<exact keys from selected cube>"],"dimensionKey":"<optional exact key>","breakdownKey":"<optional exact key>","hierarchyKeys":["<optional exact keys>"],"timeGrain":"day|month|quarter|year","filters":[{"dimensionKey":"<exact key>","operator":"in|not_in","values":["<exact observed values>"]}],"comparison":"previous_year|yoy_growth_pct","showVariancePct":true,"normalize":true,"topN":3,"sort":"asc|desc","highlightTopN":3,"highlightNegative":true,"highlightExtremes":"max|min|both","highlightWeakPerformance":true,"highlightCostWithoutRevenue":true,"highlightLowPerformance":true,"showCumulative":true,"componentMode":true,"labelMeasureKey":"<optional exact measure key>","title":"<concise title>"}}',
    '{"verdict":"clarify","question":"<one concise question>","reason":"<why the answer changes the plan>","options":[{"label":"<business label>","value":"<self-contained answer>"}]}',
    '{"verdict":"unsupported","reason":"<specific missing data>"}',
    '',
    'ACTIVE DATASET CATALOG:',
    JSON.stringify(catalog),
  ].join('\n');
}

function clarificationFrom(
  question: string,
  decision: Extract<ModelDecision, { verdict: 'clarify' }>,
): PlannerClarification | null {
  const prompt = String(decision.question ?? '').trim();
  if (!prompt) return null;
  const options = (Array.isArray(decision.options) ? decision.options : [])
    .map((option) => {
      const label = String(option?.label ?? '').trim();
      const value = String(option?.value ?? label).trim();
      return label && value ? { label, value } : null;
    })
    .filter((option): option is { label: string; value: string } => !!option)
    .slice(0, MAX_CLARIFICATION_OPTIONS);
  return {
    question: prompt,
    options,
    reason: String(decision.reason ?? 'The request has multiple supported meanings.').trim(),
    originalQuestion: question,
  };
}

function validateDecision(
  question: string,
  raw: string,
  cubes: Cube[],
  fidelityQuestion = question,
): CubePlan {
  const parsedJson = cleanJson(raw);
  const candidate =
    parsedJson && typeof parsedJson === 'object'
      ? (parsedJson as Record<string, unknown>)
      : null;
  const decision = candidate as ModelDecision | null;
  if (
    candidate &&
    !('verdict' in candidate) &&
    'chartType' in candidate &&
    'measureKeys' in candidate
  ) {
    // Safe compatibility for a model that returns the inner spec directly:
    // accept it only when the exact keys validate against one runtime cube.
    const evaluated = cubes.map((cube) => {
      const parsed = parsePlannerResponse(raw, cube.model);
      return { cube, parsed };
    });
    const matches = evaluated.flatMap(({ cube, parsed }) =>
      parsed.ok ? [{ cube, spec: parsed.spec }] : [],
    );
    if (matches.length === 1) {
      return { ok: true, cube: matches[0]!.cube, spec: matches[0]!.spec };
    }
    if (matches.length > 1) {
      const signatures = new Set(
        matches.map(({ cube, spec }) =>
          JSON.stringify(
            spec.measureKeys.map((key) => {
              const measure = cube.model.measures.find(
                (item) => item.key === key,
              );
              return measure
                ? [measure.key, measure.label, measure.unit, measure.expr.kind]
                : [key];
            }),
          ),
        ),
      );
      if (signatures.size === 1) {
        return {
          ok: true,
          cube: matches[0]!.cube,
          spec: matches[0]!.spec,
        };
      }
      return {
        ok: false,
        reasons: ['planner omitted cubeView and the spec matches multiple cubes'],
      };
    }
    return {
      ok: false,
      reasons: evaluated.map(({ cube, parsed }) =>
        parsed.ok ? `${cube.view}: ambiguous` : `${cube.view}: ${parsed.reason}`,
      ),
    };
  }
  if (!decision || typeof decision !== 'object' || !('verdict' in decision)) {
    return { ok: false, reasons: ['planner did not return a valid decision'] };
  }
  if (decision.verdict === 'clarify') {
    if ((decision.options ?? []).length === 1) {
      return {
        ok: false,
        reasons: [
          'clarification has only one option, so no material business choice exists; use that grounded interpretation and return a chart',
        ],
      };
    }
    if (clarificationRedundantlyChoosesCurrentChart(question, decision)) {
      return {
        ok: false,
        reasons: [
          'clarification asks the user to choose a chart even though the exact current chart state is authoritative',
        ],
      };
    }
    if (clarificationRepeatsNamedDimensionChoice(question, decision, cubes)) {
      return {
        ok: false,
        reasons: [
          'clarification redundantly asks the user to choose among dimensions already explicitly requested together',
        ],
      };
    }
    if (clarificationRepeatsNamedMemberSelection(question, decision, cubes)) {
      return {
        ok: false,
        reasons: [
          'clarification redundantly asks the user to choose members already named in the request and repeated in an option',
        ],
      };
    }
    const clarification = clarificationFrom(question, decision);
    return clarification
      ? { ok: false, reasons: [clarification.reason], clarification }
      : { ok: false, reasons: ['planner returned an empty clarification'] };
  }
  if (decision.verdict === 'unsupported') {
    return {
      ok: false,
      reasons: [String(decision.reason ?? 'The requested data is unavailable.')],
    };
  }
  if (decision.verdict !== 'chart') {
    return { ok: false, reasons: ['planner returned an unknown verdict'] };
  }

  const cube = cubes.find((candidate) => candidate.view === decision.cubeView);
  if (!cube) {
    return {
      ok: false,
      reasons: [`planner selected an unknown cube: ${String(decision.cubeView)}`],
    };
  }
  const parsed = parsePlannerResponse(JSON.stringify(decision.spec), cube.model);
  if (!parsed.ok) return { ok: false, reasons: [parsed.reason] };
  const plannedSpec =
    parsed.spec.breakdownKey && !parsed.spec.dimensionKey
      ? {
          ...parsed.spec,
          dimensionKey: parsed.spec.breakdownKey,
          breakdownKey: undefined,
        }
      : parsed.spec;
  if (
    requiresCatalogRatio(fidelityQuestion) &&
    cube.model.measures.some(
      (measure) => measure.expr.kind === 'ratio_of_sums',
    ) &&
    !plannedSpec.measureKeys.some(
      (key) =>
        cube.model.measures.find((measure) => measure.key === key)?.expr.kind ===
        'ratio_of_sums',
    )
  ) {
    return {
      ok: false,
      reasons: [
        'request asks for a percentage of another quantity, but the plan selected no catalog ratio measure',
      ],
    };
  }
  const omittedMeasures = [
    ...explicitlyNamedMeasures(fidelityQuestion, [cube]),
  ].filter(
    (key) => !plannedSpec.measureKeys.includes(key),
  );
  if (omittedMeasures.length) {
    return {
      ok: false,
      reasons: [
        `plan omitted explicitly requested catalog measure(s): ${omittedMeasures.join(', ')}`,
      ],
    };
  }
  if (plannedSpec.chartType === 'bubble' && plannedSpec.measureKeys.length < 3) {
    return {
      ok: false,
      reasons: [
        'bubble chart requires X, Y, and bubble-size entries in measureKeys',
      ],
    };
  }
  const representedDimensions = new Set(
    [
      plannedSpec.dimensionKey,
      plannedSpec.breakdownKey,
      ...(plannedSpec.hierarchyKeys ?? []),
    ].filter((key): key is string => !!key),
  );
  const omittedDimensions = [
    ...new Set([
      ...explicitlyNamedDimensions(fidelityQuestion, cubes),
      ...dimensionsNamedThroughMembers(fidelityQuestion, [cube]),
    ]),
  ].filter((key) => !representedDimensions.has(key));
  if (omittedDimensions.length) {
    return {
      ok: false,
      reasons: [
        `plan omitted explicitly requested catalog dimension(s): ${omittedDimensions.join(', ')}`,
      ],
    };
  }

  // The SQL comparison contract needs a time bucket even when the requested
  // output is grouped categorically (for example, an annual bridge by product).
  // Choosing the coarsest supported annual grain is structural normalization,
  // not a business-field inference; the model still owns cube/metric/grouping.
  const spec =
    plannedSpec.comparison && !plannedSpec.timeGrain
      ? cube.model.time?.grains.includes('year')
        ? { ...plannedSpec, timeGrain: 'year' as const }
        : plannedSpec
      : plannedSpec;
  return { ok: true, cube, spec };
}

export async function planGloballyAcrossCubes(
  question: string,
  cubes: Cube[],
  callLlm: LlmCaller,
  fidelityQuestion = question,
): Promise<CubePlan> {
  if (!cubes.length) return { ok: false, reasons: ['no cubes are available'] };
  const system = buildGlobalPlannerPrompt(cubes);
  const first = await callLlm(system, question);
  let raw = first;
  let result = validateDecision(question, raw, cubes, fidelityQuestion);
  for (let attempt = 0; attempt < MAX_REPAIR_ATTEMPTS; attempt += 1) {
    if (result.ok || result.clarification) return result;
    // Bounded model-led repair for malformed, incomplete, or unknown catalog
    // references. Validation supplies the exact failure; application code still
    // never chooses a business field.
    raw = await callLlm(
      system,
      [
        `USER REQUEST:\n${question}`,
        `YOUR PREVIOUS JSON:\n${raw}`,
        `MANDATORY VALIDATION ERROR:\n${result.reasons.join(' | ')}`,
        'Return a corrected decision that fixes every validation error using only the active catalog. Do not repeat the rejected decision. Ask a clarification only for a different, genuinely missing business choice.',
      ].join('\n\n'),
    );
    result = validateDecision(question, raw, cubes, fidelityQuestion);
  }
  return result;
}
