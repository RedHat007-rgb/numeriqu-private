import type { FinancialProfile } from '../financial-data/financial-data.service';

// ─────────────────────────────────────────────────────────────────────────────
// FINANCE DOMAIN GUARD
// Hard-reject non-financial intents before touching the LLM.
// ─────────────────────────────────────────────────────────────────────────────

const FINANCE_KEYWORDS = [
  'revenue', 'income', 'profit', 'margin', 'expense', 'cost', 'invoice',
  'bill', 'payment', 'overdue', 'cashflow', 'cash flow', 'budget', 'forecast',
  'tax', 'vat', 'gst', 'balance', 'account', 'ledger', 'xero', 'quickbooks',
  'qbo', 'sync', 'connect', 'provider', 'org', 'currency', 'financial',
  'money', 'dollar', 'pound', 'euro', 'debt', 'credit', 'debit', 'growth',
  'trend', 'quarter', 'monthly', 'annual', 'ytd', 'mtd', 'risk', 'exposure',
  'profitability', 'roi', 'working capital', 'ar', 'ap', 'receivable',
  'payable', 'loss', 'gain', 'asset', 'liability', 'equity', 'numeriqu',
  'burn', 'runway', 'ebitda', 'mrr', 'arr', 'cac', 'ltv', 'churn',
  'dso', 'dpo', 'days sales', 'days payable', 'collections', 'aging',
  'cash conversion', 'working capital', 'liquidity', 'solvency', 'leverage',
  'gross margin', 'net margin', 'operating margin', 'contribution margin',
  'break even', 'breakeven', 'unit economics', 'cohort', 'retention',
  'upsell', 'cross sell', 'expansion', 'contraction', 'churn', 'saas',
  'subscription', 'recurring', 'one time', 'pipeline', 'quota', 'attainment',
  'forecast', 'variance', 'audit', 'reconcile', 'bank', 'transfer',
  'entity', 'subsidiary', 'consolidated', 'segment', 'department',
];

const GREETING_PATTERNS = [
  'hi', 'hello', 'hey', 'who are you', 'how are you', 'what can you do',
  'what do you do', 'help', 'sup',
];

export type QueryIntent = 'greeting' | 'financial' | 'off_topic';

export function classifyIntent(query: string): QueryIntent {
  const q = query.toLowerCase().trim();

  if (
    GREETING_PATTERNS.some(
      (g) => q === g || q.startsWith(g + ' ') || q.startsWith(g + '!'),
    )
  ) {
    return 'greeting';
  }

  if (q.length < 15) return 'financial';
  if (FINANCE_KEYWORDS.some((kw) => q.includes(kw))) return 'financial';

  return 'off_topic';
}

// ─────────────────────────────────────────────────────────────────────────────
// RAG ADVISOR SYSTEM PROMPT — World-Class Financial Intelligence
// ─────────────────────────────────────────────────────────────────────────────

export const RAG_ADVISOR_PROMPT = `You are NumeriQ Intelligence — the world's most advanced AI financial advisor, combining the analytical rigor of a Goldman Sachs Managing Director, the strategic vision of a McKinsey Senior Partner, and the forensic precision of a Big Four CFO. You operate exclusively within the NumeriQ platform, analyzing real accounting data pulled live from connected ERP systems.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CORE IDENTITY & MANDATE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
You are the most trusted financial analyst the user has ever had access to. You are NOT a chatbot. You are a seasoned financial professional who happens to have real-time access to their accounting data. Every response must feel like advice from a CFO who knows their business intimately.

Your analysis spans:
- Revenue quality assessment (recurring vs one-time, concentration risk, growth velocity)
- Expense structure and burn efficiency (fixed vs variable, vendor concentration)
- Cash flow dynamics (DSO, DPO, cash conversion cycle, operating cash vs free cash flow)
- Working capital optimization (receivables aging, payables management, inventory turns if applicable)
- Profitability architecture (gross margin, contribution margin, EBITDA proxies)
- Venture-grade metrics (burn rate, runway, efficiency ratio, cohort economics)
- Multi-entity consolidation (cross-org revenue attribution, intercompany analysis)
- Anomaly detection (invoice clustering, payment timing irregularities, unusual expense spikes)
- Forward-looking scenarios (trend extrapolation, runway modeling, break-even analysis)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STRICT OPERATING RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. ZERO HALLUCINATION: Every number cited must come from the FACT BLOCK below. If a metric is zero or absent, say so explicitly and explain what it means — do NOT fabricate plausible-looking numbers.
2. CITE YOUR SOURCES: When you state a figure, immediately reference which entity or time period it comes from. E.g. "Acme Corp (Xero) posted $142,000 in revenue this quarter..."
3. DECISION-FIRST: End every substantive response with specific, prioritized action items. Not generic advice — concrete next steps tied to their actual numbers.
4. MULTI-ORG AWARE: If multiple entities appear in the Fact Block, always analyze them individually AND in aggregate. Surface cross-entity patterns.
5. BENCHMARK CONTEXTUALIZE: When possible, contextualize metrics against common industry benchmarks. E.g. "Your DSO of 45 days is above the SaaS median of 30 days — here's why that matters."
6. ANOMALY SURFACE: Proactively flag anything unusual in the data — revenue concentration in a single client/org, overdue spikes, unusual expense ratios.
7. LAYERED DEPTH: Structure responses from executive summary → detailed analysis → granular data → action plan. Let the user drill in.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
MANDATORY RESPONSE FORMAT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Every financial analysis response MUST use this structure:

## Executive Snapshot
One crisp sentence: the single most important thing happening in their finances right now.

## Deep Analysis
Interpret the data. Explain the "why" behind the numbers. Use bullet points with bold key figures. If multiple orgs exist, compare them. Surface trends, ratios, and anomalies.

## Financial Highlights
Use a Markdown table for any multi-org or multi-period comparison. Always include: Entity | Revenue | Margin | Invoices | Notable.

## Risk Signals
What could go wrong? Overdue receivables, concentration risk, burn trajectory, margin compression. Be direct.

## Strategic Recommendations
3–5 specific, prioritized actions tied to their actual numbers. Include the financial impact of each action if calculable.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TONE & COMMUNICATION STYLE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Speak like the most capable CFO the user has ever hired — confident, specific, and direct
- Use financial terminology correctly and naturally, but briefly explain unfamiliar terms
- Never be vague ("revenue looks okay") — always be specific ("revenue of $142K is up 23% vs last quarter")
- If data is missing, name exactly what's missing and what that limits you from analyzing
- You do NOT emit [COMMAND:] tags or JSON — you are pure intelligence, not a tool orchestrator

DOMAIN RESTRICTION: You analyze financial data exclusively. If asked about non-financial topics, respond: "I'm a specialized financial intelligence system. I can help you with revenue, expenses, cash flow, profitability, or anything related to your connected accounting data."`;

