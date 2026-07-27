/**
 * Semantic cubes for the star-finance demo dataset.
 *
 * These views contain no tenant- or organization-specific values. They only
 * expose the already-ingested star schema at useful analytic grains so the
 * generic chart engine can discover measures/dimensions deterministically.
 */

export const SFIN_SEMANTIC_CUBE_VIEWS = [
  'v_sfin_gl_semantic',
  'v_sfin_payroll_semantic',
  'v_sfin_operations_semantic',
  'v_sfin_attendance_semantic',
  'v_sfin_ar_semantic',
  'v_sfin_ap_semantic',
  'v_sfin_cashflow_semantic',
  'v_sfin_trial_balance_semantic',
  'v_sfin_employee_semantic',
  'v_sfin_client_service_performance_semantic',
  'v_sfin_department_workforce_semantic',
  'v_sfin_delivery_scorecard_semantic',
  'v_sfin_service_line_scorecard_semantic',
  'v_sfin_contract_performance_semantic',
  'v_sfin_balance_ratio_semantic',
  'v_sfin_cost_family_semantic',
  'v_sfin_payment_speed_semantic',
  'v_sfin_monthly_finance_semantic',
  'v_sfin_ledger_reconciliation_semantic',
  'v_sfin_monthly_ap_semantic',
  'v_sfin_working_capital_semantic',
  'v_sfin_payroll_reconciliation_semantic',
  'v_sfin_cash_reconciliation_semantic',
  'v_sfin_executive_performance_semantic',
] as const;

function safeDatabase(database: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(database)) {
    throw new Error(
      `Unsafe ClickHouse database identifier: ${JSON.stringify(database)}`,
    );
  }
  return database;
}

export interface SfinDiscoveredValues {
  cashFlowCategories?: string[];
  accountSubTypes?: string[];
  glCostCategories?: string[];
}

