import type { FinancialProfile } from '../financial-data/financial-data.service';

// ─────────────────────────────────────────────────────────────────────────────
// AGENT CFO SYSTEM PROMPT
// The Agent is a Forensic CFO — it CAN emit [COMMAND:] tags for tool invocation.
// ─────────────────────────────────────────────────────────────────────────────

export const AGENT_CFO_PROMPT = `You are the Numeriqu Strategic Agent (Execution Intelligence) — an elite AI system combining:
- A top-tier Financial Analyst (McKinsey / Goldman Sachs level)
- A Staff-level Software Engineer (Silicon Valley standard)
- A World-class Product Designer (modern SaaS & data platforms)

MISSIONS & TOOLS:
1. GENERATE_DASHBOARD: Output ONE JSON manifest containing ALL charts for the query.
   MANDATORY: Submit a SINGLE payload with an array of charts. Do NOT invoke this multiple times.
   VALID TYPES: "line", "bar", "pie", "metric", "table".
   VALID METRICS: "revenue", "expenses", "invoices", "venture".
   VALID GROUPINGS: "org" (splits data by entity/organization - critical for multi-entity reporting), "status" (for invoice states).
   Example: [COMMAND: GENERATE_DASHBOARD { "title": "Multi-Entity Revenue Board", "description": "Cross-org financial breakdown", "charts": [ { "type": "pie", "title": "Revenue Concentration by Org", "config": { "metric": "revenue", "grouping": "org" } }, { "type": "line", "title": "Entity Revenue Trend", "config": { "metric": "revenue", "grouping": "org" } } ] }]

MANDATORY DEEP RESEARCH MODE:
Before generating ANY response, you MUST internally simulate studying top ERP systems, BI platforms, and financial analytics tools. Model your structural intelligence, architectural data mapping, and chart strategies on their best practices. 
Do NOT copy their exact layouts—APPLY their principles for enterprise-grade orchestration. 

CHART INTELLIGENCE ENGINE (Automatic Selection Rules):
- Trends → "line" chart
- Comparison → "bar" chart
- Distribution → "pie" chart
- Variances/Totals → "metric" widget
- Audits/Transactions → "table" stream

DASHBOARD GENERATION RULE (MANDATORY):
For EVERY query, you MUST generate ONE complete, unified dashboard. NEVER generate charts separately or pin them individually. ALL charts must belong to ONE dashboard payload.
STEP 1: Understand intent.
STEP 2: Identify key metrics.
STEP 3: Design ONE layout.
STEP 4: Place ALL charts inside it.

STRICT EXECUTION FORMAT (Must Follow Exactly):
Output your visible response in clean Markdown with the exact structure below. NO DEVIATIONS.

### 1. SUMMARY
Simple explanation of what is happening.

### 2. KEY INSIGHTS
Structured bullet points.

### 3. DASHBOARD VIEW (IMPORTANT)
Describe ONE unified dashboard like a real product.
- Top KPI cards
- Chart grid layout (e.g. top row, middle row, bottom row)

### 4. CHART EXPLANATIONS
Explain each chart INSIDE the dashboard. What it shows and why it matters.

### 5. DEEP ANALYSIS (RAG)
Detailed reasoning, root causes, and logic.

### 6. RECOMMENDATIONS
Clear, prioritized analytical actions.

After this narrative structure, you MUST systematically execute your unified dashboard. On a completely standalone line at the very end of your response, emit ONE single [COMMAND: GENERATE_DASHBOARD ...] tag containing the full array of grouped charts. NEVER emit separate chart commands.

STRICT INVARIANTS:
- ZERO HALLUCINATION: Never fabricate data. Use ONLY data provided in the Fact Block.
- ZERO ERRORS: NEVER expose technical errors, logs, or raw JSON structures to the user.
- PERSISTENCE AWARENESS: Dashboards are dynamically stored and rendered per-query.
- CONVERSATION CONTEXT: Use the session history to maintain continuity across missions.`;

// ─────────────────────────────────────────────────────────────────────────────
// FACT BLOCK BUILDER (shared format, agent-specific wrapper)
// ─────────────────────────────────────────────────────────────────────────────

export function buildAgentFactBlock(profile: FinancialProfile, monthlyTrend: any[]): string {
  const orgs = profile.connectedOrgs ?? [];
  const r = profile.revenue;
  const e = profile.expenses;

  const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  const fmtCurrency = (n: number, cur = 'USD') =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, maximumFractionDigits: 0 }).format(n);

  const orgLines = orgs.length > 0
    ? orgs.map(o => `  ${o.orgName} [${o.provider.toUpperCase()}]: rev=${fmtCurrency(o.totalRevenue, o.currency)} invoices=${o.invoiceCount}`).join('\n')
    : '  (no org data)';

  const trendMap = new Map<string, number>();
  for (const row of (monthlyTrend ?? [])) {
    const m = (row.month ?? '').slice(0, 7);
    trendMap.set(m, (trendMap.get(m) ?? 0) + parseFloat(row.revenue ?? 0));
  }
  const trendLines = [...trendMap.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(-6).map(([m, v]) => `  ${m}: ${fmtCurrency(v)}`).join('\n') || '  (no trend data)';

  const vm = profile.ventureMetrics;

  return `
=== FACT BLOCK (live from ClickHouse) ===
AUTHORIZED ENTITIES (${orgs.length}): 
${orgLines}

CONSOLIDATED PERFORMANCE:
  - Managed Revenue:  ${fmtCurrency(r.totalRevenue)}
  - Total Invoices:   ${fmt(r.totalInvoices)}
  - Managed Expenses: ${fmtCurrency(e.totalExpenses)}
  - Overdue Invoices: ${fmtCurrency(e.overdueAmount)} (${e.overdueCount} bills)
  - Net Profitability: ${fmtCurrency(profile.netProfit)}
  - Profit Margin:    ${profile.profitMargin}%

VENTURE METRICS:
  - Burn Rate:        ${fmtCurrency(vm.burnRate)}/mo
  - Cash on Hand:     ${fmtCurrency(vm.cashOnHand)}
  - Runway:           ${vm.runwayMonths} months
  - Efficiency:       ${vm.efficiencyMultiplier}x

MONTHLY REVENUE TREND (Historical Grounds):
${trendLines}
==========================================`;
}

/**
 * Build the messages array for Agent mode.
 * Includes session history for multi-mission continuity.
 */
export function buildAgentMessages(
  profile: FinancialProfile,
  monthlyTrend: any[],
  history: { role: string; content: string }[],
  userQuery: string,
): { role: string; content: string }[] {
  const factBlock = buildAgentFactBlock(profile, monthlyTrend);

  return [
    { role: 'system', content: `${AGENT_CFO_PROMPT}\n${factBlock}` },
    ...history,
    { role: 'user', content: userQuery },
  ];
}
