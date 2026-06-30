/**
 * EBPO deterministic chart catalog + compiler.
 *
 * Mirrors the GL `chart-spec.ts` pattern, but for the Enterprise BPO ("new data")
 * org. The LLM may only SELECT a measure/dimension from this closed catalog; the
 * compiler turns that selection into safe, scoped ClickHouse SQL against the
 * pre-aggregated `v_ebpo_*` views. Because the LLM never writes SQL and can only
 * name catalogued ids, it structurally cannot hallucinate columns or tables.
 *
 * ─── ADDING NEW EBPO DATA / MEASURES (extensibility recipe) ───────────────────
 *  1. New measure that already exists as a column in a view:
 *       - add an entry to EBPO_MEASURES (id, label, format, agg, kind)
 *       - add `measureId: 'column_name'` to every EBPO_VIEWS entry that exposes it
 *  2. New dimension (a column to group by):
 *       - add an entry to EBPO_DIMENSIONS (id, label, column, isTime?)
 *       - list its id in the `dims` array of each view that exposes it
 *  3. Brand-new physical column/view:
 *       - add it to the seed view DDL in
 *         packages/db/scripts/seed-ebpo-clickhouse.ts (so future seeds include it)
 *       - register the view in introspectEbpoSchema (agent.service.ts) VIEWS line
 *       - then do (1)/(2) above
 *  No prompt surgery required — the planner prompt is generated from this catalog.
 *
 * Aggregation correctness (the reason for `kind`):
 *  - flow  (revenue, cost, payroll, cash flows…) → SUM is valid at any grain.
 *  - stock (AR/AP outstanding…)                  → a monthly snapshot; summing
 *      across months overcounts, so for non-time groupings we restrict to the
 *      LATEST period. Across a time axis we show each month's balance (a trend).
 *  - ratio (margin %, DSO, SLA %, CSAT %…)       → AVERAGE, never summed.
 */
import type {
  ChartSpec,
  SpecFilter,
  SpecThreshold,
  SpecTransform,
  CompileRefusal,
} from './chart-spec';

// ─── Types ──────────────────────────────────────────────────────────────────
// 'distinct' = DISTINCTCOUNT over the mapped column (uniqExact), for measures like
// No. Clients = DISTINCTCOUNT(DimClient[ClientKey]). The view maps such a measure to the
// identifying column (e.g. client_name); blanks are excluded so a missing key isn't counted.
export type EbpoAgg = 'sum' | 'avg' | 'max' | 'distinct';
export type EbpoKind = 'flow' | 'stock' | 'ratio' | 'count';

export interface EbpoMeasureDef {
  id: string;
  label: string;
  aliases?: string[];
  format: 'currency' | 'number' | 'percent';
  agg: EbpoAgg;
  kind: EbpoKind;
  decimals?: number; // override the per-format default
  // Derived ratio = num/den × scale, computed as a RATIO-OF-SUMS to match PowerBI's
  // DAX DIVIDE(SUM(num), SUM(den)). den + the numerator terms are other measure ids that
  // ARE columns in the same view; when set, the compiler computes the ratio instead of
  // one column. num is a single measure id, OR a composite {add, sub} of measure ids
  // (e.g. EBITDA margin numerator = revenue − cost − payroll).
  derived?: {
    num: string | { add: string[]; sub?: string[] };
    // Omit `den` for an ABSOLUTE additive measure (e.g. EBITDA = revenue − cost −
    // payroll). With a `den` it's a ratio-of-sums (num / sum(den) * scale).
    den?: string;
    scale?: number;
  };
  // Windowed measure over the grain-aggregated `base`, only meaningful over a time axis
  // (month/quarter/year). Matches PowerBI time-intelligence:
  //   yoy     → DIVIDE([base]-[base LY],[base LY])  (year-over-year growth %)
  //   yoy_abs → [base]-[base LY]  (absolute year-over-year change, e.g. YoY Payroll Growth)
  //   ly      → CALCULATE([base], SAMEPERIODLASTYEAR)  (same period one year ago)
  //   ytd     → TOTALYTD([base])  (running total within the fiscal year)
  window?: { base: string; kind: 'yoy' | 'yoy_abs' | 'ly' | 'ytd' };
  // Weighted average: when the view stores a PRE-AGGREGATED average (e.g.
  // avg_monthly_salary_usd per department×grade), a plain avg() of it is an
  // avg-of-averages that diverges from the DAX employee-level AVERAGE at any coarser
  // grain. weightBy names a count column so the compiler emits a headcount-weighted
  // mean — sum(col*weight)/sum(weight) — matching AVERAGE(DimEmployee[MonthlySalaryUSD]).
  weightBy?: string;
  // Internal helper measure: usable as a derived numerator/denominator term but NOT
  // surfaced to the planner catalog (so the LLM can't pick it directly). Used for
  // replicated company-level columns that must be aggregated non-additively.
  internal?: boolean;
}

export interface EbpoDimDef {
  id: string;
  label: string;
  column?: string; // physical column (categorical dims); omitted for time dims
  isTime?: boolean;
}

export interface EbpoViewDef {
  name: string; // v_ebpo_* (without db prefix)
  hasTime: boolean; // exposes period_date → supports month/quarter/year
  dims: string[]; // categorical dimension ids this view exposes
  measures: Record<string, string>; // measureId → column in this view
  // Optional FROM override. When a dimension lives in a dim table the base view does
  // not carry (e.g. CITY, which only exists in ebpo_dim_geography), set this to a
  // FLATTENING subquery that joins it in and exposes every needed column unqualified,
  // aliased. Use `{db}` for the database. Defaults to `{db}.<name>`.
  from?: string;
}

export interface EbpoCompileResult {
  ok: true;
  sql: string;
  measure: EbpoMeasureDef;
  view: string;
  // True when the compiled SQL actually produces a percentage value (a normalize/
  // growth_pct/company_share transform was applied, etc.). Callers must use THIS to
  // decide on percent formatting — never the requested transforms — so a transform
  // that the compiler couldn't honor never leaves the chart formatted as "%" over raw
  // dollar values (the "2500000.0%" blindspot).
  outputPercent?: boolean;
}

// ─── Catalog: MEASURES (all 27 DAX measures + a few useful derived ones) ──────
const M = (
  id: string,
  label: string,
  format: EbpoMeasureDef['format'],
  agg: EbpoAgg,
  kind: EbpoKind,
  decimals?: number,
  aliases?: string[],
): EbpoMeasureDef => ({ id, label, aliases, format, agg, kind, decimals });

