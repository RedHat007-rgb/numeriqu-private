import { Injectable, Logger } from '@nestjs/common';
import { FinancialDataService } from '../financial-data/financial-data.service';
import { RagContextCacheService } from './rag-context-cache.service';
import { classifyIntent, buildRagMessages } from './rag-prompt.builder';
import type { FinancialProfile } from '../financial-data/financial-data.service';

/**
 * RagService — Pure Retrieval-Augmented Generation Engine
 *
 * ARCHITECTURE INVARIANT:
 * ─────────────────────────────────────────
 * This service handles ONLY the RAG (advisor) flow.
 * - NO command parsing ([COMMAND:] is never intercepted here)
 * - NO tool execution (save insight, SQL queries)
 * - NO agent logic
 *
 * Tokens from the LLM are streamed directly to the client with ZERO
 * interception. This is the core fix — the previous monolithic service
 * had a [COMMAND:] parser that ate RAG tokens whenever the LLM
 * accidentally generated a `[` character.
 *
 * STREAMING DESIGN:
 * - Every token is yielded immediately (no 20-char buffer stall)
 * - Small batches for network efficiency without stalling
 */
@Injectable()
export class RagService {
  private readonly logger = new Logger(RagService.name);
  private readonly OLLAMA_URL: string;
  private readonly OLLAMA_MODEL: string;

  constructor(
    private readonly financialData: FinancialDataService,
    private readonly contextCache: RagContextCacheService,
  ) {
    this.OLLAMA_URL  = process.env.OLLAMA_URL   || 'http://localhost:11434';
    this.OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.2:3b';
  }

