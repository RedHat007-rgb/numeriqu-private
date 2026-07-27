/**
 * PromptGenerator — builds the planner's system prompt FROM the derived
 * SemanticModel, per client. This is what replaces the hardcoded schema block +
 * dataset-specific dollar figures in agent-prompts.ts (e.g. "payroll ~$112M").
 * See docs/TARGET_ARCHITECTURE.md §4④.
 *
 * Because the vocabulary is generated from the model, the planner can ONLY
 * reference measures/dimensions that actually exist for THIS client — there is
 * no hallucination surface and no other client's numbers leak in.
 */

import type { MeasureExpr, SemanticModel } from './semantic-model.types';

function aggWord(expr: MeasureExpr): string {
  switch (expr.kind) {
    case 'sum':
      return 'additive total (SUM)';
    case 'sum_if':
      return 'additive conditional total (SUMIF)';
    case 'ratio_of_sums':
      return 'ratio — computed as SUM/SUM, never averaged';
    case 'ratio_of_sum_to_total':
      return 'contribution ratio — computed against the scoped total denominator';
    case 'ratio_of_aggs':
      return 'composed ratio — numerator and denominator each aggregated independently (e.g. flow ÷ average level)';
    case 'last_value':
      return 'point-in-time level (latest within the period)';
    case 'max':
      return 'point-in-time level (max)';
    case 'mean':
      return 'average (mean) — never summed';
    case 'count_distinct':
      return 'distinct count';
  }
}

/** The JSON shape we ask the planner to return (an EngineChartSpec). */
export const PLANNER_OUTPUT_CONTRACT = `Return ONLY a JSON object:
{
  "chartType": "bar|horizontal_bar|stacked_bar|line|area|stacked_area|combo|pie|donut|treemap|scatter|bubble|waterfall|histogram|box_plot|radar|funnel|sankey|heatmap|matrix|table|kpi",
  "measureKeys": ["<one or more measure keys from the catalog>"],
  "dimensionKey": "<optional dimension key>",
  "breakdownKey": "<optional second dimension used for series/color>",
  "hierarchyKeys": ["<optional ordered dimensions for a hierarchical visual such as a treemap>"],
  "timeGrain": "day|month|quarter|year (optional)",
  "filters": [{"dimensionKey":"<catalog dimension key>","operator":"in|not_in","values":["<exact observed catalog value>"]}] (optional),
  "comparison": "previous_year|yoy_growth_pct (optional; use instead of duplicating a measure key)",
  "normalize": <optional boolean — true for percentage contribution / share of total / % of total by category (100%-stacked)>,
  "topN": <optional integer>,
  "sort": "asc|desc (optional)",
  "title": "<concise chart title>"
}`;

export function buildPlannerPrompt(model: SemanticModel): string {
  const measures = model.measures
    .map(
      (m) =>
        `  - ${m.key}${m.unit ? ` (${m.unit})` : ''}: ${m.label} — ${aggWord(m.expr)}`,
    )
    .join('\n');
  const dimensions =
    model.dimensions
      .map((d) => {
        const examples = d.sampleValues?.length
          ? ` — observed examples: ${d.sampleValues.slice(0, 10).map(String).join(', ')}`
          : '';
        return `  - ${d.key}: ${d.label}${examples}`;
      })
      .join('\n') || '  (none)';
  const timeLine = model.time
    ? `Time grain available on "${model.time.column}": ${model.time.grains.join(', ')}.`
    : 'This dataset has no time dimension — do not request a time grain.';

  return [
    'You are a chart planner. Turn the user question into a chart spec using ONLY the catalog below.',
    "This catalog was derived automatically from the client's own data. Do not invent measures, dimensions, or numbers.",
    '',
    `Dataset grain: ${model.factGrain}.`,
    timeLine,
    '',
    'MEASURES (you may only use these keys):',
    measures || '  (none)',
    '',
    'DIMENSIONS (grouping keys):',
    dimensions,
    '',
    'RULES:',
    '- If the question asks for something not expressible with these measures/dimensions, return {"chartType":"table","measureKeys":[],"title":"<why it cannot be answered>"} — refuse honestly, never guess.',
    '- ONLY add a dimensionKey or breakdownKey when the user EXPLICITLY names a grouping — e.g. "by business unit", "per client", "split/broken down by X", "across departments", "for each region". A plain total or a metric shown over time ("total revenue", "monthly total revenue", "revenue trend") with NO named grouping must have NO dimensionKey and NO breakdownKey: return just the measure key (plus timeGrain for a trend). NEVER infer a breakdown from the measure\'s own category — "total revenue" is the single aggregate total, never split by revenue category; "total cost" is the single total, never split by cost category.',
    '- "Total <measure>" always means the single aggregate value of that measure, not a per-category decomposition.',
    '- Set "normalize": true when the user asks for each category\'s PERCENTAGE CONTRIBUTION, SHARE OF TOTAL, "% of total", "% of revenue" by category, proportion, or a 100%-stacked view. Keep the same measure + breakdown; the engine turns each series into its share of the per-axis total and formats it as a percentage. Do NOT switch the measure to a ratio for this.',
    '- Never state or assume specific figures; the engine computes all numbers.',
    '- Ratios/percentages are already computed correctly as SUM/SUM by the engine — just reference the measure key.',
    '- For previous-year / prior-year totals, set comparison to "previous_year". For year-over-year / YoY GROWTH, set comparison to "yoy_growth_pct"; this computes (current − same period last year) ÷ |same period last year| × 100. Keep each measure key only once.',
    '- Preserve the requested visual whenever it is supported: column/clustered/grouped column → bar; horizontal bar → horizontal_bar; stacked column/bar → stacked_bar; stacked area → stacked_area; box plot → box_plot; radar → radar; funnel → funnel; Sankey → sankey.',
    '- A dashboard, KPI dashboard, or scorecard request is expressible as one kpi spec containing all requested measures; keep its optional grouping dimension. Do not refuse merely because it mixes several metrics or units.',
    '- Use combo when the user asks for a combo/dual-axis visual, donut for donut (not pie), and treemap/waterfall/heatmap/bubble exactly when requested.',
    '- For "by X and Y", heatmaps, stacked series, or nested category visuals, set dimensionKey to the primary axis/category and breakdownKey to the second dimension. For a monthly chart "by category", set timeGrain and dimensionKey; the dimension becomes the series breakdown.',
    '- A line chart, area chart, or time-series chart over an explicit calendar window must use the matching timeGrain; never collapse the entire window into one Total point.',
    '- When the user qualifies a category (for example a status, class, type, region, or account classification), add a filter using ONLY an exact observed value from the relevant catalog dimension. Include every observed value required by the requested business category. If the catalog cannot express the qualifier, refuse honestly.',
    '- Never put dates, days, weeks, months, quarters, years, periods, or time columns in filters. Calendar constraints are enforced separately and deterministically by the runtime.',
    '',
    PLANNER_OUTPUT_CONTRACT,
  ].join('\n');
}