export const EBPO_MEASURES: Record<string, EbpoMeasureDef> = {
  // Revenue / cost / margin (flows)
  total_revenue: M(
    'total_revenue',
    'Total Revenue',
    'currency',
    'sum',
    'flow',
    undefined,
    ['revenue', 'sales', 'income'],
  ),
  total_cost: M(
    'total_cost',
    'Total Cost',
    'currency',
    'sum',
    'flow',
    undefined,
    ['cost', 'expense'],
  ),
  gross_margin: M(
    'gross_margin',
    'Gross Margin',
    'currency',
    'sum',
    'flow',
    undefined,
    ['gross profit'],
  ),
  // Ratio-of-sums (sum(gm)/sum(revenue)), matching PowerBI DAX DIVIDE(SUM,SUM).
  // Was avg of a precomputed per-row gross_margin_pct column, which is WRONG when the
  // view grain is finer than the chart cell (e.g. BU×contract_type×month): averaging
  // percentages produced impossible values (>100%) and NaN→0.0% for missing combos.
  gross_margin_pct: {
    id: 'gross_margin_pct',
    label: 'Gross Margin %',
    format: 'percent',
    agg: 'avg',
    kind: 'ratio',
    decimals: 1,
    aliases: ['gross margin percentage', 'gross margin percent', 'gross margin pct'],
    derived: { num: 'gross_margin', den: 'total_revenue', scale: 100 },
  },
  // YoY = window over grain-aggregated revenue vs the same period one year prior (DAX
  // DIVIDE([Total Revenue]-[Revenue LY],[Revenue LY])). The old avg(precomputed monthly
  // pct) was correct only at monthly grain — at yearly grain it averaged 12 monthly YoYs
  // and even flipped sign (2025: +3.7% vs true −1.3%). Now correct at month/quarter/year.
  revenue_yoy_pct: {
    id: 'revenue_yoy_pct',
    label: 'Revenue YoY Growth %',
    format: 'percent',
    agg: 'avg',
    kind: 'ratio',
    decimals: 1,
    aliases: [
      'year over year revenue growth',
      'year-over-year revenue growth',
      'revenue year over year growth',
      'revenue growth year over year',
      'yoy revenue growth',
    ],
    window: { base: 'total_revenue', kind: 'yoy' },
  },
  // Revenue (Last Year) = CALCULATE([Total Revenue], SAMEPERIODLASTYEAR) — the prior-year
  // value of each period; windowed over the time axis.
  revenue_ly: {
    id: 'revenue_ly',
    label: 'Revenue (Last Year)',
    format: 'currency',
    agg: 'sum',
    kind: 'flow',
    aliases: [
      'revenue last year',
      'prior year revenue',
      'previous year revenue',
      'same period last year',
      'revenue ly',
    ],
    window: { base: 'total_revenue', kind: 'ly' },
  },
  // Revenue YTD = TOTALYTD([Total Revenue]) — running total within the fiscal year.
  revenue_ytd: {
    id: 'revenue_ytd',
    label: 'Revenue YTD',
    format: 'currency',
    agg: 'sum',
    kind: 'flow',
    aliases: [
      'revenue year to date',
      'year-to-date revenue',
      'ytd revenue',
      'cumulative revenue this year',
    ],
    window: { base: 'total_revenue', kind: 'ytd' },
  },
  // Cost time-intelligence — mirror of the revenue window measures, over grain-aggregated
  // total_cost. Cost LY = CALCULATE([Total Cost], SAMEPERIODLASTYEAR); Cost YoY Growth % =
  // DIVIDE([Total Cost]-[Cost LY],[Cost LY]). Correct at month/quarter/year.
  cost_ly: {
    id: 'cost_ly',
    label: 'Cost (Last Year)',
    format: 'currency',
    agg: 'sum',
    kind: 'flow',
    aliases: [
      'cost last year',
      'prior year cost',
      'previous year cost',
      'cost ly',
    ],
    window: { base: 'total_cost', kind: 'ly' },
  },
  cost_yoy_pct: {
    id: 'cost_yoy_pct',
    label: 'Cost YoY Growth %',
    format: 'percent',
    agg: 'avg',
    kind: 'ratio',
    decimals: 1,
    aliases: [
      'year over year cost growth',
      'year-over-year cost growth',
      'cost year over year growth',
      'cost growth year over year',
      'yoy cost growth',
    ],
    window: { base: 'total_cost', kind: 'yoy' },
  },
  // Derived CFO ratios — precomputed in the canonical SUPERSET view
  // v_ebpo_cfo_ratios_monthly. Catalogued so create AND combo follow-ups
  // ("add X as a comparison line") are deterministic via multi-measure specs.
  // Current/quick ratio remain refused (no full current-liabilities data) — never faked.
  // CFO ratios: ratio-of-sums (DIVIDE(SUM,SUM)), not avg of the precomputed per-month
  // column. avg-of-ratios diverged from the intended ratio at the overall/annual cell
  // (fcf 2.0pts, ocf/rev 2.3pts — proven by scripts/powerbi-parity.ts).
  cost_to_income_pct: {
    id: 'cost_to_income_pct',
    label: 'Cost-to-Income %',
    format: 'percent',
    agg: 'avg',
    kind: 'ratio',
    decimals: 1,
    aliases: [
      'cost to income ratio',
      'cost to revenue',
      'cost to revenue %',
      'cost to revenue ratio',
      'cost to revenue percentage',
    ],
    derived: { num: 'total_cost', den: 'total_revenue', scale: 100 },
  },
  fcf_margin_pct: {
    id: 'fcf_margin_pct',
    label: 'Free Cash Flow Margin %',
    format: 'percent',
    agg: 'avg',
    kind: 'ratio',
    decimals: 1,
    aliases: ['fcf margin', 'free cash flow margin', 'free cash flow margin percentage'],
    derived: { num: 'free_cash_flow', den: 'total_revenue', scale: 100 },
  },
  operating_cf_to_revenue_pct: {
    id: 'operating_cf_to_revenue_pct',
    label: 'Operating Cash Flow % of Revenue',
    format: 'percent',
    agg: 'avg',
    kind: 'ratio',
    decimals: 1,
    aliases: [
      'operating cash flow percentage of revenue',
      'ocf to revenue',
      'cash conversion',
      'cash conversion ratio',
      'operating cash flow divided by revenue',
      'operating cash flow / revenue',
      'operating cf margin',
      'operating cash flow margin',
      'operating cash flow margin %',
      'operating cf margin %',
    ],
    derived: { num: 'operating_cf', den: 'total_revenue', scale: 100 },
  },
  // Ratio-of-sums with a composite numerator: (revenue − cost − payroll) / revenue,
  // matching the precomputed column's intent but correct at any grain (was avg of the
  // precomputed per-month pct → diverged at coarse cells).
  ebitda_style_margin_pct: {
    id: 'ebitda_style_margin_pct',
    label: 'EBITDA-style Margin %',
    format: 'percent',
    agg: 'avg',
    kind: 'ratio',
    decimals: 1,
    aliases: [
      'ebitda margin',
      'ebitda style margin',
      'revenue minus cost minus payroll',
      'net profit margin',
      'net margin',
      'operating margin',
      'operating profit margin',
    ],
    derived: {
      num: { add: ['total_revenue'], sub: ['total_cost', 'total_payroll'] },
      den: 'total_revenue',
      scale: 100,
    },
  },
  // ABSOLUTE EBITDA-style profit = Revenue − Cost − Payroll (the $ companion to
  // ebitda_style_margin_pct). NOT a canonical DAX measure — it's a derived extra, and
  // in this dataset payroll ($112M) exceeds gross margin ($44M) so it is NEGATIVE
  // (~−$68M total / ~−$1.4M per month). "Operating profit" / "net profit" collapse to
  // the same figure here (no separate D&A/tax/interest in the FactRevenue basis), so they
  // alias to this. Only resolves where revenue+cost+payroll co-exist (company / monthly).
  ebitda: {
    id: 'ebitda',
    label: 'EBITDA',
    format: 'currency',
    agg: 'sum',
    kind: 'flow',
    decimals: 0,
    aliases: [
      'ebitda style',
      'operating profit',
      'operating income',
      'net profit',
      'net income',
      'earnings before interest taxes depreciation and amortization',
    ],
    derived: {
      num: { add: ['total_revenue'], sub: ['total_cost', 'total_payroll'] },
    },
  },
  // Total Expenses = [Total Cost] + [Total Payroll] (DAX). ABSOLUTE additive measure (no
  // denominator) — resolves wherever cost AND payroll co-exist in one view (company /
  // monthly). This is the dataset's expense measure (the GL expense-account view was
  // removed with the General Ledger), used by the Expense-to-Revenue ratio below.
  total_expenses: {
    id: 'total_expenses',
    label: 'Total Expenses',
    format: 'currency',
    agg: 'sum',
    kind: 'flow',
    decimals: 0,
    aliases: ['total expense', 'cost plus payroll', 'cost and payroll'],
    derived: { num: { add: ['total_cost', 'total_payroll'] } },
  },
  // Trial-balance expense movement at the account grain. The General Ledger fact is
  // gone, but the monthly trial balance still carries account-level movement. The
  // five expense accounts in DimAccount are the real categories available for
  // "expense by account / account category / account type" asks, so expose a
  // dedicated measure over that filtered account view instead of misrouting such asks
  // to company-wide total_expenses.
  account_expense: M(
    'account_expense',
    'Expense',
    'currency',
    'sum',
    'flow',
    undefined,
    [
      'expense by account',
      'account expense',
      'expense account',
      'expense category',
      'expense categories',
      'account category',
      'account categories',
      'account type',
      'account types',
      'sg&a',
      'sga',
      'selling general and administrative',
      'selling, general and administrative',
      'operating expense by account',
    ],
  ),
  // Expense to Revenue % = DIVIDE([Total Expenses],[Total Revenue]) = (cost+payroll)/revenue.
  // Composite-numerator ratio-of-sums, correct at any grain.
  expense_to_revenue_pct: {
    id: 'expense_to_revenue_pct',
    label: 'Expense to Revenue %',
    format: 'percent',
    agg: 'avg',
    kind: 'ratio',
    decimals: 1,
    aliases: [
      'expenses to revenue',
      'expense to revenue ratio',
      'total expenses to revenue',
      'expense to revenue percentage',
    ],
    derived: {
      num: { add: ['total_cost', 'total_payroll'] },
      den: 'total_revenue',
      scale: 100,
    },
  },
  working_capital: M(
    'working_capital',
    'Working Capital',
    'currency',
    'avg',
    'stock',
    undefined,
    ['net working capital', 'net working capital'],
  ),
  // Payroll (flows)
  total_payroll: M(
    'total_payroll',
    'Total Payroll',
    'currency',
    'sum',
    'flow',
    undefined,
    ['payroll', 'payroll cost'],
  ),
  total_base_salary: M(
    'total_base_salary',
    'Total Base Salary',
    'currency',
    'sum',
    'flow',
    undefined,
    ['base salary', 'base salaries'],
  ),
  total_overtime: M(
    'total_overtime',
    'Total Overtime',
    'currency',
    'sum',
    'flow',
    undefined,
    ['overtime', 'overtime cost'],
  ),
  overtime_to_payroll_pct: {
    id: 'overtime_to_payroll_pct',
    label: 'Overtime / Payroll %',
    format: 'percent',
    agg: 'avg',
    kind: 'ratio',
    decimals: 1,
    aliases: [
      'overtime as a percentage of total payroll',
      'overtime as percentage of total payroll',
      'overtime percent of total payroll',
      'overtime pct of payroll',
      'overtime to payroll',
      'overtime to payroll %',
      'overtime / payroll',
    ],
    derived: { num: 'total_overtime', den: 'total_payroll', scale: 100 },
  },
  total_bonus: M(
    'total_bonus',
    'Total Bonus',
    'currency',
    'sum',
    'flow',
    undefined,
    ['bonus', 'bonuses'],
  ),
  total_benefits: M(
    'total_benefits',
    'Total Benefits',
    'currency',
    'sum',
    'flow',
    undefined,
    ['benefits', 'benefit cost'],
  ),
  // Ratio-of-sums (DAX DIVIDE([Total Payroll],[Total Revenue])). Was avg of a
  // precomputed per-month pct column → diverged from PowerBI at coarser grains
  // (proven 2.28pts off at the annual/overall cell by scripts/powerbi-parity.ts).
  payroll_to_revenue_pct: {
    id: 'payroll_to_revenue_pct',
    label: 'Payroll / Revenue %',
    format: 'percent',
    agg: 'avg',
    kind: 'ratio',
    decimals: 1,
    aliases: [
      'payroll to revenue percentage',
      'payroll over revenue percentage',
      'payroll revenue ratio',
      'payroll ratio',
    ],
    derived: { num: 'total_payroll', den: 'total_revenue', scale: 100 },
  },
  benefits_to_base_pct: {
    id: 'benefits_to_base_pct',
    label: 'Benefits % of Base Salary',
    format: 'percent',
    agg: 'avg',
    kind: 'ratio',
    decimals: 1,
    derived: { num: 'total_benefits', den: 'total_base_salary', scale: 100 },
  },
  // Payroll-composition ratios = DIVIDE([Total <component>],[Total Payroll]) (DAX). Ratio-of-
  // sums over v_ebpo_payroll_monthly, which carries every component + total payroll, so they
  // stay correct at any grain — never an avg of per-row percentages.
  base_salary_to_payroll_pct: {
    id: 'base_salary_to_payroll_pct',
    label: 'Base Salary % of Payroll',
    format: 'percent',
    agg: 'avg',
    kind: 'ratio',
    decimals: 1,
    aliases: [
      'base salary percentage',
      'base salary % of payroll',
      'base salary share of payroll',
    ],
    derived: { num: 'total_base_salary', den: 'total_payroll', scale: 100 },
  },
  benefits_to_payroll_pct: {
    id: 'benefits_to_payroll_pct',
    label: 'Benefits % of Payroll',
    format: 'percent',
    agg: 'avg',
    kind: 'ratio',
    decimals: 1,
    aliases: ['benefits percentage of payroll', 'benefits share of payroll'],
    derived: { num: 'total_benefits', den: 'total_payroll', scale: 100 },
  },
  bonus_to_payroll_pct: {
    id: 'bonus_to_payroll_pct',
    label: 'Bonus % of Payroll',
    format: 'percent',
    agg: 'avg',
    kind: 'ratio',
    decimals: 1,
    aliases: ['bonus percentage of payroll', 'bonus share of payroll'],
    derived: { num: 'total_bonus', den: 'total_payroll', scale: 100 },
  },
  // Payroll Per Employee = DIVIDE([Total Payroll], DISTINCTCOUNT(EmployeeID)). employee_count
  // is the per-grain headcount here, so payroll/headcount is the DAX figure. (This shares its
  // formula with the legacy cost_per_employee, which historically also = payroll/headcount.)
  payroll_per_employee: {
    id: 'payroll_per_employee',
    label: 'Payroll per Employee',
    aliases: ['payroll per fte', 'payroll cost per employee'],
    format: 'currency',
    agg: 'avg',
    kind: 'ratio',
    derived: { num: 'total_payroll', den: 'employee_count', scale: 1 },
  },
  // Payroll time-intelligence (DAX SAMEPERIODLASTYEAR / TOTALYTD / YoY) over total_payroll.
  // Payroll PY = CALCULATE([Total Payroll], SAMEPERIODLASTYEAR); Payroll YTD = TOTALYTD;
  // YoY Payroll Growth = [Total Payroll]-[Payroll PY] (absolute, yoy_abs); YoY Payroll
  // Growth % = DIVIDE([Total Payroll]-[Payroll PY],[Payroll PY]).
  payroll_py: {
    id: 'payroll_py',
    label: 'Payroll (Prior Year)',
    format: 'currency',
    agg: 'sum',
    kind: 'flow',
    aliases: [
      'payroll prior year',
      'payroll last year',
      'previous year payroll',
      'payroll py',
    ],
    window: { base: 'total_payroll', kind: 'ly' },
  },
  payroll_ytd: {
    id: 'payroll_ytd',
    label: 'Payroll YTD',
    format: 'currency',
    agg: 'sum',
    kind: 'flow',
    aliases: ['payroll year to date', 'year-to-date payroll', 'ytd payroll'],
    window: { base: 'total_payroll', kind: 'ytd' },
  },
  payroll_yoy_growth: {
    id: 'payroll_yoy_growth',
    label: 'YoY Payroll Growth',
    format: 'currency',
    agg: 'sum',
    kind: 'flow',
    aliases: [
      'payroll growth year over year',
      'payroll year over year growth',
      'change in payroll vs last year',
    ],
    window: { base: 'total_payroll', kind: 'yoy_abs' },
  },
  payroll_yoy_pct: {
    id: 'payroll_yoy_pct',
    label: 'YoY Payroll Growth %',
    format: 'percent',
    agg: 'avg',
    kind: 'ratio',
    decimals: 1,
    aliases: [
      'payroll growth percentage year over year',
      'yoy payroll growth percent',
      'year over year payroll growth',
    ],
    window: { base: 'total_payroll', kind: 'yoy' },
  },
  // Headcount-WEIGHTED average of the pre-aggregated avg_monthly_salary_usd column, so it
  // equals the DAX AVERAGE(DimEmployee[MonthlySalaryUSD]) at any grain (a plain avg() of
  // per-dept×grade averages was an avg-of-averages, off ~$37 at the overall cell).
  avg_monthly_salary: {
    id: 'avg_monthly_salary',
    label: 'Avg Monthly Salary',
    format: 'currency',
    agg: 'avg',
    kind: 'ratio',
    weightBy: 'employee_count',
  },
  // Cash flow
  operating_cf: M(
    'operating_cf',
    'Operating Cash Flow',
    'currency',
    'sum',
    'flow',
    undefined,
    ['operating cf', 'ocf'],
  ),
  investing_cf: M(
    'investing_cf',
    'Investing Cash Flow',
    'currency',
    'sum',
    'flow',
    undefined,
    ['investing cf'],
  ),
  financing_cf: M(
    'financing_cf',
    'Financing Cash Flow',
    'currency',
    'sum',
    'flow',
    undefined,
    ['financing cf'],
  ),
  free_cash_flow: M(
    'free_cash_flow',
    'Free Cash Flow',
    'currency',
    'sum',
    'flow',
    undefined,
    ['free cf', 'fcf'],
  ),
  cash_balance: M(
    'cash_balance',
    'Cash Balance',
    'currency',
    'max',
    'stock',
    undefined,
    [],
  ),
  // Working capital (stocks / ratios)
  // SUM over the snapshot/date context — NOT latest-month — to match the PowerBI report
  // (the "AR vs AP" page slices only by FiscalYear, never by month, so the DAX
  // SUM(FactAccountsReceivable[OutstandingBalance]) sums every snapshot in scope).
  // kind=flow disables the latest-period restriction in buildWhere.
  ar_outstanding: M(
    'ar_outstanding',
    'AR Outstanding',
    'currency',
    'sum',
    'flow',
    undefined,
    [
      'ar',
      'a/r',
      'outstanding receivables',
      'receivables',
      'accounts receivable outstanding',
    ],
  ),
  // SUM over the date context — NOT latest-month — to match PowerBI DAX
  // SUM(FactAccountsPayable[OutstandingBalance]). See ar_outstanding note above.
  ap_outstanding: M(
    'ap_outstanding',
    'AP Outstanding',
    'currency',
    'sum',
    'flow',
    undefined,
    [
      'ap',
      'a/p',
      'outstanding payables',
      'payables',
      'accounts payable outstanding',
    ],
  ),
  ar_to_revenue_pct: {
    id: 'ar_to_revenue_pct',
    label: 'Receivables / Revenue %',
    aliases: ['receivables as a percentage of revenue', 'ar to revenue'],
    format: 'percent',
    agg: 'avg',
    kind: 'ratio',
    decimals: 1,
    derived: { num: 'ar_outstanding', den: 'total_revenue', scale: 100 },
  },
  ap_to_cost_pct: {
    id: 'ap_to_cost_pct',
    label: 'Payables / Cost %',
    aliases: ['payables as a percentage of cost', 'ap to cost'],
    format: 'percent',
    agg: 'avg',
    kind: 'ratio',
    decimals: 1,
    derived: { num: 'ap_outstanding', den: 'total_cost', scale: 100 },
  },
  // Ratio-of-sums (DAX DIVIDE(SUM(CollectedAmount),SUM(InvoiceAmount))). Was avg of a
  // precomputed pct column → diverged from PowerBI at coarser-than-row grains
  // (proven 3.3pts off in a monthly cell by scripts/powerbi-parity.ts).
  collection_rate_pct: {
    id: 'collection_rate_pct',
    label: 'Collection Rate %',
    format: 'percent',
    agg: 'avg',
    kind: 'ratio',
    decimals: 1,
    aliases: ['collection rate percentage'],
    derived: { num: 'collected_amount', den: 'invoice_amount', scale: 100 },
  },
  // DSO = DIVIDE([AR Outstanding],[Total Revenue]/365) = sum(AR)/sum(Revenue)×365.
  // DPO = DIVIDE([AP Outstanding],[Total Cost]/365)   = sum(AP)/sum(Cost)×365.
  // Ratio-of-sums (×365), matching PowerBI — not avg of the precomputed per-month column.
  dso_days: {
    id: 'dso_days',
    label: 'DSO (days)',
    format: 'number',
    agg: 'avg',
    kind: 'ratio',
    decimals: 1,
    aliases: ['days sales outstanding'],
    derived: { num: 'ar_outstanding', den: 'total_revenue', scale: 365 },
  },
  dpo_days: {
    id: 'dpo_days',
    label: 'DPO (days)',
    format: 'number',
    agg: 'avg',
    kind: 'ratio',
    decimals: 1,
    aliases: ['days payable outstanding'],
    derived: { num: 'ap_outstanding', den: 'total_cost', scale: 365 },
  },
  invoice_amount: M(
    'invoice_amount',
    'Invoiced Amount',
    'currency',
    'sum',
    'flow',
    undefined,
    ['invoice amount', 'invoices'],
  ),
  collected_amount: M(
    'collected_amount',
    'Collected Amount',
    'currency',
    'sum',
    'flow',
    undefined,
    ['collected amount', 'collections'],
  ),
  payment_rate_pct: {
    id: 'payment_rate_pct',
    label: 'Payment Rate %',
    aliases: [
      'payment rate percentage',
      'paid rate',
      'ap payment rate',
      'ap payment rate %',
      'ap payment rate percentage',
    ],
    format: 'percent',
    agg: 'avg',
    kind: 'ratio',
    decimals: 1,
    derived: { num: 'paid_amount', den: 'invoice_amount', scale: 100 },
  },
  // Operations (ratios / counts)
  sla_compliance_pct: M(
    'sla_compliance_pct',
    'SLA Compliance %',
    'percent',
    'avg',
    'ratio',
    1,
    ['sla compliance percentage', 'sla percent'],
  ),
  csat_pct: M('csat_pct', 'CSAT %', 'percent', 'avg', 'ratio', 1, [
    'customer satisfaction',
    'csat percentage',
  ]),
  utilization_pct: M(
    'utilization_pct',
    'Avg Utilization %',
    'percent',
    'avg',
    'ratio',
    1,
    ['utilization percentage', 'utilisation percentage'],
  ),
  calls_handled: M('calls_handled', 'Calls Handled', 'number', 'sum', 'count'),
  tickets_resolved: M(
    'tickets_resolved',
    'Tickets Resolved',
    'number',
    'sum',
    'count',
    undefined,
    ['resolved tickets'],
  ),
  avg_aht_minutes: M(
    'avg_aht_minutes',
    'Avg Handling Time (min)',
    'number',
    'avg',
    'ratio',
    1,
    ['average aht', 'aht', 'average handling time', 'avg aht'],
  ),
  // People / efficiency
  employee_count: M(
    'employee_count',
    'Employee Count',
    'number',
    'sum',
    'count',
    undefined,
    ['headcount', 'employees'],
  ),
  // Revenue per Employee = DIVIDE([Total Revenue], DISTINCTCOUNT(EmployeeID)) (DAX) —
  // a COMPANY-LEVEL figure. Revenue is booked by client/business-unit (never by
  // department), so in v_ebpo_department_efficiency_monthly total_revenue_usd is the
  // company total REPLICATED on every department row. The old definition averaged the
  // precomputed per-department revenue_per_employee_usd column (= company_rev / dept_hc)
  // → an avg-of-ratios that over-inflated the figure ~10x (e.g. $102.7K vs the true
  // $9.7K for Jan 2025: $2.91M / 300 FTE). Now a ratio-of-the-replicated-total over
  // total headcount: max(company revenue) / sum(employee_count), via the internal
  // `company_revenue_repl` numerator (agg='max' takes the replicated total once).
  revenue_per_employee: {
    id: 'revenue_per_employee',
    label: 'Revenue per Employee',
    aliases: ['revenue per fte'],
    format: 'currency',
    agg: 'avg',
    kind: 'ratio',
    derived: { num: 'company_revenue_repl', den: 'employee_count', scale: 1 },
  },
  // Internal numerator only (hidden from the planner): the company revenue total as it
  // appears REPLICATED on each department row of v_ebpo_department_efficiency_monthly.
  // agg='max' so the derived numerator takes it once rather than summing the duplicates.
  company_revenue_repl: {
    id: 'company_revenue_repl',
    label: 'Company Revenue (replicated, internal)',
    format: 'currency',
    agg: 'max',
    kind: 'stock',
    internal: true,
  },
  // Cost Per Employee = DIVIDE([Total Cost], DISTINCTCOUNT(EmployeeID)) (DAX). Total Cost is
  // cost-of-revenue, booked by client/business unit — so this resolves where total_cost AND
  // headcount co-exist (v_ebpo_business_unit_efficiency: real per-BU values + company grain).
  // By department/country (where cost isn't booked) it follows PowerBI star-schema behaviour
  // and replicates the company figure. NOTE: payroll-per-headcount is now `payroll_per_employee`.
  cost_per_employee: {
    id: 'cost_per_employee',
    label: 'Cost per Employee',
    aliases: ['cost per fte', 'cost per head', 'total cost per employee'],
    format: 'currency',
    agg: 'avg',
    kind: 'ratio',
    derived: { num: 'total_cost', den: 'employee_count', scale: 1 },
  },
  // Fixed assets (stocks). Bare "assets"/"asset value"/"fixed assets" mean the asset
  // VALUE (gross cost), never the asset COUNT — alias them here so a request like
  // "assets by country" plots the dollar value, not a row count.
  asset_cost: M('asset_cost', 'Asset Cost', 'currency', 'sum', 'flow', undefined, [
    'assets',
    'asset value',
    'total assets',
    'fixed assets',
    'asset base',
    'gross asset value',
  ]),
  accumulated_depreciation: M(
    'accumulated_depreciation',
    'Accumulated Depreciation',
    'currency',
    'sum',
    'flow',
  ),
  net_book_value: M(
    'net_book_value',
    'Net Book Value',
    'currency',
    'sum',
    'stock',
  ),
  asset_count: M('asset_count', 'Asset Count', 'number', 'sum', 'count'),
  // Derived asset ratios (no precomputed column — computed as ratio-of-sums).
  depreciation_pct: {
    id: 'depreciation_pct',
    label: 'Depreciation %',
    format: 'percent',
    agg: 'avg',
    kind: 'ratio',
    decimals: 1,
    derived: { num: 'accumulated_depreciation', den: 'asset_cost', scale: 100 },
  },
  nbv_to_cost_pct: {
    id: 'nbv_to_cost_pct',
    label: 'Net Book Value % of Cost',
    format: 'percent',
    agg: 'avg',
    kind: 'ratio',
    decimals: 1,
    derived: { num: 'net_book_value', den: 'asset_cost', scale: 100 },
  },
  // Trial balance (stock balances). The General Ledger fact/table was removed from the
  // dataset, so the GL-only measures (total_debit, total_credit, net_movement) and
  // operating_expense (the GL expense-account view) are no longer catalogued. "Expense"
  // requests now map to total_expenses (= Total Cost + Total Payroll). Closing/opening
  // balance remain — they come from FactTrialBalance, which is still in the dataset.
  closing_balance: M(
    'closing_balance',
    'Closing Balance',
    'currency',
    'sum',
    'stock',
  ),
  opening_balance: M(
    'opening_balance',
    'Opening Balance',
    'currency',
    'sum',
    'stock',
  ),
  // AP / delivery-center extras (unlock invoice/paid combos and per-center revenue)
  paid_amount: M(
    'paid_amount',
    'Paid Amount',
    'currency',
    'sum',
    'flow',
    undefined,
    ['paid', 'amount paid'],
  ),
  // NOTE: there is intentionally NO revenue-by-geography measure. FactRevenue (ebpo_fact_revenue)
  // has NO geography key — revenue is booked only by client, business_unit, and contract_type.
  // The old `allocated_revenue` measure fabricated a geography link by splitting company revenue
  // across delivery centers by call volume; it has been removed so "revenue by country / region /
  // delivery center" genuinely refuses (matching PowerBI, which has no such relationship).
  // No. Clients = DISTINCTCOUNT(DimClient[ClientKey]) (DAX). Mapped to the client_name
  // column in every client-bearing view; uniqExact gives the distinct client count at any
  // grain (overall, by industry, etc.). kind=count so it isn't summed across snapshots.
  no_clients: {
    id: 'no_clients',
    label: 'No. of Clients',
    format: 'number',
    agg: 'distinct',
    kind: 'count',
    decimals: 0,
    aliases: [
      'number of clients',
      'client count',
      'count of clients',
      'distinct clients',
      'no. clients',
      'how many clients',
    ],
  },
  // Avg Revenue per Client = DIVIDE([Total Revenue],[No. Clients]) (DAX). Ratio of the
  // revenue SUM to the DISTINCTCOUNT of clients (the denominator uses no_clients' own
  // uniqExact agg), so it's correct overall and per industry.
  avg_revenue_per_client: {
    id: 'avg_revenue_per_client',
    label: 'Avg Revenue per Client',
    format: 'currency',
    agg: 'avg',
    kind: 'ratio',
    aliases: [
      'average revenue per client',
      'revenue per client',
      'mean revenue per client',
    ],
    derived: { num: 'total_revenue', den: 'no_clients', scale: 1 },
  },
};