function safeLiteral(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

function discoveredFields(
  values: string[] | undefined,
): Array<{ value: string; key: string }> {
  const used = new Map<string, number>();
  return [
    ...new Set((values ?? []).map((value) => value.trim()).filter(Boolean)),
  ]
    .sort((a, b) => a.localeCompare(b))
    .map((value) => {
      let base = value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
      if (!base) base = 'category';
      if (/^[0-9]/.test(base)) base = `category_${base}`;
      const count = used.get(base) ?? 0;
      used.set(base, count + 1);
      return { value, key: count ? `${base}_${count + 1}` : base };
    });
}

export function buildSfinSemanticCubeDdls(
  database: string,
  discovered: SfinDiscoveredValues = {},
): string[] {
  const db = safeDatabase(database);
  const cashFlowFields = discoveredFields(discovered.cashFlowCategories);
  const accountSubtypeFields = discoveredFields(discovered.accountSubTypes);
  const glCostFields = discoveredFields(discovered.glCostCategories);
  const cashFlowSelect = cashFlowFields
    .map(
      ({ value, key }) =>
        `,\n        ifNull(any(c.cash_outflow_${key}_usd), 0) AS cash_outflow_${key}_usd`,
    )
    .join('');
  const cashFlowAggregate = cashFlowFields
    .map(
      ({ value, key }) =>
        `,\n          sumIf(cash_outflow_usd, cash_flow_category = ${safeLiteral(value)}) AS cash_outflow_${key}_usd`,
    )
    .join('');
  const accountSubtypeSelect = accountSubtypeFields
    .map(({ key }) => `,\n        t.${key}_balance_usd AS ${key}_balance_usd`)
    .join('');
  const accountSubtypeAggregate = accountSubtypeFields
    .map(
      ({ value, key }) =>
        `,\n          abs(sumIf(closing_balance_usd, account_sub_type = ${safeLiteral(value)})) AS ${key}_balance_usd`,
    )
    .join('');
  const glCostSelect = glCostFields
    .map(
      ({ key }) =>
        `,\n        ifNull(any(g.general_ledger_${key}_cost_usd), 0) AS general_ledger_${key}_cost_usd`,
    )
    .join('');
  const glCostAggregate = glCostFields
    .map(
      ({ value, key }) =>
        `,\n          sumIf(abs(pl_amount_usd), cost_category = ${safeLiteral(value)}) AS general_ledger_${key}_cost_usd`,
    )
    .join('');

  return [
    `CREATE OR REPLACE VIEW ${db}.v_sfin_gl_semantic AS
      SELECT
        f.tenant_id AS tenant_id,
        f.org_id AS org_id,
        f.org_name AS org_name,
        f.posting_date AS period_date,
        f.journal_type AS journal_type,
        f.source_system AS source_system,
        f.source_fact AS source_fact,
        f.account_name AS account_name,
        f.account_type AS account_type,
        f.account_group AS account_group,
        f.cost_category AS cost_category,
        f.revenue_category AS revenue_category,
        coalesce(c.client_name, '') AS client_name,
        coalesce(c.industry, '') AS industry,
        coalesce(v.vendor_name, '') AS vendor_name,
        coalesce(e.employee_id, '') AS employee_id,
        coalesce(e.grade, '') AS employee_grade,
        coalesce(g.region, '') AS region,
        coalesce(g.country, '') AS country,
        coalesce(g.city, '') AS city,
        coalesce(g.delivery_center, '') AS delivery_center,
        coalesce(d.department_name, '') AS department,
        if(empty(coalesce(b.business_unit_name, '')), 'Unallocated', b.business_unit_name) AS business_unit,
        f.contract_type AS contract_type,
        f.cash_flow_category AS cash_flow_category,
        f.journal_line_id,
        f.billable_hours,
        f.billing_rate_usd,
        f.driver_amount_usd,
        f.debit_usd,
        f.credit_usd,
        greatest(f.debit_usd, f.credit_usd) AS journal_value_usd,
        f.signed_amount_usd,
        f.pl_amount_usd,
        if(f.account_type = 'Revenue', abs(f.pl_amount_usd), 0) AS total_revenue_usd,
        if(f.account_type = 'Direct Cost (COS)', abs(f.pl_amount_usd), 0) AS total_cogs_usd,
        if(f.account_type = 'SG&A', abs(f.pl_amount_usd), 0) AS total_sga_usd,
        if(f.account_type = 'Finance Cost', abs(f.pl_amount_usd), 0) AS finance_cost_usd,
        if(f.account_type = 'Tax', abs(f.pl_amount_usd), 0) AS tax_expense_usd,
        if(f.cost_category = 'DepreciationAndAmortization', abs(f.pl_amount_usd), 0) AS depreciation_and_amortization_usd,
        if(f.account_type = 'Revenue', abs(f.pl_amount_usd), 0)
          - if(f.account_type = 'Direct Cost (COS)', abs(f.pl_amount_usd), 0) AS gross_profit_usd,
        if(f.account_type IN ('Direct Cost (COS)', 'SG&A'), abs(f.pl_amount_usd), 0) AS total_operating_cost_usd,
        if(f.account_type = 'Revenue', abs(f.pl_amount_usd), 0)
          - if(f.account_type IN ('Direct Cost (COS)', 'SG&A'), abs(f.pl_amount_usd), 0) AS operating_profit_usd,
        if(f.account_type = 'Revenue', abs(f.pl_amount_usd), 0)
          - if(f.account_type IN ('Direct Cost (COS)', 'SG&A', 'Finance Cost'), abs(f.pl_amount_usd), 0) AS profit_before_tax_usd,
        if(f.account_type = 'Revenue', abs(f.pl_amount_usd), 0)
          - if(f.account_type IN ('Direct Cost (COS)', 'SG&A', 'Finance Cost', 'Tax'), abs(f.pl_amount_usd), 0) AS net_profit_usd,
        if(f.account_type = 'Revenue', abs(f.pl_amount_usd), 0)
          - if(f.account_type IN ('Direct Cost (COS)', 'SG&A'), abs(f.pl_amount_usd), 0)
          + if(f.cost_category = 'DepreciationAndAmortization', abs(f.pl_amount_usd), 0) AS ebitda_usd,
        0.0 AS gross_margin_pct,
        0.0 AS operating_margin_pct,
        0.0 AS net_margin_pct,
        0.0 AS ebitda_margin_pct,
        ifNull(100 * (gy.total_revenue_usd - py.total_revenue_usd) / nullIf(abs(py.total_revenue_usd), 0), 0) AS revenue_growth_pct,
        ifNull(100 * (gy.gross_profit_usd - py.gross_profit_usd) / nullIf(abs(py.gross_profit_usd), 0), 0) AS gross_profit_growth_pct,
        ifNull(100 * (gy.ebitda_usd - py.ebitda_usd) / nullIf(abs(py.ebitda_usd), 0), 0) AS ebitda_growth_pct,
        ifNull(100 * (gy.operating_profit_usd - py.operating_profit_usd) / nullIf(abs(py.operating_profit_usd), 0), 0) AS operating_profit_growth_pct,
        ifNull(100 * (gy.net_profit_usd - py.net_profit_usd) / nullIf(abs(py.net_profit_usd), 0), 0) AS net_profit_growth_pct,
        0.0 AS sga_pct_of_revenue
      FROM ${db}.sfin_fact_general_ledger f
      LEFT JOIN ${db}.sfin_dim_client c
        ON c.tenant_id=f.tenant_id AND c.org_id=f.org_id AND c.client_key=f.client_key
      LEFT JOIN ${db}.sfin_dim_vendor v
        ON v.tenant_id=f.tenant_id AND v.org_id=f.org_id AND v.vendor_key=f.vendor_key
      LEFT JOIN ${db}.sfin_dim_employee e
        ON e.tenant_id=f.tenant_id AND e.org_id=f.org_id AND e.employee_key=f.employee_key
      LEFT JOIN ${db}.sfin_dim_geography g
        ON g.tenant_id=f.tenant_id AND g.org_id=f.org_id AND g.geography_key=f.geography_key
      LEFT JOIN ${db}.sfin_dim_department d
        ON d.tenant_id=f.tenant_id AND d.org_id=f.org_id AND d.department_key=f.department_key
      LEFT JOIN ${db}.sfin_dim_business_unit b
        ON b.tenant_id=f.tenant_id AND b.org_id=f.org_id AND b.business_unit_key=f.business_unit_key
      LEFT JOIN (
        SELECT
          tenant_id,
          org_id,
          toYear(posting_date) AS fiscal_year,
          sum(if(account_type = 'Revenue', abs(pl_amount_usd), 0)) AS total_revenue_usd,
          sum(if(account_type = 'Revenue', abs(pl_amount_usd), 0))
            - sum(if(account_type = 'Direct Cost (COS)', abs(pl_amount_usd), 0)) AS gross_profit_usd,
          sum(if(account_type = 'Revenue', abs(pl_amount_usd), 0))
            - sum(if(account_type IN ('Direct Cost (COS)', 'SG&A'), abs(pl_amount_usd), 0))
            + sum(if(cost_category = 'DepreciationAndAmortization', abs(pl_amount_usd), 0)) AS ebitda_usd,
          sum(if(account_type = 'Revenue', abs(pl_amount_usd), 0))
            - sum(if(account_type IN ('Direct Cost (COS)', 'SG&A'), abs(pl_amount_usd), 0)) AS operating_profit_usd,
          sum(if(account_type = 'Revenue', abs(pl_amount_usd), 0))
            - sum(if(account_type IN ('Direct Cost (COS)', 'SG&A', 'Finance Cost', 'Tax'), abs(pl_amount_usd), 0)) AS net_profit_usd
        FROM ${db}.sfin_fact_general_ledger
        GROUP BY tenant_id, org_id, fiscal_year
      ) gy
        ON gy.tenant_id=f.tenant_id AND gy.org_id=f.org_id AND gy.fiscal_year=toYear(f.posting_date)
      LEFT JOIN (
        SELECT
          tenant_id,
          org_id,
          toYear(posting_date) AS fiscal_year,
          sum(if(account_type = 'Revenue', abs(pl_amount_usd), 0)) AS total_revenue_usd,
          sum(if(account_type = 'Revenue', abs(pl_amount_usd), 0))
            - sum(if(account_type = 'Direct Cost (COS)', abs(pl_amount_usd), 0)) AS gross_profit_usd,
          sum(if(account_type = 'Revenue', abs(pl_amount_usd), 0))
            - sum(if(account_type IN ('Direct Cost (COS)', 'SG&A'), abs(pl_amount_usd), 0))
            + sum(if(cost_category = 'DepreciationAndAmortization', abs(pl_amount_usd), 0)) AS ebitda_usd,
          sum(if(account_type = 'Revenue', abs(pl_amount_usd), 0))
            - sum(if(account_type IN ('Direct Cost (COS)', 'SG&A'), abs(pl_amount_usd), 0)) AS operating_profit_usd,
          sum(if(account_type = 'Revenue', abs(pl_amount_usd), 0))
            - sum(if(account_type IN ('Direct Cost (COS)', 'SG&A', 'Finance Cost', 'Tax'), abs(pl_amount_usd), 0)) AS net_profit_usd
        FROM ${db}.sfin_fact_general_ledger
        GROUP BY tenant_id, org_id, fiscal_year
      ) py
        ON py.tenant_id=f.tenant_id AND py.org_id=f.org_id AND py.fiscal_year=toYear(f.posting_date)-1`,

    `CREATE OR REPLACE VIEW ${db}.v_sfin_payroll_semantic AS
      SELECT
        f.tenant_id AS tenant_id,
        f.org_id AS org_id,
        f.org_name AS org_name,
        dt.date AS period_date,
        coalesce(e.employee_id, '') AS employee_id,
        coalesce(e.grade, '') AS employee_grade,
        coalesce(d.department_name, e.department, '') AS department,
        if(empty(coalesce(b.business_unit_name, '')), 'Unallocated', b.business_unit_name) AS business_unit,
        coalesce(c.client_name, e.client_name, '') AS client_name,
        coalesce(c.industry, '') AS industry,
        coalesce(g.region, '') AS region,
        coalesce(g.country, e.country, '') AS country,
        coalesce(g.city, e.city, '') AS city,
        coalesce(g.delivery_center, e.delivery_center, '') AS delivery_center,
        f.employee_key AS employee_headcount_key,
        f.paid_hours,
        f.overtime_hours,
        f.productive_hours,
        f.basic_salary_usd,
        f.overtime_usd,
        f.incentives_usd,
        f.performance_bonus_usd,
        f.employer_contributions_usd,
        f.medical_benefits_usd,
        f.insurance_usd,
        f.shift_allowance_usd,
        f.transport_allowance_usd,
        f.meal_allowance_usd,
        f.leave_encashment_usd,
        f.joining_bonus_usd,
        f.retention_bonus_usd,
        f.variable_pay_usd,
        f.total_payroll_usd,
        e.monthly_salary_usd AS average_monthly_salary,
        if(f.paid_hours=0, 0, f.total_payroll_usd/f.paid_hours) AS average_payroll_cost_per_paid_hour
      FROM ${db}.sfin_fact_payroll f
      LEFT JOIN ${db}.sfin_dim_date dt
        ON dt.tenant_id=f.tenant_id AND dt.org_id=f.org_id AND dt.date_key=f.date_key
      LEFT JOIN ${db}.sfin_dim_employee e
        ON e.tenant_id=f.tenant_id AND e.org_id=f.org_id AND e.employee_key=f.employee_key
      LEFT JOIN ${db}.sfin_dim_department d
        ON d.tenant_id=f.tenant_id AND d.org_id=f.org_id AND d.department_key=f.department_key
      LEFT JOIN ${db}.sfin_dim_business_unit b
        ON b.tenant_id=f.tenant_id AND b.org_id=f.org_id AND b.business_unit_key=f.business_unit_key
      LEFT JOIN ${db}.sfin_dim_client c
        ON c.tenant_id=f.tenant_id AND c.org_id=f.org_id AND c.client_key=f.client_key
      LEFT JOIN ${db}.sfin_dim_geography g
        ON g.tenant_id=f.tenant_id AND g.org_id=f.org_id AND g.geography_key=f.geography_key`,

    `CREATE OR REPLACE VIEW ${db}.v_sfin_operations_semantic AS
      SELECT
        f.tenant_id AS tenant_id,
        f.org_id AS org_id,
        f.org_name AS org_name,
        f.posting_date AS period_date,
        coalesce(c.client_name, '') AS client_name,
        coalesce(c.industry, '') AS industry,
        coalesce(g.region, '') AS region,
        coalesce(g.country, '') AS country,
        coalesce(g.city, '') AS city,
        coalesce(g.delivery_center, '') AS delivery_center,
        coalesce(d.department_name, '') AS department,
        if(empty(coalesce(b.business_unit_name, '')), 'Unallocated', b.business_unit_name) AS business_unit,
        f.service_line AS service_line,
        f.contract_type AS contract_type,
        f.working_hours,
        f.paid_hours,
        f.productive_hours,
        f.non_productive_hours,
        f.billable_hours,
        f.training_hours,
        f.idle_hours,
        f.overtime_hours,
        f.capacity_hours,
        f.occupancy_pct,
        f.utilization_pct,
        f.calls_handled,
        f.tickets_resolved,
        f.aht_minutes,
        f.sla_compliance_pct,
        f.qa_score_pct,
        f.csat_pct,
        f.nps,
        f.billing_rate_usd AS average_billing_rate,
        f.revenue_usd
      FROM ${db}.sfin_fact_operations f
      LEFT JOIN ${db}.sfin_dim_client c
        ON c.tenant_id=f.tenant_id AND c.org_id=f.org_id AND c.client_key=f.client_key
      LEFT JOIN ${db}.sfin_dim_geography g
        ON g.tenant_id=f.tenant_id AND g.org_id=f.org_id AND g.geography_key=f.geography_key
      LEFT JOIN ${db}.sfin_dim_department d
        ON d.tenant_id=f.tenant_id AND d.org_id=f.org_id AND d.department_key=f.department_key
      LEFT JOIN ${db}.sfin_dim_business_unit b
        ON b.tenant_id=f.tenant_id AND b.org_id=f.org_id AND b.business_unit_key=f.business_unit_key`,

    `CREATE OR REPLACE VIEW ${db}.v_sfin_attendance_semantic AS
      SELECT
        f.tenant_id AS tenant_id,
        f.org_id AS org_id,
        f.org_name AS org_name,
        f.month_start_date AS period_date,
        coalesce(e.employee_id, '') AS employee_id,
        coalesce(e.grade, '') AS employee_grade,
        coalesce(d.department_name, e.department, '') AS department,
        if(empty(coalesce(b.business_unit_name, '')), 'Unallocated', b.business_unit_name) AS business_unit,
        coalesce(c.client_name, e.client_name, '') AS client_name,
        coalesce(c.industry, '') AS industry,
        coalesce(g.region, '') AS region,
        coalesce(g.country, e.country, '') AS country,
        coalesce(g.city, e.city, '') AS city,
        coalesce(g.delivery_center, e.delivery_center, '') AS delivery_center,
        f.shift_type AS shift_type,
        f.attendance_status AS attendance_status,
        f.employee_key AS employee_headcount_key,
        if(f.overtime_eligible_flag = 1, f.employee_key, NULL) AS overtime_eligible_employee_key,
        f.scheduled_work_days,
        f.present_days,
        f.paid_leave_days,
        f.sick_leave_days,
        f.unpaid_absent_days,
        f.scheduled_hours,
        f.paid_hours,
        f.productive_hours,
        f.training_hours,
        f.overtime_hours,
        f.utilization_pct,
        f.overtime_eligible_flag
      FROM ${db}.sfin_fact_attendance f
      LEFT JOIN ${db}.sfin_dim_employee e
        ON e.tenant_id=f.tenant_id AND e.org_id=f.org_id AND e.employee_key=f.employee_key
      LEFT JOIN ${db}.sfin_dim_department d
        ON d.tenant_id=f.tenant_id AND d.org_id=f.org_id AND d.department_key=f.department_key
      LEFT JOIN ${db}.sfin_dim_business_unit b
        ON b.tenant_id=f.tenant_id AND b.org_id=f.org_id AND b.business_unit_key=f.business_unit_key
      LEFT JOIN ${db}.sfin_dim_client c
        ON c.tenant_id=f.tenant_id AND c.org_id=f.org_id AND c.client_key=f.client_key
      LEFT JOIN ${db}.sfin_dim_geography g
        ON g.tenant_id=f.tenant_id AND g.org_id=f.org_id AND g.geography_key=f.geography_key`,

    `CREATE OR REPLACE VIEW ${db}.v_sfin_ar_semantic AS
      SELECT
        f.tenant_id AS tenant_id,
        f.org_id AS org_id,
        f.org_name AS org_name,
        f.invoice_date AS period_date,
        coalesce(c.client_name, '') AS client_name,
        coalesce(c.industry, f.industry, '') AS industry,
        coalesce(g.region, '') AS region,
        coalesce(g.country, '') AS country,
        coalesce(g.city, '') AS city,
        coalesce(g.delivery_center, '') AS delivery_center,
        coalesce(d.department_name, '') AS department,
        if(empty(coalesce(b.business_unit_name, '')), 'Unallocated', b.business_unit_name) AS business_unit,
        f.revenue_category AS revenue_category,
        f.aging_bucket AS aging_bucket,
        f.invoice_status AS invoice_status,
        f.invoice_amount_usd,
        f.collected_amount_usd,
        f.write_off_amount_usd,
        f.outstanding_balance_usd AS outstanding_receivable_usd,
        f.days_sales_outstanding,
        f.days_past_due,
        0.0 AS collection_efficiency_pct,
        0.0 AS bad_debt_pct
      FROM ${db}.sfin_fact_accounts_receivable f
      LEFT JOIN ${db}.sfin_dim_client c
        ON c.tenant_id=f.tenant_id AND c.org_id=f.org_id AND c.client_key=f.client_key
      LEFT JOIN ${db}.sfin_dim_geography g
        ON g.tenant_id=f.tenant_id AND g.org_id=f.org_id AND g.geography_key=f.geography_key
      LEFT JOIN ${db}.sfin_dim_department d
        ON d.tenant_id=f.tenant_id AND d.org_id=f.org_id AND d.department_key=f.department_key
      LEFT JOIN ${db}.sfin_dim_business_unit b
        ON b.tenant_id=f.tenant_id AND b.org_id=f.org_id AND b.business_unit_key=f.business_unit_key`,

    `CREATE OR REPLACE VIEW ${db}.v_sfin_ap_semantic AS
      SELECT
        f.tenant_id AS tenant_id,
        f.org_id AS org_id,
        f.org_name AS org_name,
        f.invoice_date AS period_date,
        if(empty(coalesce(v.vendor_name, '')), 'Unallocated', v.vendor_name) AS vendor_name,
        coalesce(c.client_name, '') AS client_name,
        coalesce(g.region, '') AS region,
        coalesce(g.country, '') AS country,
        coalesce(g.city, '') AS city,
        coalesce(g.delivery_center, '') AS delivery_center,
        coalesce(d.department_name, '') AS department,
        if(empty(coalesce(b.business_unit_name, '')), 'Unallocated', b.business_unit_name) AS business_unit,
        f.cost_category AS cost_category,
        f.expense_account_name AS expense_account_name,
        f.aging_bucket AS aging_bucket,
        f.invoice_status AS invoice_status,
        f.invoice_amount_usd,
        f.paid_amount_usd,
        f.outstanding_balance_usd AS outstanding_payable_usd,
        f.days_payable_outstanding,
        f.days_past_due
      FROM ${db}.sfin_fact_accounts_payable f
      LEFT JOIN ${db}.sfin_dim_vendor v
        ON v.tenant_id=f.tenant_id AND v.org_id=f.org_id AND v.vendor_key=f.vendor_key
      LEFT JOIN ${db}.sfin_dim_client c
        ON c.tenant_id=f.tenant_id AND c.org_id=f.org_id AND c.client_key=f.client_key
      LEFT JOIN ${db}.sfin_dim_geography g
        ON g.tenant_id=f.tenant_id AND g.org_id=f.org_id AND g.geography_key=f.geography_key
      LEFT JOIN ${db}.sfin_dim_department d
        ON d.tenant_id=f.tenant_id AND d.org_id=f.org_id AND d.department_key=f.department_key
      LEFT JOIN ${db}.sfin_dim_business_unit b
        ON b.tenant_id=f.tenant_id AND b.org_id=f.org_id AND b.business_unit_key=f.business_unit_key`,

    `CREATE OR REPLACE VIEW ${db}.v_sfin_cashflow_semantic AS
      SELECT
        f.tenant_id AS tenant_id,
        f.org_id AS org_id,
        f.org_name AS org_name,
        dt.date AS period_date,
        f.cash_flow_activity AS cash_flow_activity,
        f.cash_flow_category AS cash_flow_category,
        f.cash_inflow_usd,
        f.cash_outflow_usd,
        f.net_cash_flow_usd,
        f.transaction_count,
        f.net_activity_cash_flow_usd,
        f.opening_cash_balance_usd,
        f.closing_cash_balance_usd
      FROM ${db}.sfin_fact_cash_flow f
      LEFT JOIN ${db}.sfin_dim_date dt
        ON dt.tenant_id=f.tenant_id AND dt.org_id=f.org_id AND dt.date_key=f.date_key`,

    `CREATE OR REPLACE VIEW ${db}.v_sfin_trial_balance_semantic AS
      SELECT
        f.tenant_id AS tenant_id,
        f.org_id AS org_id,
        f.org_name AS org_name,
        dt.date AS period_date,
        f.account_name AS account_name,
        f.account_type AS account_type,
        f.account_group AS account_group,
        a.account_sub_type,
        a.cost_category,
        a.revenue_category,
        f.opening_balance_usd,
        f.debit_movement_usd,
        f.credit_movement_usd,
        f.closing_balance_usd,
        f.closing_balance_usd - f.opening_balance_usd AS balance_change_usd,
        f.debit_balance_usd,
        f.credit_balance_usd
      FROM ${db}.sfin_fact_trial_balance f
      LEFT JOIN ${db}.sfin_dim_date dt
        ON dt.tenant_id=f.tenant_id AND dt.org_id=f.org_id AND dt.date_key=f.date_key
      LEFT JOIN ${db}.sfin_dim_account a
        ON a.tenant_id=f.tenant_id AND a.org_id=f.org_id AND a.account_key=f.account_key`,

    `CREATE OR REPLACE VIEW ${db}.v_sfin_employee_semantic AS
      SELECT
        e.tenant_id AS tenant_id,
        e.org_id AS org_id,
        e.org_name AS org_name,
        e.start_date AS period_date,
        e.employee_id,
        e.department,
        e.grade AS employee_grade,
        e.country,
        e.city,
        e.delivery_center,
        e.client_name,
        e.employee_key AS employee_headcount_key,
        e.monthly_salary_usd AS average_monthly_salary,
        if(e.end_date < today(), 1, 0) AS employee_exit_count
      FROM ${db}.sfin_dim_employee e`,

    `CREATE OR REPLACE VIEW ${db}.v_sfin_client_service_performance_semantic AS
      SELECT
        b.*,
        if(
          lagInFrame(total_revenue_usd, 1, total_revenue_usd) OVER (
            PARTITION BY tenant_id, org_id, client_name ORDER BY period_date
            ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
          ) = 0,
          0,
          100 * (total_revenue_usd - lagInFrame(total_revenue_usd, 1, total_revenue_usd) OVER (
            PARTITION BY tenant_id, org_id, client_name ORDER BY period_date
            ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
          )) / lagInFrame(total_revenue_usd, 1, total_revenue_usd) OVER (
            PARTITION BY tenant_id, org_id, client_name ORDER BY period_date
            ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
          )
        ) AS average_revenue_growth_pct,
        0.0 AS gross_margin_pct,
        0.0 AS collection_efficiency_pct,
        0.0 AS bad_debt_pct
      FROM (
        SELECT
          k.tenant_id AS tenant_id,
          k.org_id AS org_id,
          k.org_name AS org_name,
          k.period_date AS period_date,
          k.client_name AS client_name,
          any(g.industry) AS industry,
          ifNull(any(g.total_revenue_usd), 0) AS total_revenue_usd,
          ifNull(any(g.gross_profit_usd), 0) AS gross_profit_usd,
          ifNull(any(o.billable_hours), 0) AS billable_hours,
          ifNull(any(o.productive_hours), 0) AS productive_hours,
          ifNull(any(o.average_billing_rate), 0) AS average_billing_rate,
          ifNull(any(o.utilization_pct), 0) AS utilization_pct,
          ifNull(any(o.sla_compliance_pct), 0) AS sla_compliance_pct,
          ifNull(any(o.csat_pct), 0) AS csat_pct,
          ifNull(any(o.qa_score_pct), 0) AS qa_score_pct,
          ifNull(any(o.nps), 0) AS nps,
          ifNull(any(p.total_payroll_usd), 0) AS total_payroll_usd,
          ifNull(any(p.employee_headcount), 0) AS employee_headcount,
          ifNull(any(a.invoice_amount_usd), 0) AS invoice_amount_usd,
          ifNull(any(a.collected_amount_usd), 0) AS collected_amount_usd,
          ifNull(any(a.outstanding_receivable_usd), 0) AS outstanding_receivable_usd,
          ifNull(any(a.write_off_amount_usd), 0) AS write_off_amount_usd,
          ifNull(any(a.days_sales_outstanding), 0) AS days_sales_outstanding
        FROM (
          SELECT tenant_id, org_id, org_name, toStartOfMonth(period_date) AS period_date, client_name
          FROM ${db}.v_sfin_gl_semantic WHERE notEmpty(client_name)
          UNION DISTINCT
          SELECT tenant_id, org_id, org_name, toStartOfMonth(period_date) AS period_date, client_name
          FROM ${db}.v_sfin_operations_semantic WHERE notEmpty(client_name)
          UNION DISTINCT
          SELECT tenant_id, org_id, org_name, toStartOfMonth(period_date) AS period_date, client_name
          FROM ${db}.v_sfin_payroll_semantic WHERE notEmpty(client_name)
          UNION DISTINCT
          SELECT tenant_id, org_id, org_name, toStartOfMonth(period_date) AS period_date, client_name
          FROM ${db}.v_sfin_ar_semantic WHERE notEmpty(client_name)
        ) k
        LEFT JOIN (
          SELECT tenant_id, org_id, toStartOfMonth(period_date) AS period_date, client_name,
            any(industry) AS industry, sum(total_revenue_usd) AS total_revenue_usd,
            sum(gross_profit_usd) AS gross_profit_usd
          FROM ${db}.v_sfin_gl_semantic GROUP BY tenant_id, org_id, period_date, client_name
        ) g USING (tenant_id, org_id, period_date, client_name)
        LEFT JOIN (
          SELECT tenant_id, org_id, toStartOfMonth(period_date) AS period_date, client_name,
            sum(billable_hours) AS billable_hours, sum(productive_hours) AS productive_hours,
            avg(average_billing_rate) AS average_billing_rate, avg(utilization_pct) AS utilization_pct,
            avg(sla_compliance_pct) AS sla_compliance_pct,
            avg(csat_pct) AS csat_pct, avg(qa_score_pct) AS qa_score_pct, avg(nps) AS nps
          FROM ${db}.v_sfin_operations_semantic GROUP BY tenant_id, org_id, period_date, client_name
        ) o USING (tenant_id, org_id, period_date, client_name)
        LEFT JOIN (
          SELECT tenant_id, org_id, toStartOfMonth(period_date) AS period_date, client_name,
            sum(total_payroll_usd) AS total_payroll_usd, uniqExact(employee_headcount_key) AS employee_headcount
          FROM ${db}.v_sfin_payroll_semantic GROUP BY tenant_id, org_id, period_date, client_name
        ) p USING (tenant_id, org_id, period_date, client_name)
        LEFT JOIN (
          SELECT tenant_id, org_id, toStartOfMonth(period_date) AS period_date, client_name,
            sum(ar.invoice_amount_usd) AS invoice_amount_usd, sum(ar.collected_amount_usd) AS collected_amount_usd,
            sum(ar.outstanding_receivable_usd) AS outstanding_receivable_usd, sum(ar.write_off_amount_usd) AS write_off_amount_usd,
            if(sum(ar.invoice_amount_usd) = 0, 0,
              30 * sum(ar.outstanding_receivable_usd) / sum(ar.invoice_amount_usd)) AS days_sales_outstanding
          FROM ${db}.v_sfin_ar_semantic ar GROUP BY tenant_id, org_id, period_date, client_name
        ) a USING (tenant_id, org_id, period_date, client_name)
        GROUP BY k.tenant_id, k.org_id, k.org_name, k.period_date, k.client_name
      ) b`,

    `CREATE OR REPLACE VIEW ${db}.v_sfin_department_workforce_semantic AS
      SELECT
        k.tenant_id AS tenant_id,
        k.org_id AS org_id,
        k.org_name AS org_name,
        k.period_date AS period_date,
        k.department AS department,
        ifNull(any(g.total_revenue_usd), 0) AS total_revenue_usd,
        ifNull(any(p.total_payroll_usd), 0) AS total_payroll_usd,
        ifNull(any(o.productive_hours), 0) AS productive_hours,
        ifNull(any(o.paid_hours), 0) AS paid_hours,
        ifNull(any(p.employee_headcount), 0) AS employee_headcount,
        0.0 AS productive_hours_percentage
      FROM (
        SELECT tenant_id, org_id, org_name, toStartOfMonth(period_date) AS period_date, department
        FROM ${db}.v_sfin_gl_semantic WHERE notEmpty(department)
        UNION DISTINCT
        SELECT tenant_id, org_id, org_name, toStartOfMonth(period_date) AS period_date, department
        FROM ${db}.v_sfin_payroll_semantic WHERE notEmpty(department)
        UNION DISTINCT
        SELECT tenant_id, org_id, org_name, toStartOfMonth(period_date) AS period_date, department
        FROM ${db}.v_sfin_operations_semantic WHERE notEmpty(department)
      ) k
      LEFT JOIN (
        SELECT tenant_id, org_id, toStartOfMonth(period_date) AS period_date, department,
          sum(total_revenue_usd) AS total_revenue_usd
        FROM ${db}.v_sfin_gl_semantic
        GROUP BY tenant_id, org_id, period_date, department
      ) g USING (tenant_id, org_id, period_date, department)
      LEFT JOIN (
        SELECT tenant_id, org_id, toStartOfMonth(period_date) AS period_date, department,
          sum(total_payroll_usd) AS total_payroll_usd,
          uniqExact(employee_headcount_key) AS employee_headcount
        FROM ${db}.v_sfin_payroll_semantic
        GROUP BY tenant_id, org_id, period_date, department
      ) p USING (tenant_id, org_id, period_date, department)
      LEFT JOIN (
        SELECT tenant_id, org_id, toStartOfMonth(period_date) AS period_date, department,
          sum(productive_hours) AS productive_hours,
          sum(paid_hours) AS paid_hours
        FROM ${db}.v_sfin_operations_semantic
        GROUP BY tenant_id, org_id, period_date, department
      ) o USING (tenant_id, org_id, period_date, department)
      GROUP BY k.tenant_id, k.org_id, k.org_name, k.period_date, k.department`,

    `CREATE OR REPLACE VIEW ${db}.v_sfin_delivery_scorecard_semantic AS
      SELECT
        k.tenant_id AS tenant_id,
        k.org_id AS org_id,
        k.org_name AS org_name,
        k.period_date AS period_date,
        k.delivery_center AS delivery_center,
        ifNull(any(g.total_revenue_usd), 0) AS total_revenue_usd,
        ifNull(any(g.gross_profit_usd), 0) AS gross_profit_usd,
        0.0 AS gross_margin_pct,
        ifNull(any(p.total_payroll_usd), 0) AS total_payroll_usd,
        ifNull(any(p.employee_headcount), 0) AS employee_headcount,
        ifNull(any(o.productive_hours), 0) AS productive_hours,
        ifNull(any(o.billable_hours), 0) AS billable_hours,
        ifNull(any(o.utilization_pct), 0) AS utilization_pct,
        ifNull(any(o.sla_compliance_pct), 0) AS sla_compliance_pct,
        ifNull(any(o.csat_pct), 0) AS csat_pct,
        if(productive_hours = 0, 0, total_revenue_usd / productive_hours) AS average_revenue_per_productive_hour,
        if(productive_hours = 0, 0, total_payroll_usd / productive_hours) AS average_cost_per_productive_hour
      FROM (
        SELECT tenant_id, org_id, org_name, toStartOfMonth(period_date) AS period_date, delivery_center
        FROM ${db}.v_sfin_gl_semantic WHERE notEmpty(delivery_center)
        UNION DISTINCT
        SELECT tenant_id, org_id, org_name, toStartOfMonth(period_date) AS period_date, delivery_center
        FROM ${db}.v_sfin_operations_semantic WHERE notEmpty(delivery_center)
        UNION DISTINCT
        SELECT tenant_id, org_id, org_name, toStartOfMonth(period_date) AS period_date, delivery_center
        FROM ${db}.v_sfin_payroll_semantic WHERE notEmpty(delivery_center)
      ) k
      LEFT JOIN (
        SELECT tenant_id, org_id, toStartOfMonth(period_date) AS period_date, delivery_center,
          sum(total_revenue_usd) AS total_revenue_usd, sum(gross_profit_usd) AS gross_profit_usd
        FROM ${db}.v_sfin_gl_semantic GROUP BY tenant_id, org_id, period_date, delivery_center
      ) g USING (tenant_id, org_id, period_date, delivery_center)
      LEFT JOIN (
        SELECT tenant_id, org_id, toStartOfMonth(period_date) AS period_date, delivery_center,
          sum(total_payroll_usd) AS total_payroll_usd, uniqExact(employee_headcount_key) AS employee_headcount
        FROM ${db}.v_sfin_payroll_semantic GROUP BY tenant_id, org_id, period_date, delivery_center
      ) p USING (tenant_id, org_id, period_date, delivery_center)
      LEFT JOIN (
        SELECT tenant_id, org_id, toStartOfMonth(period_date) AS period_date, delivery_center,
          sum(productive_hours) AS productive_hours, sum(billable_hours) AS billable_hours,
          avg(utilization_pct) AS utilization_pct, avg(sla_compliance_pct) AS sla_compliance_pct,
          avg(csat_pct) AS csat_pct
        FROM ${db}.v_sfin_operations_semantic GROUP BY tenant_id, org_id, period_date, delivery_center
      ) o USING (tenant_id, org_id, period_date, delivery_center)
      GROUP BY k.tenant_id, k.org_id, k.org_name, k.period_date, k.delivery_center`,

    `CREATE OR REPLACE VIEW ${db}.v_sfin_service_line_scorecard_semantic AS
      SELECT
        o.tenant_id AS tenant_id,
        o.org_id AS org_id,
        o.org_name AS org_name,
        o.period_date AS period_date,
        o.service_line AS service_line,
        o.service_revenue_usd AS total_revenue_usd,
        o.service_revenue_usd - if(o.month_revenue_usd = 0, 0, ifNull(c.total_cogs_usd, 0) * o.service_revenue_usd / o.month_revenue_usd) AS gross_profit_usd,
        0.0 AS gross_margin_pct,
        o.billable_hours AS billable_hours,
        o.average_billing_rate AS average_billing_rate,
        o.calls_handled AS calls_handled,
        o.tickets_resolved AS tickets_resolved,
        o.aht_minutes AS aht_minutes,
        o.sla_compliance_pct AS sla_compliance_pct,
        o.qa_score_pct AS qa_score_pct,
        o.csat_pct AS csat_pct,
        o.nps AS nps
      FROM (
        SELECT tenant_id, org_id, any(org_name) AS org_name, toStartOfMonth(period_date) AS period_date, service_line,
          sum(toFloat64(revenue_usd)) AS service_revenue_usd,
          sum(sum(toFloat64(revenue_usd))) OVER (PARTITION BY tenant_id, org_id, toStartOfMonth(period_date)) AS month_revenue_usd,
          sum(billable_hours) AS billable_hours, avg(average_billing_rate) AS average_billing_rate,
          sum(calls_handled) AS calls_handled, sum(tickets_resolved) AS tickets_resolved,
          avg(aht_minutes) AS aht_minutes, avg(sla_compliance_pct) AS sla_compliance_pct,
          avg(qa_score_pct) AS qa_score_pct, avg(csat_pct) AS csat_pct, avg(nps) AS nps
        FROM ${db}.v_sfin_operations_semantic
        GROUP BY tenant_id, org_id, period_date, service_line
      ) o
      LEFT JOIN (
        SELECT tenant_id, org_id, toStartOfMonth(period_date) AS period_date, sum(total_cogs_usd) AS total_cogs_usd
        FROM ${db}.v_sfin_gl_semantic GROUP BY tenant_id, org_id, period_date
      ) c USING (tenant_id, org_id, period_date)`,

    `CREATE OR REPLACE VIEW ${db}.v_sfin_contract_performance_semantic AS
      SELECT
        k.tenant_id AS tenant_id,
        k.org_id AS org_id,
        k.org_name AS org_name,
        k.period_date AS period_date,
        k.contract_type AS contract_type,
        ifNull(any(g.total_revenue_usd), 0) AS total_revenue_usd,
        ifNull(any(g.gross_profit_usd), 0) AS gross_profit_usd,
        0.0 AS gross_margin_pct,
        ifNull(any(o.billable_hours), 0) AS billable_hours,
        ifNull(any(o.average_billing_rate), 0) AS average_billing_rate,
        ifNull(any(o.utilization_pct), 0) AS utilization_pct,
        ifNull(any(o.sla_compliance_pct), 0) AS sla_compliance_pct,
        ifNull(any(o.csat_pct), 0) AS csat_pct
      FROM (
        SELECT tenant_id, org_id, org_name, toStartOfMonth(period_date) AS period_date, contract_type
        FROM ${db}.v_sfin_gl_semantic WHERE notEmpty(contract_type)
        UNION DISTINCT
        SELECT tenant_id, org_id, org_name, toStartOfMonth(period_date) AS period_date, contract_type
        FROM ${db}.v_sfin_operations_semantic WHERE notEmpty(contract_type)
      ) k
      LEFT JOIN (
        -- Cost rows are not contract-tagged in the ledger. Allocate the period's
        -- canonical COGS to contracts by their share of period revenue so the
        -- contract totals reconcile to the P&L instead of reporting revenue as
        -- gross profit.
        SELECT
          r.tenant_id,
          r.org_id,
          r.period_date,
          r.contract_type,
          r.total_revenue_usd,
          r.total_revenue_usd -
            if(r.period_revenue_usd = 0, 0,
              ifNull(any(c.total_cogs_usd), 0) * r.total_revenue_usd / r.period_revenue_usd) AS gross_profit_usd
        FROM (
          SELECT
            tenant_id,
            org_id,
            toStartOfMonth(period_date) AS period_date,
            contract_type,
            sum(gl.total_revenue_usd) AS total_revenue_usd,
            sum(sum(gl.total_revenue_usd)) OVER (
              PARTITION BY tenant_id, org_id, toStartOfMonth(period_date)
            ) AS period_revenue_usd
          FROM ${db}.v_sfin_gl_semantic gl
          WHERE notEmpty(contract_type)
          GROUP BY tenant_id, org_id, period_date, contract_type
        ) r
        LEFT JOIN (
          SELECT tenant_id, org_id, toStartOfMonth(period_date) AS period_date,
            sum(total_cogs_usd) AS total_cogs_usd
          FROM ${db}.v_sfin_gl_semantic
          GROUP BY tenant_id, org_id, period_date
        ) c USING (tenant_id, org_id, period_date)
        GROUP BY r.tenant_id, r.org_id, r.period_date, r.contract_type,
          r.total_revenue_usd, r.period_revenue_usd
      ) g USING (tenant_id, org_id, period_date, contract_type)
      LEFT JOIN (
        SELECT tenant_id, org_id, toStartOfMonth(period_date) AS period_date, contract_type,
          sum(billable_hours) AS billable_hours,
          avg(average_billing_rate) AS average_billing_rate,
          avg(utilization_pct) AS utilization_pct,
          avg(sla_compliance_pct) AS sla_compliance_pct,
          avg(csat_pct) AS csat_pct
        FROM ${db}.v_sfin_operations_semantic
        GROUP BY tenant_id, org_id, period_date, contract_type
      ) o USING (tenant_id, org_id, period_date, contract_type)
      GROUP BY k.tenant_id, k.org_id, k.org_name, k.period_date, k.contract_type`,

    `CREATE OR REPLACE VIEW ${db}.v_sfin_balance_ratio_semantic AS
      SELECT
        t.tenant_id AS tenant_id,
        t.org_id AS org_id,
        t.org_name AS org_name,
        t.period_date AS period_date,
        t.closing_total_assets_usd AS closing_total_assets_usd,
        t.closing_total_liabilities_usd AS closing_total_liabilities_usd,
        t.closing_total_assets_usd - t.closing_total_liabilities_usd AS closing_total_equity_usd,
        t.closing_current_assets_usd AS closing_current_assets_usd,
        t.closing_current_liabilities_usd AS closing_current_liabilities_usd,
        ifNull(g.total_revenue_usd, 0) AS total_revenue_usd,
        ifNull(g.net_profit_usd, 0) AS net_profit_usd
      FROM (
        SELECT tenant_id, org_id, any(org_name) AS org_name, toStartOfMonth(period_date) AS period_date,
          sumIf(closing_balance_usd, account_type IN ('Asset', 'Asset Contra')) AS closing_total_assets_usd,
          abs(sumIf(closing_balance_usd, account_type = 'Liability')) AS closing_total_liabilities_usd,
          sumIf(debit_balance_usd, account_group = 'Current Assets') AS closing_current_assets_usd,
          sumIf(credit_balance_usd, account_group = 'Current Liabilities') AS closing_current_liabilities_usd
        FROM ${db}.v_sfin_trial_balance_semantic
        GROUP BY tenant_id, org_id, period_date
      ) t
      LEFT JOIN (
        SELECT tenant_id, org_id, toStartOfMonth(period_date) AS period_date,
          sum(total_revenue_usd) AS total_revenue_usd, sum(net_profit_usd) AS net_profit_usd
        FROM ${db}.v_sfin_gl_semantic GROUP BY tenant_id, org_id, period_date
      ) g USING (tenant_id, org_id, period_date)`,

    `CREATE OR REPLACE VIEW ${db}.v_sfin_cost_family_semantic AS
      SELECT
        c.tenant_id AS tenant_id,
        c.org_id AS org_id,
        c.org_name AS org_name,
        c.period_date AS period_date,
        c.cost_family AS cost_family,
        c.expense_account_name AS expense_account_name,
        c.total_cost_usd AS total_cost_usd,
        ifNull(r.total_revenue_usd, 0) / greatest(c.family_row_count, 1) AS total_revenue_usd,
        0.0 AS cost_pct_of_revenue,
        ifNull(r.ebitda_usd, 0) / greatest(c.family_row_count, 1) AS ebitda_usd,
        if(ifNull(r.total_revenue_usd, 0) = 0, 0,
          100 * ifNull(r.ebitda_usd, 0) / ifNull(r.total_revenue_usd, 0)) AS ebitda_margin_pct
      FROM (
        SELECT tenant_id, org_id, any(org_name) AS org_name, toStartOfMonth(period_date) AS period_date,
          account_name AS expense_account_name,
          account_group AS cost_family,
          sumIf(abs(pl_amount_usd), account_type != 'Revenue') AS total_cost_usd,
          count() OVER (
            PARTITION BY tenant_id, org_id, toStartOfMonth(period_date), account_group
          ) AS family_row_count
        FROM ${db}.v_sfin_gl_semantic
        WHERE account_type != 'Revenue'
        GROUP BY tenant_id, org_id, period_date, cost_family, expense_account_name
      ) c
      LEFT JOIN (
        SELECT tenant_id, org_id, toStartOfMonth(period_date) AS period_date,
          sum(total_revenue_usd) AS total_revenue_usd,
          sum(ebitda_usd) AS ebitda_usd
        FROM ${db}.v_sfin_gl_semantic GROUP BY tenant_id, org_id, period_date
      ) r USING (tenant_id, org_id, period_date)`,

    `CREATE OR REPLACE VIEW ${db}.v_sfin_payment_speed_semantic AS
      SELECT
        k.tenant_id AS tenant_id,
        k.org_id AS org_id,
        any(k.org_name) AS org_name,
        k.period_date AS period_date,
        ifNull(any(a.average_client_collection_days), 0) AS average_client_collection_days,
        ifNull(any(p.average_vendor_payment_days), 0) AS average_vendor_payment_days
      FROM (
        SELECT tenant_id, org_id, org_name, toStartOfMonth(period_date) AS period_date FROM ${db}.v_sfin_ar_semantic
        UNION DISTINCT
        SELECT tenant_id, org_id, org_name, toStartOfMonth(period_date) AS period_date FROM ${db}.v_sfin_ap_semantic
      ) k
      LEFT JOIN (
        SELECT tenant_id, org_id, toStartOfMonth(period_date) AS period_date,
          avg(days_sales_outstanding) AS average_client_collection_days
        FROM ${db}.v_sfin_ar_semantic GROUP BY tenant_id, org_id, period_date
      ) a USING (tenant_id, org_id, period_date)
      LEFT JOIN (
        SELECT tenant_id, org_id, toStartOfMonth(period_date) AS period_date,
          avg(days_payable_outstanding) AS average_vendor_payment_days
        FROM ${db}.v_sfin_ap_semantic GROUP BY tenant_id, org_id, period_date
      ) p USING (tenant_id, org_id, period_date)
      GROUP BY k.tenant_id, k.org_id, k.period_date`,

    `CREATE OR REPLACE VIEW ${db}.v_sfin_monthly_finance_semantic AS
      SELECT
        k.tenant_id AS tenant_id,
        k.org_id AS org_id,
        any(k.org_name) AS org_name,
        k.period_date AS period_date,
        ifNull(any(g.total_revenue_usd), 0) AS total_revenue_usd,
        ifNull(any(a.invoice_amount_usd), 0) AS invoice_amount_usd,
        ifNull(any(a.collected_amount_usd), 0) AS collected_amount_usd,
        ifNull(any(c.cash_received_usd), 0) AS cash_received_usd,
        ifNull(any(a.outstanding_receivable_usd), 0) AS outstanding_receivable_usd,
        ifNull(any(a.current_receivable_usd), 0) AS current_receivable_usd,
        ifNull(any(a.overdue_receivable_usd), 0) AS overdue_receivable_usd,
        ifNull(any(a.average_days_sales_outstanding), 0) AS average_days_sales_outstanding
      FROM (
        SELECT tenant_id, org_id, org_name, toStartOfMonth(period_date) AS period_date FROM ${db}.v_sfin_gl_semantic
        UNION DISTINCT
        SELECT tenant_id, org_id, org_name, toStartOfMonth(period_date) AS period_date FROM ${db}.v_sfin_ar_semantic
        UNION DISTINCT
        SELECT tenant_id, org_id, org_name, toStartOfMonth(period_date) AS period_date FROM ${db}.v_sfin_cashflow_semantic
      ) k
      LEFT JOIN (
        SELECT tenant_id, org_id, toStartOfMonth(period_date) AS period_date,
          sum(total_revenue_usd) AS total_revenue_usd
        FROM ${db}.v_sfin_gl_semantic GROUP BY tenant_id, org_id, period_date
      ) g USING (tenant_id, org_id, period_date)
      LEFT JOIN (
        SELECT tenant_id, org_id, toStartOfMonth(period_date) AS period_date,
          sum(ar.invoice_amount_usd) AS invoice_amount_usd,
          sum(ar.collected_amount_usd) AS collected_amount_usd,
          sum(ar.outstanding_receivable_usd) AS outstanding_receivable_usd,
          sumIf(ar.outstanding_receivable_usd, ar.days_past_due <= 0) AS current_receivable_usd,
          sumIf(ar.outstanding_receivable_usd, ar.days_past_due > 0) AS overdue_receivable_usd,
          if(sum(ar.invoice_amount_usd) = 0, 0,
            30 * sum(ar.outstanding_receivable_usd) / sum(ar.invoice_amount_usd)) AS average_days_sales_outstanding
        FROM ${db}.v_sfin_ar_semantic ar GROUP BY tenant_id, org_id, period_date
      ) a USING (tenant_id, org_id, period_date)
      LEFT JOIN (
        SELECT tenant_id, org_id, toStartOfMonth(period_date) AS period_date,
          sum(cash_inflow_usd) AS cash_received_usd
        FROM ${db}.v_sfin_cashflow_semantic GROUP BY tenant_id, org_id, period_date
      ) c USING (tenant_id, org_id, period_date)
      GROUP BY k.tenant_id, k.org_id, k.period_date`,

    `CREATE OR REPLACE VIEW ${db}.v_sfin_ledger_reconciliation_semantic AS
      SELECT
        k.tenant_id AS tenant_id,
        k.org_id AS org_id,
        any(k.org_name) AS org_name,
        k.period_date AS period_date,
        ifNull(any(g.general_ledger_debit_usd), 0) AS general_ledger_debit_usd,
        ifNull(any(g.general_ledger_credit_usd), 0) AS general_ledger_credit_usd,
        ifNull(any(t.trial_balance_debit_movement_usd), 0) AS trial_balance_debit_movement_usd,
        ifNull(any(t.trial_balance_credit_movement_usd), 0) AS trial_balance_credit_movement_usd,
        general_ledger_debit_usd - trial_balance_debit_movement_usd AS debit_reconciliation_difference_usd,
        general_ledger_credit_usd - trial_balance_credit_movement_usd AS credit_reconciliation_difference_usd
      FROM (
        SELECT tenant_id, org_id, org_name, toStartOfMonth(period_date) AS period_date FROM ${db}.v_sfin_gl_semantic
        UNION DISTINCT
        SELECT tenant_id, org_id, org_name, toStartOfMonth(period_date) AS period_date FROM ${db}.v_sfin_trial_balance_semantic
      ) k
      LEFT JOIN (
        SELECT tenant_id, org_id, toStartOfMonth(period_date) AS period_date,
          sum(debit_usd) AS general_ledger_debit_usd,
          sum(credit_usd) AS general_ledger_credit_usd
        FROM ${db}.v_sfin_gl_semantic GROUP BY tenant_id, org_id, period_date
      ) g USING (tenant_id, org_id, period_date)
      LEFT JOIN (
        SELECT tenant_id, org_id, toStartOfMonth(period_date) AS period_date,
          sum(debit_movement_usd) AS trial_balance_debit_movement_usd,
          sum(credit_movement_usd) AS trial_balance_credit_movement_usd
        FROM ${db}.v_sfin_trial_balance_semantic GROUP BY tenant_id, org_id, period_date
      ) t USING (tenant_id, org_id, period_date)
      GROUP BY k.tenant_id, k.org_id, k.period_date`,

    `CREATE OR REPLACE VIEW ${db}.v_sfin_monthly_ap_semantic AS
      SELECT
        k.tenant_id AS tenant_id,
        k.org_id AS org_id,
        any(k.org_name) AS org_name,
        k.period_date AS period_date,
        ifNull(any(p.invoice_amount_usd), 0) AS invoice_amount_usd,
        ifNull(any(p.paid_amount_usd), 0) AS paid_amount_usd,
        ifNull(any(c.total_cash_outflow_usd), 0) AS total_cash_outflow_usd${cashFlowSelect},
        ifNull(any(p.outstanding_payable_usd), 0) AS outstanding_payable_usd,
        ifNull(any(p.current_payable_usd), 0) AS current_payable_usd,
        ifNull(any(p.overdue_payable_usd), 0) AS overdue_payable_usd,
        ifNull(any(p.average_days_payable_outstanding), 0) AS average_days_payable_outstanding
      FROM (
        SELECT tenant_id, org_id, org_name, toStartOfMonth(period_date) AS period_date FROM ${db}.v_sfin_ap_semantic
        UNION DISTINCT
        SELECT tenant_id, org_id, org_name, toStartOfMonth(period_date) AS period_date FROM ${db}.v_sfin_cashflow_semantic
      ) k
      LEFT JOIN (
        SELECT tenant_id, org_id, toStartOfMonth(period_date) AS period_date,
          sum(ap.invoice_amount_usd) AS invoice_amount_usd,
          sum(ap.paid_amount_usd) AS paid_amount_usd,
          sum(ap.outstanding_payable_usd) AS outstanding_payable_usd,
          sumIf(ap.outstanding_payable_usd, ap.days_past_due <= 0) AS current_payable_usd,
          sumIf(ap.outstanding_payable_usd, ap.days_past_due > 0) AS overdue_payable_usd,
          if(sum(ap.invoice_amount_usd) = 0, 0,
            30 * sum(ap.outstanding_payable_usd) / sum(ap.invoice_amount_usd)) AS average_days_payable_outstanding
        FROM ${db}.v_sfin_ap_semantic ap GROUP BY tenant_id, org_id, period_date
      ) p USING (tenant_id, org_id, period_date)
      LEFT JOIN (
        SELECT tenant_id, org_id, toStartOfMonth(period_date) AS period_date,
          sum(cash_outflow_usd) AS total_cash_outflow_usd${cashFlowAggregate}
        FROM ${db}.v_sfin_cashflow_semantic GROUP BY tenant_id, org_id, period_date
      ) c USING (tenant_id, org_id, period_date)
      GROUP BY k.tenant_id, k.org_id, k.period_date`,

    `CREATE OR REPLACE VIEW ${db}.v_sfin_working_capital_semantic AS
      SELECT
        t.tenant_id AS tenant_id,
        t.org_id AS org_id,
        t.org_name AS org_name,
        t.period_date AS period_date,
        t.total_closing_balance_usd AS total_closing_balance_usd${accountSubtypeSelect},
        ifNull(a.average_days_sales_outstanding, 0) AS average_days_sales_outstanding,
        ifNull(p.average_days_payable_outstanding, 0) AS average_days_payable_outstanding
      FROM (
        SELECT tenant_id, org_id, any(org_name) AS org_name, toStartOfMonth(period_date) AS period_date,
          abs(sum(closing_balance_usd)) AS total_closing_balance_usd${accountSubtypeAggregate}
        FROM ${db}.v_sfin_trial_balance_semantic
        GROUP BY tenant_id, org_id, period_date
      ) t
      LEFT JOIN (
        SELECT tenant_id, org_id, toStartOfMonth(period_date) AS period_date,
          if(sum(invoice_amount_usd) = 0, 0,
            30 * sum(outstanding_receivable_usd) / sum(invoice_amount_usd)) AS average_days_sales_outstanding
        FROM ${db}.v_sfin_ar_semantic GROUP BY tenant_id, org_id, period_date
      ) a USING (tenant_id, org_id, period_date)
      LEFT JOIN (
        SELECT tenant_id, org_id, toStartOfMonth(period_date) AS period_date,
          if(sum(invoice_amount_usd) = 0, 0,
            30 * sum(outstanding_payable_usd) / sum(invoice_amount_usd)) AS average_days_payable_outstanding
        FROM ${db}.v_sfin_ap_semantic GROUP BY tenant_id, org_id, period_date
      ) p USING (tenant_id, org_id, period_date)`,

    `CREATE OR REPLACE VIEW ${db}.v_sfin_payroll_reconciliation_semantic AS
      SELECT
        k.tenant_id AS tenant_id,
        k.org_id AS org_id,
        any(k.org_name) AS org_name,
        k.period_date AS period_date,
        ifNull(any(p.payroll_cost_usd), 0) AS payroll_cost_usd,
        ifNull(any(c.total_cash_outflow_usd), 0) AS total_cash_outflow_usd${cashFlowSelect},
        ifNull(any(g.total_general_ledger_cost_usd), 0) AS total_general_ledger_cost_usd,
        ifNull(any(g.general_ledger_payroll_cost_usd), 0) AS general_ledger_payroll_cost_usd${glCostSelect}
      FROM (
        SELECT tenant_id, org_id, org_name, toStartOfMonth(period_date) AS period_date FROM ${db}.v_sfin_payroll_semantic
        UNION DISTINCT
        SELECT tenant_id, org_id, org_name, toStartOfMonth(period_date) AS period_date FROM ${db}.v_sfin_cashflow_semantic
        UNION DISTINCT
        SELECT tenant_id, org_id, org_name, toStartOfMonth(period_date) AS period_date FROM ${db}.v_sfin_gl_semantic
      ) k
      LEFT JOIN (
        SELECT tenant_id, org_id, toStartOfMonth(period_date) AS period_date,
          sum(total_payroll_usd) AS payroll_cost_usd
        FROM ${db}.v_sfin_payroll_semantic GROUP BY tenant_id, org_id, period_date
      ) p USING (tenant_id, org_id, period_date)
      LEFT JOIN (
        SELECT tenant_id, org_id, toStartOfMonth(period_date) AS period_date,
          sum(cash_outflow_usd) AS total_cash_outflow_usd${cashFlowAggregate}
        FROM ${db}.v_sfin_cashflow_semantic GROUP BY tenant_id, org_id, period_date
      ) c USING (tenant_id, org_id, period_date)
      LEFT JOIN (
        SELECT tenant_id, org_id, toStartOfMonth(period_date) AS period_date,
          sum(abs(pl_amount_usd)) AS total_general_ledger_cost_usd,
          sumIf(abs(pl_amount_usd), match(lowerUTF8(cost_category), 'payroll|salary|wage|labor|labour')) AS general_ledger_payroll_cost_usd${glCostAggregate}
        FROM ${db}.v_sfin_gl_semantic GROUP BY tenant_id, org_id, period_date
      ) g USING (tenant_id, org_id, period_date)
      GROUP BY k.tenant_id, k.org_id, k.period_date`,

    `CREATE OR REPLACE VIEW ${db}.v_sfin_cash_reconciliation_semantic AS
      SELECT
        k.tenant_id AS tenant_id,
        k.org_id AS org_id,
        any(k.org_name) AS org_name,
        k.period_date AS period_date,
        ifNull(any(c.net_cash_flow_usd), 0) AS net_cash_flow_usd,
        ifNull(any(g.general_ledger_cash_movement_usd), 0) AS general_ledger_cash_movement_usd,
        net_cash_flow_usd - general_ledger_cash_movement_usd AS cash_reconciliation_difference_usd
      FROM (
        SELECT tenant_id, org_id, org_name, toStartOfMonth(period_date) AS period_date
        FROM ${db}.v_sfin_cashflow_semantic
        UNION DISTINCT
        SELECT tenant_id, org_id, org_name, toStartOfMonth(period_date) AS period_date
        FROM ${db}.v_sfin_gl_semantic WHERE notEmpty(cash_flow_category)
      ) k
      LEFT JOIN (
        SELECT tenant_id, org_id, toStartOfMonth(period_date) AS period_date,
          sum(net_cash_flow_usd) AS net_cash_flow_usd
        FROM ${db}.v_sfin_cashflow_semantic GROUP BY tenant_id, org_id, period_date
      ) c USING (tenant_id, org_id, period_date)
      LEFT JOIN (
        SELECT tenant_id, org_id, toStartOfMonth(period_date) AS period_date,
          sum(signed_amount_usd) AS general_ledger_cash_movement_usd
        FROM ${db}.v_sfin_gl_semantic
        WHERE notEmpty(cash_flow_category)
        GROUP BY tenant_id, org_id, period_date
      ) g USING (tenant_id, org_id, period_date)
      GROUP BY k.tenant_id, k.org_id, k.period_date`,

    `CREATE OR REPLACE VIEW ${db}.v_sfin_executive_performance_semantic AS
      SELECT
        b.*,
        if(
          lagInFrame(total_revenue_usd, 12, total_revenue_usd) OVER (
            PARTITION BY tenant_id, org_id, region, business_unit, client_name, delivery_center, service_line
            ORDER BY period_date ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
          ) = 0,
          0,
          100 * (total_revenue_usd - lagInFrame(total_revenue_usd, 12, total_revenue_usd) OVER (
            PARTITION BY tenant_id, org_id, region, business_unit, client_name, delivery_center, service_line
            ORDER BY period_date ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
          )) / abs(lagInFrame(total_revenue_usd, 12, total_revenue_usd) OVER (
            PARTITION BY tenant_id, org_id, region, business_unit, client_name, delivery_center, service_line
            ORDER BY period_date ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
          ))
        ) AS revenue_growth_pct,
        if(
          lagInFrame(ebitda_usd, 12, ebitda_usd) OVER (
            PARTITION BY tenant_id, org_id, region, business_unit, client_name, delivery_center, service_line
            ORDER BY period_date ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
          ) = 0,
          0,
          100 * (ebitda_usd - lagInFrame(ebitda_usd, 12, ebitda_usd) OVER (
            PARTITION BY tenant_id, org_id, region, business_unit, client_name, delivery_center, service_line
            ORDER BY period_date ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
          )) / abs(lagInFrame(ebitda_usd, 12, ebitda_usd) OVER (
            PARTITION BY tenant_id, org_id, region, business_unit, client_name, delivery_center, service_line
            ORDER BY period_date ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
          ))
        ) AS ebitda_growth_pct,
        if(total_revenue_usd = 0, 0, 100 * gross_profit_usd / total_revenue_usd) AS gross_margin_pct
      FROM (
        SELECT
          o.tenant_id AS tenant_id,
          o.org_id AS org_id,
          o.org_name AS org_name,
          o.period_date AS period_date,
          o.region AS region,
          o.business_unit AS business_unit,
          o.client_name AS client_name,
          o.delivery_center AS delivery_center,
          o.service_line AS service_line,
          if(o.period_revenue_usd = 0, 0, ifNull(g.total_revenue_usd, 0) * o.service_revenue_usd / o.period_revenue_usd) AS total_revenue_usd,
          if(o.period_revenue_usd = 0, 0, ifNull(g.gross_profit_usd, 0) * o.service_revenue_usd / o.period_revenue_usd) AS gross_profit_usd,
          if(o.period_revenue_usd = 0, 0, ifNull(g.ebitda_usd, 0) * o.service_revenue_usd / o.period_revenue_usd) AS ebitda_usd,
          if(o.period_productive_hours = 0, 0, ifNull(p.total_payroll_usd, 0) * o.service_productive_hours / o.period_productive_hours) AS total_payroll_usd,
          if(o.period_productive_hours = 0, 0, ifNull(p.employee_headcount, 0) * o.service_productive_hours / o.period_productive_hours) AS employee_headcount,
          o.service_productive_hours AS productive_hours,
          o.utilization_pct AS utilization_pct,
          o.sla_compliance_pct AS sla_compliance_pct,
          o.csat_pct AS csat_pct,
          if(o.period_revenue_usd = 0, 0, ifNull(a.outstanding_receivable_usd, 0) * o.service_revenue_usd / o.period_revenue_usd) AS outstanding_receivable_usd
        FROM (
          -- Allocate every P&L/payroll/AR total to (client × service line) by that
          -- row's share of the PERIOD total (revenue for money, productive hours for
          -- payroll). Denominators partition by tenant/org/period only, so the shares
          -- sum to 1 across all rows in a period and every measure reconciles to the
          -- canonical gl_semantic org total (previously a 6-key join silently dropped
          -- untagged cost/payroll rows, inflating margin and collapsing payroll).
          SELECT tenant_id, org_id, any(org_name) AS org_name, toStartOfMonth(period_date) AS period_date,
            region, business_unit, client_name, delivery_center, service_line,
            sum(revenue_usd) AS service_revenue_usd,
            sum(productive_hours) AS service_productive_hours,
            sum(sum(revenue_usd)) OVER (PARTITION BY tenant_id, org_id, toStartOfMonth(period_date)) AS period_revenue_usd,
            sum(sum(productive_hours)) OVER (PARTITION BY tenant_id, org_id, toStartOfMonth(period_date)) AS period_productive_hours,
            avg(utilization_pct) AS utilization_pct,
            avg(sla_compliance_pct) AS sla_compliance_pct,
            avg(csat_pct) AS csat_pct
          FROM ${db}.v_sfin_operations_semantic
          GROUP BY tenant_id, org_id, period_date, region, business_unit, client_name, delivery_center, service_line
        ) o
        LEFT JOIN (
          SELECT tenant_id, org_id, toStartOfMonth(period_date) AS period_date,
            sum(total_revenue_usd) AS total_revenue_usd,
            sum(gross_profit_usd) AS gross_profit_usd,
            sum(ebitda_usd) AS ebitda_usd
          FROM ${db}.v_sfin_gl_semantic
          GROUP BY tenant_id, org_id, period_date
        ) g USING (tenant_id, org_id, period_date)
        LEFT JOIN (
          SELECT tenant_id, org_id, toStartOfMonth(period_date) AS period_date,
            sum(total_payroll_usd) AS total_payroll_usd,
            uniqExact(employee_headcount_key) AS employee_headcount
          FROM ${db}.v_sfin_payroll_semantic
          GROUP BY tenant_id, org_id, period_date
        ) p USING (tenant_id, org_id, period_date)
        LEFT JOIN (
          SELECT tenant_id, org_id, toStartOfMonth(period_date) AS period_date,
            sum(outstanding_receivable_usd) AS outstanding_receivable_usd
          FROM ${db}.v_sfin_ar_semantic
          GROUP BY tenant_id, org_id, period_date
        ) a USING (tenant_id, org_id, period_date)
      ) b`,
  ];
}
