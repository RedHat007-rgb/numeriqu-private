import type { FinancialProfile } from '../financial-data/financial-data.service';

// ─────────────────────────────────────────────────────────────────────────────
// AGENT CFO SYSTEM PROMPT — Autonomous Financial Intelligence
// The Agent CAN emit [COMMAND:] tags for dashboard generation and tool invocation.
// ─────────────────────────────────────────────────────────────────────────────

export const AGENT_CFO_PROMPT = `You are the NumeriQ Autonomous Financial Agent — the world's most capable AI CFO operating in agentic mode. You combine deep financial expertise with the ability to generate live dashboards, identify strategic opportunities, and produce board-ready analysis autonomously.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
IDENTITY & CAPABILITIES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
You are a seasoned Chief Financial Officer with 20+ years experience across SaaS, fintech, and multi-entity enterprises. You have the technical depth of a quantitative analyst and the communication clarity of a board advisor. Your specialty: turning raw accounting data into precise, actionable intelligence.

WHAT YOU CAN DO IN AGENTIC MODE:
1. Generate real-time financial dashboards with custom chart configurations
2. Perform multi-dimensional financial modeling (scenarios, projections, sensitivity)
3. Conduct forensic analysis (anomaly detection, expense archaeology, revenue attribution)
4. Build investor-grade reports (board packs, LP updates, investor memos)
5. Model what-if scenarios (hiring plans, expansion costs, price changes)
6. Issue proactive financial health alerts and recommendations

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ANALYTICAL FRAMEWORKS YOU APPLY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Revenue Quality: ARR/MRR decomposition, logo concentration, expansion vs new business
- Expense Architecture: Fixed vs variable split, burn efficiency, vendor concentration
- Cash Flow: Operating cash flow, free cash flow, cash conversion cycle
- Working Capital: DSO (Days Sales Outstanding), DPO (Days Payable Outstanding), CCC
- Profitability: Gross margin, EBITDA, contribution margin, unit economics
- Venture Metrics: Burn multiple, runway, magic number, rule of 40
- Risk: Overdue concentration, currency exposure, customer/vendor dependency
- Cohort Analysis: Payment timing patterns, client lifetime value proxies

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ANALYSIS OUTPUT STANDARDS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Every response MUST:
1. Lead with the single most critical financial finding
2. Cite specific numbers from the Fact Block — never approximate or round without noting it
3. Provide cross-entity comparison when multiple orgs exist
4. Flag any anomaly, concentration risk, or trend inflection point
5. End with a concrete prioritized action list with quantified impact
6. Generate a dashboard command that visualizes the analysis

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
MANDATORY RESPONSE STRUCTURE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

## Executive Summary
The single most important financial finding — one sentence, highly specific.

## Financial Intelligence Report
Deep analysis with:
- **Current State**: Key metrics with specific numbers, entity-by-entity breakdown
- **Trend Analysis**: Direction, velocity, and pattern of key metrics over time
- **Anomalies & Risks**: Anything unusual — overdue spikes, concentration, irregularities
- **Benchmarking**: How these metrics compare to industry standards
- **Multi-Entity Comparison**: Side-by-side if multiple orgs connected (use Markdown tables)

## Scenario Analysis
Model 2-3 scenarios based on current trajectory:
- Base case (current trend continues)
- Upside case (what needs to happen for improvement)
- Risk case (what happens if overdue situation worsens / growth slows)

## Priority Actions
5 specific, numbered actions ranked by financial impact. Include the dollar value of each action where calculable.

## Strategic Dashboard
Brief description of the visualization you are generating below.

[COMMAND: GENERATE_DASHBOARD {...}]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DASHBOARD GENERATION CONTRACT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EVERY response MUST end with exactly ONE [COMMAND: GENERATE_DASHBOARD ...] on its own line.

COMMAND FORMAT (minified JSON, no newlines inside):
[COMMAND: GENERATE_DASHBOARD {"title":"<Board-ready title>","description":"<1 sentence>","charts":[...]}]

VALID CHART TYPES: "line", "bar", "pie", "metric", "table"
VALID METRICS: "revenue", "expenses", "invoices", "venture"
VALID GROUPINGS: "org" (for multi-entity), "status" (for invoice status), "month" (for trends)

CHART EXAMPLES:
{"type":"line","config":{"metric":"revenue","grouping":"month","title":"Revenue Trend"}}
{"type":"pie","config":{"metric":"revenue","grouping":"org","title":"Revenue by Entity"}}
{"type":"bar","config":{"metric":"expenses","grouping":"org","title":"Expense Breakdown"}}
{"type":"metric","config":{"metric":"venture","title":"Burn & Runway"}}
{"type":"table","config":{"metric":"invoices","grouping":"status","title":"Invoice Status"}}

ALWAYS include at least 3 charts per dashboard. Tailor chart selection to what the user asked.`;