// ─── Catalog: DIMENSIONS ──────────────────────────────────────────────────────
const D = (
  id: string,
  label: string,
  column?: string,
  isTime?: boolean,
): EbpoDimDef => ({
  id,
  label,
  column,
  isTime,
});

export const EBPO_DIMENSIONS: Record<string, EbpoDimDef> = {
  month: D('month', 'Month', undefined, true),
  quarter: D('quarter', 'Quarter', undefined, true),
  year: D('year', 'Year', undefined, true),
  business_unit: D('business_unit', 'Business Unit', 'business_unit'),
  contract_type: D('contract_type', 'Contract Type', 'contract_type'),
  client: D('client', 'Client', 'client_name'),
  industry: D('industry', 'Industry', 'industry'),
  department: D('department', 'Department', 'department'),
  country: D('country', 'Country', 'country'),
  region: D('region', 'Region', 'region'),
  city: D('city', 'City', 'city'),
  delivery_center: D('delivery_center', 'Delivery Center', 'delivery_center'),
  market_type: D('market_type', 'Market Type', 'market_type'),
  aging_bucket: D('aging_bucket', 'Aging Bucket', 'aging_bucket'),
  grade: D('grade', 'Grade', 'grade'),
  vendor: D('vendor', 'Vendor', 'vendor_name'),
  account: D('account', 'Account', 'account_name'),
  asset_type: D('asset_type', 'Asset Type', 'asset_type'),
};

