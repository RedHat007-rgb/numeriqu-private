/**
 * DataProfiler — classifies each column's aggregation semantics from its TYPE,
 * NAME signals, and DATA STATISTICS. Pure & deterministic so it is fully unit
 * testable (no live DB, no LLM). See docs/TARGET_ARCHITECTURE.md §4②.
 *
 * This is the accuracy core: it decides additive vs semi_additive(stock) vs
 * ratio vs count_distinct vs attribute. The SpecCompiler then MUST honour that,
 * which is what structurally prevents avg-of-ratios and summed-stock bugs.
 *
 * Classification order (first match wins):
 *   1. Non-numeric type            → attribute
 *   2. Ratio by name/unit/range    → ratio (needs numerator/denominator or refuse)
 *   3. Identifier by name          → count_distinct
 *   4. Stock/balance by name       → semi_additive
 *   5. Numeric flow (default)      → additive
 */

import type { AggSemantics, ColumnProfile } from './semantic-model.types';

/** Raw stats a caller collects from ClickHouse for one column. */
export interface ColumnStats {
  table: string;
  column: string;
  type: string;
  distinctCount: number;
  nullFraction: number;
  min?: number | string;
  max?: number | string;
  sampleValues: Array<string | number>;
  /** Total rows sampled/available, used to judge distinctness ratio. */
  rowCount: number;
}

// NB: no trailing \b — ClickHouse sizes types ("Float64", "UInt32", "Decimal(18,2)"),
// and \b does not match between "Float" and "64". Leading boundary is enough.
const NUMERIC_TYPE_RE = /\b(Int|UInt|Float|Decimal)/i;
const DATE_TYPE_RE = /\b(Date|DateTime)/i;

// --- Name signals (case-insensitive, matched on normalized column name) ---
// Ratios / rates / percentages — must never be averaged.
const RATIO_NAME_RE =
  /(_pct|_percent|percentage|_rate\b|ratio|margin|_per_|per_employee|per_head|utili[sz]ation|_share\b|yield|conversion)/i;
// Point-in-time balances / levels — must not be summed across periods.
const STOCK_NAME_RE =
  /(balance|headcount|head_count|employee_count|\bfte\b|outstanding|on_hand|inventory_level|closing|opening|_snapshot|as_of|end_of_period|\beop\b|current_)/i;
// Identifiers — counted distinctly, never summed.
const ID_NAME_RE = /(^id$|_id$|_key$|_code$|uuid|guid|_number$|_no$)/i;
// Operational averages / durations that ARE a genuine row-level mean in the
// source model (DAX uses AVERAGE(...) for these). They must be averaged, not
// summed and not refused. Kept SEPARATE from financial ratios (margin, *_to_
// revenue) which must resolve $ components or refuse — never become a mean.
const AVG_METRIC_NAME_RE =
  /(^avg_|^average_|utili[sz]ation|occupancy|\bsla\b|sla_compliance|csat|\bqa\b|qa_score|\bnps\b|aht_minutes|\baht\b|handle_time|response_time|dso_days|dpo_days|\bdso\b|\bdpo\b|days_sales_outstanding|days_payable_outstanding|days_past_due|attrition|absenteeism|productive_hours_pct|_score$|_score_)/i;
// Explicit flow words (revenue, cost…) reinforce additive even if ambiguous.
const FLOW_NAME_RE =
  /(revenue|sales|amount|cost|expense|spend|payment|invoiced|collected|billed|hours?|work_days|present_days|leave_days|absent_days|units?|quantity|qty|count\b|total_|_usd$|_amount$|gross(?!_margin)|net(?!_margin))/i;
// A clear money amount (dollar column). These are additive flows even when the
// name also contains a ratio word like "margin" (e.g. gross_margin_usd).
const MONEY_AMOUNT_RE = /(_usd$|_amount$|_amt$)/i;
// Integer calendar-part columns are time attributes, not measures.
const TIME_PART_NAME_RE = /^(year|quarter|month|day|week|fiscal_year|fiscal_quarter|period|period_index|day_of_week|iso_week)$/i;

/**
 * Common numerator/denominator name pairs for deriving ratio components.
 * Denominators/numerators are matched loosely (substring) so real EBPO columns
 * like `invoice_amount_usd`, `total_revenue_usd`, `gross_margin_usd` resolve.
 */
