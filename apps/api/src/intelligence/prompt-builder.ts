import type { FinancialProfile } from './financial-data.service';

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
  // (e.g. "P&L", "ARR?", "margin?")
  if (q.length < 15) return 'financial';

  if (FINANCE_KEYWORDS.some(kw => q.includes(kw))) return 'financial';

  return 'off_topic';
}

// ─────────────────────────────────────────────────────────────────────────────
// SYSTEM PROMPT — Tightly scoped, compression-optimized
// Rule: every token in the system prompt costs latency. Cut ruthlessly.
// ─────────────────────────────────────────────────────────────────────────────

export const FINANCE_SYSTEM_PROMPT = `You are Numeriqu Intelligence, an elite Senior CFO and financial architect based in Silicon Valley, advising a highly successful enterprise.

Your goal is to provide exceptional, conversational, deeply analytical financial advisory. You do NOT just repeat numbers—you interpret them, provide strategic insights, explain what the numbers mean for the business, and highlight trends, risks, and opportunities.

RULES (non-negotiable):
1. ACT AS A HIGH-END STRATEGIC ADVISOR: Write in a confident, articulate, and insightful tone. Feel like ChatGPT, but specialized in finance. Provide rich, conversational answers.
2. NO HALLUCINATIONS: You have a FACT BLOCK below. Use ONLY these real numbers for data. Never invent figures. 
3. SYNTHESIZE AND EXPLAIN: When asked a simple question (like "What is my revenue?"), don't just output a single line. Break down the revenue, compare it to expenses or profit margin, and explain the overall financial health based on the context provided.
4. BE MULTI-ORG AWARE: If there are multiple orgs, explicitly mention them by name (e.g., "Demo Company [XERO]") so the user knows where the numbers come from.
5. FORMATTING: Use markdown for readability (bolding key metrics, using bullet points for structural clarity, but wrapping them in flowing paragraphs).
6. IF NO DATA: Say: "I need you to complete a sync first to load your financial data before we can dive into the analysis."
7. IF NON-FINANCIAL: Pivot back politely: "My expertise is strictly focused on your financial architecture, revenue growth, and operational metrics."

You are expected to deliver a world-class strategic breakdown for every query.`;

// ─────────────────────────────────────────────────────────────────────────────
// FACT BLOCK BUILDER — Compressed financial context injector
// Compression strategy: JSON is verbose. We use a tabular plaintext format
// that's ~40% smaller than JSON, giving the model the same signal with fewer tokens.
// ─────────────────────────────────────────────────────────────────────────────

export function buildFactBlock(profile: FinancialProfile, monthlyTrend: any[]): string {
  const orgs = profile.connectedOrgs ?? [];
  const r = profile.revenue;
  const e = profile.expenses;

  const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  const fmtCurrency = (n: number, cur = 'USD') =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, maximumFractionDigits: 0 }).format(n);

  // Per-org summary (the most important context)
  const orgLines = orgs.length > 0
    ? orgs.map(o =>
        `  ${o.orgName} [${o.provider.toUpperCase()}]: rev=${fmtCurrency(o.totalRevenue, o.currency)} invoices=${o.invoiceCount}`
      ).join('\n')
    : '  (no org data — trigger a sync)';

  // Monthly trend: last 6 months only, aggregated across orgs
  const trendMap = new Map<string, number>();
  for (const row of (monthlyTrend ?? [])) {
    const m = (row.month ?? '').slice(0, 7);
    trendMap.set(m, (trendMap.get(m) ?? 0) + parseFloat(row.revenue ?? 0));
  }
  const trendLines = [...trendMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-6)
    .map(([m, v]) => `  ${m}: ${fmtCurrency(v)}`)
    .join('\n') || '  (no trend data)';

  return `
=== FACT BLOCK (live from ClickHouse) ===
ORGS (${orgs.length}): ${orgs.map(o => `${o.orgName}[${o.provider.toUpperCase()}]`).join(', ') || 'none'}
${orgLines}

AGGREGATE:
  Revenue:  ${fmtCurrency(r.totalRevenue)}  |  Invoices: ${fmt(r.totalInvoices)}
  Expenses: ${fmtCurrency(e.totalExpenses)} |  Overdue:  ${fmtCurrency(e.overdueAmount)} (${e.overdueCount} bills)
  Net Profit: ${fmtCurrency(profile.netProfit)} | Margin: ${profile.profitMargin}%
  Providers: ${r.providerCount} | Orgs: ${r.orgCount} | As of: ${profile.computedAt.slice(0, 19)}Z

MONTHLY REVENUE TREND (last 6 months):
${trendLines}
==========================================`;
}

/**
 * Assemble the final messages array sent to Ollama.
 */
export function buildMessages(
  profile: FinancialProfile,
  monthlyTrend: any[],
  userQuery: string,
): { role: string; content: string }[] {
  const factBlock = buildFactBlock(profile, monthlyTrend);
  return [
    { role: 'system', content: `${FINANCE_SYSTEM_PROMPT}\n${factBlock}` },
    { role: 'user',   content: userQuery },
  ];
}