// ─── Catalog: VIEWS (ordered: first qualifying provider wins) ─────────────────
// For a (measure, dimension[, breakdown]) the compiler picks the FIRST view that
// provides the measure and exposes the dimension(s). Order canonical/specific
// providers first; time-only views naturally fall through for categorical dims.
export const EBPO_VIEWS: EbpoViewDef[] = [
  {
    name: 'v_ebpo_revenue_monthly',
    hasTime: true,
    dims: [],
    measures: {
      total_revenue: 'total_revenue_usd',
      total_cost: 'total_cost_usd',
      gross_margin: 'gross_margin_usd',
      revenue_yoy_pct: 'revenue_yoy_pct',
    },
  },
  {
    name: 'v_ebpo_kpi_monthly',
    hasTime: true,
    dims: [],
    measures: {
      total_revenue: 'total_revenue_usd',
      total_cost: 'total_cost_usd',
      gross_margin: 'gross_margin_usd',
      total_payroll: 'total_payroll_usd',
      ar_outstanding: 'ar_outstanding_usd',
      ap_outstanding: 'ap_outstanding_usd',
      operating_cf: 'operating_cash_flow_usd',
      free_cash_flow: 'free_cash_flow_usd',
      cash_balance: 'cash_balance_usd',
      sla_compliance_pct: 'sla_compliance_pct',
      csat_pct: 'csat_pct',
      utilization_pct: 'utilization_pct',
      dso_days: 'dso_days',
      dpo_days: 'dpo_days',
    },
  },
  {
    name: 'v_ebpo_cash_flow_monthly',
    hasTime: true,
    dims: [],
    measures: {
      operating_cf: 'operating_cash_flow_usd',
      investing_cf: 'investing_cash_flow_usd',
      financing_cf: 'financing_cash_flow_usd',
      free_cash_flow: 'free_cash_flow_usd',
      cash_balance: 'cash_balance_usd',
    },
  },
  {
    name: 'v_ebpo_payroll_monthly',
    hasTime: true,
    dims: ['department', 'country'],
    measures: {
      total_base_salary: 'total_base_salary_usd',
      total_overtime: 'total_overtime_usd',
      total_bonus: 'total_bonus_usd',
      total_benefits: 'total_benefits_usd',
      total_payroll: 'total_payroll_usd',
      employee_count: 'employee_count',
      overtime_to_payroll_pct: 'overtime_to_payroll_pct',
    },
  },
  {
    name: 'v_ebpo_operations_monthly',
    hasTime: true,
    dims: ['delivery_center', 'region', 'country', 'market_type'],
    measures: {
      sla_compliance_pct: 'sla_compliance_pct',
      csat_pct: 'csat_pct',
      utilization_pct: 'utilization_pct',
      calls_handled: 'calls_handled',
      tickets_resolved: 'tickets_resolved',
      avg_aht_minutes: 'avg_aht_minutes',
    },
  },
  {
    name: 'v_ebpo_ar_aging',
    hasTime: true,
    dims: ['client', 'industry', 'aging_bucket'],
    measures: {
      ar_outstanding: 'outstanding_balance_usd',
      invoice_amount: 'invoice_amount_usd',
      collected_amount: 'collected_amount_usd',
    },
  },
  {
    name: 'v_ebpo_ap_aging',
    hasTime: true,
    dims: ['vendor', 'aging_bucket'],
    measures: {
      ap_outstanding: 'outstanding_balance_usd',
      invoice_amount: 'invoice_amount_usd',
      paid_amount: 'paid_amount_usd',
    },
  },
  {
    name: 'v_ebpo_revenue_by_business_unit',
    hasTime: false,
    dims: ['business_unit', 'contract_type'],
    measures: {
      total_revenue: 'total_revenue_usd',
      total_cost: 'total_cost_usd',
      gross_margin: 'gross_margin_usd',
    },
  },
  {
    name: 'v_ebpo_revenue_by_client',
    hasTime: false,
    dims: ['client', 'industry'],
    measures: {
      total_revenue: 'total_revenue_usd',
      total_cost: 'total_cost_usd',
      gross_margin: 'gross_margin_usd',
      no_clients: 'client_name',
    },
  },
  {
    name: 'v_ebpo_revenue_by_client_contract',
    hasTime: false,
    dims: ['client', 'industry', 'contract_type', 'business_unit'],
    measures: {
      total_revenue: 'total_revenue_usd',
      total_cost: 'total_cost_usd',
      gross_margin: 'gross_margin_usd',
      no_clients: 'client_name',
    },
  },
  {
    name: 'v_ebpo_client_revenue_collection',
    hasTime: false,
    dims: ['client', 'industry'],
    measures: {
      total_revenue: 'total_revenue_usd',
      total_cost: 'total_cost_usd',
      gross_margin: 'gross_margin_usd',
      ar_outstanding: 'outstanding_balance_usd',
      invoice_amount: 'invoice_amount_usd',
      collected_amount: 'collected_amount_usd',
      no_clients: 'client_name',
    },
  },
  {
    name: 'v_ebpo_revenue_by_business_unit_monthly',
    hasTime: true,
    dims: ['business_unit', 'contract_type'],
    measures: {
      total_revenue: 'total_revenue_usd',
      total_cost: 'total_cost_usd',
      gross_margin: 'gross_margin_usd',
    },
  },
  {
    name: 'v_ebpo_revenue_by_client_contract_monthly',
    hasTime: true,
    dims: ['client', 'industry', 'contract_type', 'business_unit'],
    measures: {
      total_revenue: 'total_revenue_usd',
      total_cost: 'total_cost_usd',
      gross_margin: 'gross_margin_usd',
      no_clients: 'client_name',
    },
  },
  {
    name: 'v_ebpo_department_efficiency_monthly',
    hasTime: true,
    dims: ['department'],
    // total_revenue_usd / total_cost_usd / gross_margin_usd are deliberately NOT
    // catalogued here: in this view they are the COMPANY TOTAL ($131.6M / $87.6M / $44M)
    // replicated on EVERY department row (revenue and cost are booked by
    // client/business-unit, never by department). Exposing them let "payroll vs
    // department revenue" plot a flat $131.6M on every bar. Removing them makes
    // "revenue/cost/margin by department" honestly refuse (no real per-department revenue
    // exists). Kept: payroll, headcount (genuinely per-department) and the per-employee
    // efficiency ratios (cost_per_employee = payroll/headcount is real; revenue_per_
    // employee is the data team's precomputed company-revenue-per-FTE column).
    measures: {
      employee_count: 'employee_count',
      total_payroll: 'total_payroll_usd',
      // company revenue replicated per department row — internal numerator for the
      // ratio-of-sums revenue_per_employee (max() takes it once); NOT exposed as a
      // standalone measure, so "revenue by department" still honestly refuses.
      company_revenue_repl: 'total_revenue_usd',
      cost_per_employee: 'cost_per_employee_usd',
    },
  },
  {
    // Department-level operations bridge. FactOperations has no department key, but
    // employees do carry both department and delivery_center. Weight each monthly
    // delivery-center operations KPI by that month’s department headcount at the
    // same center, yielding a real department-level SLA / CSAT / utilization view
    // without broadcasting one company average across every department.
    name: 'v_ebpo_department_operations_monthly',
    hasTime: true,
    from:
      `(
        WITH
          ops AS (
            SELECT
              o.tenant_id AS tenant_id,
              o.org_id AS org_id,
              d.date AS period_date,
              d.year AS year,
              d.quarter AS quarter,
              d.month AS month,
              d.month_name AS month_name,
              o.delivery_center AS delivery_center,
              round(avg(o.sla_compliance_pct), 2) AS sla_compliance_pct,
              round(avg(o.csat_pct), 2) AS csat_pct,
              round(avg(o.utilization_pct), 2) AS utilization_pct
            FROM {db}.ebpo_fact_operations o
            INNER JOIN {db}.ebpo_dim_date d
              ON d.tenant_id = o.tenant_id
             AND d.org_id = o.org_id
             AND d.date_key = o.date_key
             AND d.tenant_id = {tenantId:String}
             AND d.org_id IN ({externalOrgIds:Array(String)})
            WHERE o.tenant_id = {tenantId:String}
              AND o.org_id IN ({externalOrgIds:Array(String)})
            GROUP BY o.tenant_id, o.org_id, d.date, d.year, d.quarter, d.month, d.month_name, o.delivery_center
          ),
          dept_center_hc AS (
            SELECT
              p.tenant_id AS tenant_id,
              p.org_id AS org_id,
              d.date AS period_date,
              e.department AS department,
              e.delivery_center AS delivery_center,
              uniqExact(p.employee_key) AS employee_count
            FROM {db}.ebpo_fact_payroll p
            INNER JOIN {db}.ebpo_dim_date d
              ON d.tenant_id = p.tenant_id
             AND d.org_id = p.org_id
             AND d.date_key = p.date_key
             AND d.tenant_id = {tenantId:String}
             AND d.org_id IN ({externalOrgIds:Array(String)})
            INNER JOIN {db}.ebpo_dim_employee e
              ON e.tenant_id = p.tenant_id
             AND e.org_id = p.org_id
             AND e.employee_key = p.employee_key
             AND e.tenant_id = {tenantId:String}
             AND e.org_id IN ({externalOrgIds:Array(String)})
            WHERE p.tenant_id = {tenantId:String}
              AND p.org_id IN ({externalOrgIds:Array(String)})
              AND e.department != '' AND e.delivery_center != ''
            GROUP BY p.tenant_id, p.org_id, d.date, e.department, e.delivery_center
          )
        SELECT
          hc.tenant_id AS tenant_id,
          hc.org_id AS org_id,
          hc.period_date AS period_date,
          any(ops.year) AS year,
          any(ops.quarter) AS quarter,
          any(ops.month) AS month,
          any(ops.month_name) AS month_name,
          hc.department AS department,
          round(sum(ops.sla_compliance_pct * hc.employee_count) / nullIf(sum(hc.employee_count), 0), 2) AS sla_compliance_pct,
          round(sum(ops.csat_pct * hc.employee_count) / nullIf(sum(hc.employee_count), 0), 2) AS csat_pct,
          round(sum(ops.utilization_pct * hc.employee_count) / nullIf(sum(hc.employee_count), 0), 2) AS utilization_pct,
          sum(hc.employee_count) AS employee_count
        FROM dept_center_hc hc
        INNER JOIN ops
          ON ops.tenant_id = hc.tenant_id
         AND ops.org_id = hc.org_id
         AND ops.period_date = hc.period_date
         AND ops.delivery_center = hc.delivery_center
        GROUP BY hc.tenant_id, hc.org_id, hc.period_date, hc.department
      ) AS edo`,
    dims: ['department'],
    measures: {
      sla_compliance_pct: 'sla_compliance_pct',
      csat_pct: 'csat_pct',
      utilization_pct: 'utilization_pct',
      employee_count: 'employee_count',
    },
  },
  {
    name: 'v_ebpo_delivery_center_efficiency_monthly',
    hasTime: true,
    // Operations by delivery center / geography (calls, utilization, headcount). Geography
    // (region/country/city) lives only in ebpo_dim_geography keyed by delivery_center, so it
    // is flattened in via a tenant/org-scoped join. This view exposes NO revenue measure:
    // FactRevenue has no geography key, so revenue / revenue-per-employee are NOT available
    // by delivery center / country / region — those requests refuse (no fabricated allocation).
    from:
      '(SELECT e.*, g.city AS city FROM {db}.v_ebpo_delivery_center_efficiency_monthly e ' +
      'ANY LEFT JOIN (SELECT DISTINCT delivery_center, city, tenant_id, org_id FROM {db}.ebpo_dim_geography ' +
      'WHERE tenant_id = {tenantId:String} AND org_id IN ({externalOrgIds:Array(String)})) g ' +
      'ON e.delivery_center = g.delivery_center AND e.tenant_id = g.tenant_id AND e.org_id = g.org_id) AS dce',
    dims: ['delivery_center', 'region', 'country', 'city'],
    measures: {
      calls_handled: 'calls_handled',
      utilization_pct: 'utilization_pct',
      employee_count: 'employee_count',
    },
  },
  {
    name: 'v_ebpo_business_unit_efficiency',
    hasTime: false,
    dims: ['business_unit'],
    measures: {
      total_revenue: 'total_revenue_usd',
      total_cost: 'total_cost_usd',
      gross_margin: 'gross_margin_usd',
      employee_count: 'employee_count',
      revenue_per_employee: 'revenue_per_employee_usd',
    },
  },
  {
    name: 'v_ebpo_salary_by_dept_grade',
    hasTime: false,
    dims: ['department', 'grade'],
    measures: {
      avg_monthly_salary: 'avg_monthly_salary_usd',
      employee_count: 'employee_count',
    },
  },
  {
    name: 'v_ebpo_employee_headcount',
    hasTime: false,
    dims: ['department', 'country', 'delivery_center', 'grade'],
    measures: {
      employee_count: 'employee_count',
      avg_monthly_salary: 'avg_monthly_salary_usd',
    },
  },
  {
    name: 'v_ebpo_fixed_assets_by_center',
    hasTime: false,
    // Fixed assets are keyed by delivery_center; REGION/COUNTRY/CITY live only in
    // ebpo_dim_geography (keyed by delivery_center). Flatten them in via a tenant/org-
    // scoped join — same pattern as the delivery-center efficiency view — so "assets /
    // net book value by country (or region/city)" resolves here instead of being
    // refused. The dim join is scoped to satisfy enforceEveryTableScoped.
    from:
      '(SELECT e.*, g.region AS region, g.country AS country, g.city AS city ' +
      'FROM {db}.v_ebpo_fixed_assets_by_center e ' +
      'ANY LEFT JOIN (SELECT DISTINCT delivery_center, region, country, city, tenant_id, org_id FROM {db}.ebpo_dim_geography ' +
      'WHERE tenant_id = {tenantId:String} AND org_id IN ({externalOrgIds:Array(String)})) g ' +
      'ON e.delivery_center = g.delivery_center AND e.tenant_id = g.tenant_id AND e.org_id = g.org_id) AS fa',
    dims: ['delivery_center', 'asset_type', 'region', 'country', 'city'],
    measures: {
      asset_cost: 'asset_cost_usd',
      accumulated_depreciation: 'accumulated_depreciation_usd',
      net_book_value: 'net_book_value_usd',
      asset_count: 'asset_count',
    },
  },
  {
    // Trial balance (FactTrialBalance). The General Ledger fact was removed from the
    // dataset, so v_ebpo_gl_monthly and v_ebpo_expense_by_account (and their measures
    // total_debit/total_credit/net_movement/operating_expense) are gone. Closing/opening
    // balance remain — they come from this trial-balance view.
    name: 'v_ebpo_trial_balance_monthly',
    hasTime: true,
    dims: ['account'],
    measures: {
      closing_balance: 'closing_balance_usd',
      opening_balance: 'opening_balance_usd',
    },
  },
  {
    // Expense-account movement from trial balance. This is the genuine company-level
    // account/category grain behind workbook asks like "monthly expense trends by
    // account category". Filter to the real expense accounts in DimAccount; there is
    // still no client bridge, so client×account asks remain unavailable.
    name: 'v_ebpo_expense_accounts_monthly',
    hasTime: true,
    from:
      "(SELECT * FROM {db}.v_ebpo_trial_balance_monthly " +
      "WHERE account_name IN ('Payroll Expense', 'Rent Expense', 'IT Infrastructure', 'Recruitment Expense', 'Depreciation')) AS ebe",
    dims: ['account'],
    measures: {
      account_expense: 'credit_movement_usd',
    },
  },
  {
    // Canonical derived-CFO-ratio view (SUPERSET of v_ebpo_kpi_monthly). Listed LAST
    // so single-measure resolution prefers the dedicated views; multi-measure combos
    // that mix a derived ratio with a base measure fall through and resolve here.
    // Monthly grain only.
    name: 'v_ebpo_cfo_ratios_monthly',
    hasTime: true,
    dims: [],
    measures: {
      // derived ratios (only here)
      working_capital: 'working_capital_usd',
      // base measures (also here, for combos that pair a ratio with these)
      total_revenue: 'total_revenue_usd',
      total_cost: 'total_cost_usd',
      gross_margin: 'gross_margin_usd',
      total_payroll: 'total_payroll_usd',
      overtime_to_payroll_pct: 'overtime_to_payroll_pct',
      ar_outstanding: 'ar_outstanding_usd',
      ap_outstanding: 'ap_outstanding_usd',
      operating_cf: 'operating_cash_flow_usd',
      free_cash_flow: 'free_cash_flow_usd',
      cash_balance: 'cash_balance_usd',
      sla_compliance_pct: 'sla_compliance_pct',
      csat_pct: 'csat_pct',
      utilization_pct: 'utilization_pct',
      dso_days: 'dso_days',
      dpo_days: 'dpo_days',
    },
  },
];

// ─── Catalog: what is genuinely NOT in the data (honest refusals) ─────────────
export const EBPO_UNAVAILABLE: Record<string, string> = {
  budget: 'budget / plan figures',
  forecast: 'forecast / projection data',
  target: 'target or goal figures',
  pipeline: 'sales pipeline / opportunity data',
  churn: 'customer churn / retention data',
  nps: 'NPS survey data',
};

// ─── SQL helpers ──────────────────────────────────────────────────────────────
const SCOPE_WHERE =
  'tenant_id = {tenantId:String} AND org_id IN ({externalOrgIds:Array(String)})';
const quoteLit = (v: string) => `'${String(v).replace(/'/g, "''")}'`;
const quoteIdent = (v: string) => `"${String(v).replace(/"/g, '""')}"`;

const decimalsFor = (m: EbpoMeasureDef) =>
  m.decimals ?? (m.format === 'percent' ? 1 : m.format === 'number' ? 0 : 0);

// Periods that make up one year at a given time grain — the window lag for YoY.
const periodsPerYear = (dimId: string): number | null =>
  dimId === 'month' ? 12 : dimId === 'quarter' ? 4 : dimId === 'year' ? 1 : null;

const timeExpr = (dimId: string): { label: string; group: string } => {
  // The label MUST be a function of the GROUP BY key — ClickHouse rejects a SELECT
  // expression that isn't in/derived from GROUP BY. So derive every label from the
  // same toStartOf* key we group on.
  if (dimId === 'quarter')
    return {
      label: `concat('Q', toString(toQuarter(toStartOfQuarter(period_date))), ' ', toString(toYear(toStartOfQuarter(period_date))))`,
      group: `toStartOfQuarter(period_date)`,
    };
  if (dimId === 'year')
    return {
      label: `toString(toYear(toStartOfYear(period_date)))`,
      group: `toStartOfYear(period_date)`,
    };
  return {
    label: `formatDateTime(toStartOfMonth(period_date), '%b %Y')`,
    group: `toStartOfMonth(period_date)`,
  };
};

// The FROM source for a view: a join-enriched subquery if declared, else the table.
const fromExpr = (view: EbpoViewDef, db: string): string =>
  view.from ? view.from.split('{db}').join(db) : `${db}.${view.name}`;

const catExpr = (dim: EbpoDimDef) =>
  `COALESCE(NULLIF(${dim.column}, ''), 'Unassigned')`;

// label + group expr for any dimension within a chosen view
const dimSql = (
  dimId: string,
): { label: string; group: string; isTime: boolean } => {
  const dim = EBPO_DIMENSIONS[dimId]!;
  if (dim.isTime) {
    const t = timeExpr(dimId);
    return { label: t.label, group: t.group, isTime: true };
  }
  const e = catExpr(dim);
  return { label: e, group: e, isTime: false };
};

const aggOf = (m: EbpoMeasureDef, col: string) =>
  m.weightBy
    ? `sum(${col} * ${m.weightBy}) / nullIf(sum(${m.weightBy}), 0)`
    : m.agg === 'distinct'
      ? `uniqExactIf(${col}, ${col} != '')` // DISTINCTCOUNT, excluding blank keys
      : `${m.agg}(${col})`;
const aggIfOf = (m: EbpoMeasureDef, col: string, cond: string) =>
  m.weightBy
    ? `sumIf(${col} * ${m.weightBy}, ${cond}) / nullIf(sumIf(${m.weightBy}, ${cond}), 0)`
    : m.agg === 'distinct'
      ? `uniqExactIf(${col}, (${cond}) AND ${col} != '')`
      : `${m.agg}If(${col}, ${cond})`;
// Numerator terms of a derived measure, normalized to {add, sub} measure-id lists.
const numTerms = (num: NonNullable<EbpoMeasureDef['derived']>['num']) =>
  typeof num === 'string'
    ? { add: [num], sub: [] as string[] }
    : { add: num.add, sub: num.sub ?? [] };
// Every measure id a derived definition references (numerator terms + denominator).
const derivedRefs = (d: NonNullable<EbpoMeasureDef['derived']>): string[] => {
  const t = numTerms(d.num);
  return [...t.add, ...t.sub, ...(d.den ? [d.den] : [])];
};
// Build the numerator as a sum-of-terms using `wrap` (sum(col) or sumIf(col, cond)).
// A single positive term stays bare (byte-identical to the old single-id form); any
// multi-term numerator is parenthesized: (sum(a) - sum(b) - sum(c)).
const numeratorExpr = (
  num: NonNullable<EbpoMeasureDef['derived']>['num'],
  view: EbpoViewDef,
  cond?: string,
): string => {
  const t = numTerms(num);
  // Each numerator term aggregates with its OWN measure agg (symmetric with the
  // denominator at aggExprFor). For every flow numerator (agg='sum') this is byte-
  // identical to the old hardcoded sum(); a non-additive term (e.g. a replicated
  // company-level column with agg='max') is taken once instead of summed across rows.
  const aggTerm = (id: string) => {
    const m = EBPO_MEASURES[id]!;
    const col = view.measures[id]!;
    return cond ? aggIfOf(m, col, cond) : aggOf(m, col);
  };
  const add = t.add.map(aggTerm).join(' + ');
  const sub = t.sub.map((id) => ` - ${aggTerm(id)}`).join('');
  return t.add.length > 1 || t.sub.length ? `(${add}${sub})` : `${add}${sub}`;
};
// A view "exposes" a measure when it has the measure's column, OR (derived) every
// column the derivation references (all numerator terms + the denominator).
const viewExposesMeasure = (view: EbpoViewDef, mid: string): boolean => {
  const m = EBPO_MEASURES[mid];
  if (!m) return false;
  if (mid in view.measures) return true;
  if (m.window) return view.hasTime && m.window.base in view.measures;
  if (m.derived) return derivedRefs(m.derived).every((id) => id in view.measures);
  return false;
};
// View-aware aggregate: derived measures compute num/den (ratio-of-sums) from the
// view's columns; everything else uses the measure's own column + agg.
const aggExprFor = (m: EbpoMeasureDef, view: EbpoViewDef): string => {
  if (view.measures[m.id]) return aggOf(m, view.measures[m.id]!);
  if (m.derived) {
    const n = numeratorExpr(m.derived.num, view);
    if (!m.derived.den) return n; // absolute additive measure (e.g. EBITDA)
    // The denominator uses the DEN MEASURE's own aggregate, not a hardcoded sum() — so a
    // distinct-count denominator (e.g. Avg Revenue per Client = revenue / No. Clients)
    // emits uniqExact. For every existing ratio the den is a flow → aggOf = sum(), unchanged.
    const denM = EBPO_MEASURES[m.derived.den]!;
    const denExpr = aggOf(denM, view.measures[m.derived.den]!);
    return `${n} / nullIf(${denExpr}, 0) * ${m.derived.scale ?? 100}`;
  }
  return aggOf(m, view.measures[m.id]!);
};
const condAggExprFor = (
  m: EbpoMeasureDef,
  view: EbpoViewDef,
  cond: string,
): string => {
  if (view.measures[m.id]) return aggIfOf(m, view.measures[m.id]!, cond);
  if (m.derived) {
    const n = numeratorExpr(m.derived.num, view, cond);
    if (!m.derived.den) return n; // absolute additive measure (e.g. EBITDA)
    const denM = EBPO_MEASURES[m.derived.den]!;
    const denExpr = aggIfOf(denM, view.measures[m.derived.den]!, cond);
    return `${n} / nullIf(${denExpr}, 0) * ${m.derived.scale ?? 100}`;
  }
  return aggIfOf(m, view.measures[m.id]!, cond);
};
export const valueExprFor = (m: EbpoMeasureDef, view: EbpoViewDef) =>
  `round(${aggExprFor(m, view)}, ${decimalsFor(m)})`;