  /**
   * Main entry: Zero-Latency SSE generator for RAG mode.
   * Each yield produces one SSE event chunk.
   */
  async *query(
    tenantId: string,
    userQuery: string,
    conversationHistory: { role: string; content: string }[] = [],
  ): AsyncGenerator<string> {
    const startTime = Date.now();

    try {
      // ── STEP 0: FAST-PATH — Greetings (< 5ms, no LLM) ──────────────────
      const intent = classifyIntent(userQuery);

      if (intent === 'greeting') {
        yield this.chunk('status', { message: 'Ready.' });
        yield this.chunk('token', { content: this.greetingResponse() });
        yield this.chunk('done', { metrics: { totalMs: Date.now() - startTime, mode: 'fast-path' } });
        return;
      }

      // ── STEP 0b: DOMAIN GATE — Reject non-financial queries (< 1ms) ─────
      if (intent === 'off_topic') {
        yield this.chunk('status', { message: 'Analyzing intent...' });
        yield this.chunk('token', {
          content: "I'm specialized in financial analysis only. Please ask about revenue, expenses, profitability, invoices, cash flow, or your connected organizations.",
        });
        yield this.chunk('done', { metrics: { totalMs: Date.now() - startTime, mode: 'domain-gate' } });
        return;
      }

      // ── STEP 1: CONTEXT RETRIEVAL (Cached or Parallel) ─────────────────
      yield this.chunk('status', { message: 'Loading financial intelligence...' });

      let profile: FinancialProfile;
      let monthlyTrend: any[];

      const cachedEntry = this.contextCache.get(tenantId);
      if (cachedEntry) {
        profile = cachedEntry.profile;
        monthlyTrend = cachedEntry.monthlyTrend;
        // Background refresh for next query
        this.backgroundRefresh(tenantId);
      } else {
        try {
          const [p, t] = await Promise.all([
            this.financialData.getFinancialProfile(tenantId),
            this.financialData.getMonthlyRevenueTrend(tenantId),
          ]);
          profile = p;
          monthlyTrend = t;
          this.contextCache.set(tenantId, p, t);
        } catch (e: any) {
          this.logger.error(`[RAG:Context] Fetch failed: ${e.message}`);
          profile = this.emptyProfile(tenantId);
          monthlyTrend = [];
        }
      }

      // Emit context snapshot for UI dashboard widgets
      yield this.chunk('context', {
        data: {
          totalRevenue:   profile.revenue.totalRevenue,
          totalExpenses:  profile.expenses.totalExpenses,
          netProfit:      profile.netProfit,
          profitMargin:   profile.profitMargin,
          fetchTimeMs:    Date.now() - startTime,
        },
      });

      // ── STEP 2: LLM STREAMING (Pure token passthrough) ─────────────────
      yield this.chunk('status', { message: 'Analyzing your finances...' });

      const messages = buildRagMessages(profile, monthlyTrend, conversationHistory, userQuery);

      const controller = new AbortController();
      // PRODUCTION FIX: Increase execution timeout to 300s to handle deep analytical stream generation
      const timeout = setTimeout(() => controller.abort(), 300_000);

      let response: Response;
      try {
        response = await fetch(`${this.OLLAMA_URL}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            model:   this.OLLAMA_MODEL,
            messages,
            stream:  true,
            options: { temperature: 0.1, num_predict: 2048, top_p: 0.9 },
          }),
        });
      } catch (fetchErr: any) {
        clearTimeout(timeout);
        if (fetchErr.name === 'AbortError') throw new Error('AI_TIMEOUT');
        throw new Error('AI_ENGINE_OFFLINE');
      }

      if (!response.ok) { clearTimeout(timeout); throw new Error('AI_ENGINE_OFFLINE'); }

      const reader = response.body?.getReader();
      if (!reader) { clearTimeout(timeout); throw new Error('AI_ENGINE_OFFLINE'); }

      const decoder = new TextDecoder();
      let tokensGenerated = 0;
      let streamBuffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const raw = decoder.decode(value, { stream: true });
        for (const line of raw.split('\n')) {
          if (!line.trim()) continue;

          let parsed;
          try {
            parsed = JSON.parse(line);
          } catch { continue; }

          const token = parsed.message?.content;
          if (token) {
            streamBuffer += token;

            // Flush in small batches for network efficiency
            if (streamBuffer.length > 5) {
              yield this.chunk('token', { content: streamBuffer });
              tokensGenerated++;
              streamBuffer = '';
            }
          }
          if (parsed.done === true) break;
        }
      }

      // Final flush
      if (streamBuffer) {
        yield this.chunk('token', { content: streamBuffer });
        tokensGenerated++;
      }

      clearTimeout(timeout);

      yield this.chunk('done', {
        metrics: {
          totalMs: Date.now() - startTime,
          tokens: tokensGenerated,
          mode: 'rag-advisor',
        },
      });

    } catch (e: any) {
      if (e.name === 'AbortError' || e.message === 'This operation was aborted') {
        e.message = 'AI_TIMEOUT';
      }

      this.logger.error(`[RAG:Fatal] Query failure: ${e.message}`);

      let userMessage: string;

      if (e.message === 'AI_ENGINE_OFFLINE' || e.message?.includes('ECONNREFUSED')) {
        userMessage = "The AI engine is starting up. Please try again in a moment — your data is available on the dashboard while we warm up.";
      } else if (e.message === 'AI_TIMEOUT') {
        userMessage = "We’re analyzing your data. One part is taking longer than expected. Here’s what we’ve found so far.";
      } else if (e.message?.includes('DATABASE') || e.message?.includes('ClickHouse')) {
        userMessage = "I'm having trouble retrieving your financial data right now. Please check your connection status on the Integrations page.";
      } else {
        userMessage = "I encountered an unexpected issue. Our team has been notified. Please try again shortly.";
      }

      yield this.chunk('error', { message: userMessage });
    }
  }

  /**
   * Health check — used by RAG status endpoint.
   */
  async healthCheck() {
    let ollamaStatus = false;
    try {
      const res = await fetch(`${this.OLLAMA_URL}/api/tags`);
      ollamaStatus = res.ok;
    } catch {
      ollamaStatus = false;
    }

    return {
      status: 'ok',
      layer: 'rag',
      ollama: ollamaStatus,
      engine: this.OLLAMA_MODEL,
      uptime: process.uptime(),
      mode: ollamaStatus ? 'rag-active' : 'heuristic-fallback',
    };
  }

  // ─── Private Helpers ─────────────────────────────────────────────────────

  private chunk(type: string, payload: any): string {
    return JSON.stringify({ type, ...payload }) + '\n';
  }

  private greetingResponse(): string {
    return "Hi! I'm **Numeriqu Intelligence**. I'm ready to analyze your financial architecture, generate live performance charts, and help you scale your business with data-driven insights.";
  }

  private emptyProfile(tenantId: string): FinancialProfile {
    return {
      tenantId,
      revenue: { totalRevenue: 0, avgInvoiceValue: 0, totalInvoices: 0, minInvoice: 0, maxInvoice: 0, providerCount: 0, orgCount: 0, currencyCount: 0 },
      expenses: { totalExpenses: 0, totalBills: 0, overdueAmount: 0, overdueCount: 0 },
      netProfit: 0,
      profitMargin: 0,
      invoiceStats: { byStatusAndOrg: [] },
      accountSummary: { byTypeAndOrg: [] },
      connectedOrgs: [],
      budgetSummary: [],
      bankSummary: { total_transfers: 0, total_volume: 0 },
      ventureMetrics: { burnRate: 0, runwayMonths: 0, cashOnHand: 0, efficiencyMultiplier: 0 },
      computedAt: new Date().toISOString(),
    } as FinancialProfile;
  }

  private backgroundRefresh(tenantId: string): void {
    Promise.all([
      this.financialData.getFinancialProfile(tenantId),
      this.financialData.getMonthlyRevenueTrend(tenantId),
    ])
      .then(([p, t]) => this.contextCache.set(tenantId, p, t))
      .catch(() => {});
  }
}