// ─────────────────────────────────────────────────────────────────────────────
// FACT BLOCK BUILDER — Maximum context for the Agent
// ─────────────────────────────────────────────────────────────────────────────

export function buildAgentFactBlock(
  profile: FinancialProfile,
  monthlyTrend: any[],
): string {
  const orgs = profile.connectedOrgs ?? [];
  const r = profile.revenue;
  const e = profile.expenses;
  const vm = profile.ventureMetrics;

  const fmt = (n: number) =>
    n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  const fmtCurrency = (n: number, cur = 'USD') =>
    new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: cur,
      maximumFractionDigits: 0,
    }).format(n);
  const fmtPct = (n: number) => `${Math.round(n * 10) / 10}%`;

  const orgLines =
    orgs.length > 0
      ? orgs
          .map(
            (o) =>
              `  • ${o.orgName} [${o.provider.toUpperCase()}]: revenue=${fmtCurrency(o.totalRevenue, o.currency)} | invoices=${o.invoiceCount} | currency=${o.currency}`,
          )
          .join('\n')
      : '  (no connected org data)';

  const trendMap = new Map<string, number>();
  for (const row of monthlyTrend ?? []) {
    const m = (row.month ?? '').slice(0, 7);
    trendMap.set(m, (trendMap.get(m) ?? 0) + parseFloat(row.revenue ?? 0));
  }
  const sortedTrend = [...trendMap.entries()].sort(([a], [b]) => a.localeCompare(b));
  const trendLines =
    sortedTrend
      .slice(-6)
      .map(([m, v]) => `  ${m}: ${fmtCurrency(v)}`)
      .join('\n') || '  (no trend data)';

  // Compute MoM and 3M growth
  let growthMetrics = '';
  if (sortedTrend.length >= 2) {
    const last = sortedTrend[sortedTrend.length - 1]![1];
    const prev = sortedTrend[sortedTrend.length - 2]![1];
    const mom = prev > 0 ? ((last - prev) / prev) * 100 : 0;
    growthMetrics = `  MoM Revenue Growth: ${mom >= 0 ? '+' : ''}${Math.round(mom)}%`;
  }
  if (sortedTrend.length >= 4) {
    const last = sortedTrend[sortedTrend.length - 1]![1];
    const prev3 = sortedTrend[sortedTrend.length - 4]![1];
    const q = prev3 > 0 ? ((last - prev3) / prev3) * 100 : 0;
    growthMetrics += `\n  QoQ Revenue Growth: ${q >= 0 ? '+' : ''}${Math.round(q)}%`;
  }

  // Invoice status breakdown
  const invoiceStatus = (profile.invoiceStats?.byStatusAndOrg ?? [])
    .reduce((acc: Record<string, { count: number; amount: number }>, row: any) => {
      const key = row.status ?? 'UNKNOWN';
      if (!acc[key]) acc[key] = { count: 0, amount: 0 };
      acc[key]!.count += Number(row.count ?? 0);
      acc[key]!.amount += Number(row.totalAmount ?? 0);
      return acc;
    }, {});
  const invoiceStatusLines = Object.entries(invoiceStatus)
    .map(([status, data]) => `  ${status}: ${data.count} invoices = ${fmtCurrency(data.amount)}`)
    .join('\n') || '  (no breakdown)';

  // Revenue concentration
  const topOrg = orgs.length > 0 ? orgs.reduce((a, b) => a.totalRevenue > b.totalRevenue ? a : b) : null;
  const concentrationPct = topOrg && r.totalRevenue > 0
    ? Math.round((topOrg.totalRevenue / r.totalRevenue) * 100)
    : 0;

  // Efficiency ratios
  const burnMultiple = r.totalRevenue > 0 && (vm?.burnRate ?? 0) > 0
    ? Math.round((vm!.burnRate / (r.totalRevenue / 12)) * 100) / 100
    : 'N/A';

  return `
╔══════════════════════════════════════════════════════════════╗
║         LIVE FACT BLOCK — Agent Financial Intelligence      ║
║         Freshness: ${profile.computedAt?.slice(0, 19) ?? 'unknown'}Z                    ║
╚══════════════════════════════════════════════════════════════╝

MISSION CONTEXT:
  Entities: ${orgs.length} connected organization(s)
  Providers: ${r.providerCount} ERP system(s)
  Currencies: ${r.currencyCount} currency(ies)

CONNECTED ENTITIES:
${orgLines}

CONSOLIDATED P&L:
  Total Revenue:    ${fmtCurrency(r.totalRevenue)} (${fmt(r.totalInvoices)} invoices)
  Avg Invoice:      ${fmtCurrency(r.avgInvoiceValue)} | Max: ${fmtCurrency(r.maxInvoice)}
  Total Expenses:   ${fmtCurrency(e.totalExpenses)} (${fmt(e.totalBills)} bills)
  Overdue AR:       ${fmtCurrency(e.overdueAmount)} (${e.overdueCount} overdue)
  Net Profit:       ${fmtCurrency(profile.netProfit)}
  Profit Margin:    ${fmtPct(profile.profitMargin)}

REVENUE CONCENTRATION:
  Top Entity: ${topOrg?.orgName ?? 'N/A'} = ${concentrationPct}% of total revenue
  ${concentrationPct > 80 ? '⚠ HIGH CONCENTRATION RISK: >80% in single entity' : concentrationPct > 50 ? '⚡ MODERATE CONCENTRATION: >50% in single entity' : '✓ Healthy distribution'}

INVOICE STATUS BREAKDOWN:
${invoiceStatusLines}

VENTURE / CAPITAL METRICS:
  Monthly Burn:     ${fmtCurrency(vm?.burnRate ?? 0)}/month
  Cash on Hand:     ${fmtCurrency(vm?.cashOnHand ?? 0)}
  Runway:           ${vm?.runwayMonths ?? 0} months
  Efficiency Ratio: ${vm?.efficiencyMultiplier ?? 0}x (rev/burn)
  Burn Multiple:    ${burnMultiple}x

REVENUE TREND (last 6 months):
${trendLines}
${growthMetrics}

ANALYTICAL NOTES:
- Zero values = no synced data, not literal zero
- Revenue = PAID + AUTHORISED invoices from Gold Layer
- Burn = avg 3-month outflows from accounting system
══════════════════════════════════════════════════════════════`;
}

/**
 * Build the messages array for Agent mode.
 */
export function buildAgentMessages(
  profile: FinancialProfile,
  monthlyTrend: any[],
  history: { role: string; content: string }[],
  userQuery: string,
): { role: string; content: string }[] {
  const factBlock = buildAgentFactBlock(profile, monthlyTrend);

  return [
    { role: 'system', content: `${AGENT_CFO_PROMPT}\n\n${factBlock}` },
    ...history,
    { role: 'user', content: userQuery },
  ];
}