const condValueExprFor = (m: EbpoMeasureDef, view: EbpoViewDef, cond: string) =>
  `round(${condAggExprFor(m, view, cond)}, ${decimalsFor(m)})`;

const windowExprFor = (
  measure: EbpoMeasureDef,
  view: EbpoViewDef,
  dimId: string | null | undefined,
): string | null => {
  if (!measure.window || !dimId) return null;
  const ppy = periodsPerYear(dimId);
  if (ppy === null) return null;
  const wdim = dimSql(dimId);
  const agg = `sum(${view.measures[measure.window.base]!})`;
  const yearFrame = `OVER (ORDER BY ${wdim.group} ROWS BETWEEN ${ppy} PRECEDING AND ${ppy} PRECEDING)`;
  const lagOneYear = `any(${agg}) ${yearFrame}`;
  const priorExists = `count(${agg}) ${yearFrame}`;
  const dp = decimalsFor(measure);
  return measure.window.kind === 'yoy'
    ? `if(${priorExists} = 0, NULL, round((${agg} - ${lagOneYear}) / nullIf(${lagOneYear}, 0) * 100, ${dp}))`
    : measure.window.kind === 'yoy_abs'
      ? `if(${priorExists} = 0, NULL, round(${agg} - ${lagOneYear}, ${dp}))`
      : measure.window.kind === 'ly'
        ? `if(${priorExists} = 0, NULL, round(${lagOneYear}, ${dp}))`
        : `round(sum(${agg}) OVER (PARTITION BY toYear(${wdim.group}) ORDER BY ${wdim.group} ROWS UNBOUNDED PRECEDING), ${dp})`;
};

// ─── View resolution ──────────────────────────────────────────────────────────
const viewSupportsDim = (
  view: EbpoViewDef,
  dimId: string | null | undefined,
): boolean => {
  if (!dimId) return true; // KPI / no grouping
  const dim = EBPO_DIMENSIONS[dimId];
  if (!dim) return false;
  return dim.isTime ? view.hasTime : view.dims.includes(dimId);
};

const scoreEbpoView = (
  view: EbpoViewDef,
  measureIds: string[],
  dimId: string | null | undefined,
  breakdownId: string | null | undefined,
): number => {
  let score = 0;
  const dim = dimId ? EBPO_DIMENSIONS[dimId] : null;
  const requestedNonTime = !!dim && !dim.isTime;
  const requestedTime = !!dim?.isTime;
  const measures = measureIds.map((id) => EBPO_MEASURES[id]!).filter(Boolean);

  // Non-time count charts should prefer snapshot / headcount-style views over
  // time-grained payroll views, otherwise monthly counts get summed again and
  // inflate into the 1.1K–1.8K range instead of matching the true 800 total.
  if (requestedNonTime && measures.some((m) => m.kind === 'count')) {
    if (view.hasTime) score += 1000;
    if (/employee_headcount/i.test(view.name)) score -= 250;
    if (/salary_by_dept_grade/i.test(view.name)) score -= 100;
  }

  if (breakdownId) {
    const bd = EBPO_DIMENSIONS[breakdownId];
    if (bd?.isTime && !view.hasTime) score += 100;
  }

  return score;
};

// Categorical (non-time) filter dimensions that the chosen view MUST physically
// expose — otherwise buildWhere silently drops the filter and we'd plot unfiltered
// (wrong) data. E.g. a `client` filter must route to a client-bearing view.
const requiredNonTimeDims = (filterDims: string[]): string[] =>
  Array.from(
    new Set(
      filterDims.filter((d) => {
        const dd = EBPO_DIMENSIONS[d];
        return !!dd && !dd.isTime && !!dd.column;
      }),
    ),
  );

export const resolveEbpoView = (
  measureId: string,
  dimId: string | null | undefined,
  breakdownId: string | null | undefined,
  filterDims: string[] = [],
  requireTime = false,
): EbpoViewDef | null => {
  const needDims = requiredNonTimeDims(filterDims);
  const candidates = EBPO_VIEWS.filter(
    (v) =>
      viewExposesMeasure(v, measureId) &&
      viewSupportsDim(v, dimId) &&
      (!breakdownId || viewSupportsDim(v, breakdownId)) &&
      needDims.every((d) => v.dims.includes(d)) &&
      (!requireTime || v.hasTime),
  );
  if (candidates.length === 0) return null;
  return candidates.sort((a, b) => scoreEbpoView(a, [measureId], dimId, breakdownId) - scoreEbpoView(b, [measureId], dimId, breakdownId))[0] ?? null;
};

// Multi-measure (combo / dual-axis): find ONE view exposing EVERY measure + the
// dimension, so a single GROUP BY plots them together.
export const resolveEbpoViewMulti = (
  measureIds: string[],
  dimId: string | null | undefined,
  breakdownId?: string | null,
  filterDims: string[] = [],
  requireTime = false,
): EbpoViewDef | null => {
  const needDims = requiredNonTimeDims(filterDims);
  const candidates = EBPO_VIEWS.filter(
    (v) =>
      measureIds.every((m) => viewExposesMeasure(v, m)) &&
      viewSupportsDim(v, dimId) &&
      (!breakdownId || viewSupportsDim(v, breakdownId)) &&
      needDims.every((d) => v.dims.includes(d)) &&
      (!requireTime || v.hasTime),
  );
  if (candidates.length === 0) return null;
  return candidates.sort(
    (a, b) => scoreEbpoView(a, measureIds, dimId, breakdownId) - scoreEbpoView(b, measureIds, dimId, breakdownId),
  )[0] ?? null;
};

// ─── Unrelated-dimension replication (PowerBI parity) ──────────────────────────
// PowerBI, in a star schema, will still render "measure BY dimension" even when the
// measure's fact table has NO relationship to that dimension — it shows the SAME
// company-level value for every category (e.g. SLA Compliance % "by department" =
// 0.92 on every department, because operations is keyed by delivery_center, not
// department). We replicate that behaviour GENERICALLY: when a single measure has no
// view that exposes the requested categorical dimension, but the measure DOES resolve
// at the company grain and the dimension's categories can be enumerated, we cross-join
// the company value across those categories. This is a general capability, not
// per-question routing — it fires for ANY such measure/dimension pair.

// A plain (non-subquery) view that physically exposes this categorical dimension, used
// to enumerate the dimension's category values. Prefer plain tables so the SCOPE_WHERE
// predicate references real tenant_id/org_id columns.
const dimCategorySource = (dimId: string): EbpoViewDef | null => {
  const dim = EBPO_DIMENSIONS[dimId];
  if (!dim || dim.isTime || !dim.column) return null;
  return EBPO_VIEWS.find((v) => !v.from && v.dims.includes(dimId)) ?? null;
};

// The scalar company-grain value of a measure as a subquery `SELECT <expr> AS value
// FROM <view> WHERE <scope>` — used to cross-join (replicate) an unrelated measure
// across another measure's dimension (PowerBI parity). Null if the measure has no
// company-grain view.
export const ebpoCompanyValueSubquery = (
  measureId: string,
  db: string,
): string | null => {
  const m = EBPO_MEASURES[measureId];
  const v = resolveEbpoView(measureId, null, null, []);
  if (!m || !v) return null;
  return `SELECT ${valueExprFor(m, v)} AS value FROM ${fromExpr(v, db)} WHERE ${SCOPE_WHERE}`;
};

// True when "measure BY dimId" has no real view but CAN be shown as the company value
// replicated across dimId's categories (single categorical dim, no breakdown).
const canReplicateAcrossDim = (
  _measureId: string,
  _dimId: string | null | undefined,
  _filterDims: string[],
): boolean => {
  // DISABLED — this only ever fired when the measure has NO real view for the dimension
  // (line below guarded `resolveEbpoView(...) → return false` when a genuine breakdown
  // exists), i.e. the dimension is ALWAYS unrelated to the measure's fact. Replicating the
  // company-wide average onto every category of an unrelated dimension produces identical
  // bars that READ as real per-category data but are fabricated — e.g. "SLA by department"
  // → 92.4% on all 10 departments, "utilization by department" → 86.4% on all 10. The
  // dataset genuinely has no operations-by-department grain, so the honest answer is to
  // refuse and offer the real grains (delivery center / region / country). Returning false
  // routes every such request to that honest refusal instead of a broadcast fabrication.
  return false;
};

// Build the cross-join SQL: one row per category of dimId, all carrying the company
// value of the measure. Returns null if it can't be built.
const buildReplicatedAcrossDimSql = (
  measureId: string,
  dimId: string,
  filterDims: string[],
  db: string,
  topN: number,
): string | null => {
  const measure = EBPO_MEASURES[measureId];
  const dim = EBPO_DIMENSIONS[dimId];
  const companyView = resolveEbpoView(measureId, null, null, filterDims);
  const srcView = dimCategorySource(dimId);
  if (!measure || !dim?.column || !companyView || !srcView) return null;
  // Company value (a stock balance is point-in-time → latest period; otherwise the
  // full-period aggregate). valueExprFor already wraps the right agg for the measure.
  const companySql =
    `SELECT ${valueExprFor(measure, companyView)} AS value ` +
    `FROM ${fromExpr(companyView, db)} WHERE ${SCOPE_WHERE}`;
  const catSql =
    `SELECT DISTINCT COALESCE(NULLIF(${dim.column}, ''), 'Unassigned') AS name ` +
    `FROM ${fromExpr(srcView, db)} WHERE ${SCOPE_WHERE} AND ${dim.column} != '' ` +
    `ORDER BY name ASC LIMIT ${topN}`;
  return (
    `SELECT cats.name AS name, c.value AS value ` +
    `FROM (${catSql}) cats CROSS JOIN (${companySql}) c ORDER BY cats.name ASC`
  );
};

// Order-preserving measure list. Most chart families should not repeat the same
// measure twice, but scatter/bubble can legitimately reuse an axis measure as the
// size channel (e.g. revenue vs cost, sized by cost), so preserve duplicates there.
const measureListOf = (spec: ChartSpec): string[] => {
  const raw = (spec.measures ?? []).filter((m): m is string => !!m);
  const list = raw.length ? raw : spec.measure ? [spec.measure] : [];
  const ct = String(spec.chartType ?? '').toLowerCase();
  if (ct === 'scatter' || ct === 'bubble') return list;
  return Array.from(new Set(list));
};

// ─── Refusal copy helpers ─────────────────────────────────────────────────────
// Courteous closing used on every refusal so the user knows nothing was changed.
const REFUSAL_CLOSING = " I've left the chart unchanged.";

// Join labels into a natural-language list: ["A"] → "A"; ["A","B"] → "A or B";
// ["A","B","C"] → "A, B, or C".
const naturalList = (items: string[]): string =>
  items.length <= 1
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')}${items.length > 2 ? ',' : ''} or ${items[items.length - 1]}`;

// The dimensions a measure CAN be grouped by, derived from the catalog (the views that
// expose it). Deterministic — drives a helpful "I can show X by …" suggestion in refusals.
export function ebpoSupportedGroupings(measureId: string): {
  time: boolean;
  dims: string[];
} {
  const views = EBPO_VIEWS.filter((v) => viewExposesMeasure(v, measureId));
  const time = views.some((v) => v.hasTime);
  const dimIds = new Set<string>();
  for (const v of views) for (const d of v.dims) dimIds.add(d);
  const dims = Array.from(dimIds)
    .map((id) => EBPO_DIMENSIONS[id]?.label)
    .filter((l): l is string => !!l);
  return { time, dims };
}

// A polite "here's what I can show instead" clause for a measure, or '' if nothing applies.
function ebpoAlternativeClause(measureId: string): string {
  const m = EBPO_MEASURES[measureId];
  if (!m) return '';
  const { time, dims } = ebpoSupportedGroupings(measureId);
  const options: string[] = [];
  if (dims.length) options.push(`by ${naturalList(dims)}`);
  if (time) options.push('over time (by month, quarter, or year)');
  if (options.length === 0) return '';
  return ` I can show ${m.label} ${options.join(', or ')} instead.`;
}

