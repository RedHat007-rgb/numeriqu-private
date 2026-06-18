/**
 * Legacy widget vocabulary — every (type, metric, grouping) the vocab/metricData
 * planner can emit. Extracted from agent.service.ts (Phase 3 decomposition).
 * Pure data, no runtime deps. Slated for retirement with the legacy planner once
 * AGENT_LEGACY_FALLBACK=0 is validated in staging.
 */

export const VALID_WIDGETS = [
  // ── Time-series trends (line charts)
  { type: 'line', metric: 'revenue', grouping: 'month' },
  // Bar variant for when the user explicitly asks for bars over time
  { type: 'bar', metric: 'revenue', grouping: 'month' },
  { type: 'line', metric: 'outstanding', grouping: 'month' },
  { type: 'line', metric: 'paid', grouping: 'month' },
  { type: 'line', metric: 'invoice_count', grouping: 'month' },
  { type: 'bar', metric: 'invoice_count', grouping: 'month' },
  { type: 'line', metric: 'overdue', grouping: 'month' },
  { type: 'line', metric: 'collection_rate', grouping: 'month' },
  { type: 'line', metric: 'mom_growth', grouping: 'month' },
  { type: 'line', metric: 'revenue', grouping: 'quarter' },
  { type: 'line', metric: 'avg_invoice', grouping: 'month' },
  { type: 'bar', metric: 'avg_invoice', grouping: 'month' },
  // ── Comparison bars — entity / period
  { type: 'bar', metric: 'revenue', grouping: 'org' },
  { type: 'bar', metric: 'revenue', grouping: 'quarter' },
  { type: 'bar', metric: 'invoices', grouping: 'org' },
  { type: 'bar', metric: 'outstanding', grouping: 'org' },
  { type: 'bar', metric: 'overdue', grouping: 'org' },
  // ── Client-level bars (sourced from dim_clients gold table)
  { type: 'bar', metric: 'revenue', grouping: 'client' },
  { type: 'bar', metric: 'total_invoiced', grouping: 'client' },
  { type: 'bar', metric: 'outstanding', grouping: 'client' },
  { type: 'bar', metric: 'overdue', grouping: 'client' },
  { type: 'bar', metric: 'invoices', grouping: 'client' },
  { type: 'bar', metric: 'avg_invoice', grouping: 'client' },
  { type: 'bar', metric: 'paid', grouping: 'client' },
  { type: 'bar', metric: 'collection_rate', grouping: 'client' },
  { type: 'bar', metric: 'overdue_rate', grouping: 'client' },
  // ── Proportional pies
  { type: 'pie', metric: 'revenue', grouping: 'client' },
  { type: 'pie', metric: 'revenue', grouping: 'provider' },
  // ── Revenue by GL account / category (from journal lines)
  { type: 'bar', metric: 'revenue', grouping: 'account' },
  { type: 'horizontal_bar', metric: 'revenue', grouping: 'account' },
  { type: 'pie', metric: 'revenue', grouping: 'account' },
  { type: 'donut', metric: 'revenue', grouping: 'account' },
  { type: 'bar', metric: 'revenue', grouping: 'category' },
  { type: 'horizontal_bar', metric: 'revenue', grouping: 'category' },
  { type: 'pie', metric: 'revenue', grouping: 'category' },
  { type: 'treemap', metric: 'revenue', grouping: 'account' },
  { type: 'treemap', metric: 'revenue', grouping: 'category' },
  { type: 'bar', metric: 'pl_comparison', grouping: 'summary' },
  { type: 'pie', metric: 'invoices', grouping: 'status' },
  { type: 'pie', metric: 'outstanding', grouping: 'client' },
  // ── Metric tiles
  { type: 'kpi', metric: 'summary', grouping: 'overview' },
  { type: 'gauge', metric: 'financial_health', grouping: 'summary' },
  { type: 'metric', metric: 'venture', grouping: 'summary' },
  { type: 'metric', metric: 'top5_revenue_share', grouping: 'summary' },
  { type: 'metric', metric: 'collected_vs_outstanding', grouping: 'summary' },
  // ── Tables
  { type: 'table', metric: 'invoices', grouping: 'list' },
  { type: 'table', metric: 'overdue', grouping: 'aging' },
  { type: 'table', metric: 'payment_days', grouping: 'list' },
  // ── Payment efficiency distributions
  { type: 'bar', metric: 'payment_days', grouping: 'bucket' },
  { type: 'line', metric: 'dso', grouping: 'month' },

  // ── P&L / Income Statement (sourced from fact_accounting_journal_lines)
  { type: 'line', metric: 'net_income', grouping: 'month' },
  { type: 'bar', metric: 'net_income', grouping: 'month' },
  { type: 'bar', metric: 'net_income', grouping: 'quarter' },
  { type: 'line', metric: 'expense', grouping: 'month' },
  { type: 'bar', metric: 'expense', grouping: 'month' },
  { type: 'bar', metric: 'expense', grouping: 'quarter' },
  { type: 'line', metric: 'gross_profit', grouping: 'month' },
  { type: 'line', metric: 'gross_margin_pct', grouping: 'month' },
  { type: 'line', metric: 'net_margin_pct', grouping: 'month' },
  { type: 'line', metric: 'ebitda', grouping: 'month' },
  { type: 'line', metric: 'revenue_vs_expense', grouping: 'month' },
  { type: 'bar', metric: 'revenue_vs_expense', grouping: 'month' },

  // ── Expense breakdowns by GL account
  { type: 'bar', metric: 'expense', grouping: 'account' },
  { type: 'pie', metric: 'expense', grouping: 'account' },
  // Expense breakdowns by user-defined cost category (e.g., Admin / Marketing / Sales)
  { type: 'bar', metric: 'expense', grouping: 'category' },
  { type: 'pie', metric: 'expense', grouping: 'category' },
  { type: 'bar', metric: 'opex', grouping: 'account' },
  { type: 'bar', metric: 'cogs', grouping: 'account' },
  // Admin-only expense cuts (requires map_account_cost_categories mapping)
  { type: 'line', metric: 'admin_expense', grouping: 'month' },
  { type: 'bar', metric: 'admin_expense', grouping: 'month' },
  { type: 'bar', metric: 'admin_expense', grouping: 'account' },
  { type: 'table', metric: 'admin_expense', grouping: 'list' },

  // ── CFO / controller-style extras
  { type: 'area', metric: 'revenue_cumulative', grouping: 'month' },
  { type: 'line', metric: 'revenue_cumulative', grouping: 'month' },
  { type: 'bar', metric: 'debits_credits', grouping: 'month' },
  { type: 'stacked_bar', metric: 'debits_credits', grouping: 'month' },
  { type: 'bar', metric: 'net_position', grouping: 'month' },
  { type: 'waterfall', metric: 'net_position', grouping: 'month' },
  { type: 'line', metric: 'running_balance', grouping: 'month' },
  { type: 'bar', metric: 'invoice_amount', grouping: 'bucket' },
  { type: 'table', metric: 'top_invoices', grouping: 'list' },
  { type: 'pie', metric: 'invoice_value', grouping: 'invoice_type' },
  { type: 'pie', metric: 'transaction_value', grouping: 'journal_type' },
  { type: 'pie', metric: 'transaction_value', grouping: 'currency' },
  { type: 'treemap', metric: 'expense', grouping: 'account' },
  { type: 'scatter', metric: 'invoice_amount', grouping: 'time' },

  // ── P&L tables and metric tiles
  { type: 'table', metric: 'pl', grouping: 'summary' },
  { type: 'table', metric: 'expense', grouping: 'list' },
  { type: 'table', metric: 'gl_transactions', grouping: 'list' },
  { type: 'metric', metric: 'pl_summary', grouping: 'summary' },
  { type: 'metric', metric: 'expense_summary', grouping: 'summary' },

  // ── Department dimension (QB DepartmentRef / Xero TrackingCategory 1)
  { type: 'bar', metric: 'expense', grouping: 'department' },
  { type: 'pie', metric: 'expense', grouping: 'department' },
  { type: 'donut', metric: 'expense', grouping: 'department' },
  { type: 'treemap', metric: 'expense', grouping: 'department' },
  { type: 'horizontal_bar', metric: 'expense', grouping: 'department' },
  { type: 'stacked_bar', metric: 'expense', grouping: 'department' },
  { type: 'line', metric: 'expense', grouping: 'department' },
  { type: 'bar', metric: 'net_income', grouping: 'department' },
  { type: 'line', metric: 'net_income', grouping: 'department' },
  { type: 'bar', metric: 'revenue', grouping: 'department' },
  { type: 'pie', metric: 'revenue', grouping: 'department' },

  // ── Class dimension (QB ClassRef / Xero TrackingCategory 2)
  { type: 'bar', metric: 'expense', grouping: 'class' },
  { type: 'pie', metric: 'expense', grouping: 'class' },
  { type: 'donut', metric: 'expense', grouping: 'class' },
  { type: 'treemap', metric: 'expense', grouping: 'class' },
  { type: 'horizontal_bar', metric: 'expense', grouping: 'class' },
  { type: 'stacked_bar', metric: 'expense', grouping: 'class' },

  // ── Vendor dimension (QB VendorRef / Xero contact on bills)
  { type: 'bar', metric: 'expense', grouping: 'vendor' },
  { type: 'horizontal_bar', metric: 'expense', grouping: 'vendor' },
  { type: 'pie', metric: 'expense', grouping: 'vendor' },
  { type: 'donut', metric: 'expense', grouping: 'vendor' },
  { type: 'treemap', metric: 'expense', grouping: 'vendor' },
  { type: 'pareto', metric: 'expense', grouping: 'vendor' },
  { type: 'table', metric: 'expense', grouping: 'vendor' },
  { type: 'bar', metric: 'vendor_count', grouping: 'vendor' },
  { type: 'horizontal_bar', metric: 'vendor_count', grouping: 'vendor' },
  { type: 'line', metric: 'vendor_count', grouping: 'month_vendor' },
  { type: 'heatmap', metric: 'vendor_count', grouping: 'month_vendor' },
  { type: 'matrix', metric: 'vendor_count', grouping: 'month_vendor' },
  { type: 'stacked_bar', metric: 'vendor_count', grouping: 'month_vendor' },
  { type: 'scatter', metric: 'expense', grouping: 'vendor' },
  { type: 'bubble', metric: 'expense', grouping: 'vendor' },
  { type: 'line', metric: 'expense', grouping: 'vendor' },

  // ── Debit / Credit by account type (balance-sheet analysis)
  { type: 'bar', metric: 'debits_credits', grouping: 'account_type' },
  { type: 'stacked_bar', metric: 'debits_credits', grouping: 'account_type' },
  { type: 'pie', metric: 'debits_credits', grouping: 'account_type' },

  // ── Multi-series monthly expense with department breakdown
  { type: 'stacked_bar', metric: 'expense', grouping: 'month_department' },
  { type: 'line', metric: 'expense', grouping: 'month_department' },
  { type: 'area', metric: 'expense', grouping: 'month_department' },
  { type: 'heatmap', metric: 'expense', grouping: 'month_department' },
  { type: 'line', metric: 'expense', grouping: 'month_account' },
  { type: 'line', metric: 'expense', grouping: 'month_class' },
  { type: 'line', metric: 'expense', grouping: 'month_vendor' },
  { type: 'heatmap', metric: 'expense', grouping: 'month_account' },
  { type: 'heatmap', metric: 'expense', grouping: 'account_month' },
  { type: 'heatmap', metric: 'expense', grouping: 'account_department' },
  { type: 'heatmap', metric: 'expense', grouping: 'account_vendor' },
  { type: 'heatmap', metric: 'expense', grouping: 'department_account' },
  { type: 'heatmap', metric: 'expense', grouping: 'department_class' },
  { type: 'heatmap', metric: 'expense', grouping: 'class_department' },
  { type: 'matrix', metric: 'expense', grouping: 'department_vendor' },
  { type: 'matrix', metric: 'expense', grouping: 'account_vendor' },
  { type: 'heatmap', metric: 'expense', grouping: 'vendor_department' },
  { type: 'heatmap', metric: 'expense', grouping: 'vendor_month' },
  { type: 'matrix', metric: 'expense', grouping: 'vendor_account' },
  { type: 'matrix', metric: 'expense', grouping: 'month_vendor' },
  { type: 'matrix', metric: 'expense', grouping: 'vendor_month' },
  // ── Vendor spend trend (multi-series line per vendor over months)
  { type: 'stacked_bar', metric: 'expense', grouping: 'month_vendor' },
  { type: 'area', metric: 'expense', grouping: 'month_vendor' },

  // ── Vendor transactions (scatter / bubble for risk / concentration)
  { type: 'scatter', metric: 'vendor_transactions', grouping: 'vendor' },
  { type: 'bubble', metric: 'vendor_transactions', grouping: 'vendor' },

  // ── GL transactions by vendor (table)
  { type: 'table', metric: 'gl_transactions', grouping: 'vendor' },

  // ── Monthly by class (multi-series)
  { type: 'stacked_bar', metric: 'expense', grouping: 'month_class' },
  { type: 'line', metric: 'expense', grouping: 'month_class' },
  { type: 'area', metric: 'expense', grouping: 'month_class' },

  // ── Dept × Class cross breakdown
  { type: 'stacked_bar', metric: 'expense', grouping: 'dept_class' },
  { type: 'bar', metric: 'expense', grouping: 'dept_class' },

  // ── Department stats scatter
  { type: 'scatter', metric: 'expense', grouping: 'dept_stats' },

  // ── Revenue vs Expense by department
  { type: 'stacked_bar', metric: 'revenue_vs_expense', grouping: 'department' },
  { type: 'bar', metric: 'revenue_vs_expense', grouping: 'department' },

  // ── P&L waterfall
  { type: 'waterfall', metric: 'pl', grouping: 'summary' },

  // ── Monthly financial KPI lines
  { type: 'line', metric: 'gross_profit', grouping: 'month' },
  { type: 'line', metric: 'net_margin', grouping: 'month' },
  { type: 'line', metric: 'expense_ratio', grouping: 'month' },
  { type: 'line', metric: 'net_position', grouping: 'month' },

  // ── Balance sheet: assets / liabilities / equity / balance_sheet summary
  { type: 'donut', metric: 'assets', grouping: 'account_type' },
  { type: 'pie', metric: 'assets', grouping: 'account_type' },
  { type: 'bar', metric: 'assets', grouping: 'breakdown' },
  { type: 'horizontal_bar', metric: 'assets', grouping: 'breakdown' },
  { type: 'donut', metric: 'assets', grouping: 'breakdown' },
  { type: 'donut', metric: 'liabilities', grouping: 'account_type' },
  { type: 'pie', metric: 'liabilities', grouping: 'account_type' },
  { type: 'bar', metric: 'liabilities', grouping: 'breakdown' },
  { type: 'horizontal_bar', metric: 'liabilities', grouping: 'breakdown' },
  { type: 'donut', metric: 'liabilities', grouping: 'breakdown' },
  { type: 'bar', metric: 'equity', grouping: 'breakdown' },
  { type: 'donut', metric: 'equity', grouping: 'breakdown' },
  { type: 'bar', metric: 'balance_sheet', grouping: 'summary' },
  { type: 'donut', metric: 'balance_sheet', grouping: 'summary' },
  { type: 'table', metric: 'trial_balance', grouping: 'summary' },
  { type: 'table', metric: 'trial_balance', grouping: 'list' },
  { type: 'table', metric: 'gl_dump', grouping: 'detail' },
  { type: 'bar', metric: 'income', grouping: 'breakdown' },
  { type: 'donut', metric: 'income', grouping: 'breakdown' },
  { type: 'bar', metric: 'account_type', grouping: 'breakdown' },
  { type: 'donut', metric: 'account_type', grouping: 'breakdown' },

  // ── Account type treemap / top debits / top credits / scatter
  { type: 'treemap', metric: 'accounts', grouping: 'account_type' },
  { type: 'treemap', metric: 'assets', grouping: 'account_type' },
  { type: 'treemap', metric: 'liabilities', grouping: 'account_type' },
  { type: 'treemap', metric: 'equity', grouping: 'breakdown' },
  { type: 'bar', metric: 'debits', grouping: 'account_type' },
  { type: 'bar', metric: 'credits', grouping: 'account_type' },
  { type: 'bar', metric: 'pl_comparison', grouping: 'summary' },
  { type: 'scatter', metric: 'debits_credits', grouping: 'account' },

  // ── Monthly debits vs credits stacked
  { type: 'stacked_bar', metric: 'debits_credits', grouping: 'month' },
  { type: 'donut', metric: 'debits_credits', grouping: 'account_type' },
] as const;
