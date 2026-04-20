import type { FinancialProfile } from './financial-data.service';

// ─────────────────────────────────────────────────────────────────────────────
// FINANCE DOMAIN GUARD
// Hard-reject non-financial intents before touching the LLM.
// This alone saves 500ms-3s per irrelevant query by never calling Ollama.
// ─────────────────────────────────────────────────────────────────────────────

const FINANCE_KEYWORDS = [
  'revenue',
  'income',
  'profit',
  'margin',
  'expense',
  'cost',
  'invoice',
  'bill',
  'payment',
  'overdue',
  'cashflow',
  'cash flow',
  'budget',
  'forecast',
  'tax',
  'vat',
  'gst',
  'balance',
  'account',
  'ledger',
  'xero',
  'quickbooks',
  'qbo',
  'sync',
  'connect',
  'provider',
  'org',
  'currency',
  'financial',
  'money',
  'dollar',
  'pound',
  'euro',
  'debt',
  'credit',
  'debit',
  'growth',
  'trend',
  'quarter',
  'monthly',
  'annual',
  'ytd',
  'mtd',
  'risk',
  'exposure',
  'profitability',
  'roi',
  'working capital',
  'ar',
  'ap',
  'receivable',
  'payable',
  'loss',
  'gain',
  'asset',
  'liability',
  'equity',
  'numeriqu',
];

const GREETING_PATTERNS = [
  'hi',
  'hello',
  'hey',
  'who are you',
  'how are you',
  'what can you do',
  'what do you do',
  'help',
  'sup',
];

export type QueryIntent = 'greeting' | 'financial' | 'off_topic';

/**
 * Classify the user's intent. This is the domain gate — only financial
 * queries proceed to the LLM. Responses are instant for greetings/off-topic.
 */
export function classifyIntent(query: string): QueryIntent {
  const q = query.toLowerCase().trim();

  if (
    GREETING_PATTERNS.some(
      (g) => q === g || q.startsWith(g + ' ') || q.startsWith(g + '!'),
    )
  ) {
    return 'greeting';
  }

  // Short queries (< 15 chars) that aren't greetings get routed as financial
  // (e.g. "P&L", "ARR?", "margin?")
  if (q.length < 15) return 'financial';

  if (FINANCE_KEYWORDS.some((kw) => q.includes(kw))) return 'financial';

  return 'off_topic';
}

// ─────────────────────────────────────────────────────────────────────────────
// SYSTEM PROMPT — Tightly scoped, compression-optimized
// Rule: every token in the system prompt costs latency. Cut ruthlessly.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// SYSTEM PROMPTS — Specialized Personas
// ─────────────────────────────────────────────────────────────────────────────

export const ADVISOR_PROMPT = `You are the Numeriqu Personal Advisor — a sophisticated, RAG-grounded financial concierge.
Your goal is to provide deep, accurate, and professional conversational guidance based on live accounting data.

STRICT ANALYTICAL RULES:
1. ACKNOWLEDGE IDENTITY: Always mention the specific organization names you see in the Fact Block (e.g., "Arvion Services Sdn Bhd").
2. DATA OVER GENERALITY: If the user asks for revenue, do not give generic growth advice. Give the EXACT numbers from the Fact Block.
3. HANDLING ZEROES: If the Fact Block shows $(0) or "no trend data", explain that you see their authorized connection but the data is still being processed or finalized in ClickHouse.
4. AGENT GATE: YOU ARE NOT AN AGENT: Never emit [COMMAND:] tags. You only talk.
5. DOMAIN VETO: Only discuss finances.
6. TONE: Professional, articulate, and friendly. Like a private banker.`;

export const AGENT_PROMPT = `You are the Numeriqu Strategic Agent — a high-performance Forensic CFO.
Your goal is deep analytical orchestration and visualization.

MISSIONS & TOOLS:
1. SAVE_INSIGHT: Use to design and pin an insight component to the dashboard.
   MANDATORY: Use EXACT JSON. NO PLACEHOLDERS.
   VALID TYPES: "line", "bar", "pie", "metric", "table".
   VALID METRICS: "revenue", "expenses", "invoices", "venture".
   Example: [COMMAND: SAVE_INSIGHT { "type": "table", "title": "Forensic Invoice Stream", "description": "Direct grounding from raw custom ingestion stream", "config": { "metric": "invoices", "grouping": "none" } }]

2. QUERY_SQL: Use ONLY if the Fact Block lacks necessary depth.
   MANDATORY: Provide valid ClickHouse SQL for the "Gold Layer".
   Example: [COMMAND: QUERY_SQL { "sql": "SELECT ...", "reason": "Verifying cost anomalies" }]

STRICT EXECUTION RULES:
- VISUAL SELECTION: Use "type": "table" + "metric": "invoices" for requests to "list", "show", "audit", or "verify" transaction-level data.
- ZERO TOLERANCE for placeholders like "metric": "revenue|expenses". Choose ONE based on user mission.
- NEVER use emoticons, icons (like :]), or text-based symbols to represent data. "Pictorial representation" means specifically using the SAVE_INSIGHT chart command.
- NEVER mention JSON or SQL in your visible text. The machinery is invisible.
- REVEAL: Provide a high-level strategic narrative FIRST, then emit the [COMMAND:] on its own line.
- GROUNDING: Use ONLY data provided in the Fact Block. If data is missing (e.g., $0), explain why.`;

// ─────────────────────────────────────────────────────────────────────────────
// FACT BLOCK BUILDER
// ─────────────────────────────────────────────────────────────────────────────

export function buildFactBlock(
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
      .slice(-6)
      .map(([m, v]) => `  ${m}: ${fmtCurrency(v)}`)
      .join('\n') || '  (no trend data)';

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
 * Assemble the final messages array sent to Ollama.
 */
export function buildMessages(
  profile: FinancialProfile,
  monthlyTrend: any[],
  userQuery: string,
  mode: 'advisor' | 'agent' = 'advisor',
): { role: string; content: string }[] {
  const factBlock = buildFactBlock(profile, monthlyTrend);
  const systemPrompt = mode === 'agent' ? AGENT_PROMPT : ADVISOR_PROMPT;

  return [
    { role: 'system', content: `${systemPrompt}\n${factBlock}` },
    { role: 'user', content: userQuery },
  ];
}