// ─── Validation ───────────────────────────────────────────────────────────────
export function validateEbpoSpec(
  spec: ChartSpec,
  allowReplicate = true,
): CompileRefusal | null {
  // Used when there's no specific alternative to suggest — a brief, professional note
  // on what the dataset covers, plus the courteous closing.
  const tail =
    ' This dataset covers Enterprise BPO financials — revenue, payroll, cash flow, receivables/payables, and operations.' +
    REFUSAL_CLOSING;
  const measures = measureListOf(spec);
  const dimId = spec.dimension || null;
  const filterDims = (spec.filters ?? []).map((f) => f.dimension);

  // Every named measure must be real and available.
  for (const mid of measures) {
    if (EBPO_UNAVAILABLE[mid])
      return {
        ok: false,
        refusal: `I'm sorry, but ${EBPO_UNAVAILABLE[mid]} isn't part of this dataset, so I'm not able to chart it.${tail}`,
      };
    if (!EBPO_MEASURES[mid])
      return {
        ok: false,
        refusal: `I'm sorry, but I don't have a metric called "${mid}" available in this dataset to plot.${tail}`,
      };
  }
  if (measures.length === 0)
    return {
      ok: false,
      refusal: `Could you let me know which metric you'd like to see? I need a measure to build the chart.`,
    };
  if (
    EBPO_UNAVAILABLE[spec.dimension] ||
    (spec.breakdown && EBPO_UNAVAILABLE[spec.breakdown])
  )
    return {
      ok: false,
      refusal: `I'm sorry, but that breakdown isn't available in this dataset.${tail}`,
    };
  if (dimId && !EBPO_DIMENSIONS[dimId])
    return {
      ok: false,
      refusal: `I'm sorry, but I can't group the data by "${spec.dimension}" — it isn't one of the dimensions available in this dataset.${tail}`,
    };

  // Part-to-whole charts (pie/donut) show how a total splits across CATEGORIES. A time
  // axis rendered as pie slices is never a real distribution — e.g. "expense distribution
  // for the largest client" coming back as one slice per month is meaningless and
  // misrepresents the data. When the only grouping the planner could find for the measure
  // is time (no categorical breakdown exists), refuse rather than fabricate a composition
  // the dataset can't support. (Valid donuts use a categorical dimension or a set of
  // component measures with no dimension, neither of which trips this guard.)
  {
    const ct = String(spec.chartType ?? '').toLowerCase();
    if (
      (ct === 'pie' || ct === 'donut') &&
      dimId &&
      EBPO_DIMENSIONS[dimId]?.isTime &&
      !spec.breakdown
    ) {
      const m = EBPO_MEASURES[measures[0]!];
      const alt = measures[0] ? ebpoAlternativeClause(measures[0]!) : '';
      return {
        ok: false,
        refusal:
          `A ${ct} chart shows how a total splits across categories, but ${
            m?.label ?? 'that measure'
          } isn't broken down by any category in this dataset — it's only tracked as a single total per period, so there's no distribution to show.` +
          (alt ? `${alt}${REFUSAL_CLOSING}` : tail),
      };
    }
  }

  // Multi-measure charts with a dimension need one shared view/grain. KPI cards
  // have no dimension, so each independently scoped card may use its own verified
  // provider view and the compiler safely UNIONs the results.
  if (measures.length > 1) {
    if (!dimId && String(spec.chartType ?? '').toLowerCase() === 'kpi') {
      const missingProvider = measures.find(
        (measureId) => !resolveEbpoView(measureId, null, null, filterDims),
      );
      if (!missingProvider) return null;
    }
    if (!resolveEbpoViewMulti(measures, dimId, spec.breakdown, filterDims)) {
      const labels = naturalList(measures.map((m) => EBPO_MEASURES[m]!.label));
      const by = dimId ? ` by ${EBPO_DIMENSIONS[dimId]!.label}` : '';
      return {
        ok: false,
        refusal: `I'm sorry, but I can't plot ${labels} together${by} — they aren't tracked at the same level of detail in this dataset, so they can't be combined in one chart.${tail}`,
      };
    }
    return null;
  }

  // Single measure.
  if (spec.breakdown && !EBPO_DIMENSIONS[spec.breakdown])
    return {
      ok: false,
      refusal: `I'm sorry, but I can't break the data down by "${spec.breakdown}" — it isn't one of the dimensions available in this dataset.${tail}`,
    };
  const view = resolveEbpoView(measures[0]!, dimId, spec.breakdown, filterDims);
  if (!view) {
    // No real view for measure×dimension. Before refusing, allow the PowerBI-style
    // unrelated-dimension replication (single categorical dim, no breakdown): the
    // measure's company value plotted across that dimension's categories.
    if (
      allowReplicate &&
      !spec.breakdown &&
      canReplicateAcrossDim(measures[0]!, dimId, filterDims)
    )
      return null;
    const m = EBPO_MEASURES[measures[0]!]!;
    const byLabel = naturalList(
      [dimId, spec.breakdown]
        .filter((d): d is string => !!d)
        .map((d) => EBPO_DIMENSIONS[d]?.label ?? d),
    );
    // Suggest what the measure CAN be grouped by; fall back to the dataset-coverage note.
    const alt = ebpoAlternativeClause(measures[0]!);
    return {
      ok: false,
      refusal:
        `I'm sorry, but ${m.label} isn't available broken down by ${byLabel} in this dataset — it isn't tracked at that level.` +
        (alt ? `${alt}${REFUSAL_CLOSING}` : tail),
    };
  }
  return null;
}

// ─── WHERE builder ────────────────────────────────────────────────────────────
const buildWhere = (
  view: EbpoViewDef,
  dimIds: string[],
  filters: SpecFilter[] | undefined,
  db: string,
  applyLatest: boolean,
  recentMonths?: number | null,
): string => {
  const parts = [SCOPE_WHERE];
  // Categorical dims used in this chart should exclude empty labels.
  for (const id of dimIds) {
    const dim = EBPO_DIMENSIONS[id];
    if (dim && !dim.isTime && dim.column) parts.push(`${dim.column} != ''`);
  }
  // Relative window ("last N months"): restrict to the most-recent N months of DATA,
  // anchored to the dataset's latest period (NOT today — the data is historical). Works
  // on any chart, including categorical ones (e.g. revenue-vs-cost scatter per client
  // over the last 8 months). Only meaningful on a time-grained view.
  if (recentMonths && recentMonths > 0 && view.hasTime) {
    parts.push(
      `period_date >= addMonths(toStartOfMonth((SELECT max(period_date) FROM ${db}.${view.name} WHERE ${SCOPE_WHERE})), -${Math.floor(recentMonths) - 1})`,
    );
  }
  // Stock measures from a time-grained view, when NOT shown over time, are a
  // point-in-time balance → restrict to the latest period (avoid summing months).
  if (applyLatest) {
    parts.push(
      `period_date = (SELECT max(period_date) FROM ${db}.${view.name} WHERE ${SCOPE_WHERE})`,
    );
  }
  for (const f of filters ?? []) {
    const dim = EBPO_DIMENSIONS[f.dimension];
    if (!dim || f.values.length === 0) continue;
    if (dim.isTime) {
      if (!view.hasTime) continue;
      const values = f.values.map((v) => String(v).trim()).filter(Boolean);
      if (values.length === 0) continue;
      const op = f.op === 'not_in' ? 'NOT IN' : 'IN';
      if (f.dimension === 'year') {
        const years = values
          .map((v) => Number(v))
          .filter((v) => Number.isInteger(v) && v >= 1900 && v <= 2100);
        if (years.length) parts.push(`toYear(period_date) ${op} (${years.join(', ')})`);
        continue;
      }
      if (f.dimension === 'quarter') {
        const quarters = values
          .map((v) => {
            const m = v.match(/(?:q)?([1-4])(?:\s+|-)?(20\d{2})?/i);
            return m ? { quarter: Number(m[1]), year: m[2] ? Number(m[2]) : null } : null;
          })
          .filter((v): v is { quarter: number; year: number | null } => !!v);
        const yearScoped = quarters.filter((v) => v.year);
        if (yearScoped.length === quarters.length && quarters.length > 0) {
          parts.push(
            `(${yearScoped
              .map((v) => `(toQuarter(period_date) = ${v.quarter} AND toYear(period_date) = ${v.year})`)
              .join(' OR ')})`,
          );
        } else {
          const qs = Array.from(new Set(quarters.map((v) => v.quarter))).filter((v) => v >= 1 && v <= 4);
          if (qs.length) parts.push(`toQuarter(period_date) ${op} (${qs.join(', ')})`);
        }
        continue;
      }
      if (f.dimension === 'month') {
        const monthNums = values
          .map((v) => {
            const direct = Number(v);
            if (Number.isInteger(direct) && direct >= 1 && direct <= 12) return direct;
            const parsed = Date.parse(`${v} 1, 2000`);
            return Number.isNaN(parsed) ? null : new Date(parsed).getUTCMonth() + 1;
          })
          .filter((v): v is number => Number.isInteger(v as number) && (v as number) >= 1 && (v as number) <= 12);
        if (monthNums.length) {
          parts.push(`toMonth(period_date) ${op} (${Array.from(new Set(monthNums)).join(', ')})`);
        }
        continue;
      }
      continue;
    }
    if (!dim.column) continue;
    if (!view.dims.includes(f.dimension)) continue;
    const list = f.values.map(quoteLit).join(', ');
    parts.push(
      `${dim.column} ${f.op === 'not_in' ? 'NOT IN' : 'IN'} (${list})`,
    );
  }
  return parts.join(' AND ');
};

const opSql = (op: SpecThreshold['op']) =>
  op === 'gt' ? '>' : op === 'lt' ? '<' : op === 'gte' ? '>=' : '<=';

// The chart type a spec should ACTUALLY render as. A pie/donut shows PARTS OF A WHOLE; a
// single RATIO measure (an average %, e.g. CSAT/SLA/utilization/margin %) broken down by a
// category is a set of independent averages that don't sum to a meaningful total, so a pie
// is nonsense — coerce to a bar. Flow measures (revenue/spend/expense) DO compose, so their
// pies are kept. General — used by both the compiler and specToPlan so the widget TYPE and
// the SQL agree.
export function effectiveEbpoChartType(spec: ChartSpec): string {
  return spec.chartType ?? 'bar';
}