const RATIO_COMPONENT_HINTS: Array<{ re: RegExp; numerator: RegExp; denominator: RegExp }> = [
  { re: /gross_margin/i, numerator: /gross_margin_usd|gross_profit|profit|margin_amount/i, denominator: /revenue|sales/i },
  { re: /operating_margin/i, numerator: /operating_profit/i, denominator: /revenue|sales/i },
  { re: /net_margin/i, numerator: /net_profit/i, denominator: /revenue|sales/i },
  { re: /ebitda_margin/i, numerator: /ebitda_usd|ebitda/i, denominator: /revenue|sales/i },
  { re: /sga.*(pct|percent|share|to_revenue)/i, numerator: /total_sga|sga_usd/i, denominator: /revenue|sales/i },
  { re: /cost.*(pct|percent|share).*revenue/i, numerator: /total_cost|cost_usd/i, denominator: /revenue|sales/i },
  { re: /payroll.*(rate|pct|ratio|to_revenue)|payroll_to_revenue/i, numerator: /payroll|labou?r_cost/i, denominator: /revenue|sales/i },
  { re: /utili[sz]ation/i, numerator: /billable|utilized|used/i, denominator: /available|capacity|total_hours/i },
  { re: /collection_(?:rate|efficiency)|collected.*(?:rate|efficiency)/i, numerator: /collected/i, denominator: /invoice|billed|total_billed/i },
  { re: /bad_debt/i, numerator: /write_off|bad_debt/i, denominator: /invoice|revenue|sales/i },
  { re: /payment_rate|paid.*rate/i, numerator: /paid/i, denominator: /invoice|billed/i },
  { re: /productive_hours.*(?:pct|percent|percentage)/i, numerator: /productive_hours/i, denominator: /paid_hours|working_hours|capacity_hours/i },
  { re: /cost_to_income|cost.*ratio/i, numerator: /total_cost|cost_usd/i, denominator: /revenue|income/i },
  { re: /per_employee/i, numerator: /revenue|sales|amount/i, denominator: /headcount|employee_count|employees|fte/i },
];

const normalize = (name: string) => name.trim().toLowerCase();

function isNumeric(type: string): boolean {
  return NUMERIC_TYPE_RE.test(type);
}

function looksLikePercentByRange(stats: ColumnStats): boolean {
  const { min, max } = stats;
  if (typeof min !== 'number' || typeof max !== 'number') return false;
  // Values confined to 0..1 or 0..100 with a name that isn't an obvious count.
  const in01 = min >= 0 && max <= 1.0001;
  const in0100 = min >= 0 && max <= 100.0001;
  return in01 || in0100;
}

/**
 * Try to resolve a ratio's numerator/denominator from sibling columns in the
 * same table. Returns undefined if we can't — the caller then refuses rather
 * than fabricating an average.
 */
export function deriveRatioComponents(
  column: string,
  siblingColumns: string[],
): { numerator: string; denominator: string } | undefined {
  const col = normalize(column);
  const sibs = siblingColumns.filter((c) => normalize(c) !== col);
  for (const hint of RATIO_COMPONENT_HINTS) {
    if (!hint.re.test(col)) continue;
    const numerator = sibs.find((c) => hint.numerator.test(normalize(c)));
    const denominator = sibs.find((c) => hint.denominator.test(normalize(c)));
    if (numerator && denominator) return { numerator, denominator };
  }
  return undefined;
}

export interface ProfileOptions {
  /** All column names in the same table — used to resolve ratio components. */
  siblingColumns: string[];
  /**
   * Enable `mean` classification for operational averages/durations. OFF by
   * default so existing datasets (e.g. EBPO on the env cube list) keep their
   * exact prior behavior — those columns stay refused, not averaged. Only the
   * new registry-driven datasets (whose cubes carry proper weight components)
   * opt in. This is the "don't disturb older orgs" gate.
   */
  allowMean?: boolean;
}

