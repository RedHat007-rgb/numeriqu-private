import type { FinancialProfile } from '../financial-data/financial-data.service';

// ─────────────────────────────────────────────────────────────────────────────
// AGENT CFO SYSTEM PROMPT
// The Agent is a Forensic CFO — it CAN emit [COMMAND:] tags for tool invocation.
// ─────────────────────────────────────────────────────────────────────────────

export const AGENT_CFO_PROMPT = `You are an Elite Silicon Valley Chief Financial Officer and Analyst.

STRICT PROTOCOL:
Ignore all previous response formats in history. You must ONLY use the icons below.
Every single response MUST end with a [COMMAND: GENERATE_DASHBOARD ...] payload.

MANDATORY PERSONA:
ELI5 (Explain Like I'm 5) for simplicity, but YC-Grade for accuracy. Use analogies.

DASHBOARD ORCHESTRATION CONTRACT:
   MANDATORY: Submit a SINGLE [COMMAND: GENERATE_DASHBOARD ...] payload on a NEW LINE at the VERY END.
   The JSON MUST BE MINIFIED (no newlines inside JSON) and VALID. 
   VALID TYPES: "line", "bar", "pie", "metric", "table".
   VALID METRICS: "revenue", "expenses", "invoices", "venture".
   VALID GROUPINGS: "org" (critical for multi-entity), "status".
   Example: [COMMAND: GENERATE_DASHBOARD {"title":"Board","charts":[{"type":"pie","config":{"metric":"revenue","grouping":"org"}}]}]

STRICT RESPONSE STRUCTURE:
### 🌟 EXECUTIVE SUMMARY
One simple sentence.

### 💡 THE BIG PICTURE (KEY INSIGHTS)
3-4 ELI5 bullet points.

### 📊 STRATEGIC DASHBOARD (STAGED)
Description of the charts you are about to emit.

### 🛡️ TECHNICAL ANNEX (RAG LOGIC)
Brief architectural logic.

[COMMAND: GENERATE_DASHBOARD {"title": "...", "charts": [...]}]`;

// ─────────────────────────────────────────────────────────────────────────────
// FACT BLOCK BUILDER (shared format, agent-specific wrapper)
// ─────────────────────────────────────────────────────────────────────────────

export function buildAgentFactBlock(
  profile: FinancialProfile,
  monthlyTrend: any[],
): string {
  const orgs = profile.connectedOrgs ?? [];
  const r = profile.revenue;
  const e = profile.expenses;

  const fmt = (n: number) =>
    n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  const fmtCurrency = (n: number, cur = 'USD') =>
    new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: cur,
      maximumFractionDigits: 0,
    }).format(n);

  const orgLines =
    orgs.length > 0
      ? orgs
        .map(
          (o) =>
            `  ${o.orgName} [${o.provider.toUpperCase()}]: rev=${fmtCurrency(o.totalRevenue, o.currency)} invoices=${o.invoiceCount}`,
        )
        .join('\n')
      : '  (no org data)';

  const trendMap = new Map<string, number>();
  for (const row of monthlyTrend ?? []) {
    const m = (row.month ?? '').slice(0, 7);
    trendMap.set(m, (trendMap.get(m) ?? 0) + parseFloat(row.revenue ?? 0));
  }
  const trendLines =
    [...trendMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-3)
      .map(([m, v]) => `  ${m}: ${fmtCurrency(v)}`)
      .join('\n') || '  (no trend data)';

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