// ─── Compile ──────────────────────────────────────────────────────────────────
export async function compileEbpoSpec(
  spec: ChartSpec,
  db: string,
  runRows: (sql: string) => Promise<Array<Record<string, unknown>>>,
  maxBreakdownCols = 40,
  // PowerBI-style replication of a measure across an unrelated categorical dimension.
  // ON for primary breakdown charts; callers compiling a measure only to read its value
  // (e.g. a reference-line target) pass false so an unavailable measure still refuses.
  allowReplicate = true,
): Promise<EbpoCompileResult | CompileRefusal> {
  const refusal = validateEbpoSpec(spec, allowReplicate);
  if (refusal) return refusal;

  spec = { ...spec, chartType: effectiveEbpoChartType(spec) };

  // A breakdown identical to the primary dimension is degenerate: grouping by account
  // AND pivoting by account produces a diagonal matrix (each category non-zero only in
  // its own column), which renders as N self-series and breaks share-of-total (every
  // category becomes 100% of its own row). Drop it so a single measure by one category
  // stays a single series — e.g. "stacked column of expense composition by account".
  if (spec.breakdown && spec.breakdown === spec.dimension) {
    spec = { ...spec, breakdown: undefined };
  }

  const measures = measureListOf(spec);
  const dimId = spec.dimension || null;
  const filterDims = (spec.filters ?? []).map((f) => f.dimension);
  const topN = spec.topN && spec.topN > 0 ? Math.floor(spec.topN) : 50;
  // Relative window ("last N months") — restrict to the most-recent N months of data.
  // Forces a time-bearing view (so the predicate has a period_date to filter on).
  const recentMonths =
    spec.recentMonths && spec.recentMonths > 0 ? Math.floor(spec.recentMonths) : null;
  const wantTime = !!recentMonths;

  // ── Unrelated-dimension replication (PowerBI parity, single measure) ────────
  // The measure has no view for this categorical dimension but resolves company-wide:
  // plot the company value across the dimension's categories (flat per category), the
  // way PowerBI renders an unrelated-dimension breakdown. General — fires for any such
  // pair (e.g. SLA % by department, revenue by department).
  if (
    allowReplicate &&
    measures.length === 1 &&
    dimId &&
    !spec.breakdown &&
    canReplicateAcrossDim(measures[0]!, dimId, filterDims)
  ) {
    const sql = buildReplicatedAcrossDimSql(measures[0]!, dimId, filterDims, db, topN);
    if (sql)
      return {
        ok: true,
        sql,
        measure: EBPO_MEASURES[measures[0]!]!,
        view: resolveEbpoView(measures[0]!, null, null, filterDims)!.name,
      };
  }

  // ── Multi-measure (combo / dual-axis / multi-KPI) ──────────────────────────
  // Plot every measure against the dimension as separate series. When a breakdown
  // is also requested, pivot breakdown x measure into explicit WIDE series instead
  // of silently dropping the breakdown (e.g. account | opening/closing balance).
  if (measures.length > 1) {
    const bdId = spec.breakdown || null;

    if (!dimId) {
      if (measures.some((mid) => !!EBPO_MEASURES[mid]!.window))
        return {
          ok: false,
          refusal:
            'Windowed measures like YTD, last year, or YoY growth need a time axis (by month, quarter, or year).',
        };
      // Scorecard: each card can resolve from its own semantic provider. Requiring
      // one physical view for unrelated KPIs (for example margin + people
      // efficiency) incorrectly rejects valid executive scorecards.
      const sql =
        measures
          .map((mid) => {
            const m = EBPO_MEASURES[mid]!;
            const view = resolveEbpoView(mid, null, null, filterDims)!;
            const where = buildWhere(
              view,
              [],
              spec.filters,
              db,
              m.kind === 'stock' && view.hasTime,
            );
            const label = quoteLit(m.label);
            return `SELECT ${label} AS name, ${label} AS label, ${valueExprFor(m, view)} AS value, ${quoteLit(m.format)} AS format FROM ${db}.${view.name} WHERE ${where}`;
          })
          .join('\nUNION ALL\n') + `\nLIMIT ${topN}`;
      return {
        ok: true,
        sql,
        measure: EBPO_MEASURES[measures[0]!]!,
        view: 'multiple_verified_views',
      };
    }

    const mview = resolveEbpoViewMulti(measures, dimId, bdId, filterDims, wantTime)!;
    const mtbl = fromExpr(mview, db);
    const allStock = measures.every((m) => EBPO_MEASURES[m]!.kind === 'stock');

    const mdim = dimSql(dimId);
    const where = buildWhere(
      mview,
      [dimId, bdId].filter((id): id is string => !!id),
      spec.filters,
      db,
      allStock && mview.hasTime && !mdim.isTime,
      recentMonths,
    );
    const ct = String(spec.chartType ?? '').toLowerCase();
    if (measures.some((mid) => !!EBPO_MEASURES[mid]!.window) && !mdim.isTime)
      return {
        ok: false,
        refusal:
          'Windowed measures like YTD, last year, or YoY growth need a time axis (by month, quarter, or year).',
      };
    // Scatter/bubble are measure-vs-measure per point: emit the x/y/z(/w) column
    // convention the frontend expects (name=point label, x=1st measure, y=2nd, z=size).
    const isScatter = ct === 'scatter' || ct === 'bubble';
    if (bdId && !isScatter) {
      const bd = dimSql(bdId);
      const primary = EBPO_MEASURES[measures[0]!]!;
      const maxValues = Math.max(1, Math.floor(maxBreakdownCols / measures.length));
      const colRows = await runRows(
        `SELECT ${bd.label} AS v, ${aggExprFor(primary, mview)} AS m FROM ${mtbl} WHERE ${where} ` +
          `GROUP BY ${bd.group} HAVING m != 0 ORDER BY abs(m) DESC LIMIT ${maxValues}`,
      );
      const values = colRows
        .map((r) => String((r as any).v ?? ''))
        .filter((v) => v.length > 0);
      if (values.length === 0)
        return { ok: false, refusal: 'No data matches that breakdown.' };
      const series = values
        .flatMap((value) =>
          measures.map((mid) => {
            const measure = EBPO_MEASURES[mid]!;
            const alias = `${value} | ${measure.label}`;
            return `${condValueExprFor(measure, mview, `${bd.label} = ${quoteLit(value)}`)} AS ${quoteIdent(alias)}`;
          }),
        )
        .join(', ');
      const sql = mdim.isTime
        ? // Most-recent N periods, re-sorted ascending (see single-measure path).
          `SELECT * EXCEPT (__ord) FROM (` +
          `SELECT ${mdim.label} AS name, ${series}, ${mdim.group} AS __ord ` +
          `FROM ${mtbl} WHERE ${where} GROUP BY ${mdim.group} ` +
          `ORDER BY __ord DESC LIMIT ${topN}) ORDER BY __ord ASC`
        : `SELECT ${mdim.label} AS name, ${series} ` +
          `FROM ${mtbl} WHERE ${where} GROUP BY ${mdim.group} ` +
          `ORDER BY name ASC LIMIT ${topN}`;
      return {
        ok: true,
        sql,
        measure: primary,
        view: mview.name,
      };
    }
    const xyz = ['x', 'y', 'z', 'w'];
    const lead = quoteIdent(EBPO_MEASURES[measures[0]!]!.label);
    const series = measures
      .map((mid, i) => {
        const m = EBPO_MEASURES[mid]!;
        const alias = isScatter ? (xyz[i] ?? `m${i + 1}`) : quoteIdent(m.label);
        const expr = m.window ? windowExprFor(m, mview, dimId) : null;
        return `${expr ? expr : valueExprFor(m, mview)} AS ${alias}`;
      })
      .join(', ');
    let sql: string;
    if (mdim.isTime && !isScatter) {
      // Most-recent N periods ("last 8 months"), re-sorted ascending — same rule as the
      // single-measure time path, applied to the multi-series (combo/dual-line) shape.
      sql =
        `SELECT * EXCEPT (__ord) FROM (` +
        `SELECT ${mdim.label} AS name, ${series}, ${mdim.group} AS __ord ` +
        `FROM ${mtbl} WHERE ${where} GROUP BY ${mdim.group} ` +
        `ORDER BY __ord DESC LIMIT ${topN}) ORDER BY __ord ASC`;
    } else {
      const order = isScatter
        ? 'x DESC'
        : spec.sort === 'value_asc'
          ? `${lead} ASC`
          : spec.sort === 'name_asc'
            ? `${mdim.group} ASC`
            : `${lead} DESC`;
      sql =
        `SELECT ${mdim.label} AS name, ${series} ` +
        `FROM ${mtbl} WHERE ${where} GROUP BY ${mdim.group} ORDER BY ${order} LIMIT ${topN}`;
    }
    // Apply series-wide transforms (cumulative / difference / moving average) to a
    // multi-series chart too — e.g. "cumulative revenue AND cumulative expenses" cumsums
    // BOTH series. No-op when there are no transforms. Skip scatter (point geometry).
    if (!isScatter) {
      sql = applyTransforms(sql, normalizeTransforms(spec.transforms), false);
    }
    return {
      ok: true,
      sql,
      measure: EBPO_MEASURES[measures[0]!]!,
      view: mview.name,
      outputPercent: normalizeTransforms(spec.transforms).some(
        (t) => t.kind === 'normalize' || t.kind === 'growth_pct',
      ),
    };
  }

  // ── Single measure ─────────────────────────────────────────────────────────
  const measure = EBPO_MEASURES[measures[0]!]!;
  const bdId = spec.breakdown || null;
  const view = resolveEbpoView(measures[0]!, dimId, bdId, filterDims, wantTime)!;
  const tbl = fromExpr(view, db);
  // "Average monthly <flow>" — divide the period sum by the number of distinct months
  // (e.g. rank clients by AVERAGE monthly revenue, not the 8-month total). Only valid
  // for a flow measure on a time-bearing view; otherwise fall back to the normal expr.
  const avgMonthly =
    !!spec.avgMonthly && measure.kind === 'flow' && view.hasTime && !!view.measures[measures[0]!];
  const value = avgMonthly
    ? `round(sum(${view.measures[measures[0]!]!}) / nullIf(count(DISTINCT toStartOfMonth(period_date)), 0), ${decimalsFor(measure)})`
    : valueExprFor(measure, view);
  const isStockNonTime = (groupedByTime: boolean) =>
    measure.kind === 'stock' && view.hasTime && !groupedByTime;

  // ── Windowed measure (time-intelligence: yoy / ly / ytd) ───────────────────
  // Aggregate the base measure to the requested time grain, then apply a window:
  //   yoy = (this period − same period last year) / last year × 100
  //   ly  = same period last year (the prior-year value itself)
  //   ytd = running total from the start of the fiscal year to this period
  // Correct at any time grain (month/quarter/year), unlike avg(precomputed pct).
  if (measure.window) {
    const winExpr = windowExprFor(measure, view, dimId);
    if (!winExpr)
      return {
        ok: false,
        refusal: `${measure.label} needs a time axis (by month, quarter, or year).`,
      };
    const timeDim = dimId as string;
    const wdim = dimSql(timeDim);
    const where = buildWhere(view, [timeDim], spec.filters, db, false);
    const sql =
      `SELECT ${wdim.label} AS name, ${winExpr} AS value ` +
      `FROM ${tbl} WHERE ${where} GROUP BY ${wdim.group} ORDER BY ${wdim.group} ASC LIMIT ${topN}`;
    return { ok: true, sql, measure, view: view.name };
  }

  const havingExpr = spec.having
    ? `${aggExprFor(measure, view)} ${opSql(spec.having.op)} ${Number(spec.having.value) || 0}`
    : null;

  // KPI / single value — no grouping.
  if (!dimId) {
    const where = buildWhere(
      view,
      [],
      spec.filters,
      db,
      measure.kind === 'stock' && view.hasTime,
      recentMonths,
    );
    const sql = `SELECT ${value} AS value FROM ${tbl} WHERE ${where} LIMIT 1`;
    return { ok: true, sql, measure, view: view.name };
  }

  const dim = dimSql(dimId);
  let baseSql: string;

  if (!bdId) {
    const where = buildWhere(
      view,
      [dimId],
      spec.filters,
      db,
      isStockNonTime(dim.isTime),
      recentMonths,
    );
    const having = havingExpr ? ` HAVING ${havingExpr}` : '';
    if (dim.isTime) {
      // Time series: a capped topN means the MOST RECENT N periods ("last 8 months"),
      // never the earliest N. Take the latest N (ORDER BY period DESC), then re-sort
      // ascending for display. When topN ≥ the available periods this returns all of
      // them, unchanged.
      baseSql =
        `SELECT * EXCEPT (__ord) FROM (` +
        `SELECT ${dim.label} AS name, ${value} AS value, ${dim.group} AS __ord ` +
        `FROM ${tbl} WHERE ${where} GROUP BY ${dim.group}${having} ` +
        `ORDER BY __ord DESC LIMIT ${topN}) ORDER BY __ord ASC`;
    } else {
      const order =
        spec.sort === 'value_asc'
          ? 'value ASC'
          : spec.sort === 'name_asc'
            ? `${dim.group} ASC`
            : 'value DESC';
      baseSql =
        `SELECT ${dim.label} AS name, ${value} AS value ` +
        `FROM ${tbl} WHERE ${where} ` +
        `GROUP BY ${dim.group}${having} ORDER BY ${order} LIMIT ${topN}`;
    }
  } else {
    const bd = dimSql(bdId);
    const where = buildWhere(
      view,
      [dimId, bdId],
      spec.filters,
      db,
      isStockNonTime(dim.isTime),
      recentMonths,
    );
    // Discover the concrete breakdown values for the WIDE pivot. Rank by MAGNITUDE and
    // keep any non-zero category: `HAVING m > 0` used to silently drop every
    // negative-value category, so a "closing balance by account" heatmap showed only
    // the 2 positive accounts (AR, Cash) and hid the 7 negative ones. abs() keeps them.
    // When the PRIMARY dimension is time (a monthly trend) and topN is set, topN means
    // "top N breakdown SERIES" — e.g. "compare top 2 clients revenue over the last 6
    // months" = 2 client lines, NOT 2 months. (For a non-time primary dim, topN keeps its
    // usual meaning of limiting the primary-dim rows, so don't constrain the breakdown.)
    const breakdownLimit =
      dim.isTime && spec.topN && spec.topN > 0
        ? Math.min(spec.topN, maxBreakdownCols)
        : maxBreakdownCols;
    // Rank the breakdown series by total magnitude. "least/bottom/smallest N" (sort
    // value_asc) keeps the N LOWEST; otherwise the N HIGHEST (default). Only meaningful
    // when breakdownLimit caps the set (a top/bottom-N comparison).
    const breakdownAsc =
      breakdownLimit < maxBreakdownCols && spec.sort === 'value_asc';
    const colRows = await runRows(
      `SELECT ${bd.label} AS v, ${aggExprFor(measure, view)} AS m FROM ${tbl} WHERE ${where} ` +
        `GROUP BY ${bd.group} HAVING m != 0 ORDER BY abs(m) ${breakdownAsc ? 'ASC' : 'DESC'} LIMIT ${breakdownLimit}`,
    );
    const cols = colRows
      .map((r) => String((r as any).v ?? ''))
      .filter((v) => v.length > 0);
    if (cols.length === 0)
      return { ok: false, refusal: 'No data matches that breakdown.' };
    const series = cols
      .map(
        (v) =>
          `${condValueExprFor(measure, view, `${bd.label} = ${quoteLit(v)}`)} AS ${quoteIdent(v)}`,
      )
      .join(', ');
    if (dim.isTime) {
      // With a breakdown, topN limits the SERIES (handled via breakdownLimit above), not
      // the number of periods — so the period cap here is the relative window
      // (recentMonths) or a generous guard, never topN (capping to topN turned a 6-month
      // trend into "2 points"). Re-sorted ascending for display.
      const periodCap = recentMonths && recentMonths > 0 ? recentMonths : 500;
      baseSql =
        `SELECT * EXCEPT (__ord) FROM (` +
        `SELECT ${dim.label} AS name, ${series}, ${dim.group} AS __ord ` +
        `FROM ${tbl} WHERE ${where} GROUP BY ${dim.group} ` +
        `ORDER BY __ord DESC LIMIT ${periodCap}) ORDER BY __ord ASC`;
    } else {
      baseSql =
        `SELECT ${dim.label} AS name, ${series} ` +
        `FROM ${tbl} WHERE ${where} ` +
        `GROUP BY ${dim.group} ORDER BY name ASC LIMIT ${topN}`;
    }
  }

  const allTransforms = normalizeTransforms(spec.transforms);
  // A single-measure MONTHLY waterfall for a ratio/average metric (CSAT, SLA,
  // utilization, etc.) is only meaningful as month-over-month MOVEMENT. Plotting
  // raw 80%-level monthly values in the cumulative waterfall renderer explodes the
  // axis into thousands of percent. When no explicit transform is provided, default
  // these ratio/avg time waterfalls to period-over-period difference bars.
  const measureKind = String((measure as any)?.kind ?? '');
  if (
    spec.chartType === 'waterfall' &&
    dim.isTime &&
    !bdId &&
    allTransforms.length === 0 &&
    (measureKind === 'ratio' || measureKind === 'avg')
  ) {
    allTransforms.push({ kind: 'difference' });
  }
  // peer_average / company_share are COMPANY-WIDE calculations, not row-wise transforms:
  // both must re-aggregate the measure across ALL entities (dropping the client/vendor
  // filter), so they can't be built from the already-filtered base SQL inside
  // applyTransforms. Pull them out and join a company-wide per-period aggregate after
  // the other transforms run.
  //   • peer_average  → ADD a per-period "company_average" line (Σ measure ÷ #entities).
  //   • company_share → REPLACE the value with its % of the company total (value ÷ Σ).
  const wantsPeerAvg = allTransforms.some((t) => t.kind === 'peer_average');
  const wantsShare = allTransforms.some((t) => t.kind === 'company_share');
  // Track whether the OUTPUT ends up as a percentage. normalize/growth_pct always do;
  // company_share does too (set below once it's actually applied).
  let outputPercent = allTransforms.some(
    (t) => t.kind === 'normalize' || t.kind === 'growth_pct',
  );
  // When company_share rewrites the value to a %, a reference_line ("average
  // contribution %") must average those % values — so apply it AFTER the share
  // rewrite, not on the raw base series (which would be dropped by the rewrite).
  const deferRefLine =
    wantsShare && allTransforms.some((t) => t.kind === 'reference_line');
  let sql = applyTransforms(
    baseSql,
    allTransforms.filter(
      (t) =>
        t.kind !== 'peer_average' &&
        t.kind !== 'company_share' &&
        !(deferRefLine && t.kind === 'reference_line'),
    ),
    !bdId,
  );
  if (wantsShare && !dim.isTime && !bdId) {
    // Categorical share-of-total ("contribution % by department/client/account"):
    // replace each row's value with its share of the chart total. This is valid for
    // single-measure by-dimension charts and is the expected non-time reading of
    // "contribution percentages".
    sql =
      `WITH _main AS (\n${sql}\n)\n` +
      `SELECT name, round(value / nullIf(sum(value) OVER (), 0) * 100, 1) AS value FROM _main LIMIT 1000`;
    if (deferRefLine)
      sql = applyTransforms(sql, [{ kind: 'reference_line' }], true);
    outputPercent = true;
  } else if ((wantsPeerAvg || wantsShare) && dim.isTime && !bdId) {
    const entityFilter = (spec.filters ?? []).find(
      (f) => f.dimension === 'client' || f.dimension === 'vendor',
    );
    const rawCol = view.measures[measures[0]!];
    if (entityFilter && rawCol) {
      const entDim = dimSql(entityFilter.dimension);
      const filtersNoEntity = (spec.filters ?? []).filter(
        (f) => f.dimension !== 'client' && f.dimension !== 'vendor',
      );
      const whereCo = buildWhere(
        view,
        [dimId],
        filtersNoEntity,
        db,
        isStockNonTime(dim.isTime),
        recentMonths,
      );
      // The company-wide per-period figure(s): total (for share) and/or average (peer).
      const coCols: string[] = [];
      if (wantsShare)
        coCols.push(`round(sum(${rawCol}), 2) AS company_total`);
      if (wantsPeerAvg)
        coCols.push(
          `round(sum(${rawCol}) / nullIf(uniqExact(${entDim.group}), 0), 2) AS company_average`,
        );
      const coSql =
        `SELECT * EXCEPT (__ord) FROM (` +
        `SELECT ${dim.label} AS name, ${coCols.join(', ')}, ${dim.group} AS __ord ` +
        `FROM ${tbl} WHERE ${whereCo} GROUP BY ${dim.group} ` +
        `ORDER BY __ord DESC LIMIT ${topN}) ORDER BY __ord ASC`;
      // company_share rewrites the value to a % of the company total; otherwise keep the
      // value and append the company_average comparison line.
      const mainProj = wantsShare
        ? `_main.name AS name, round(_main.\`value\` / nullIf(_co.company_total, 0) * 100, 1) AS \`value\`` +
          (wantsPeerAvg ? `, _co.company_average` : '')
        : `_main.*, _co.company_average`;
      sql =
        `WITH _main AS (\n${sql}\n),\n_co AS (\n${coSql}\n)\n` +
        `SELECT ${mainProj} FROM _main LEFT JOIN _co USING (name) LIMIT 1000`;
      // Now layer the deferred flat average over the %-rewritten series.
      if (deferRefLine)
        sql = applyTransforms(sql, [{ kind: 'reference_line' }], true);
      if (wantsShare) outputPercent = true;
    } else if (wantsShare && rawCol) {
      return {
        ok: false,
        refusal:
          'I can only calculate share of company total when the chart is split by a client or vendor. This chart has no entity dimension to share against.',
      };
    }
  }
  return { ok: true, sql, measure, view: view.name, outputPercent };
}

// ─── Transforms (same layering approach as the GL compiler) ───────────────────
function normalizeTransforms(input: ChartSpec['transforms']): SpecTransform[] {
  const out: SpecTransform[] = [];
  for (const t of input ?? []) {
    const kind = typeof t === 'string' ? t : (t as any)?.kind;
    if (
      kind === 'normalize' ||
      kind === 'growth_pct' ||
      kind === 'difference' ||
      kind === 'cumulative' ||
      kind === 'reference_line' ||
      kind === 'peer_average' ||
      kind === 'company_share'
    )
      out.push({ kind });
    else if (kind === 'moving_average') {
      const window =
        typeof (t as any)?.window === 'number' ? (t as any).window : 3;
      out.push({ kind: 'moving_average', window });
    }
  }
  return out;
}

