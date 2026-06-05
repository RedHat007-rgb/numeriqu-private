import { Injectable, Logger } from '@nestjs/common';
import { FinancialDataService } from '../financial-data/financial-data.service';
import { RagContextCacheService } from './rag-context-cache.service';
import { classifyIntent, buildRagMessages } from './rag-prompt.builder';
import type { FinancialProfile } from '../financial-data/financial-data.service';
import {
  resolveLlmRuntimeConfig,
  type LlmProvider,
} from '../common/llm/llm-config';

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
import { PersistenceService } from '../common/services/persistence.service';

@Injectable()
export class RagService {
  private readonly logger = new Logger(RagService.name);
  private readonly OLLAMA_URL: string;
  private readonly OLLAMA_MODEL: string;
  private readonly llmProvider: LlmProvider;

  constructor(
    private readonly financialData: FinancialDataService,
    private readonly contextCache: RagContextCacheService,
    private readonly persistence: PersistenceService,
  ) {
    const llm = resolveLlmRuntimeConfig('llama3:latest');
    this.llmProvider = llm.provider;
    this.OLLAMA_URL = llm.url;
    this.OLLAMA_MODEL = llm.model;
  }

  async *query(
    tenantId: string,
    userId: string,
    userQuery: string,
    sessionId?: string,
  ): AsyncGenerator<string> {
    const startTime = Date.now();

    // ── STEP -1: PERSISTENCE SETUP ───────────────────────────────────
    const session = await this.persistence.getOrCreateSession({
      tenantId,
      userId,
      sessionId,
      mode: 'rag',
      title: userQuery.slice(0, 40) + '...',
    });

    await this.persistence.saveMessage({
      sessionId: session.id,
      role: 'user',
      content: userQuery,
    });

    const conversationHistory = session.messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    try {
      // ── STEP 0: FAST-PATH — Greetings (< 5ms, no LLM) ──────────────────
      const intent = classifyIntent(userQuery);

      if (intent === 'greeting') {
        const text = this.greetingResponse();
        yield this.chunk('status', { message: 'Ready.' });
        yield this.chunk('token', { content: text });
        await this.persistence.saveMessage({
          sessionId: session.id,
          role: 'assistant',
          content: text,
          tokens: 0,
          latencyMs: Date.now() - startTime,
        });
        yield this.chunk('done', {
          metrics: {
            totalMs: Date.now() - startTime,
            mode: 'fast-path',
            sessionId: session.id,
          },
        });
        return;
      }

      // ── STEP 0b: DOMAIN GATE — Reject non-financial queries (< 1ms) ─────
      if (intent === 'off_topic') {
        const text =
          "I'm specialized in financial analysis only. Please ask about revenue, expenses, profitability, invoices, cash flow, or your connected organizations.";
        yield this.chunk('status', { message: 'Analyzing intent...' });
        yield this.chunk('token', { content: text });
        await this.persistence.saveMessage({
          sessionId: session.id,
          role: 'assistant',
          content: text,
          tokens: 0,
          latencyMs: Date.now() - startTime,
        });
        yield this.chunk('done', {
          metrics: {
            totalMs: Date.now() - startTime,
            mode: 'domain-gate',
            sessionId: session.id,
          },
        });
        return;
      }

      // ── STEP 1: CONTEXT RETRIEVAL (Cached or Parallel) ─────────────────
      yield this.chunk('status', {
        message: 'Loading financial intelligence...',
      });

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
          totalRevenue: profile.revenue.totalRevenue,
          totalExpenses: profile.expenses.totalExpenses,
          netProfit: profile.netProfit,
          profitMargin: profile.profitMargin,
          fetchTimeMs: Date.now() - startTime,
        },
      });

      // ── STEP 2: LLM STREAMING (Pure token passthrough) ─────────────────
      yield this.chunk('status', { message: 'Analyzing your finances...' });

      const messages = buildRagMessages(
        profile,
        monthlyTrend,
        conversationHistory,
        userQuery,
      );

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
            model: this.OLLAMA_MODEL,
            messages,
            stream: true,
            options: { temperature: 0.1, num_predict: 2048, top_p: 0.9 },
          }),
        });
      } catch (fetchErr: any) {
        clearTimeout(timeout);
        if (fetchErr.name === 'AbortError') throw new Error('AI_TIMEOUT');
        throw new Error('AI_ENGINE_OFFLINE');
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
      let tokensGenerated = 0;
      let streamBuffer = '';
      /** Full model output for durable history (streamBuffer is only the tail between flushes). */
      let fullAssistantContent = '';
      /** Ollama NDJSON lines can split across TCP chunks; reassemble before JSON.parse. */
      let lineCarry = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        lineCarry += decoder.decode(value, { stream: true });
        const lines = lineCarry.split('\n');
        lineCarry = lines.pop() ?? '';

        let streamEnded = false;
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
            fullAssistantContent += token;
            streamBuffer += token;

            // Flush in small batches for network efficiency
            if (streamBuffer.length > 5) {
              yield this.chunk('token', { content: streamBuffer });
              tokensGenerated++;
              streamBuffer = '';
            }
          }
          if (parsed.done === true) {
            streamEnded = true;
            break;
          }
        }
        if (streamEnded) break;
      }

      if (lineCarry.trim()) {
        try {
          const parsed = JSON.parse(lineCarry.trim()) as {
            message?: { content?: string };
            done?: boolean;
          };
          const token = parsed.message?.content;
          if (token) {
            fullAssistantContent += token;
            streamBuffer += token;
          }
        } catch {
          /* ignore trailing garbage */
        }
      }

      // Final flush
      const finalResponse = streamBuffer;
      if (finalResponse) {
        yield this.chunk('token', { content: finalResponse });
        tokensGenerated++;
      }

      // Save Assistant Response to Persistence
      await this.persistence.saveMessage({
        sessionId: session.id,
        role: 'assistant',
        content: fullAssistantContent.trim() || 'Analysis complete.',
        tokens: tokensGenerated,
        latencyMs: Date.now() - startTime,
      });

      clearTimeout(timeout);

      yield this.chunk('done', {
        metrics: {
          totalMs: Date.now() - startTime,
          tokens: tokensGenerated,
          mode: 'rag-advisor',
          sessionId: session.id,
        },
      });
    } catch (e: any) {
      if (
        e.name === 'AbortError' ||
        e.message === 'This operation was aborted'
      ) {
        e.message = 'AI_TIMEOUT';
      }

      this.logger.error(`[RAG:Fatal] Query failure: ${e.message}`);

      let userMessage: string;

      if (
        e.message === 'AI_ENGINE_OFFLINE' ||
        e.message?.includes('ECONNREFUSED')
      ) {
        userMessage =
          'The AI engine is starting up. Please try again in a moment — your data is available on the dashboard while we warm up.';
      } else if (e.message === 'AI_TIMEOUT') {
        userMessage =
          'We’re analyzing your data. One part is taking longer than expected. Here’s what we’ve found so far.';
      } else if (
        e.message?.includes('DATABASE') ||
        e.message?.includes('ClickHouse')
      ) {
        userMessage =
          "I'm having trouble retrieving your financial data right now. Please check your connection status on the Integrations page.";
      } else {
        userMessage =
          'I encountered an unexpected issue. Our team has been notified. Please try again shortly.';
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
    const backendLabel =
      this.llmProvider === 'openai' ? 'OpenAI' : 'Ollama';

    return {
      status: 'ok',
      layer: 'rag',
      ollama: ollamaStatus,
      provider: this.llmProvider,
      backendUrl: this.OLLAMA_URL,
      engine: this.OLLAMA_MODEL,
      uptime: process.uptime(),
      advisory: ollamaStatus
        ? `Numeriqu Intelligence ready — ${backendLabel}: ${this.OLLAMA_MODEL}`
        : `${backendLabel} offline at ${this.OLLAMA_URL}`,
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
      revenue: {
        totalRevenue: 0,
        avgInvoiceValue: 0,
        totalInvoices: 0,
        minInvoice: 0,
        maxInvoice: 0,
        providerCount: 0,
        orgCount: 0,
        currencyCount: 0,
      },
      expenses: {
        totalExpenses: 0,
        totalBills: 0,
        overdueAmount: 0,
        overdueCount: 0,
      },
      netProfit: 0,
      profitMargin: 0,
      invoiceStats: { byStatusAndOrg: [] },
      accountSummary: { byTypeAndOrg: [] },
      connectedOrgs: [],
      budgetSummary: [],
      bankSummary: { total_transfers: 0, total_volume: 0 },
      ventureMetrics: {
        burnRate: 0,
        runwayMonths: 0,
        cashOnHand: 0,
        efficiencyMultiplier: 0,
      },
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
