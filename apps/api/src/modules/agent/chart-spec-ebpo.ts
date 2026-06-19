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
export type EbpoAgg = 'sum' | 'avg' | 'max';
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
  // DAX DIVIDE(SUM(num), SUM(den)). num/den are other measure ids that ARE columns in
  // the same view; when set, the compiler computes the ratio instead of one column.
  derived?: { num: string; den: string; scale?: number };
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
}

export interface EbpoCompileResult {
  ok: true;
  sql: string;
  measure: EbpoMeasureDef;
  view: string;
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
  gross_margin_pct: M(
    'gross_margin_pct',
    'Gross Margin %',
    'percent',
    'avg',
    'ratio',
    1,
    ['gross margin percentage', 'gross margin percent', 'gross margin pct'],
  ),
  revenue_yoy_pct: M(
    'revenue_yoy_pct',
    'Revenue YoY Growth %',
    'percent',
    'avg',
    'ratio',
    1,
    [
      'year over year revenue growth',
      'year-over-year revenue growth',
      'revenue year over year growth',
      'revenue growth year over year',
      'yoy revenue growth',
    ],
  ),
  // Derived CFO ratios — precomputed in the canonical SUPERSET view
  // v_ebpo_cfo_ratios_monthly. Catalogued so create AND combo follow-ups
  // ("add X as a comparison line") are deterministic via multi-measure specs.
  // Current/quick ratio remain refused (no full current-liabilities data) — never faked.
  cost_to_income_pct: M(
    'cost_to_income_pct',
    'Cost-to-Income %',
    'percent',
    'avg',
    'ratio',
    1,
    ['cost to income ratio'],
  ),
  fcf_margin_pct: M(
    'fcf_margin_pct',
    'Free Cash Flow Margin %',
    'percent',
    'avg',
    'ratio',
    1,
    ['fcf margin', 'free cash flow margin', 'free cash flow margin percentage'],
  ),
  operating_cf_to_revenue_pct: M(
    'operating_cf_to_revenue_pct',
    'Operating Cash Flow % of Revenue',
    'percent',
    'avg',
    'ratio',
    1,
    [
      'operating cash flow percentage of revenue',
      'ocf to revenue',
      'cash conversion',
      'cash conversion ratio',
      'operating cash flow divided by revenue',
      'operating cash flow / revenue',
    ],
  ),
  ebitda_style_margin_pct: M(
    'ebitda_style_margin_pct',
    'EBITDA-style Margin %',
    'percent',
    'avg',
    'ratio',
    1,
    ['ebitda margin', 'ebitda style margin', 'revenue minus cost minus payroll'],
  ),
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
  payroll_to_revenue_pct: M(
    'payroll_to_revenue_pct',
    'Payroll / Revenue %',
    'percent',
    'avg',
    'ratio',
    1,
    [
      'payroll to revenue percentage',
      'payroll over revenue percentage',
      'payroll revenue ratio',
      'payroll ratio',
    ],
  ),
  benefits_to_base_pct: {
    id: 'benefits_to_base_pct',
    label: 'Benefits % of Base Salary',
    format: 'percent',
    agg: 'avg',
    kind: 'ratio',
    decimals: 1,
    derived: { num: 'total_benefits', den: 'total_base_salary', scale: 100 },
  },
  avg_monthly_salary: M(
    'avg_monthly_salary',
    'Avg Monthly Salary',
    'currency',
    'avg',
    'ratio',
  ),
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
  ar_outstanding: M(
    'ar_outstanding',
    'AR Outstanding',
    'currency',
    'sum',
    'stock',
    undefined,
    [
      'ar',
      'a/r',
      'outstanding receivables',
      'receivables',
      'accounts receivable outstanding',
    ],
  ),
  ap_outstanding: M(
    'ap_outstanding',
    'AP Outstanding',
    'currency',
    'sum',
    'stock',
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
  collection_rate_pct: M(
    'collection_rate_pct',
    'Collection Rate %',
    'percent',
    'avg',
    'ratio',
    1,
    ['collection rate percentage'],
  ),
  dso_days: M('dso_days', 'DSO (days)', 'number', 'avg', 'ratio', 1, [
    'days sales outstanding',
  ]),
  dpo_days: M('dpo_days', 'DPO (days)', 'number', 'avg', 'ratio', 1, [
    'days payable outstanding',
  ]),
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
    aliases: ['payment rate percentage', 'paid rate'],
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
  ),
  avg_aht_minutes: M(
    'avg_aht_minutes',
    'Avg Handling Time (min)',
    'number',
    'avg',
    'ratio',
    1,
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
  revenue_per_employee: M(
    'revenue_per_employee',
    'Revenue per Employee',
    'currency',
    'avg',
    'ratio',
    undefined,
    ['revenue per fte'],
  ),
  cost_per_employee: {
    id: 'cost_per_employee',
    label: 'Cost per Employee',
    aliases: ['cost per fte', 'payroll cost per employee', 'cost per employee by country'],
    format: 'currency',
    agg: 'avg',
    kind: 'ratio',
    derived: { num: 'total_payroll', den: 'employee_count', scale: 1 },
  },
  // Fixed assets (stocks)
  asset_cost: M('asset_cost', 'Asset Cost', 'currency', 'sum', 'flow'),
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
  // GL / trial balance
  total_debit: M('total_debit', 'Total Debit', 'currency', 'sum', 'flow'),
  total_credit: M('total_credit', 'Total Credit', 'currency', 'sum', 'flow'),
  net_movement: M('net_movement', 'Net Movement', 'currency', 'sum', 'flow'),
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
  allocated_revenue: M(
    'allocated_revenue',
    'Revenue (allocated)',
    'currency',
    'sum',
    'flow',
    undefined,
    ['revenue per delivery center', 'delivery center revenue', 'revenue by delivery center'],
  ),
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
      gross_margin_pct: 'gross_margin_pct',
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
      gross_margin_pct: 'gross_margin_pct',
      total_payroll: 'total_payroll_usd',
      payroll_to_revenue_pct: 'payroll_to_revenue_pct',
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
      collection_rate_pct: 'collection_rate_pct',
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
      payment_rate_pct: 'payment_rate_pct',
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
      gross_margin_pct: 'gross_margin_pct',
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
      gross_margin_pct: 'gross_margin_pct',
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
      gross_margin_pct: 'gross_margin_pct',
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
      gross_margin_pct: 'gross_margin_pct',
      collection_rate_pct: 'collection_rate_pct',
      ar_outstanding: 'outstanding_balance_usd',
      invoice_amount: 'invoice_amount_usd',
      collected_amount: 'collected_amount_usd',
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
      gross_margin_pct: 'gross_margin_pct',
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
      gross_margin_pct: 'gross_margin_pct',
    },
  },
  {
    name: 'v_ebpo_department_efficiency_monthly',
    hasTime: true,
    dims: ['department'],
    measures: {
      employee_count: 'employee_count',
      total_payroll: 'total_payroll_usd',
      total_revenue: 'total_revenue_usd',
      total_cost: 'total_cost_usd',
      gross_margin: 'gross_margin_usd',
      revenue_per_employee: 'revenue_per_employee_usd',
      cost_per_employee: 'cost_per_employee_usd',
    },
  },
  {
    name: 'v_ebpo_delivery_center_efficiency_monthly',
    hasTime: true,
    dims: ['delivery_center', 'region', 'country'],
    measures: {
      calls_handled: 'calls_handled',
      utilization_pct: 'utilization_pct',
      employee_count: 'employee_count',
      revenue_per_employee: 'revenue_per_employee_usd',
      allocated_revenue: 'allocated_revenue_usd',
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
    dims: ['delivery_center', 'asset_type'],
    measures: {
      asset_cost: 'asset_cost_usd',
      accumulated_depreciation: 'accumulated_depreciation_usd',
      net_book_value: 'net_book_value_usd',
      asset_count: 'asset_count',
    },
  },
  {
    name: 'v_ebpo_gl_monthly',
    hasTime: true,
    dims: ['account', 'department', 'business_unit', 'country'],
    measures: {
      total_debit: 'total_debit_usd',
      total_credit: 'total_credit_usd',
      net_movement: 'net_movement_usd',
    },
  },
  {
    name: 'v_ebpo_trial_balance_monthly',
    hasTime: true,
    dims: ['account'],
    measures: {
      net_movement: 'net_movement_usd',
      closing_balance: 'closing_balance_usd',
      opening_balance: 'opening_balance_usd',
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
      cost_to_income_pct: 'cost_to_income_pct',
      fcf_margin_pct: 'fcf_margin_pct',
      operating_cf_to_revenue_pct: 'operating_cf_to_revenue_pct',
      ebitda_style_margin_pct: 'ebitda_style_margin_pct',
      working_capital: 'working_capital_usd',
      // base measures (also here, for combos that pair a ratio with these)
      total_revenue: 'total_revenue_usd',
      total_cost: 'total_cost_usd',
      gross_margin: 'gross_margin_usd',
      gross_margin_pct: 'gross_margin_pct',
      total_payroll: 'total_payroll_usd',
      payroll_to_revenue_pct: 'payroll_to_revenue_pct',
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

const aggOf = (m: EbpoMeasureDef, col: string) => `${m.agg}(${col})`;
const aggIfOf = (m: EbpoMeasureDef, col: string, cond: string) =>
  `${m.agg}If(${col}, ${cond})`;
// A view "exposes" a measure when it has the measure's column, OR (derived) both the
// numerator and denominator columns.
const viewExposesMeasure = (view: EbpoViewDef, mid: string): boolean => {
  const m = EBPO_MEASURES[mid];
  if (!m) return false;
  if (m.derived)
    return m.derived.num in view.measures && m.derived.den in view.measures;
  return mid in view.measures;
};
// View-aware aggregate: derived measures compute num/den (ratio-of-sums) from the
// view's columns; everything else uses the measure's own column + agg.
const aggExprFor = (m: EbpoMeasureDef, view: EbpoViewDef): string => {
  if (m.derived) {
    const n = view.measures[m.derived.num]!;
    const d = view.measures[m.derived.den]!;
    return `sum(${n}) / nullIf(sum(${d}), 0) * ${m.derived.scale ?? 100}`;
  }
  return aggOf(m, view.measures[m.id]!);
};
const condAggExprFor = (
  m: EbpoMeasureDef,
  view: EbpoViewDef,
  cond: string,
): string => {
  if (m.derived) {
    const n = view.measures[m.derived.num]!;
    const d = view.measures[m.derived.den]!;
    return `sumIf(${n}, ${cond}) / nullIf(sumIf(${d}, ${cond}), 0) * ${m.derived.scale ?? 100}`;
  }
  return aggIfOf(m, view.measures[m.id]!, cond);
};
const valueExprFor = (m: EbpoMeasureDef, view: EbpoViewDef) =>
  `round(${aggExprFor(m, view)}, ${decimalsFor(m)})`;
const condValueExprFor = (m: EbpoMeasureDef, view: EbpoViewDef, cond: string) =>
  `round(${condAggExprFor(m, view, cond)}, ${decimalsFor(m)})`;

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

export const resolveEbpoView = (
  measureId: string,
  dimId: string | null | undefined,
  breakdownId: string | null | undefined,
): EbpoViewDef | null => {
  const candidates = EBPO_VIEWS.filter(
    (v) => viewExposesMeasure(v, measureId) && viewSupportsDim(v, dimId) && (!breakdownId || viewSupportsDim(v, breakdownId)),
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
): EbpoViewDef | null => {
  const candidates = EBPO_VIEWS.filter(
    (v) => measureIds.every((m) => viewExposesMeasure(v, m)) && viewSupportsDim(v, dimId) && (!breakdownId || viewSupportsDim(v, breakdownId)),
  );
  if (candidates.length === 0) return null;
  return candidates.sort(
    (a, b) => scoreEbpoView(a, measureIds, dimId, breakdownId) - scoreEbpoView(b, measureIds, dimId, breakdownId),
  )[0] ?? null;
};

// Distinct, order-preserving measure list (>1 ⇒ multi-measure combo).
const measureListOf = (spec: ChartSpec): string[] => {
  const raw = (spec.measures ?? []).filter((m): m is string => !!m);
  const list = raw.length ? raw : spec.measure ? [spec.measure] : [];
  return Array.from(new Set(list));
};

// ─── Validation ───────────────────────────────────────────────────────────────
export function validateEbpoSpec(spec: ChartSpec): CompileRefusal | null {
  const tail =
    ' This dataset covers Enterprise BPO financials (revenue, payroll, cash flow, AR/AP, operations) — I left the chart unchanged.';
  const measures = measureListOf(spec);
  const dimId = spec.dimension || null;

  // Every named measure must be real and available.
  for (const mid of measures) {
    if (EBPO_UNAVAILABLE[mid])
      return {
        ok: false,
        refusal: `I can't use ${EBPO_UNAVAILABLE[mid]} — it isn't in this dataset.${tail}`,
      };
    if (!EBPO_MEASURES[mid])
      return {
        ok: false,
        refusal: `I don't have a "${mid}" measure to plot.${tail}`,
      };
  }
  if (measures.length === 0)
    return { ok: false, refusal: `I need a measure to plot.${tail}` };
  if (
    EBPO_UNAVAILABLE[spec.dimension] ||
    (spec.breakdown && EBPO_UNAVAILABLE[spec.breakdown])
  )
    return {
      ok: false,
      refusal: `That breakdown isn't in this dataset.${tail}`,
    };
  if (dimId && !EBPO_DIMENSIONS[dimId])
    return {
      ok: false,
      refusal: `I can't break data down by "${spec.dimension}".${tail}`,
    };

  // Multi-measure (combo): one view must expose all measures + the dimension.
  if (measures.length > 1) {
    if (!resolveEbpoViewMulti(measures, dimId, spec.breakdown)) {
      const labels = measures.map((m) => EBPO_MEASURES[m]!.label).join(', ');
      const by = dimId ? ` by ${EBPO_DIMENSIONS[dimId]!.label}` : '';
      return {
        ok: false,
        refusal: `I can't plot ${labels} together${by} — no single EBPO view exposes them at the same grain.${tail}`,
      };
    }
    return null;
  }

  // Single measure.
  if (spec.breakdown && !EBPO_DIMENSIONS[spec.breakdown])
    return {
      ok: false,
      refusal: `I can't break data down by "${spec.breakdown}".${tail}`,
    };
  const view = resolveEbpoView(measures[0]!, dimId, spec.breakdown);
  if (!view) {
    const m = EBPO_MEASURES[measures[0]!]!;
    const by = [dimId, spec.breakdown].filter(Boolean).join(' and ');
    return {
      ok: false,
      refusal: `I can't break "${m.label}" down by ${by} — no EBPO view exposes that combination.${tail}`,
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
): string => {
  const parts = [SCOPE_WHERE];
  // Categorical dims used in this chart should exclude empty labels.
  for (const id of dimIds) {
    const dim = EBPO_DIMENSIONS[id];
    if (dim && !dim.isTime && dim.column) parts.push(`${dim.column} != ''`);
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
    if (!dim || !dim.column || dim.isTime || f.values.length === 0) continue;
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

// ─── Compile ──────────────────────────────────────────────────────────────────
export async function compileEbpoSpec(
  spec: ChartSpec,
  db: string,
  runRows: (sql: string) => Promise<Array<Record<string, unknown>>>,
  maxBreakdownCols = 40,
): Promise<EbpoCompileResult | CompileRefusal> {
  const refusal = validateEbpoSpec(spec);
  if (refusal) return refusal;

  const measures = measureListOf(spec);
  const dimId = spec.dimension || null;
  const topN = spec.topN && spec.topN > 0 ? Math.floor(spec.topN) : 50;

  // ── Multi-measure (combo / dual-axis / multi-KPI) ──────────────────────────
  // Plot every measure against the dimension as separate series. When a breakdown
  // is also requested, pivot breakdown x measure into explicit WIDE series instead
  // of silently dropping the breakdown (e.g. account | opening/closing balance).
  if (measures.length > 1) {
    const bdId = spec.breakdown || null;
    const mview = resolveEbpoViewMulti(measures, dimId, bdId)!;
    const mtbl = `${db}.${mview.name}`;
    const allStock = measures.every((m) => EBPO_MEASURES[m]!.kind === 'stock');

    if (!dimId) {
      // Scorecard: one (name, value) row per measure.
      const where = buildWhere(
        mview,
        [],
        spec.filters,
        db,
        allStock && mview.hasTime,
      );
      const sql =
        measures
          .map((mid) => {
            const m = EBPO_MEASURES[mid]!;
            return `SELECT ${quoteLit(m.label)} AS name, ${valueExprFor(m, mview)} AS value FROM ${mtbl} WHERE ${where}`;
          })
          .join('\nUNION ALL\n') + `\nLIMIT ${topN}`;
      return {
        ok: true,
        sql,
        measure: EBPO_MEASURES[measures[0]!]!,
        view: mview.name,
      };
    }

    const mdim = dimSql(dimId);
    const where = buildWhere(
      mview,
      [dimId, bdId].filter((id): id is string => !!id),
      spec.filters,
      db,
      allStock && mview.hasTime && !mdim.isTime,
    );
    const ct = String(spec.chartType ?? '').toLowerCase();
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
      const sql =
        `SELECT ${mdim.label} AS name, ${series} ` +
        `FROM ${mtbl} WHERE ${where} GROUP BY ${mdim.group} ` +
        `ORDER BY ${mdim.isTime ? `${mdim.group} ASC` : 'name ASC'} LIMIT ${topN}`;
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
        return `${valueExprFor(m, mview)} AS ${alias}`;
      })
      .join(', ');
    const order = isScatter
      ? 'x DESC'
      : mdim.isTime
        ? `${mdim.group} ASC`
        : spec.sort === 'value_asc'
          ? `${lead} ASC`
          : spec.sort === 'name_asc'
            ? `${mdim.group} ASC`
            : `${lead} DESC`;
    const sql =
      `SELECT ${mdim.label} AS name, ${series} ` +
      `FROM ${mtbl} WHERE ${where} GROUP BY ${mdim.group} ORDER BY ${order} LIMIT ${topN}`;
    return {
      ok: true,
      sql,
      measure: EBPO_MEASURES[measures[0]!]!,
      view: mview.name,
    };
  }

  // ── Single measure ─────────────────────────────────────────────────────────
  const measure = EBPO_MEASURES[measures[0]!]!;
  const bdId = spec.breakdown || null;
  const view = resolveEbpoView(measures[0]!, dimId, bdId)!;
  const tbl = `${db}.${view.name}`;
  const value = valueExprFor(measure, view);
  const isStockNonTime = (groupedByTime: boolean) =>
    measure.kind === 'stock' && view.hasTime && !groupedByTime;

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
    );
    const having = havingExpr ? ` HAVING ${havingExpr}` : '';
    const order = dim.isTime
      ? `${dim.group} ASC`
      : spec.sort === 'value_asc'
        ? 'value ASC'
        : spec.sort === 'name_asc'
          ? `${dim.group} ASC`
          : 'value DESC';
    baseSql =
      `SELECT ${dim.label} AS name, ${value} AS value ` +
      `FROM ${tbl} WHERE ${where} ` +
      `GROUP BY ${dim.group}${having} ORDER BY ${order} LIMIT ${topN}`;
  } else {
    const bd = dimSql(bdId);
    const where = buildWhere(
      view,
      [dimId, bdId],
      spec.filters,
      db,
      isStockNonTime(dim.isTime),
    );
    // Discover the concrete breakdown values for the WIDE pivot. Rank by MAGNITUDE and
    // keep any non-zero category: `HAVING m > 0` used to silently drop every
    // negative-value category, so a "closing balance by account" heatmap showed only
    // the 2 positive accounts (AR, Cash) and hid the 7 negative ones. abs() keeps them.
    const colRows = await runRows(
      `SELECT ${bd.label} AS v, ${aggExprFor(measure, view)} AS m FROM ${tbl} WHERE ${where} ` +
        `GROUP BY ${bd.group} HAVING m != 0 ORDER BY abs(m) DESC LIMIT ${maxBreakdownCols}`,
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
    baseSql =
      `SELECT ${dim.label} AS name, ${series} ` +
      `FROM ${tbl} WHERE ${where} ` +
      `GROUP BY ${dim.group} ORDER BY ${dim.isTime ? `${dim.group} ASC` : 'name ASC'} LIMIT ${topN}`;
  }

  const sql = applyTransforms(
    baseSql,
    normalizeTransforms(spec.transforms),
    !bdId,
  );
  return { ok: true, sql, measure, view: view.name };
}

// ─── Transforms (same layering approach as the GL compiler) ───────────────────
function normalizeTransforms(input: ChartSpec['transforms']): SpecTransform[] {
  const out: SpecTransform[] = [];
  for (const t of input ?? []) {
    const kind = typeof t === 'string' ? t : (t as any)?.kind;
    if (
      kind === 'normalize' ||
      kind === 'growth_pct' ||
      kind === 'reference_line'
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
      Array.from(sql.matchAll(/\bAS\s+(?:"([^"]+)"|`([^`]+)`|([a-zA-Z_]\w*))/g))
        .map((m) => m[1] ?? m[2] ?? m[3]!)
        .filter((a) => a && a.toLowerCase() !== 'name');

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
    // A line whose unit differs from the left (primary) axis goes on the right axis;
    // everything sharing the primary unit stays on the left so magnitudes are comparable.
    const axis: 'left' | 'right' =
      role === 'line' && def.format !== leftFormat ? 'right' : 'left';
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
    'SCATTER / BUBBLE: for "X versus Y by <entity>" set dimension=<entity> and measures=[xId, yId] with chartType "scatter". For "size each bubble by W" add the size measure: measures=[xId, yId, sizeId] with chartType "bubble". All measures must come from one view that also has the entity dimension.',
    'DIMENSIONS (pick one as "dimension"; optionally one as "breakdown" for a single-measure series split; omit "dimension" for a single KPI value):',
    dims,
    'NOTE: not every measure is available by every dimension; if a measure (or a measures[] set) cannot be grouped by the chosen dimension the request is refused (no fabricated data).',
    `NOT AVAILABLE (if the request needs any of these, return a refusal): ${unavailable}.`,
    'THRESHOLD (optional): keep only rows whose measure passes a number ("clients above $1M", "departments under $100k") → having:{op:"gt"|"lt"|"gte"|"lte", value:<number>}.',
    'TRANSFORMS (optional): normalize, growth_pct, moving_average(window), reference_line.',
    'CHART TYPES: bar, horizontal_bar, line, area, pie, donut, scatter, treemap, heatmap, matrix, stacked_bar, stacked_area, combo, waterfall, pareto, kpi. Use "pareto" for a single measure RANKED descending with a cumulative-percentage line ("Pareto chart", "ranked … with cumulative %") — one measure + one categorical dimension, no breakdown.',
  ].join('\n');
}