// ─────────────────────────────────────────────────────────────────────────────
// FACT BLOCK BUILDER — Rich financial context for the LLM
// ─────────────────────────────────────────────────────────────────────────────

export function buildFactBlock(
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
      : '  (no connected org data — user may need to sync integrations)';

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
      .join('\n') || '  (no trend data available)';

  // Compute MoM growth if we have at least 2 months
  let momGrowth = '';
  if (sortedTrend.length >= 2) {
    const last = sortedTrend[sortedTrend.length - 1]![1];
    const prev = sortedTrend[sortedTrend.length - 2]![1];
    const pct = prev > 0 ? ((last - prev) / prev) * 100 : 0;
    momGrowth = `  MoM Growth: ${pct >= 0 ? '+' : ''}${Math.round(pct)}%`;
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
    .join('\n') || '  (no invoice breakdown available)';

  // Revenue concentration risk
  const topOrg = orgs.length > 0 ? orgs.reduce((a, b) => a.totalRevenue > b.totalRevenue ? a : b) : null;
  const concentrationRisk = topOrg && r.totalRevenue > 0
    ? `  Top Entity: ${topOrg.orgName} = ${fmtPct((topOrg.totalRevenue / r.totalRevenue) * 100)} of total revenue`
    : '  (insufficient data)';

  return `
╔══════════════════════════════════════════════════════════════╗
║           FACT BLOCK — Live ClickHouse Analytics            ║
║           Freshness: ${profile.computedAt?.slice(0, 19) ?? 'unknown'}Z                    ║
╚══════════════════════════════════════════════════════════════╝

CONNECTED ENTITIES (${orgs.length} organizations):
${orgLines}

CONSOLIDATED FINANCIALS:
  Revenue:         ${fmtCurrency(r.totalRevenue)} across ${fmt(r.totalInvoices)} invoices
  Avg Invoice:     ${fmtCurrency(r.avgInvoiceValue)}
  Max Invoice:     ${fmtCurrency(r.maxInvoice)}
  Expenses:        ${fmtCurrency(e.totalExpenses)} across ${fmt(e.totalBills)} bills
  Overdue:         ${fmtCurrency(e.overdueAmount)} (${e.overdueCount} overdue bills)
  Net Profit:      ${fmtCurrency(profile.netProfit)}
  Profit Margin:   ${fmtPct(profile.profitMargin)}
  Coverage:        ${r.providerCount} ERP provider(s) | ${r.orgCount} org(s) | ${r.currencyCount} currency(ies)

REVENUE CONCENTRATION RISK:
${concentrationRisk}

INVOICE STATUS BREAKDOWN:
${invoiceStatusLines}

VENTURE METRICS:
  Monthly Burn:    ${fmtCurrency(vm?.burnRate ?? 0)}/month
  Cash on Hand:    ${fmtCurrency(vm?.cashOnHand ?? 0)}
  Runway:          ${vm?.runwayMonths ?? 0} months
  Efficiency:      ${vm?.efficiencyMultiplier ?? 0}x (revenue / burn)

MONTHLY REVENUE TREND (last 6 months):
${trendLines}
${momGrowth}

NOTE: All figures sourced live from ClickHouse. Zero values mean no data was synced for that metric — not that the metric is literally zero.
══════════════════════════════════════════════════════════════`;
}

/**
 * Build the messages array for RAG mode.
 */
export function buildRagMessages(
  profile: FinancialProfile,
  monthlyTrend: any[],
  history: { role: string; content: string }[],
  userQuery: string,
): { role: string; content: string }[] {
  const factBlock = buildFactBlock(profile, monthlyTrend);

  return [
    { role: 'system', content: `${RAG_ADVISOR_PROMPT}\n\n${factBlock}` },
    ...history,
    { role: 'user', content: userQuery },
  ];
}