/** Classify a single column. Pure. */
export function classifyColumn(stats: ColumnStats, opts: ProfileOptions): ColumnProfile {
  const name = normalize(stats.column);
  const base = {
    table: stats.table,
    column: stats.column,
    type: stats.type,
    distinctCount: stats.distinctCount,
    nullFraction: stats.nullFraction,
    min: stats.min,
    max: stats.max,
    sampleValues: stats.sampleValues,
  };
  const make = (
    agg: AggSemantics,
    confidence: number,
    rationale: string,
    ratioComponents?: { numerator: string; denominator: string },
    meanWeight?: string,
  ): ColumnProfile => ({
    ...base,
    agg,
    confidence,
    rationale,
    ...(ratioComponents ? { ratioComponents } : {}),
    ...(meanWeight ? { meanWeight } : {}),
  });

  // 1. Non-numeric ⇒ attribute (dates are attributes too — the time grain uses them).
  if (!isNumeric(stats.type)) {
    if (DATE_TYPE_RE.test(stats.type)) return make('attribute', 0.99, 'date/time type');
    return make('attribute', 0.95, `non-numeric type (${stats.type})`);
  }

  // 2a. Integer calendar-part columns (year/quarter/month…) are attributes, not
  // measures — summing "year" is nonsense.
  if (TIME_PART_NAME_RE.test(name)) {
    return make('attribute', 0.95, 'calendar-part column (time attribute)');
  }

  // 2b. Identifier by name ⇒ count_distinct (check before flow: "_number" is numeric).
  if (ID_NAME_RE.test(name)) {
    return make('count_distinct', 0.9, 'name matches identifier pattern');
  }

  // 2c. Operational average / duration ⇒ mean (row-level average, never summed).
  // Checked BEFORE ratio/flow/stock so durations like dso_days don't fall
  // through to additive (summing days is nonsense) and scores/utilisation are
  // averaged, not refused. A money amount is never a mean. GATED on opts.allowMean
  // so datasets that didn't opt in keep their exact prior classification.
  if (opts.allowMean && AVG_METRIC_NAME_RE.test(name) && !MONEY_AMOUNT_RE.test(name)) {
    // A paired `<metric>_wt` sibling (cube pre-sum + weight) ⇒ weighted mean.
    const weight = opts.siblingColumns.find((c) => normalize(c) === `${name}_wt`);
    return make(
      'mean',
      0.8,
      `operational average/duration metric (${weight ? 'weighted ' : ''}row-level mean)`,
      undefined,
      weight,
    );
  }

  // 3. Ratio by name OR (0..1 / 0..100 range AND not an obvious flow/id).
  // A clear money amount (…_usd/_amount) is an additive flow even if the name
  // contains a ratio word ("margin") — do NOT treat gross_margin_usd as a ratio.
  const isMoneyAmount = MONEY_AMOUNT_RE.test(name);
  const ratioByName = RATIO_NAME_RE.test(name) && !isMoneyAmount;
  const ratioByRange = looksLikePercentByRange(stats) && !FLOW_NAME_RE.test(name);
  if (ratioByName || ratioByRange) {
    const components = deriveRatioComponents(stats.column, opts.siblingColumns);
    const confidence = ratioByName ? (components ? 0.9 : 0.6) : 0.5;
    const why = ratioByName
      ? `name matches ratio pattern${components ? ' (components resolved)' : ' (components UNRESOLVED — will refuse to average)'}`
      : 'values confined to 0..1/0..100 range';
    return make('ratio', confidence, why, components);
  }

  // Invoice-grain receivable/payable outstanding is an amount attached to each
  // invoice, so it adds across clients, vendors, industries and aging buckets.
  // It is not a periodic account balance snapshot. The semantic views use these
  // explicit names to distinguish the two concepts without any data hardcoding.
  if (/^outstanding_(?:receivable|payable)_usd$/i.test(name)) {
    return make('additive', 0.95, 'invoice-grain outstanding amount');
  }

  // A movement/flow remains additive even when its source name contains a
  // stock noun (for example `trial_balance_debit_movement_usd`). Treating the
  // source prefix as a balance made the compiler take only the latest month
  // with argMax instead of summing the requested debit/credit movements.
  if (/(?:^|_)(?:movement|movements|flow)(?:_|$)/i.test(name)) {
    return make('additive', 0.95, 'name explicitly identifies a movement/flow');
  }

  // 4. Stock / balance by name ⇒ semi_additive (must not sum across periods).
  if (STOCK_NAME_RE.test(name)) {
    return make('semi_additive', 0.85, 'name matches stock/balance pattern');
  }

  // 5. Default numeric ⇒ additive flow.
  const confident = FLOW_NAME_RE.test(name);
  return make('additive', confident ? 0.85 : 0.6, confident ? 'name matches flow pattern' : 'numeric with no stronger signal');
}

/** Classify every column of a table. `allowMean` opts into mean classification. */
export function profileTable(tableStats: ColumnStats[], opts: { allowMean?: boolean } = {}): ColumnProfile[] {
  // Ratio components must be numeric. Name-only matching can otherwise select a
  // text dimension such as `revenue_category` as the denominator for
  // `gross_margin_pct`, producing an invalid SUM(String) at runtime.
  const siblingColumns = tableStats.filter((s) => isNumeric(s.type)).map((s) => s.column);
  return tableStats.map((s) => classifyColumn(s, { siblingColumns, allowMean: opts.allowMean }));
}
