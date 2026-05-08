import { Inject, Injectable, Logger } from '@nestjs/common';
import type { PrismaClient } from '@repo/db';
import {
  CLICKHOUSE_ANALYTICS_TOKEN,
  PRISMA_TOKEN,
} from '../../database/database.module';
import type { ClickHouseClient } from '@clickhouse/client';

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

const SAFE_QUERY_SETTINGS = {
  max_memory_usage: '536870912',
  max_execution_time: 25,
};

// ─── Intent Classification ────────────────────────────────────────────────────

const FINANCE_KEYWORDS = [
  'revenue', 'income', 'profit', 'margin', 'expense', 'cost', 'invoice',
  'bill', 'payment', 'overdue', 'cashflow', 'cash flow', 'budget', 'forecast',
  'tax', 'vat', 'gst', 'balance', 'account', 'ledger', 'xero', 'quickbooks',
  'currency', 'financial', 'money', 'debt', 'credit', 'debit', 'growth',
  'trend', 'quarter', 'monthly', 'annual', 'ytd', 'mtd', 'risk', 'exposure',
  'profitability', 'roi', 'working capital', 'ar', 'ap', 'receivable',
  'payable', 'loss', 'gain', 'asset', 'liability', 'equity', 'numeriqu',
  'burn', 'runway', 'ebitda', 'mrr', 'arr', 'cac', 'ltv', 'churn',
  'dso', 'dpo', 'collections', 'aging', 'liquidity', 'solvency',
  'gross margin', 'net margin', 'operating margin', 'breakeven',
  'entity', 'subsidiary', 'segment', 'department', 'bank', 'transfer',
  'saas', 'subscription', 'recurring', 'audit', 'reconcile',
];

const GREETING_PATTERNS = [
  'hi', 'hello', 'hey', 'sup', 'help', 'who are you', 'what can you do', 'what do you do',
];

function classifyIntent(query: string): 'greeting' | 'financial' | 'off_topic' {
  const q = query.toLowerCase().trim();
  if (GREETING_PATTERNS.some((g) => q === g || q.startsWith(g + ' ') || q.startsWith(g + '!'))) {
    return 'greeting';
  }
  if (q.length < 15) return 'financial';
  if (FINANCE_KEYWORDS.some((kw) => q.includes(kw))) return 'financial';
  return 'off_topic';
}

// ─── Prompt Builder ───────────────────────────────────────────────────────────

const RAG_ADVISOR_SYSTEM_PROMPT = `You are NumeriQ Intelligence — a Goldman Sachs Managing Director-level CFO AI with 25 years of institutional finance experience and real-time access to the user's live accounting data. You combine the analytical depth of a McKinsey Financial Advisory partner, the precision of a Bloomberg Terminal, and the strategic urgency of a board-facing CFO.

━━━ IDENTITY ━━━
You have managed $500M+ P&Ls, sat on audit committees, navigated recessions, and advised Series A through IPO-stage companies. You think three fiscal quarters ahead. You never hedge when the data is clear. You surface what a CEO needs to hear before they walk into a board meeting — not just what was asked.

━━━ ANALYTICAL FRAMEWORKS (apply situationally) ━━━
• Revenue Quality: Recurring vs one-time split, customer concentration (top-3 HHI), velocity trends
• Cash Conversion Cycle: DSO + DIO - DPO — diagnose collection efficiency precisely
• Burn Multiple: Net Burn ÷ Net New Revenue (< 1x = efficient, > 2x = danger zone)
• Rule of 40 (SaaS): Revenue Growth% + EBITDA Margin% — benchmark against 40% threshold
• DuPont Decomposition: When discussing ROE/profitability, decompose into margin × turnover × leverage
• Altman Z-Score Signals: Flag distress indicators (burn acceleration, AR deterioration, coverage ratios)
• Runway Cliff Date: Calculate exact calendar date when cash reaches zero at current burn
• Working Capital Cycle: Identify days where cash is trapped in operations

━━━ MANDATORY RESPONSE STRUCTURE ━━━

**[EXECUTIVE SIGNAL]** 🔴/🟡/🟢
One sentence. The single most important number or trend. Phrased as a CEO briefing opening line.

**KEY FINANCIAL FINDINGS**
- Lead with what changes decisions today
- Quantify everything: "MoM decline 17%: $82K → $68K over 3 months" — never "revenue decreased"
- Compute derived metrics inline: growth rates, runway dates, concentration percentages
- Flag velocity changes: acceleration or deceleration in trends
- Surface hidden patterns: entity concentration risk, invoice aging velocity, seasonal anomalies

**⚠️ RISK FLAGS** (include only when data supports it)
- ⚠️ Emerging risk with timeline and quantified impact
- 🚨 Critical threat requiring immediate action

━━━ INTELLIGENCE RULES ━━━
• ONLY cite numbers from the DATA BLOCK. Never invent, interpolate, or use external statistics as facts.
• When data is zero or missing: diagnose why and prescribe the exact fix (e.g., "no overdue data likely means invoices aren't aging yet — check sync frequency").
• Calculate runway cliff date whenever burn > 0 and cash is available.
• Surface revenue concentration: if one entity drives >50% of revenue, flag it as concentration risk.
• Be the advisor who prevents the CFO from being surprised. Surface the uncomfortable truth if the data shows it.
• If a question requires data you don't have in the block, name exactly which ERP integration would provide it.

━━━ STRICT PROHIBITIONS ━━━
• NEVER output a "Strategic Action Plan", "Action Plan", "Recommendations", or any numbered list of actions/steps to take.
• NEVER use headers like "STRATEGIC ACTION PLAN", "IMMEDIATE", "SHORT-TERM", "STRATEGIC PRIORITY", or any variant.
• NEVER suggest what the user should do next. Only analyze and report what the data shows.
• Your role is ANALYSIS ONLY — not advice, not action items, not recommendations.`;