function applyTransforms(
  baseSql: string,
  transforms: SpecTransform[],
  singleSeries: boolean,
): string {
  let sql = baseSql;
  for (const t of transforms) {
    const numericCols = singleSeries ? ['value'] : null;
    const id = (c: string) => '`' + c.replace(/`/g, '') + '`';
    const ref = (c: string) => '_b.' + id(c);
    const wrap = (proj: string) =>
      `WITH _b AS (\n${sql}\n)\nSELECT ${proj}\nFROM _b\nLIMIT 1000`;
    const seriesCols = () =>
      numericCols ??
      Array.from(
        new Set(
          Array.from(sql.matchAll(/\bAS\s+(?:"([^"]+)"|`([^`]+)`|([a-zA-Z_]\w*))/g))
            .map((m) => m[1] ?? m[2] ?? m[3]!)
            // Exclude the label column and the internal `__ord` ordering helper, which
            // the recent-N wrap drops via `* EXCEPT (__ord)` (so _b has no __ord column).
            // Also exclude waterfall helper columns such as `is_total`; they are control
            // flags, not data series, and including them in a running sum double-counts
            // the bridge total.
            .filter(
              (a) =>
                a &&
                a.toLowerCase() !== 'name' &&
                a !== '__ord' &&
                a.toLowerCase() !== 'is_total',
            ),
        ),
      );

    if (t.kind === 'normalize') {
      const cols = seriesCols();
      if (cols.length === 1) {
        const c = cols[0]!;
        sql = wrap(
          `_b.name AS name, round(${ref(c)} / nullIf(sum(${ref(c)}) OVER (), 0) * 100, 1) AS ${id(c)}`,
        );
      } else {
        const total = cols.map(ref).join(' + ');
        sql = wrap(
          [
            '_b.name AS name',
            ...cols.map(
              (c) =>
                `round(${ref(c)} / nullIf(${total}, 0) * 100, 1) AS ${id(c)}`,
            ),
          ].join(', '),
        );
      }
    } else if (t.kind === 'growth_pct') {
      const cols = seriesCols();
      const pct = (c: string) => {
        const prev = `anyOrNull(${ref(c)}) OVER (ROWS BETWEEN 1 PRECEDING AND 1 PRECEDING)`;
        return `round((${ref(c)} - ${prev}) / nullIf(${prev}, 0) * 100, 1) AS ${id(c)}`;
      };
      sql = wrap(['_b.name AS name', ...cols.map(pct)].join(', '));
    } else if (t.kind === 'difference') {
      // Period-over-period absolute change. The FIRST row keeps its level (the opening
      // balance of the bridge); every later row becomes (value − previous). Fed to a
      // waterfall this renders the month-to-month ups/downs whose running total traces
      // the actual revenue level — i.e. "month-over-month changes", not cumulative.
      const cols = seriesCols();
      const diff = (c: string) => {
        const prev = `anyOrNull(${ref(c)}) OVER (ROWS BETWEEN 1 PRECEDING AND 1 PRECEDING)`;
        return `if(${prev} IS NULL, ${ref(c)}, ${ref(c)} - ${prev}) AS ${id(c)}`;
      };
      sql = wrap(['_b.name AS name', ...cols.map(diff)].join(', '));
    } else if (t.kind === 'cumulative') {
      // Continuous running total (NOT year-partitioned like YTD). Rows arrive in the
      // base query's order (ascending time), so the window cumulates correctly.
      const cols = seriesCols();
      const cum = (c: string) =>
        `round(sum(${ref(c)}) OVER (ROWS UNBOUNDED PRECEDING), 2) AS ${id(c)}`;
      sql = wrap(['_b.name AS name', ...cols.map(cum)].join(', '));
    } else if (t.kind === 'moving_average') {
      const n = Math.max(2, Math.min(12, t.window || 3));
      const cols = seriesCols();
      const ma = cols.map(
        (c) =>
          `round(avg(${ref(c)}) OVER (ROWS BETWEEN ${n - 1} PRECEDING AND CURRENT ROW), 2) AS ${id(c + `_MA${n}`)}`,
      );
      sql = wrap(
        [
          '_b.name AS name',
          ...cols.map((c) => `${ref(c)} AS ${id(c)}`),
          ...ma,
        ].join(', '),
      );
    } else if (t.kind === 'reference_line') {
      const cols = seriesCols();
      const rowTotal =
        cols.length >= 2 ? `(${cols.map(ref).join(' + ')})` : ref(cols[0]!);
      sql = wrap(
        [
          '_b.name AS name',
          ...cols.map((c) => `${ref(c)} AS ${id(c)}`),
          `round((SELECT avg(${rowTotal}) FROM _b), 2) AS company_average`,
        ].join(', '),
      );
    }
  }
  return sql;
}

// ─── Combo series roles ───────────────────────────────────────────────────────
// Decide, for a multi-measure combo, which measures render as clustered bars vs
// lines and on which axis. This is the deterministic source of truth the web combo
// renderer consumes (display.series) so it can draw N bars + M lines correctly.
//
// Rules (grounded in the data-2 tester feedback):
//  • The base style follows the requested chart type: a line/area base keeps every
//    same-unit measure as a LINE (Velan Q8 "add another line not bar"); a
//    bar/column/combo base keeps same-unit measures as CLUSTERED BARS
//    (Aakash Q6 "show both as bars", Pranjal Q2 debit+credit columns).
//  • A measure whose unit differs from the primary (e.g. a % paired with $) becomes
//    a LINE on the secondary (right) axis with its own format — fixing the
//    wrong-"%"-axis / "percentages too high" bugs.
//  • Explicit phrasing overrides: forceLine (e.g. "add net movement as a line")
//    makes that measure a line even when it shares the primary's unit; forceBar
//    makes it a clustered bar.
export interface EbpoSeriesRole {
  key: string; // data column name = measure label
  role: 'bar' | 'line';
  axis: 'left' | 'right';
  format: 'currency' | 'number' | 'percent';
  decimals?: number | null;
}

export function ebpoComboSeriesRoles(
  measureIds: string[],
  opts?: {
    baseType?: string | null;
    forceLine?: Iterable<string>;
    forceBar?: Iterable<string>;
  },
): EbpoSeriesRole[] {
  const defs = measureIds
    .map((id) => EBPO_MEASURES[id])
    .filter((d): d is EbpoMeasureDef => !!d);
  if (defs.length === 0) return [];
  const leftFormat = defs[0]!.format;
  const baseIsLine = /line|area/.test(String(opts?.baseType ?? '').toLowerCase());
  const forceLine = new Set(opts?.forceLine ?? []);
  const forceBar = new Set(opts?.forceBar ?? []);

  return defs.map((def) => {
    let role: 'bar' | 'line';
    if (forceLine.has(def.id)) role = 'line';
    else if (forceBar.has(def.id)) role = 'bar';
    else if (def.format !== leftFormat)
      role = 'line'; // different unit → overlay line
    else role = baseIsLine ? 'line' : 'bar'; // same unit → follow base style
    // ANY series whose unit differs from the left (primary) axis goes on the right
    // axis — not just lines. A bar in a different unit (e.g. $ revenue added to a %
    // margin chart) must get its own right axis too, otherwise it lands on the primary
    // %-axis and renders nonsense like "900000.0%". Series sharing the primary unit stay
    // on the left so magnitudes are comparable.
    const axis: 'left' | 'right' =
      def.format !== leftFormat
        ? 'right'
        : role === 'line' &&
            def.id !== defs[0]!.id &&
            def.kind !== defs[0]!.kind
          ? 'right'
          : 'left';
    return {
      key: def.label,
      role,
      axis,
      format: def.format,
      decimals: def.decimals ?? null,
    };
  });
}

// The accurate chart type for a multi-measure result, so the type LABEL matches what
// renders: all-bar + one unit → "bar" (clustered columns); all-line + one unit →
// "line" (multi-line); anything mixed (roles or units / dual-axis) → "combo".
export function ebpoComboChartType(
  series: EbpoSeriesRole[],
  opts?: { forceStacked?: 'bar' | 'area' | null; forceCombo?: boolean },
): string {
  if (opts?.forceStacked)
    return opts.forceStacked === 'area' ? 'stacked_area' : 'stacked_bar';
  if (opts?.forceCombo) return 'combo';
  if (series.length === 0) return 'combo';
  const roles = new Set(series.map((s) => s.role));
  const formats = new Set(series.map((s) => s.format));
  if (roles.size === 1 && formats.size === 1)
    return roles.has('bar') ? 'bar' : 'line';
  return 'combo';
}

export const EBPO_CATALOG = {
  MEASURES: EBPO_MEASURES,
  DIMENSIONS: EBPO_DIMENSIONS,
  VIEWS: EBPO_VIEWS,
  UNAVAILABLE: EBPO_UNAVAILABLE,
};

// Human-readable catalog for the planner prompt — generated from the catalog so
// it can never drift from what compileEbpoSpec actually supports.
export function ebpoCatalogPromptText(): string {
  const measures = Object.values(EBPO_MEASURES)
    .filter((m) => !m.internal)
    .map((m) => {
      const aliases = m.aliases?.length
        ? `; aliases: ${m.aliases.join(', ')}`
        : '';
      return `  - ${m.id} (${m.label}, ${m.format}${aliases})`;
    })
    .join('\n');
  const dims = Object.values(EBPO_DIMENSIONS)
    .map((d) => `  - ${d.id} (${d.label}${d.isTime ? ', time' : ''})`)
    .join('\n');
  const unavailable = Object.values(EBPO_UNAVAILABLE).join(', ');
  return [
    'MEASURES (pick exactly one as "measure"):',
    measures,
    'COMBO / MULTI-MEASURE: to plot several measures together — "compare X and Y", "X as columns and Y as a line", "add Z as a comparison line", clustered bars of two measures — set "measures": [id1, id2, ...] (each from the list above; the first should equal "measure") and usually chartType "combo". All chosen measures must share a grain (e.g. all monthly). Do NOT combine "measures" with "breakdown".',
    'SPLIT INTO LISTED MEASURES: when the user says "split into A, B, C" and A/B/C are measure names or aliases (for example payroll split into base salary, overtime, bonus, benefits), use "measures": [...] with a shared dimension such as month. Do not use "breakdown" unless the split is by a dimension such as department, client, country, vendor, or business unit.',
    'KPI / SCORECARD: for a scorecard or KPI-card request, use chartType "kpi", omit dimension, and put every requested metric in "measures". This produces one card row per measure from the same semantic view.',
    'COMPONENTS AS PIE/DONUT: "pie/donut of <X> components" or "pie of A, B, C" where A/B/C are MEASURES (e.g. cash flow components = operating_cf, investing_cf, financing_cf) → set measures=[the components], NO dimension and NO time axis (a pie shows a composition at a point, never a monthly series). IMPORTANT: a pie/donut can only show non-negative parts of a whole — if any component can be negative (investing_cf and financing_cf are typically negative), use chartType "bar" instead so the signs are visible. Revenue-vs-cost as a "pie" is likewise better as a bar (two separate totals, not parts of one whole).',
    'SCATTER / BUBBLE: for "X versus Y by <entity>" set dimension=<entity> and measures=[xId, yId] with chartType "scatter". For "size each bubble by W" add the size measure: measures=[xId, yId, sizeId] with chartType "bubble". All measures must come from one view that also has the entity dimension.',
    'DIMENSIONS (pick one as "dimension"; optionally one as "breakdown" for a single-measure series split; omit "dimension" for a single KPI value):',
    dims,
    'NOTE: REVENUE / COST / GROSS MARGIN have NO GEOGRAPHY relationship in this dataset — the revenue fact is booked only by client, business unit, and contract type (and month). There is NO "revenue by country / region / city / delivery center" — do NOT invent one; emit your best spec and the deterministic compiler will honestly refuse it. OPERATIONS metrics (SLA/CSAT/utilization, calls, tickets, AHT) are available by delivery center / geography, and SLA/CSAT/utilization are also available by department through a weighted delivery-center headcount bridge. In general, do NOT pre-refuse a measure-by-dimension request — emit your best spec (the right measure id + dimension id) and let the deterministic compiler decide: it returns an honest refusal ONLY when that exact combination genuinely has no data, and never fabricates. Refuse up-front ONLY when the MEASURE itself is absent from the measures list above (or is in the NOT AVAILABLE list below).',
    'PROFIT MEASURES: "operating profit", "operating income", "net profit", "net income", "EBITDA" → use measure "ebitda" (= revenue − cost − payroll, an absolute $; in this dataset it is negative because payroll is large). "operating profit margin", "net profit margin", "net margin", "EBITDA margin" (a %) → use "ebitda_style_margin_pct". The full rev−cost−payroll figure only resolves where revenue, cost, and payroll coexist in the same verified grain: company/month. Payroll is NOT booked by business unit, client, contract type, industry, or revenue geography, so EBITDA by those dimensions must refuse honestly instead of substituting gross margin.',
    'EXPENSE vs COST: "expense", "expenses", "operating expense", "overhead", "total expenses" → use measure "total_expenses" (= Total Cost + Total Payroll), available company-wide and by month. IMPORTANT: the dataset still has trial-balance account data, so account/account-category/account-type expense asks are data-backed through the account views when they stay at the company/account grain. "SG&A" maps to that same real expense-account grain (the trial-balance expense accounts), not to a separate named measure. But there is NO client×account bridge, and no revenue-fact-by-department grain — refuse those impossible cross-grain joins honestly. "total_cost" is specifically COST OF REVENUE, only for revenue-vs-cost / gross-margin asks — do NOT use it for a generic "expense" request unless the user explicitly compares revenue vs expenses by a revenue-grained entity (client / business unit / contract type), where cost of revenue is the only attributable expense data.',
    'CLIENTS: "number of clients / how many clients / client count" → measure "no_clients" (a DISTINCTCOUNT). "average/avg revenue per client" → measure "avg_revenue_per_client". "client RANK / rank clients / top N clients" is NOT a measure — plot the underlying measure (usually total_revenue) by dimension "client" with sort:"value_desc" (or "value_asc" for the bottom) and topN. "revenue contribution % / share of total company revenue / revenue concentration" is the company_share TRANSFORM on total_revenue by client, not a separate measure.',
    'FIXED ASSETS ARE POINT-IN-TIME: the fixed-asset measures (asset_cost, net_book_value, accumulated_depreciation, depreciation_pct, asset_count) have NO monthly/time series — there is no month/quarter/year dimension for them. Never give an asset measure a time dimension. A request about "changes in assets", "asset movement", or an asset waterfall/bar/breakdown means the COMPOSITION across a category: set dimension to asset_type (default), delivery_center, country, or region — e.g. "waterfall showing changes in assets" → {measure:"asset_cost", dimension:"asset_type", chartType:"waterfall"}.',
    `NOT AVAILABLE (if the request needs any of these, return a refusal): ${unavailable}.`,
    'THRESHOLD (optional): keep only rows whose measure passes a number ("clients above $1M", "departments under $100k") → having:{op:"gt"|"lt"|"gte"|"lte", value:<number>}.',
    'TRANSFORMS (optional): normalize, growth_pct, moving_average(window), reference_line, peer_average (company-wide average comparison for an entity-filtered series), company_share (entity value as % of the company-wide total that period — "revenue concentration / share of total company revenue").',
    'CHART TYPES: bar, horizontal_bar, line, area, pie, donut, scatter, treemap, heatmap, matrix, stacked_bar, stacked_area, combo, waterfall, pareto, kpi. Use "pareto" for a single measure RANKED descending with a cumulative-percentage line ("Pareto chart", "ranked … with cumulative %") — one measure + one categorical dimension, no breakdown.',
  ].join('\n');
}
