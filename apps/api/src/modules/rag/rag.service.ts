import { Inject, Injectable, Logger } from '@nestjs/common';
import type { PrismaClient } from '@repo/db';
import {
  CLICKHOUSE_ANALYTICS_TOKEN,
  PRISMA_TOKEN,
} from '../../database/database.module';
import type { ClickHouseClient } from '@clickhouse/client';
import {
  resolveLlmRuntimeConfig,
  type LlmProvider,
} from '../../common/llm/llm-config';

// ─── Types ────────────────────────────────────────────────────────────────────

interface FinancialContext {
  connectionCount: number;
  externalOrgIds: string[];
  connectionIds: string[];
  summary: {
    totalRevenue: number;
    openAmount: number;
    overdueAmount: number;
    overdueCount: number;
    invoiceCount: number;
    avgInvoiceValue: number;
  };
  monthlyTrend: Array<{ month: string; revenue: number; invoiceCount: number }>;
  entityBreakdown: Array<{
    orgName: string;
    provider: string;
    totalRevenue: number;
    invoiceCount: number;
    currency: string;
  }>;
  invoiceStatusBreakdown: Array<{
    status: string;
    count: number;
    amount: number;
  }>;
  ventureMetrics: {
    burnRate: number;
    runwayMonths: number;
    cashOnHand: number;
    efficiencyRatio: number;
  };
  semanticSnippets: string[];
  computedAt: string;
}

type TimeRange =
  | { kind: 'ALL_TIME' }
  | { kind: 'MTD' }
  | { kind: 'QTD' }
  | { kind: 'YTD' }
  | { kind: 'LAST_N_DAYS'; days: number }
  | { kind: 'LAST_N_WEEKS'; weeks: number }
  | { kind: 'LAST_N_MONTHS'; months: number }
  | { kind: 'LAST_N_QUARTERS'; quarters: number }
  | { kind: 'LAST_N_YEARS'; years: number };

const SAFE_QUERY_SETTINGS = {
  max_memory_usage: '536870912',
  max_execution_time: 25,
};

// ─── Intent Classification ────────────────────────────────────────────────────

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
  'currency',
  'financial',
  'money',
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
  'burn',
  'runway',
  'ebitda',
  'mrr',
  'arr',
  'cac',
  'ltv',
  'churn',
  'dso',
  'dpo',
  'collections',
  'aging',
  'liquidity',
  'solvency',
  'gross margin',
  'net margin',
  'operating margin',
  'breakeven',
  'entity',
  'subsidiary',
  'segment',
  'department',
  'bank',
  'transfer',
  'saas',
  'subscription',
  'recurring',
  'audit',
  'reconcile',
];

const GREETING_PATTERNS = [
  'hi',
  'hello',
  'hey',
  'sup',
  'help',
  'who are you',
  'what can you do',
  'what do you do',
];

