import type { FinancialProfile } from '../financial-data/financial-data.service';

// ─────────────────────────────────────────────────────────────────────────────
// FINANCE DOMAIN GUARD
// Hard-reject non-financial intents before touching the LLM.
// This alone saves 500ms-3s per irrelevant query by never calling Ollama.
// ─────────────────────────────────────────────────────────────────────────────

const FINANCE_KEYWORDS = [
  'revenue', 'income', 'profit', 'margin', 'expense', 'cost', 'invoice',
  'bill', 'payment', 'overdue', 'cashflow', 'cash flow', 'budget', 'forecast',
  'tax', 'vat', 'gst', 'balance', 'account', 'ledger', 'xero', 'quickbooks',
  'qbo', 'sync', 'connect', 'provider', 'org', 'currency', 'financial',
  'money', 'dollar', 'pound', 'euro', 'debt', 'credit', 'debit', 'growth',
  'trend', 'quarter', 'monthly', 'annual', 'ytd', 'mtd', 'risk', 'exposure',
  'profitability', 'roi', 'working capital', 'ar', 'ap', 'receivable', 'payable',
  'loss', 'gain', 'asset', 'liability', 'equity', 'numeriqu',
];

const GREETING_PATTERNS = [
  'hi', 'hello', 'hey', 'who are you', 'how are you', 'what can you do',
  'what do you do', 'help', 'sup',
];

export type QueryIntent = 'greeting' | 'financial' | 'off_topic';

/**
 * Classify the user's intent. This is the domain gate — only financial
 * queries proceed to the LLM. Responses are instant for greetings/off-topic.
 */
export function classifyIntent(query: string): QueryIntent {
  const q = query.toLowerCase().trim();

  if (GREETING_PATTERNS.some(g => q === g || q.startsWith(g + ' ') || q.startsWith(g + '!'))) {
    return 'greeting';
  }

  // Short queries (< 15 chars) that aren't greetings get routed as financial
  if (q.length < 15) return 'financial';

  if (FINANCE_KEYWORDS.some(kw => q.includes(kw))) return 'financial';

  return 'off_topic';
}

// ─────────────────────────────────────────────────────────────────────────────
// RAG ADVISOR SYSTEM PROMPT
// The Advisor is a conversational concierge — NO commands, NO tool invocations.
// ─────────────────────────────────────────────────────────────────────────────

export const RAG_ADVISOR_PROMPT = `You are the Numeriqu Personal Advisor (RAG Layer) — an elite AI system combining:
- A top-tier Financial Analyst (McKinsey / Goldman Sachs level)
- A Staff-level Software Engineer (Silicon Valley standard)
- A World-class Product Designer (modern SaaS & data platforms)

MANDATORY DEEP RESEARCH MODE:
Before generating ANY response, you MUST internally simulate studying top ERP systems, financial analytics platforms, and YC-backed BI tools. Apply their architecture documentation, error handling strategies, and UX systems to your reasoning. Do NOT copy their exact logic—APPLY their principles for enterprise-grade advisory. 

CORE PRINCIPLES (STRICT):
1. ZERO HALLUCINATION: Never fabricate data. Only use data provided in the Fact Block below. If data is missing or $(0), clearly state assumptions. Always prefer correctness over completeness.
2. DECISION-FIRST THINKING: Every output must help a business decision. Avoid dumping raw numbers without interpretation. Always answer: "What should the user DO next?"
3. UNIVERSAL UX: Explain insights so a 10-year-old can understand, yet make them deep enough for a CEO to trust.
4. TONE: Professional, articulate, and friendly. Like a private banker.

RAG LAYER MISSION (Knowledge Intelligence):
Provide deep, structured, logically explained, and multi-layered reasoning. Do NOT emit [COMMAND:] tags or JSON configurations; you are pure conversational intelligence. Focus on historical data analysis, trends, root causes, and business impact. ALWAYS use Markdown for visual hierarchy.

STRICT ANALYTICAL RULES:
1. ACKNOWLEDGE IDENTITY: Always mention specific organization names you see in the Fact Block.
2. CONTEXT AWARENESS: Use the conversation history below to provide contextual, follow-up responses and smart recommendations.
3. DOMAIN VETO: Only discuss finances. Politely redirect off-topic questions.
4. STRUCTURE YOUR OUTPUT: You must follow this output format strictly: Break your response into logical sections (e.g., DEEP ANALYSIS, KEY INSIGHTS, RECOMMENDATIONS).`;

// ─────────────────────────────────────────────────────────────────────────────
// FACT BLOCK BUILDER
// ─────────────────────────────────────────────────────────────────────────────

export function buildFactBlock(profile: FinancialProfile, monthlyTrend: any[]): string {
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
  - Data Coverage:    ${r.providerCount} Providers | ${r.orgCount} Orgs
  - Last Freshness:   ${profile.computedAt.slice(0, 19)}Z

MONTHLY REVENUE TREND (Historical Grounds):
${trendLines}
==========================================`;
}

/**
 * Build the messages array for RAG mode.
 * Includes conversation history for multi-turn context.
 */
export function buildRagMessages(
  profile: FinancialProfile,
  monthlyTrend: any[],
  history: { role: string; content: string }[],
  userQuery: string,
): { role: string; content: string }[] {
  const factBlock = buildFactBlock(profile, monthlyTrend);

  return [
    { role: 'system', content: `${RAG_ADVISOR_PROMPT}\n${factBlock}` },
    ...history,
    { role: 'user', content: userQuery },
  ];
}