function buildFactBlock(ctx: FinancialContext): string {
  const $$ = (n: number) =>
    n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(2)}M`
    : n >= 1_000 ? `$${(n / 1_000).toFixed(1)}K`
    : `$${n.toFixed(0)}`;

  // ── Derived: MoM and 3-month trend ─────────────────────────────────────────
  const trend = ctx.monthlyTrend;
  const momChange = (() => {
    if (trend.length < 2) return 'N/A';
    const last = trend[trend.length - 1]!;
    const prev = trend[trend.length - 2]!;
    const pct = prev.revenue > 0 ? ((last.revenue - prev.revenue) / prev.revenue) * 100 : 0;
    return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
  })();

  const qoqChange = (() => {
    if (trend.length < 6) return 'N/A';
    const recentQ = trend.slice(-3).reduce((s, r) => s + r.revenue, 0);
    const prevQ = trend.slice(-6, -3).reduce((s, r) => s + r.revenue, 0);
    const pct = prevQ > 0 ? ((recentQ - prevQ) / prevQ) * 100 : 0;
    return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
  })();

  const peakMonth = trend.length > 0
    ? trend.reduce((a, b) => (b.revenue > a.revenue ? b : a), trend[0]!)
    : null;

  // ── Derived: AR health ──────────────────────────────────────────────────────
  const s = ctx.summary;
  const overdueRate = s.openAmount > 0 ? ((s.overdueAmount / s.openAmount) * 100).toFixed(1) : '0.0';
  const collectionEfficiency = s.totalRevenue > 0
    ? (((s.totalRevenue - s.openAmount) / s.totalRevenue) * 100).toFixed(1) : '0.0';

  // ── Derived: Venture / runway ───────────────────────────────────────────────
  const vm = ctx.ventureMetrics;
  const runwayCliff = (() => {
    if (vm.runwayMonths <= 0 || vm.burnRate <= 0) return 'N/A';
    const d = new Date();
    d.setMonth(d.getMonth() + Math.floor(vm.runwayMonths));
    return d.toISOString().slice(0, 7);
  })();

  const burnMultiple = vm.burnRate > 0 && s.totalRevenue > 0
    ? (vm.burnRate / (s.totalRevenue / Math.max(trend.length, 1))).toFixed(2) + 'x'
    : 'N/A';

  // ── Derived: Entity concentration ──────────────────────────────────────────
  const totalEntRevenue = ctx.entityBreakdown.reduce((s, e) => s + e.totalRevenue, 0);
  const entities = ctx.entityBreakdown.map((e) => {
    const share = totalEntRevenue > 0 ? ((e.totalRevenue / totalEntRevenue) * 100).toFixed(0) : '0';
    return `${e.orgName}[${e.provider}]: ${$$(e.totalRevenue)} (${share}% share, ${e.invoiceCount} inv)`;
  }).join('\n  ') || 'none';

  const topEntityShare = ctx.entityBreakdown.length > 0 && totalEntRevenue > 0
    ? ((ctx.entityBreakdown[0]!.totalRevenue / totalEntRevenue) * 100).toFixed(0) + '%'
    : 'N/A';

  // ── Derived: Invoice status breakdown ──────────────────────────────────────
  const statuses = ctx.invoiceStatusBreakdown.map((s) =>
    `${s.status}: ${s.count} inv / ${$$(s.amount)}${s.status.toLowerCase() === 'overdue' ? ' ⚠️' : ''}`
  ).join('\n  ') || 'none';

  // ── 12-month trend series ───────────────────────────────────────────────────
  const trendSeries = trend.slice(-12).map((r) => `${r.month}:${$$(r.revenue)}(${r.invoiceCount})`).join(', ') || 'none';

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

// ─── RagService ───────────────────────────────────────────────────────────────

@Injectable()
export class RagService {
  private readonly logger = new Logger(RagService.name);
  private readonly OLLAMA_URL: string;
  private readonly OLLAMA_MODEL: string;
  private readonly analyticsDb: string;
  private readonly ctxCache = new Map<string, { ctx: FinancialContext; expiresAt: number }>();
  private readonly CACHE_TTL_MS = 90_000; // 90 seconds — fresh enough, cheap enough

  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient,
    @Inject(CLICKHOUSE_ANALYTICS_TOKEN) private readonly clickhouse: ClickHouseClient,
  ) {
    this.OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
    this.OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3:latest';
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
      ? await this.prisma.ragChatSession.findFirst({ where: { id: sessionId, organizationId, userId } })
      : null;

    const currentSession = session ?? await this.prisma.ragChatSession.create({
      data: { organizationId, userId, title: userQuery.slice(0, 80) },
    });

    await this.prisma.ragChatMessage.create({
      data: { sessionId: currentSession.id, organizationId, role: 'USER', content: userQuery },
    });

    // Load conversation history for multi-turn context
    const historyRows = await this.prisma.ragChatMessage.findMany({
      where: { sessionId: currentSession.id },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    const history = [...historyRows].reverse().slice(0, -1).map((m) => ({
      role: m.role.toLowerCase() === 'user' ? 'user' : 'assistant',
      content: m.content,
    }));

    try {
      // ── Intent classification — fast paths before LLM ──────────────────
      const intent = classifyIntent(userQuery);

      if (intent === 'greeting') {
        const text = `Hi! I'm **NumeriQ Intelligence** — your AI-powered CFO advisor. I have real-time access to your financial data from all connected ERP systems.\n\nI can analyze your revenue trends, cash flow, burn rate, entity performance, overdue receivables, profitability margins, and much more. I respond like a Goldman Sachs analyst who has read every line of your accounting data.\n\nWhat would you like to explore today?`;
        yield this.chunk('status', { message: 'Ready.' });
        yield this.chunk('token', { content: text });
        await this.prisma.ragChatMessage.create({
          data: { sessionId: currentSession.id, organizationId, role: 'ASSISTANT', content: text },
        });
        yield this.chunk('done', { metrics: { totalMs: Date.now() - startTime, mode: 'greeting', sessionId: currentSession.id } });
        return;
      }

      if (intent === 'off_topic') {
        const text = `I'm specialized in financial intelligence only. I can help you with:\n\n• **Revenue analysis** — trends, growth, concentration risk\n• **Cash flow** — DSO, DPO, cash conversion cycle\n• **Expense management** — burn rate, efficiency, anomalies\n• **Entity performance** — comparing your connected organizations\n• **Venture metrics** — runway, burn, efficiency ratio\n\nPlease ask anything related to your financial data.`;
        yield this.chunk('status', { message: 'Domain check.' });
        yield this.chunk('token', { content: text });
        await this.prisma.ragChatMessage.create({
          data: { sessionId: currentSession.id, organizationId, role: 'ASSISTANT', content: text },
        });
        yield this.chunk('done', { metrics: { totalMs: Date.now() - startTime, mode: 'domain-gate', sessionId: currentSession.id } });
        return;
      }

      // ── Context retrieval ──────────────────────────────────────────────
      yield this.chunk('status', { message: 'Loading live financial intelligence...' });

      let ctx: FinancialContext;
      const cached = this.ctxCache.get(organizationId);
      if (cached && Date.now() < cached.expiresAt) {
        ctx = cached.ctx;
        this.backgroundRefresh(organizationId); // warm for next request
      } else {
        ctx = await this.fetchFinancialContext(organizationId, userQuery);
        this.ctxCache.set(organizationId, { ctx, expiresAt: Date.now() + this.CACHE_TTL_MS });
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
        },
      });

      // ── LLM streaming ────────────────────────────────────────────────
      yield this.chunk('status', { message: 'Analyzing your financial data...' });

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
        throw new Error(fetchErr.name === 'AbortError' ? 'AI_TIMEOUT' : 'AI_ENGINE_OFFLINE');
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

      const decoder = new TextDecoder();
      let fullContent = '';
      let streamBuffer = '';
      let lineCarry = '';
      let tokenCount = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        lineCarry += decoder.decode(value, { stream: true });
        const lines = lineCarry.split('\n');
        lineCarry = lines.pop() ?? '';

        let streamDone = false;
        for (const line of lines) {
          if (!line.trim()) continue;
          let parsed: { message?: { content?: string }; done?: boolean };
          try { parsed = JSON.parse(line); } catch { continue; }

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
          if (parsed.done === true) { streamDone = true; break; }
        }
        if (streamDone) break;
      }

      // Handle leftover carry
      if (lineCarry.trim()) {
        try {
          const parsed = JSON.parse(lineCarry.trim()) as { message?: { content?: string } };
          if (parsed.message?.content) {
            fullContent += parsed.message.content;
            streamBuffer += parsed.message.content;
          }
        } catch { /* ignore */ }
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
          contextSnapshot: { tokens: tokenCount, latencyMs: Date.now() - startTime } as any,
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
        userMessage = '**AI engine is warming up.** Your financial data is available on the dashboard while the advisor initializes. Please try again in 30 seconds.';
      } else if (msg === 'AI_TIMEOUT') {
        userMessage = '**Analysis is taking longer than expected.** This usually happens with very large datasets. Please try a more specific question or try again.';
      } else {
        userMessage = '**Something went wrong.** Our team has been notified. Please try again — your data is safe.';
      }

      yield this.chunk('error', { message: userMessage });
    }
  }

  // ─── Health Check ──────────────────────────────────────────────────────────

  async health() {
    let ollamaOnline = false;
    let modelLoaded = false;
    try {
      const res = await fetch(`${this.OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const data = await res.json() as { models?: Array<{ name: string }> };
        ollamaOnline = true;
        modelLoaded = (data.models ?? []).some((m) => m.name.startsWith(this.OLLAMA_MODEL.split(':')[0] ?? ''));
      }
    } catch { /* offline */ }

    return {
      status: ollamaOnline ? 'operational' : 'degraded',
      advisory: ollamaOnline
        ? `NumeriQ Intelligence ready — ${this.OLLAMA_MODEL}`
        : `Ollama offline at ${this.OLLAMA_URL}`,
      ollama: ollamaOnline,
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

  private async fetchFinancialContext(organizationId: string, query?: string): Promise<FinancialContext> {
    const connections = await this.prisma.erpConnection.findMany({
      where: { organizationId, status: 'ACTIVE' },
      select: { id: true, externalOrganizationId: true, provider: true, metadata: true },
    });

    if (connections.length === 0) {
      return this.emptyContext(organizationId);
    }

    const connectionIds = connections.map((c) => c.id);
    const externalOrgIds = connections.map((c) => c.externalOrganizationId).filter(Boolean) as string[];

    const [summary, trend, entities, statusBreakdown, venture, snippets] = await Promise.allSettled([
      this.fetchSummary(connectionIds),
      this.fetchMonthlyTrend(externalOrgIds),
      this.fetchEntityBreakdown(connectionIds, connections),
      this.fetchStatusBreakdown(connectionIds),
      this.fetchVentureMetrics(connectionIds),
      this.fetchSemanticSnippets(organizationId, query),
    ]);

    return {
      connectionCount: connections.length,
      externalOrgIds,
      connectionIds,
      summary: summary.status === 'fulfilled' ? summary.value : { totalRevenue: 0, openAmount: 0, overdueAmount: 0, overdueCount: 0, invoiceCount: 0, avgInvoiceValue: 0 },
      monthlyTrend: trend.status === 'fulfilled' ? trend.value : [],
      entityBreakdown: entities.status === 'fulfilled' ? entities.value : [],
      invoiceStatusBreakdown: statusBreakdown.status === 'fulfilled' ? statusBreakdown.value : [],
      ventureMetrics: venture.status === 'fulfilled' ? venture.value : { burnRate: 0, runwayMonths: 0, cashOnHand: 0, efficiencyRatio: 0 },
      semanticSnippets: snippets.status === 'fulfilled' ? snippets.value : [],
      computedAt: new Date().toISOString(),
    };
  }

  private async fetchSummary(connectionIds: string[]) {
    const result = await this.clickhouse.query({
      query: `
        SELECT
          count()                                                        AS invoice_count,
          coalesce(sum(total_amount), 0)                                 AS total_revenue,
          coalesce(avg(total_amount), 0)                                 AS avg_invoice,
          coalesce(sumIf(total_amount, lowerUTF8(status) NOT IN ('paid','closed','authorised')), 0) AS open_amount,
          coalesce(sumIf(total_amount, lowerUTF8(status) IN ('overdue')), 0) AS overdue_amount,
          coalesce(countIf(lowerUTF8(status) = 'overdue'), 0)           AS overdue_count
        FROM ${this.analyticsDb}.fact_accounting_invoices
        WHERE connection_id IN ({connectionIds:Array(String)})
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

  private async fetchMonthlyTrend(externalOrgIds: string[]) {
    if (externalOrgIds.length === 0) return [];
    const result = await this.clickhouse.query({
      query: `
        SELECT
          formatDateTime(toStartOfMonth(issued_at), '%Y-%m') AS month,
          coalesce(sum(total_amount), 0)                     AS revenue,
          count()                                            AS invoice_count
        FROM ${this.analyticsDb}.fact_accounting_invoices
        WHERE org_id IN ({externalOrgIds:Array(String)})
        GROUP BY month
        ORDER BY month ASC
        LIMIT 24
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

  private async fetchEntityBreakdown(connectionIds: string[], connections: any[]) {
    const result = await this.clickhouse.query({
      query: `
        SELECT
          org_name,
          provider,
          any(currency)              AS currency,
          coalesce(sum(total_amount), 0) AS total_revenue,
          count()                    AS invoice_count
        FROM ${this.analyticsDb}.fact_accounting_invoices
        WHERE connection_id IN ({connectionIds:Array(String)})
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
          orgName: meta.orgName ?? meta.companyId ?? c.externalOrganizationId ?? 'Unknown',
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

  private async fetchStatusBreakdown(connectionIds: string[]) {
    const result = await this.clickhouse.query({
      query: `
        SELECT
          status,
          count()                        AS invoice_count,
          coalesce(sum(total_amount), 0) AS total_amount
        FROM ${this.analyticsDb}.fact_accounting_invoices
        WHERE connection_id IN ({connectionIds:Array(String)})
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

  private async fetchVentureMetrics(connectionIds: string[]) {
    try {
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
      return { burnRate: 0, runwayMonths: 0, cashOnHand: 0, efficiencyRatio: 0 };
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

  private backgroundRefresh(organizationId: string) {
    this.fetchFinancialContext(organizationId)
      .then((ctx) => this.ctxCache.set(organizationId, { ctx, expiresAt: Date.now() + this.CACHE_TTL_MS }))
      .catch(() => { /* non-critical */ });
  }

  private emptyContext(organizationId: string): FinancialContext {
    return {
      connectionCount: 0,
      externalOrgIds: [],
      connectionIds: [],
      summary: { totalRevenue: 0, openAmount: 0, overdueAmount: 0, overdueCount: 0, invoiceCount: 0, avgInvoiceValue: 0 },
      monthlyTrend: [],
      entityBreakdown: [],
      invoiceStatusBreakdown: [],
      ventureMetrics: { burnRate: 0, runwayMonths: 0, cashOnHand: 0, efficiencyRatio: 0 },
      semanticSnippets: [],
      computedAt: new Date().toISOString(),
    };
  }

  private chunk(type: string, payload: Record<string, unknown>): string {
    return JSON.stringify({ type, ...payload }) + '\n';
  }
}