function classifyIntent(query: string): 'greeting' | 'financial' | 'off_topic' {
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

// ─── Prompt Builder ───────────────────────────────────────────────────────────

const RAG_ADVISOR_SYSTEM_PROMPT = `You are Prism — NumeriQ's evidence-first finance calculator.

Your job:
- Answer ONLY what the user asked.
- Use ONLY the numbers in the LIVE FINANCIAL INTELLIGENCE BLOCK (no outside knowledge, no guessing).

Hard constraints:
1) No suggestions, no recommendations, no next steps. Do not tell the user what to do.
2) Be audit-friendly: show the formula and the exact values used.
3) If a metric is not available, say: "Not available in the current gold layer."
4) If the question is ambiguous, ask a clarifying question and provide 4–7 options.

Preferred format:
- A short direct answer (1–3 lines)
- Then a CALCULATION section showing the math
- Then a DATA USED section listing the exact inputs (numbers)`;

function buildFactBlock(ctx: FinancialContext): string {
  const $$ = (n: number) =>
    n >= 1_000_000
      ? `$${(n / 1_000_000).toFixed(2)}M`
      : n >= 1_000
        ? `$${(n / 1_000).toFixed(1)}K`
        : `$${n.toFixed(0)}`;

  // ── Derived: MoM and 3-month trend ─────────────────────────────────────────
  const trend = ctx.monthlyTrend;
  const momChange = (() => {
    if (trend.length < 2) return 'N/A';
    const last = trend[trend.length - 1]!;
    const prev = trend[trend.length - 2]!;
    const pct =
      prev.revenue > 0
        ? ((last.revenue - prev.revenue) / prev.revenue) * 100
        : 0;
    return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
  })();

  const qoqChange = (() => {
    if (trend.length < 6) return 'N/A';
    const recentQ = trend.slice(-3).reduce((s, r) => s + r.revenue, 0);
    const prevQ = trend.slice(-6, -3).reduce((s, r) => s + r.revenue, 0);
    const pct = prevQ > 0 ? ((recentQ - prevQ) / prevQ) * 100 : 0;
    return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
  })();

  const peakMonth =
    trend.length > 0
      ? trend.reduce((a, b) => (b.revenue > a.revenue ? b : a), trend[0]!)
      : null;

  // ── Derived: AR health ──────────────────────────────────────────────────────
  const s = ctx.summary;
  const overdueRate =
    s.openAmount > 0
      ? ((s.overdueAmount / s.openAmount) * 100).toFixed(1)
      : '0.0';
  const collectionEfficiency =
    s.totalRevenue > 0
      ? (((s.totalRevenue - s.openAmount) / s.totalRevenue) * 100).toFixed(1)
      : '0.0';

  // ── Derived: Venture / runway ───────────────────────────────────────────────
  const vm = ctx.ventureMetrics;
  const runwayCliff = (() => {
    if (vm.runwayMonths <= 0 || vm.burnRate <= 0) return 'N/A';
    const d = new Date();
    d.setMonth(d.getMonth() + Math.floor(vm.runwayMonths));
    return d.toISOString().slice(0, 7);
  })();

  const burnMultiple =
    vm.burnRate > 0 && s.totalRevenue > 0
      ? (vm.burnRate / (s.totalRevenue / Math.max(trend.length, 1))).toFixed(
          2,
        ) + 'x'
      : 'N/A';

  // ── Derived: Entity concentration ──────────────────────────────────────────
  const totalEntRevenue = ctx.entityBreakdown.reduce(
    (s, e) => s + e.totalRevenue,
    0,
  );
  const entities =
    ctx.entityBreakdown
      .map((e) => {
        const share =
          totalEntRevenue > 0
            ? ((e.totalRevenue / totalEntRevenue) * 100).toFixed(0)
            : '0';
        return `${e.orgName}[${e.provider}]: ${$$(e.totalRevenue)} (${share}% share, ${e.invoiceCount} inv)`;
      })
      .join('\n  ') || 'none';

  const topEntityShare =
    ctx.entityBreakdown.length > 0 && totalEntRevenue > 0
      ? (
          (ctx.entityBreakdown[0]!.totalRevenue / totalEntRevenue) *
          100
        ).toFixed(0) + '%'
      : 'N/A';

  // ── Derived: Invoice status breakdown ──────────────────────────────────────
  const statuses =
    ctx.invoiceStatusBreakdown
      .map(
        (s) =>
          `${s.status}: ${s.count} inv / ${$$(s.amount)}${s.status.toLowerCase() === 'overdue' ? ' ⚠️' : ''}`,
      )
      .join('\n  ') || 'none';

  // ── 12-month trend series ───────────────────────────────────────────────────
  const trendSeries =
    trend
      .slice(-12)
      .map((r) => `${r.month}:${$$(r.revenue)}(${r.invoiceCount})`)
      .join(', ') || 'none';

  return `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LIVE FINANCIAL INTELLIGENCE BLOCK
As of: ${ctx.computedAt.slice(0, 16)} UTC | Connections: ${ctx.connectionCount} active ERPs
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[REVENUE SUMMARY]
Total Revenue:         ${$$(s.totalRevenue)}
Avg Invoice Value:     ${$$(s.avgInvoiceValue)}
Total Invoices:        ${s.invoiceCount}
Collection Efficiency: ${collectionEfficiency}%

[ACCOUNTS RECEIVABLE]
Open AR:               ${$$(s.openAmount)}
Overdue AR:            ${$$(s.overdueAmount)} (${s.overdueCount} invoices — ${overdueRate}% of open)

[VENTURE HEALTH]
Monthly Burn:          ${$$(vm.burnRate)}/mo
Cash on Hand:          ${$$(vm.cashOnHand)}
Runway:                ${vm.runwayMonths} months (cliff: ${runwayCliff})
Burn Multiple:         ${burnMultiple}
Efficiency Ratio:      ${vm.efficiencyRatio}x

[REVENUE MOMENTUM]
MoM Change:            ${momChange}
QoQ Change:            ${qoqChange}
Peak Month:            ${peakMonth ? `${peakMonth.month} @ ${$$(peakMonth.revenue)}` : 'N/A'}

[ENTITY BREAKDOWN — concentration risk]
Top Entity Share:      ${topEntityShare}
  ${entities}

[INVOICE STATUS PORTFOLIO]
  ${statuses}

[12-MONTH REVENUE SERIES]
  ${trendSeries}
${ctx.semanticSnippets.length > 0 ? '\n[SEMANTIC CONTEXT]\n  ' + ctx.semanticSnippets.slice(0, 4).join('\n  ') : ''}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
}

function buildMessages(
  ctx: FinancialContext,
  history: Array<{ role: string; content: string }>,
  userQuery: string,
): Array<{ role: string; content: string }> {
  const factBlock = buildFactBlock(ctx);
  const systemContent = `${RAG_ADVISOR_SYSTEM_PROMPT}\n\n${factBlock}`;
  return [
    { role: 'system', content: systemContent },
    ...history.slice(-12),
    { role: 'user', content: userQuery },
  ];
}

// ─── Prism Query Helpers ──────────────────────────────────────────────────────

function parseTimeRangeFromQuery(query: string): TimeRange | null {
  const q = query.toLowerCase();
  if (/\b(all time|all-time|lifetime|since inception)\b/.test(q))
    return { kind: 'ALL_TIME' };
  if (/\b(mtd|month to date|month-to-date|this month)\b/.test(q))
    return { kind: 'MTD' };
  if (/\b(qtd|quarter to date|quarter-to-date|this quarter)\b/.test(q))
    return { kind: 'QTD' };
  if (/\b(ytd|year to date|year-to-date|this year)\b/.test(q))
    return { kind: 'YTD' };

  const days = q.match(/\b(last|past)\s+(\d{1,3})\s+days?\b/);
  if (days)
    return {
      kind: 'LAST_N_DAYS',
      days: Math.max(1, Math.floor(Number(days[2]))),
    };
  const weeks = q.match(/\b(last|past)\s+(\d{1,3})\s+weeks?\b/);
  if (weeks)
    return {
      kind: 'LAST_N_WEEKS',
      weeks: Math.max(1, Math.floor(Number(weeks[2]))),
    };
  const months = q.match(/\b(last|past)\s+(\d{1,3})\s+months?\b/);
  if (months)
    return {
      kind: 'LAST_N_MONTHS',
      months: Math.max(1, Math.floor(Number(months[2]))),
    };
  const quarters = q.match(/\b(last|past)\s+(\d{1,2})\s+quarters?\b/);
  if (quarters)
    return {
      kind: 'LAST_N_QUARTERS',
      quarters: Math.max(1, Math.floor(Number(quarters[2]))),
    };
  const years = q.match(/\b(last|past)\s+(\d{1,2})\s+years?\b/);
  if (years)
    return {
      kind: 'LAST_N_YEARS',
      years: Math.max(1, Math.floor(Number(years[2]))),
    };

  if (/\b(last month|previous month)\b/.test(q))
    return { kind: 'LAST_N_MONTHS', months: 1 };
  if (/\b(last quarter|previous quarter)\b/.test(q))
    return { kind: 'LAST_N_QUARTERS', quarters: 1 };
  if (/\b(last year|previous year)\b/.test(q))
    return { kind: 'LAST_N_YEARS', years: 1 };

  return null;
}

function queryNeedsRangeClarification(query: string): boolean {
  const q = query.toLowerCase();
  const impliesPeriod =
    /\b(compare|comparison|trend|month|monthly|quarter|quarterly|qoq|mom|growth|decline|increase|decrease|change|delta|over time)\b/.test(
      q,
    );
  if (!impliesPeriod) return false;
  return parseTimeRangeFromQuery(query) == null;
}

function formatRangeLabel(range: TimeRange): string {
  if (range.kind === 'ALL_TIME') return 'All time';
  if (range.kind === 'MTD') return 'Month to date';
  if (range.kind === 'QTD') return 'Quarter to date';
  if (range.kind === 'YTD') return 'Year to date';
  if (range.kind === 'LAST_N_DAYS') return `Last ${range.days} days`;
  if (range.kind === 'LAST_N_WEEKS') return `Last ${range.weeks} weeks`;
  if (range.kind === 'LAST_N_MONTHS') return `Last ${range.months} months`;
  if (range.kind === 'LAST_N_QUARTERS')
    return `Last ${range.quarters} quarters`;
  if (range.kind === 'LAST_N_YEARS') return `Last ${range.years} years`;
  return 'All time';
}

function formatMoney(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

function pct(n: number): string {
  if (!Number.isFinite(n)) return '0.0%';
  return `${n.toFixed(1)}%`;
}

function buildDeterministicPrismAnswer(
  query: string,
  ctx: FinancialContext,
  range: TimeRange,
): string | null {
  const q = query.toLowerCase();
  const scope = formatRangeLabel(range);
  const s = ctx.summary;

  const asksForAdvice =
    /\b(should i|what should|recommend|recommendation|suggest|next step|action plan)\b/.test(
      q,
    );
  if (asksForAdvice) {
    return [
      `I can’t provide recommendations in Prism.`,
      ``,
      `What do you want to calculate?`,
      `- Revenue (total / trend)`,
      `- Open invoices / overdue exposure`,
      `- Invoice status breakdown`,
      `- Entity breakdown (top entities by revenue)`,
      `- Burn / runway (if available)`,
    ].join('\n');
  }

  const asksProfit =
    /\b(net profit|profit|margin|ebitda|gross margin|net margin|operating margin)\b/.test(
      q,
    );
  if (asksProfit) {
    return [
      `Not available in the current gold layer.`,
      ``,
      `CALCULATION`,
      `- Profit/margin requires a verified expenses/bills model (not present here).`,
      ``,
      `DATA USED`,
      `- Revenue (scope: ${scope}): ${formatMoney(s.totalRevenue)}`,
      `- Open invoices (scope: ${scope}): ${formatMoney(s.openAmount)}`,
    ].join('\n');
  }

  const wantsOverdue = /\boverdue\b/.test(q);
  const wantsOpen = /\b(open|outstanding|unpaid|accounts receivable|ar)\b/.test(
    q,
  );
  const wantsRunway = /\b(runway|burn|cash on hand|cliff)\b/.test(q);
  const wantsStatus =
    /\b(status|paid|authorised|submitted|draft|breakdown)\b/.test(q) &&
    /\binvoice\b/.test(q);
  const wantsEntities =
    /\b(entity|entities|org|organization|client|customers?)\b/.test(q) &&
    (/\btop\b/.test(q) || /\bcompare\b/.test(q) || /\bbreakdown\b/.test(q));
  const wantsTrend =
    /\b(trend|monthly|month|month-wise|over time|mom|qoq|quarter)\b/.test(q) &&
    /\b(revenue|income|invoic)\b/.test(q);
  const wantsRevenue = /\b(revenue|income|invoic(ed)?|sales)\b/.test(q);

  if (wantsOverdue || wantsOpen) {
    const overdueRate =
      s.openAmount > 0 ? (s.overdueAmount / s.openAmount) * 100 : 0;
    return [
      `**Answer (scope: ${scope})**`,
      `- Open invoices: ${formatMoney(s.openAmount)}`,
      `- Overdue: ${formatMoney(s.overdueAmount)} across ${s.overdueCount} invoices`,
      ``,
      `**CALCULATION**`,
      `- Overdue rate = Overdue / Open = ${formatMoney(s.overdueAmount)} / ${formatMoney(s.openAmount)} = ${pct(overdueRate)}`,
      ``,
      `**DATA USED**`,
      `- Open invoices: ${formatMoney(s.openAmount)}`,
      `- Overdue amount: ${formatMoney(s.overdueAmount)}`,
      `- Overdue invoice count: ${s.overdueCount}`,
    ].join('\n');
  }

  if (wantsRunway) {
    const vm = ctx.ventureMetrics;
    const cliff = (() => {
      if (!vm.runwayMonths || vm.runwayMonths <= 0) return 'N/A';
      const d = new Date();
      d.setMonth(d.getMonth() + Math.floor(vm.runwayMonths));
      return d.toISOString().slice(0, 10);
    })();
    return [
      `**Answer (scope: ${scope})**`,
      `- Burn rate: ${formatMoney(vm.burnRate)} / month`,
      `- Cash on hand (derived): ${formatMoney(vm.cashOnHand)}`,
      `- Runway: ${vm.runwayMonths} months (cliff ≈ ${cliff})`,
      ``,
      `**CALCULATION**`,
      `- Runway (months) = Cash on hand / Burn rate`,
      ``,
      `**DATA USED**`,
      `- Burn rate: ${formatMoney(vm.burnRate)}`,
      `- Cash on hand: ${formatMoney(vm.cashOnHand)}`,
    ].join('\n');
  }

  if (wantsStatus) {
    const top = ctx.invoiceStatusBreakdown.slice(0, 8);
    const total = top.reduce((sum, row) => sum + (row.amount || 0), 0);
    const lines = top.map((row) => {
      const share = total > 0 ? (row.amount / total) * 100 : 0;
      return `- ${row.status}: ${row.count} invoices · ${formatMoney(row.amount)} (${pct(share)})`;
    });
    return [
      `**Answer (scope: ${scope})**`,
      ...lines,
      ``,
      `**DATA USED**`,
      `- Invoice status aggregation from fact invoices (top ${top.length} statuses).`,
    ].join('\n');
  }

  if (wantsEntities) {
    const top = ctx.entityBreakdown.slice(0, 6);
    const total = ctx.entityBreakdown.reduce(
      (sum, row) => sum + (row.totalRevenue || 0),
      0,
    );
    const lines = top.map((row) => {
      const share = total > 0 ? (row.totalRevenue / total) * 100 : 0;
      return `- ${row.orgName} (${row.provider}): ${formatMoney(row.totalRevenue)} · ${row.invoiceCount} invoices · ${pct(share)} share`;
    });
    return [
      `**Answer (scope: ${scope})**`,
      ...lines,
      ``,
      `**CALCULATION**`,
      `- Share % = Entity revenue / Total revenue across entities`,
      ``,
      `**DATA USED**`,
      `- Entity breakdown (org_name + provider) from fact invoices.`,
    ].join('\n');
  }

  if (wantsTrend) {
    const series = ctx.monthlyTrend.slice(-12);
    const lines = series.map(
      (row) =>
        `- ${row.month}: ${formatMoney(row.revenue)} · ${row.invoiceCount} invoices`,
    );
    return [
      `**Answer (scope: ${scope})**`,
      ...lines,
      ``,
      `**DATA USED**`,
      `- Monthly aggregation: toStartOfMonth(issued_at) grouped sums.`,
    ].join('\n');
  }

  if (wantsRevenue) {
    return [
      `**Answer (scope: ${scope})**`,
      `- Revenue: ${formatMoney(s.totalRevenue)}`,
      `- Invoices: ${s.invoiceCount}`,
      `- Avg invoice value: ${formatMoney(s.avgInvoiceValue)}`,
      ``,
      `**CALCULATION**`,
      `- Avg invoice = Revenue / Invoice count (from aggregation)`,
      ``,
      `**DATA USED**`,
      `- Revenue, invoice count, and avg invoice value from fact invoices.`,
    ].join('\n');
  }

  return null;
}

// ─── RagService ───────────────────────────────────────────────────────────────

@Injectable()
export class RagService {
  private readonly logger = new Logger(RagService.name);
  private readonly OLLAMA_URL: string;
  private readonly OLLAMA_MODEL: string;
  private readonly llmProvider: LlmProvider;
  private readonly analyticsDb: string;
  private readonly ctxCache = new Map<
    string,
    { ctx: FinancialContext; expiresAt: number }
  >();
  private readonly CACHE_TTL_MS = 90_000; // 90 seconds — fresh enough, cheap enough

  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient,
    @Inject(CLICKHOUSE_ANALYTICS_TOKEN)
    private readonly clickhouse: ClickHouseClient,
  ) {
    const llm = resolveLlmRuntimeConfig('llama3:latest');
    this.llmProvider = llm.provider;
    this.OLLAMA_URL = llm.url;
    this.OLLAMA_MODEL = llm.model;
    this.analyticsDb = process.env.CLICKHOUSE_ANALYTICS_DB || 'analytics';
  }

  // ─── Public Query Entry Point ──────────────────────────────────────────────

  async *query(
    organizationId: string,
    userId: string,
    userQuery: string,
    sessionId?: string,
  ): AsyncGenerator<string> {
    const startTime = Date.now();

    // ── Session management ──────────────────────────────────────────────────
    const session = sessionId
      ? await this.prisma.ragChatSession.findFirst({
          where: { id: sessionId, organizationId, userId },
        })
      : null;

    const currentSession =
      session ??
      (await this.prisma.ragChatSession.create({
        data: { organizationId, userId, title: userQuery.slice(0, 80) },
      }));

    await this.prisma.ragChatMessage.create({
      data: {
        sessionId: currentSession.id,
        organizationId,
        role: 'USER',
        content: userQuery,
      },
    });

    // Load conversation history for multi-turn context
    const historyRows = await this.prisma.ragChatMessage.findMany({
      where: { sessionId: currentSession.id },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    const history = [...historyRows]
      .reverse()
      .slice(0, -1)
      .map((m) => ({
        role: m.role.toLowerCase() === 'user' ? 'user' : 'assistant',
        content: m.content,
      }));

    try {
      // ── Intent classification — fast paths before LLM ──────────────────
      const intent = classifyIntent(userQuery);

      if (intent === 'greeting') {
        const text = `Hi — I'm **Prism**.\n\nAsk me for calculations from your live accounting data (revenue, invoice counts, overdue exposure, entity breakdowns, trends). I answer with math + the exact inputs used.\n\nWhat do you want to calculate?`;
        yield this.chunk('status', { message: 'Ready.' });
        yield this.chunk('token', { content: text });
        await this.prisma.ragChatMessage.create({
          data: {
            sessionId: currentSession.id,
            organizationId,
            role: 'ASSISTANT',
            content: text,
          },
        });
        yield this.chunk('done', {
          metrics: {
            totalMs: Date.now() - startTime,
            mode: 'greeting',
            sessionId: currentSession.id,
          },
        });
        return;
      }

      if (intent === 'off_topic') {
        const text = `I'm specialized in financial intelligence only. I can help you with:\n\n• **Revenue analysis** — trends, growth, concentration risk\n• **Cash flow** — DSO, DPO, cash conversion cycle\n• **Expense management** — burn rate, efficiency, anomalies\n• **Entity performance** — comparing your connected organizations\n• **Venture metrics** — runway, burn, efficiency ratio\n\nPlease ask anything related to your financial data.`;
        yield this.chunk('status', { message: 'Domain check.' });
        yield this.chunk('token', { content: text });
        await this.prisma.ragChatMessage.create({
          data: {
            sessionId: currentSession.id,
            organizationId,
            role: 'ASSISTANT',
            content: text,
          },
        });
        yield this.chunk('done', {
          metrics: {
            totalMs: Date.now() - startTime,
            mode: 'domain-gate',
            sessionId: currentSession.id,
          },
        });
        return;
      }

      // ── Context retrieval ──────────────────────────────────────────────
      yield this.chunk('status', {
        message: 'Loading live financial intelligence...',
      });

      const parsedRange = parseTimeRangeFromQuery(userQuery);
      const range: TimeRange = parsedRange ?? { kind: 'ALL_TIME' };

      if (queryNeedsRangeClarification(userQuery)) {
        const question = 'Which time range should Prism use?';
        const options = [
          { label: 'Last 30 days', value: `${userQuery} (last 30 days)` },
          { label: 'Last 90 days', value: `${userQuery} (last 90 days)` },
          { label: 'MTD', value: `${userQuery} (MTD)` },
          { label: 'QTD', value: `${userQuery} (QTD)` },
          { label: 'YTD', value: `${userQuery} (YTD)` },
          { label: 'All time', value: `${userQuery} (all time)` },
        ];

        yield this.chunk('clarify', {
          question,
          reason:
            'Your question implies a time period, but none was specified.',
          options,
        });

        const text = `${question}\n\n- ${options.map((o) => o.label).join('\n- ')}`;
        yield this.chunk('token', { content: text });
        await this.prisma.ragChatMessage.create({
          data: {
            sessionId: currentSession.id,
            organizationId,
            role: 'ASSISTANT',
            content: text,
          },
        });

        yield this.chunk('done', {
          metrics: {
            totalMs: Date.now() - startTime,
            mode: 'clarify',
            sessionId: currentSession.id,
          },
        });
        return;
      }

      let ctx: FinancialContext;
      const cacheKey = `${organizationId}::${this.rangeKey(range)}`;
      const cached = this.ctxCache.get(cacheKey);
      if (cached && Date.now() < cached.expiresAt) {
        ctx = cached.ctx;
        this.backgroundRefresh(cacheKey, organizationId, range); // warm for next request
      } else {
        ctx = await this.fetchFinancialContext(
          organizationId,
          userQuery,
          range,
        );
        this.ctxCache.set(cacheKey, {
          ctx,
          expiresAt: Date.now() + this.CACHE_TTL_MS,
        });
      }

      // Emit financial snapshot so frontend can render context panel
      yield this.chunk('context', {
        data: {
          totalRevenue: ctx.summary.totalRevenue,
          openAmount: ctx.summary.openAmount,
          overdueAmount: ctx.summary.overdueAmount,
          invoiceCount: ctx.summary.invoiceCount,
          runway: ctx.ventureMetrics.runwayMonths,
          burnRate: ctx.ventureMetrics.burnRate,
          entityCount: ctx.entityBreakdown.length,
          connectionCount: ctx.connectionCount,
          trend: ctx.monthlyTrend.slice(-6),
          scope: formatRangeLabel(range),
        },
      });

      // ── Deterministic Prism answer (default) ──────────────────────────
      yield this.chunk('status', { message: 'Calculating…' });

      const deterministic = buildDeterministicPrismAnswer(
        userQuery,
        ctx,
        range,
      );
      if (deterministic) {
        yield this.chunk('token', { content: deterministic });
        await this.prisma.ragChatMessage.create({
          data: {
            sessionId: currentSession.id,
            organizationId,
            role: 'ASSISTANT',
            content: deterministic,
          },
        });
        yield this.chunk('done', {
          metrics: {
            totalMs: Date.now() - startTime,
            mode: 'deterministic',
            sessionId: currentSession.id,
            scope: formatRangeLabel(range),
          },
        });
        return;
      }

      // If Prism can't confidently map the question to a supported calculation, ask.
      const clarifyQuestion = 'What should Prism calculate from your data?';
      const clarifyOptions = [
        {
          label: 'Revenue (total)',
          value: `What is my total revenue? (${formatRangeLabel(range)})`,
        },
        {
          label: 'Revenue trend (monthly)',
          value: `Show my monthly revenue trend. (${formatRangeLabel(range)})`,
        },
        {
          label: 'Overdue exposure',
          value: `How much is overdue? (${formatRangeLabel(range)})`,
        },
        {
          label: 'Open invoices',
          value: `How much is open (unpaid)? (${formatRangeLabel(range)})`,
        },
        {
          label: 'Entity breakdown',
          value: `Show top entities by revenue. (${formatRangeLabel(range)})`,
        },
        {
          label: 'Invoice status breakdown',
          value: `Break down invoices by status. (${formatRangeLabel(range)})`,
        },
      ];
      yield this.chunk('clarify', {
        question: clarifyQuestion,
        reason:
          'Your request is not specific enough to compute deterministically.',
        options: clarifyOptions,
      });
      const clarifyText = `${clarifyQuestion}\n\n- ${clarifyOptions.map((o) => o.label).join('\n- ')}`;
      yield this.chunk('token', { content: clarifyText });
      await this.prisma.ragChatMessage.create({
        data: {
          sessionId: currentSession.id,
          organizationId,
          role: 'ASSISTANT',
          content: clarifyText,
        },
      });
      yield this.chunk('done', {
        metrics: {
          totalMs: Date.now() - startTime,
          mode: 'clarify',
          sessionId: currentSession.id,
        },
      });
      return;

      // ── LLM streaming (optional, feature-flagged) ─────────────────────
      // Set `PRISM_ENABLE_LLM=1` to allow the model to answer beyond deterministic templates.
      /* c8 ignore next  */
      if (process.env.PRISM_ENABLE_LLM !== '1') return;

      yield this.chunk('status', {
        message: 'Analyzing your financial data...',
      });

      const messages = buildMessages(ctx, history, userQuery);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 300_000);

      let response: Response;
      try {
        response = await fetch(`${this.OLLAMA_URL}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            model: this.OLLAMA_MODEL,
            messages,
            stream: true,
            options: {
              temperature: 0.08,
              num_predict: 2048,
              num_ctx: 8192,
              top_p: 0.92,
              top_k: 40,
              repeat_penalty: 1.1,
              stop: ['<|eot_id|>', '<|end_of_text|>'],
            },
          }),
        });
      } catch (fetchErr: any) {
        clearTimeout(timeout);
        throw new Error(
          fetchErr.name === 'AbortError' ? 'AI_TIMEOUT' : 'AI_ENGINE_OFFLINE',
        );
      }

      if (!response.ok) {
        clearTimeout(timeout);
        throw new Error('AI_ENGINE_OFFLINE');
      }

      const reader = response.body?.getReader();
      if (!reader) {
        clearTimeout(timeout);
        throw new Error('AI_ENGINE_OFFLINE');
      }
      const streamReader = reader as ReadableStreamDefaultReader<Uint8Array>;

      const decoder = new TextDecoder();
      let fullContent = '';
      let streamBuffer = '';
      let lineCarry = '';
      let tokenCount = 0;

      while (true) {
        const { done, value } = await streamReader.read();
        if (done) break;

        lineCarry += decoder.decode(value, { stream: true });
        const lines = lineCarry.split('\n');
        lineCarry = lines.pop() ?? '';

        let streamDone = false;
        for (const line of lines) {
          if (!line.trim()) continue;
          let parsed: { message?: { content?: string }; done?: boolean };
          try {
            parsed = JSON.parse(line);
          } catch {
            continue;
          }

          const token = parsed.message?.content;
          if (token) {
            fullContent += token;
            streamBuffer += token;
            if (streamBuffer.length >= 8) {
              yield this.chunk('token', { content: streamBuffer });
              tokenCount++;
              streamBuffer = '';
            }
          }
          if (parsed.done === true) {
            streamDone = true;
            break;
          }
        }
        if (streamDone) break;
      }

      // Handle leftover carry
      if (lineCarry.trim()) {
        try {
          const parsed = JSON.parse(lineCarry.trim()) as {
            message?: { content?: string };
          };
          const tail = parsed.message?.content;
          if (tail) {
            fullContent += tail;
            streamBuffer += tail;
          }
        } catch {
          /* ignore */
        }
      }

      // Final flush
      if (streamBuffer) {
        yield this.chunk('token', { content: streamBuffer });
        tokenCount++;
      }

      clearTimeout(timeout);

      await this.prisma.ragChatMessage.create({
        data: {
          sessionId: currentSession.id,
          organizationId,
          role: 'ASSISTANT',
          content: fullContent.trim() || 'Analysis complete.',
          contextSnapshot: {
            tokens: tokenCount,
            latencyMs: Date.now() - startTime,
          } as any,
        },
      });

      yield this.chunk('done', {
        metrics: {
          totalMs: Date.now() - startTime,
          tokens: tokenCount,
          mode: 'rag-advisor',
          sessionId: currentSession.id,
          model: this.OLLAMA_MODEL,
        },
      });
    } catch (err: any) {
      const msg = err.name === 'AbortError' ? 'AI_TIMEOUT' : err.message;
      this.logger.error(`[RAG:Fatal] ${msg}`);

      let userMessage: string;
      if (msg === 'AI_ENGINE_OFFLINE' || msg?.includes('ECONNREFUSED')) {
        userMessage =
          '**AI engine is warming up.** Your financial data is available on the dashboard while the advisor initializes. Please try again in 30 seconds.';
      } else if (msg === 'AI_TIMEOUT') {
        userMessage =
          '**Analysis is taking longer than expected.** This usually happens with very large datasets. Please try a more specific question or try again.';
      } else {
        userMessage =
          '**Something went wrong.** Our team has been notified. Please try again — your data is safe.';
      }

      yield this.chunk('error', { message: userMessage });
    }
  }

  // ─── Health Check ──────────────────────────────────────────────────────────

  async health() {
    let ollamaOnline = false;
    let modelLoaded = false;
    try {
      const res = await fetch(`${this.OLLAMA_URL}/api/tags`, {
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const data = (await res.json()) as { models?: Array<{ name: string }> };
        ollamaOnline = true;
        modelLoaded = (data.models ?? []).some((m) =>
          m.name.startsWith(this.OLLAMA_MODEL.split(':')[0] ?? ''),
        );
      }
    } catch {
      /* offline */
    }

    const backendLabel =
      this.llmProvider === 'openai' ? 'OpenAI' : 'Ollama';

    return {
      status: ollamaOnline ? 'operational' : 'degraded',
      advisory: ollamaOnline
        ? `NumeriQ Intelligence ready — ${backendLabel}: ${this.OLLAMA_MODEL}`
        : `${backendLabel} offline at ${this.OLLAMA_URL}`,
      ollama: ollamaOnline,
      provider: this.llmProvider,
      backendUrl: this.OLLAMA_URL,
      model: this.OLLAMA_MODEL,
      modelLoaded,
      uptime: process.uptime(),
    };
  }

  // ─── Session Management ────────────────────────────────────────────────────

  async listSessions(organizationId: string, userId: string) {
    const sessions = await this.prisma.ragChatSession.findMany({
      where: { organizationId, userId },
      orderBy: { updatedAt: 'desc' },
      take: 50,
      include: { _count: { select: { messages: true } } },
    });
    return sessions.map((s) => ({
      id: s.id,
      title: s.title,
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
      messageCount: s._count.messages,
    }));
  }

  async getSession(organizationId: string, userId: string, sessionId: string) {
    const session = await this.prisma.ragChatSession.findFirst({
      where: { id: sessionId, organizationId, userId },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
    if (!session) return null;
    return {
      id: session.id,
      title: session.title,
      messages: session.messages.map((m) => ({
        role: m.role.toLowerCase(),
        content: m.content,
      })),
    };
  }

  // ─── Private: Financial Context Fetching ──────────────────────────────────

  private timeWhere(range?: TimeRange | null): string {
    if (!range || range.kind === 'ALL_TIME') return '';
    if (range.kind === 'MTD') return `AND issued_at >= toStartOfMonth(now())`;
    if (range.kind === 'QTD') return `AND issued_at >= toStartOfQuarter(now())`;
    if (range.kind === 'YTD') return `AND issued_at >= toStartOfYear(now())`;
    if (range.kind === 'LAST_N_DAYS')
      return `AND issued_at >= (now() - INTERVAL ${Math.max(1, Math.floor(range.days))} DAY)`;
    if (range.kind === 'LAST_N_WEEKS')
      return `AND issued_at >= (now() - INTERVAL ${Math.max(1, Math.floor(range.weeks))} WEEK)`;
    if (range.kind === 'LAST_N_MONTHS')
      return `AND issued_at >= (now() - INTERVAL ${Math.max(1, Math.floor(range.months))} MONTH)`;
    if (range.kind === 'LAST_N_QUARTERS')
      return `AND issued_at >= (now() - INTERVAL ${Math.max(1, Math.floor(range.quarters)) * 3} MONTH)`;
    if (range.kind === 'LAST_N_YEARS')
      return `AND issued_at >= (now() - INTERVAL ${Math.max(1, Math.floor(range.years))} YEAR)`;
    return '';
  }

  private rangeKey(range?: TimeRange | null): string {
    if (!range) return 'ALL_TIME';
    if (
      range.kind === 'ALL_TIME' ||
      range.kind === 'MTD' ||
      range.kind === 'QTD' ||
      range.kind === 'YTD'
    )
      return range.kind;
    if (range.kind === 'LAST_N_DAYS') return `LAST_N_DAYS:${range.days}`;
    if (range.kind === 'LAST_N_WEEKS') return `LAST_N_WEEKS:${range.weeks}`;
    if (range.kind === 'LAST_N_MONTHS') return `LAST_N_MONTHS:${range.months}`;
    if (range.kind === 'LAST_N_QUARTERS')
      return `LAST_N_QUARTERS:${range.quarters}`;
    if (range.kind === 'LAST_N_YEARS') return `LAST_N_YEARS:${range.years}`;
    return 'ALL_TIME';
  }

  private async fetchFinancialContext(
    organizationId: string,
    query?: string,
    range?: TimeRange | null,
  ): Promise<FinancialContext> {
    const connections = await this.prisma.erpConnection.findMany({
      where: { organizationId, status: 'ACTIVE' },
      select: {
        id: true,
        externalOrganizationId: true,
        provider: true,
        metadata: true,
      },
    });

    if (connections.length === 0) {
      return this.emptyContext(organizationId);
    }

    const connectionIds = connections.map((c) => c.id);
    const externalOrgIds = connections
      .map((c) => c.externalOrganizationId)
      .filter(Boolean) as string[];

    const [summary, trend, entities, statusBreakdown, venture, snippets] =
      await Promise.allSettled([
        this.fetchSummary(connectionIds, range),
        this.fetchMonthlyTrend(externalOrgIds, range),
        this.fetchEntityBreakdown(connectionIds, connections, range),
        this.fetchStatusBreakdown(connectionIds, range),
        this.fetchVentureMetrics(connectionIds, range),
        this.fetchSemanticSnippets(organizationId, query),
      ]);

    return {
      connectionCount: connections.length,
      externalOrgIds,
      connectionIds,
      summary:
        summary.status === 'fulfilled'
          ? summary.value
          : {
              totalRevenue: 0,
              openAmount: 0,
              overdueAmount: 0,
              overdueCount: 0,
              invoiceCount: 0,
              avgInvoiceValue: 0,
            },
      monthlyTrend: trend.status === 'fulfilled' ? trend.value : [],
      entityBreakdown: entities.status === 'fulfilled' ? entities.value : [],
      invoiceStatusBreakdown:
        statusBreakdown.status === 'fulfilled' ? statusBreakdown.value : [],
      ventureMetrics:
        venture.status === 'fulfilled'
          ? venture.value
          : { burnRate: 0, runwayMonths: 0, cashOnHand: 0, efficiencyRatio: 0 },
      semanticSnippets: snippets.status === 'fulfilled' ? snippets.value : [],
      computedAt: new Date().toISOString(),
    };
  }

  private async fetchSummary(
    connectionIds: string[],
    range?: TimeRange | null,
  ) {
    const time = this.timeWhere(range);
    const result = await this.clickhouse.query({
      query: `
        SELECT
          count()                                                        AS invoice_count,
          coalesce(sumIf(total_amount, total_amount > 0), 0)             AS total_revenue,
          coalesce(avgIf(total_amount, total_amount > 0), 0)             AS avg_invoice,
          coalesce(sumIf(total_amount, total_amount > 0 AND lowerUTF8(status) NOT IN ('paid','closed','authorised')), 0) AS open_amount,
          coalesce(sumIf(total_amount, total_amount > 0 AND lowerUTF8(status) IN ('overdue')), 0) AS overdue_amount,
          coalesce(countIf(lowerUTF8(status) = 'overdue'), 0)           AS overdue_count
        FROM ${this.analyticsDb}.fact_accounting_invoices
        WHERE connection_id IN ({connectionIds:Array(String)})
          ${time}
      `,
      query_params: { connectionIds },
      format: 'JSONEachRow',
      clickhouse_settings: SAFE_QUERY_SETTINGS,
    });
    const rows: any[] = await result.json();
    const r = rows[0] ?? {};
    return {
      totalRevenue: parseFloat(r.total_revenue) || 0,
      openAmount: parseFloat(r.open_amount) || 0,
      overdueAmount: parseFloat(r.overdue_amount) || 0,
      overdueCount: parseInt(r.overdue_count) || 0,
      invoiceCount: parseInt(r.invoice_count) || 0,
      avgInvoiceValue: parseFloat(r.avg_invoice) || 0,
    };
  }

  private async fetchMonthlyTrend(
    externalOrgIds: string[],
    range?: TimeRange | null,
  ) {
    if (externalOrgIds.length === 0) return [];
    const time = this.timeWhere(range);
    const result = await this.clickhouse.query({
      query: `
        SELECT
          formatDateTime(toStartOfMonth(issued_at), '%Y-%m') AS month,
          coalesce(sumIf(total_amount, total_amount > 0), 0) AS revenue,
          count()                                            AS invoice_count
        FROM ${this.analyticsDb}.fact_accounting_invoices
        WHERE org_id IN ({externalOrgIds:Array(String)})
          ${time}
        GROUP BY month
        ORDER BY month ASC
        LIMIT 48
      `,
      query_params: { externalOrgIds },
      format: 'JSONEachRow',
      clickhouse_settings: SAFE_QUERY_SETTINGS,
    });
    const rows: any[] = await result.json();
    return rows.map((r) => ({
      month: r.month as string,
      revenue: parseFloat(r.revenue) || 0,
      invoiceCount: parseInt(r.invoice_count) || 0,
    }));
  }

  private async fetchEntityBreakdown(
    connectionIds: string[],
    connections: any[],
    range?: TimeRange | null,
  ) {
    const time = this.timeWhere(range);
    const result = await this.clickhouse.query({
      query: `
        SELECT
          org_name,
          provider,
          any(currency)              AS currency,
          coalesce(sumIf(total_amount, total_amount > 0), 0) AS total_revenue,
          count()                    AS invoice_count
        FROM ${this.analyticsDb}.fact_accounting_invoices
        WHERE connection_id IN ({connectionIds:Array(String)})
          ${time}
        GROUP BY org_name, provider
        ORDER BY total_revenue DESC
      `,
      query_params: { connectionIds },
      format: 'JSONEachRow',
      clickhouse_settings: SAFE_QUERY_SETTINGS,
    });
    const rows: any[] = await result.json();

    // Seed from prisma metadata if ClickHouse returns empty
    if (rows.length === 0) {
      return connections.map((c) => {
        const meta = (c.metadata as Record<string, any>) ?? {};
        return {
          orgName:
            meta.orgName ??
            meta.companyId ??
            c.externalOrganizationId ??
            'Unknown',
          provider: c.provider as string,
          totalRevenue: 0,
          invoiceCount: 0,
          currency: 'USD',
        };
      });
    }

    return rows.map((r) => ({
      orgName: (r.org_name as string) || 'Unknown Entity',
      provider: (r.provider as string) || 'unknown',
      totalRevenue: parseFloat(r.total_revenue) || 0,
      invoiceCount: parseInt(r.invoice_count) || 0,
      currency: (r.currency as string) || 'USD',
    }));
  }

  private async fetchStatusBreakdown(
    connectionIds: string[],
    range?: TimeRange | null,
  ) {
    const time = this.timeWhere(range);
    const result = await this.clickhouse.query({
      query: `
        SELECT
          status,
          count()                        AS invoice_count,
          coalesce(sumIf(total_amount, total_amount > 0), 0) AS total_amount
        FROM ${this.analyticsDb}.fact_accounting_invoices
        WHERE connection_id IN ({connectionIds:Array(String)})
          ${time}
        GROUP BY status
        ORDER BY total_amount DESC
        LIMIT 20
      `,
      query_params: { connectionIds },
      format: 'JSONEachRow',
      clickhouse_settings: SAFE_QUERY_SETTINGS,
    });
    const rows: any[] = await result.json();
    return rows.map((r) => ({
      status: (r.status as string) || 'UNKNOWN',
      count: parseInt(r.invoice_count) || 0,
      amount: parseFloat(r.total_amount) || 0,
    }));
  }

  private async fetchVentureMetrics(
    connectionIds: string[],
    range?: TimeRange | null,
  ) {
    try {
      const time = this.timeWhere(range);
      const result = await this.clickhouse.query({
        query: `
          SELECT
            coalesce(avg(monthly_outflow), 0) AS burn_rate,
            coalesce(sum(monthly_net), 0)     AS total_inflow
          FROM (
            SELECT
              toStartOfMonth(issued_at)    AS month,
              sum(abs(total_amount))       AS monthly_outflow,
              sum(total_amount)            AS monthly_net
            FROM ${this.analyticsDb}.fact_accounting_invoices
            WHERE connection_id IN ({connectionIds:Array(String)})
              AND total_amount < 0
              ${time}
            GROUP BY month
            ORDER BY month DESC
            LIMIT 3
          )
        `,
        query_params: { connectionIds },
        format: 'JSONEachRow',
        clickhouse_settings: SAFE_QUERY_SETTINGS,
      });
      const rows: any[] = await result.json();
      const r = rows[0] ?? {};
      const burn = parseFloat(r.burn_rate) || 0;
      const inflow = parseFloat(r.total_inflow) || 0;
      return {
        burnRate: Math.round(burn),
        runwayMonths: burn > 0 ? Math.round((inflow / burn) * 10) / 10 : 0,
        cashOnHand: Math.round(inflow),
        efficiencyRatio: burn > 0 ? Math.round((inflow / burn) * 100) / 100 : 0,
      };
    } catch {
      return {
        burnRate: 0,
        runwayMonths: 0,
        cashOnHand: 0,
        efficiencyRatio: 0,
      };
    }
  }

  private async fetchSemanticSnippets(tenantId: string, query?: string) {
    if (!tenantId) return [];
    try {
      const result = await this.clickhouse.query({
        query: `
          SELECT text_content
          FROM ${this.analyticsDb}.rag_context_invoices
          WHERE tenant_id = {tenantId:String}
            ${query ? `AND hasAny(splitByNonAlpha(lower(text_content)), splitByNonAlpha(lower({query:String})))` : ''}
          LIMIT 5
        `,
        query_params: { tenantId, ...(query ? { query } : {}) },
        format: 'JSONEachRow',
        clickhouse_settings: SAFE_QUERY_SETTINGS,
      });
      const rows: any[] = await result.json();
      return rows.map((r) => String(r.text_content ?? '')).filter(Boolean);
    } catch {
      return [];
    }
  }

  private backgroundRefresh(
    cacheKey: string,
    organizationId: string,
    range: TimeRange,
  ) {
    this.fetchFinancialContext(organizationId, undefined, range)
      .then((ctx) =>
        this.ctxCache.set(cacheKey, {
          ctx,
          expiresAt: Date.now() + this.CACHE_TTL_MS,
        }),
      )
      .catch(() => {
        /* non-critical */
      });
  }

  private emptyContext(organizationId: string): FinancialContext {
    return {
      connectionCount: 0,
      externalOrgIds: [],
      connectionIds: [],
      summary: {
        totalRevenue: 0,
        openAmount: 0,
        overdueAmount: 0,
        overdueCount: 0,
        invoiceCount: 0,
        avgInvoiceValue: 0,
      },
      monthlyTrend: [],
      entityBreakdown: [],
      invoiceStatusBreakdown: [],
      ventureMetrics: {
        burnRate: 0,
        runwayMonths: 0,
        cashOnHand: 0,
        efficiencyRatio: 0,
      },
      semanticSnippets: [],
      computedAt: new Date().toISOString(),
    };
  }

  private chunk(type: string, payload: Record<string, unknown>): string {
    return JSON.stringify({ type, ...payload }) + '\n';
  }
}
