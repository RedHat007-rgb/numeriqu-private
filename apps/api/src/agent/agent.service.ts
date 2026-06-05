import { Injectable, Logger } from '@nestjs/common';
import { FinancialDataService } from '../financial-data/financial-data.service';
import { AgentToolExecutor } from './agent-tool.executor';
import { buildAgentMessages } from './agent-prompt.builder';
import type { FinancialProfile } from '../financial-data/financial-data.service';
import {
  getLlmProviderLabel,
  resolveLlmRuntimeConfig,
  type LlmProvider,
} from '../common/llm/llm-config';

/**
 * AgentService — Strategic Intelligence Agent with Tool Invocation
 *
 * ARCHITECTURE INVARIANT:
 * ─────────────────────────────────────────
 * This service handles ONLY the Agent (strategic) flow.
 * - HAS command parsing ([COMMAND:] interception)
 * - HAS tool execution (save insight, SQL queries)
 * - NO shared state with RAG layer
 * - Always fetches FRESH data (no cache — agent needs real-time accuracy)
 *
 * The [COMMAND:] parser ONLY runs here. RAG's RagService has zero
 * command parsing, which is why separating them fixes RAG.
 */
import { PersistenceService } from '../common/services/persistence.service';

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);
  private readonly OLLAMA_URL: string;
  private readonly OLLAMA_MODEL: string;
  private readonly llmProvider: LlmProvider;

  constructor(
    private readonly financialData: FinancialDataService,
    private readonly toolExecutor: AgentToolExecutor,
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
      mode: 'agent',
      title: userQuery.slice(0, 40) + '...',
    });

    await this.persistence.saveMessage({
      sessionId: session.id,
      role: 'user',
      content: userQuery,
    });

    const sessionHistory = session.messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    try {
      // ── STEP 1: FRESH DATA (No cache — agent needs real-time accuracy) ──
      yield this.chunk('status', {
        message: 'Gathering live financial data...',
      });

      let profile: FinancialProfile;
      let monthlyTrend: any[];

      try {
        const [p, t] = await Promise.all([
          this.financialData.getFinancialProfile(tenantId),
          this.financialData.getMonthlyRevenueTrend(tenantId),
        ]);
        profile = p;
        monthlyTrend = t;
      } catch (e: any) {
        this.logger.error(`[Agent:Context] Fetch failed: ${e.message}`);
        profile = this.emptyProfile(tenantId);
        monthlyTrend = [];
      }

      // Emit context snapshot for UI
      yield this.chunk('context', {
        data: {
          totalRevenue: profile.revenue.totalRevenue,
          totalExpenses: profile.expenses.totalExpenses,
          netProfit: profile.netProfit,
          profitMargin: profile.profitMargin,
          fetchTimeMs: Date.now() - startTime,
        },
      });

      // ── STEP 2: BUILD AGENT MESSAGES (with session history) ──
      yield this.chunk('status', {
        message: 'Strategic analysis in progress...',
      });

      const messages = buildAgentMessages(
        profile,
        monthlyTrend,
        sessionHistory,
        userQuery,
      );

      const controller = new AbortController();
      // PRODUCTION FIX: Increase absolute execution timeout from 60s to 300s (5 minutes)
      // The new elite persona requires generating heavy analytical blocks AND multiple JSON
      // chart configurations, which legitimately takes > 60s on local models.
      // PRODUCTION FIX: Increase absolute execution timeout to 600s (10 minutes) for local CPU prefill
      const timeout = setTimeout(() => controller.abort(), 600_000);

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
              temperature: 0.1,
              num_predict: 4096,
              top_p: 0.9,
              num_ctx: 16384, // ADJUSTED: High enough for charts, low enough to prevent 500 VRAM errors
            },
          }),
        });
      } catch (fetchErr: any) {
        clearTimeout(timeout);
        if (fetchErr.name === 'AbortError') throw new Error('AI_TIMEOUT');
        throw new Error('AI_ENGINE_OFFLINE');
      }

      if (!response.ok) {
        clearTimeout(timeout);
        this.logger.error(
          `[Agent:Ollama] Engine returned non-OK status: ${response.status} ${response.statusText}`,
        );
        throw new Error('AI_ENGINE_OFFLINE');
      }

      const reader = response.body?.getReader();
      if (!reader) {
        clearTimeout(timeout);
        throw new Error('AI_ENGINE_OFFLINE');
      }

      // ── STEP 3: STREAM WITH COMMAND PARSING ──
      const decoder = new TextDecoder();
      let narrativeBuffer = ''; // The clean text saved to history
      let currentDisplayBuffer = ''; // The text yielded to UI
      let isCapturingCommand = false;
      let commandBuffer = '';
      let bracketCount = 0;
      let tokensGenerated = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const raw = decoder.decode(value, { stream: true });
        for (const line of raw.split('\n')) {
          if (!line.trim()) continue;

          let parsed;
          try {
            parsed = JSON.parse(line);
          } catch {
            continue;
          }

          const token = parsed.message?.content;
          if (!token) continue;

          tokensGenerated++;
          narrativeBuffer += token; // ALWAYS save to the full history buffer

          if (!isCapturingCommand) {
            currentDisplayBuffer += token;

            // Check for command start
            if (currentDisplayBuffer.includes('[COMMAND:')) {
              const startIdx = currentDisplayBuffer.indexOf('[COMMAND:');
              const textBefore = currentDisplayBuffer.substring(0, startIdx);

              // Clean indicators and yield preceding text
              const sanitizedTextBefore = textBefore
                .replace(/Here is the( exact)? JSON command:?[\s\S]*$/i, '')
                .replace(/The following \[COMMAND:[\s\S]*$/i, '')
                .trim();

              if (sanitizedTextBefore) {
                yield this.chunk('token', {
                  content: sanitizedTextBefore + ' ',
                });
              }

              isCapturingCommand = true;
              commandBuffer = currentDisplayBuffer.substring(startIdx);
              currentDisplayBuffer = '';
              bracketCount = 0;

              // Count brackets already in command start
              for (const char of commandBuffer) {
                if (char === '{') bracketCount++;
                if (char === '}') bracketCount--;
              }
            } else if (currentDisplayBuffer.includes('{"charts":')) {
              // Naked JSON fallback
              const startIdx = currentDisplayBuffer.indexOf('{');
              const textBefore = currentDisplayBuffer.substring(0, startIdx);
              if (textBefore.trim()) {
                yield this.chunk('token', { content: textBefore });
              }
              isCapturingCommand = true;
              commandBuffer = currentDisplayBuffer.substring(startIdx);
              currentDisplayBuffer = '';
              bracketCount = 1;
            } else {
              // Standard narrative flow
              if (currentDisplayBuffer.length > 20) {
                yield this.chunk('token', { content: currentDisplayBuffer });
                currentDisplayBuffer = '';
              }
            }
          } else {
            // Processing Command Block
            commandBuffer += token;
            for (const char of token) {
              if (char === '{') bracketCount++;
              if (char === '}') bracketCount--;
            }

            // A command is complete if we have a closing ']' or '}' that restores parity
            const hasClosingTag = commandBuffer.includes(']');
            if (
              bracketCount === 0 &&
              (hasClosingTag ||
                (commandBuffer.includes('}') && commandBuffer.length > 50))
            ) {
              try {
                const firstBrace = commandBuffer.indexOf('{');
                const lastBrace = commandBuffer.lastIndexOf('}');

                if (firstBrace !== -1 && lastBrace !== -1) {
                  const cmdJson = commandBuffer.substring(
                    firstBrace,
                    lastBrace + 1,
                  );
                  const cmdBody = commandBuffer.substring(0, firstBrace);
                  const cmdName = cmdBody.includes('GENERATE_DASHBOARD')
                    ? 'GENERATE_DASHBOARD'
                    : 'SAVE_INSIGHT';

                  this.logger.log(
                    `[Agent:Parser] Executing isolated command: ${cmdName}`,
                  );
                  await this.executeCommand(tenantId, userId, cmdName, cmdJson);

                  yield this.chunk('system', {
                    action: 'DASHBOARD_REFRESH',
                    message: `Strategic views updated.`,
                  });

                  // Move past command and restore narrative flow
                  const lastTagIdx = hasClosingTag
                    ? commandBuffer.lastIndexOf(']')
                    : lastBrace;
                  currentDisplayBuffer = commandBuffer.substring(
                    lastTagIdx + 1,
                  );
                  commandBuffer = '';
                  isCapturingCommand = false;
                }
              } catch (err: any) {
                this.logger.warn(
                  `[Agent:Parser] Command partial/failed: ${err.message}`,
                );
                // Don't swallow, might be text LLM forgot to tag
              }
            }
          }
          if (parsed.done === true) break;
        }
      }

      // Final display flush
      if (currentDisplayBuffer.trim()) {
        yield this.chunk('token', { content: currentDisplayBuffer });
      }

      // Save COMPLETE Assistant Response to Persistence (independent of Display/Command logic)
      await this.persistence.saveMessage({
        sessionId: session.id,
        role: 'assistant',
        content: narrativeBuffer || 'Strategic mission complete.',
        tokens: tokensGenerated,
        latencyMs: Date.now() - startTime,
      });

      yield this.chunk('done', {
        metrics: {
          totalMs: Date.now() - startTime,
          tokens: tokensGenerated,
          mode: 'strategic-agent',
          sessionId: session.id,
        },
      });

      clearTimeout(timeout);
    } catch (e: any) {
      const errorName = e.name;
      const errorMessage = e.message || '';

      this.logger.error(
        `[Agent:Fatal] Query failure: ${errorMessage}`,
        e.stack,
      );

      let userMessage: string;

      // Map technical errors to user-friendly messages without mutating the original error object
      if (errorName === 'AbortError' || errorMessage.includes('aborted')) {
        userMessage =
          'We’re analyzing your data. One part is taking longer than expected. Here’s what we’ve found so far.';
      } else if (
        errorMessage === 'AI_ENGINE_OFFLINE' ||
        errorMessage.includes('ECONNREFUSED')
      ) {
        userMessage =
          'The AI engine is starting up. Please try again in a moment — your financial data is still accessible on the dashboard.';
      } else if (
        errorMessage.includes('DATABASE') ||
        errorMessage.includes('ClickHouse') ||
        errorMessage.includes('Prisma')
      ) {
        userMessage =
          "I'm having trouble accessing your financial data. Please check your connection status on the Integrations page.";
      } else {
        userMessage =
          'I encountered an unexpected issue during analysis. Our team has been notified. Please try again shortly.';
      }

      yield this.chunk('error', { message: userMessage });
    }
  }

  /**
   * Execute an intercepted agent command.
   */
  private async executeCommand(
    tenantId: string,
    userId: string,
    cmdName: string,
    cmdJson: string,
  ): Promise<void> {
    try {
      const cleaned = this.cleanJson(cmdJson);
      const payload = JSON.parse(cleaned);

      if (
        cmdName === 'GENERATE_DASHBOARD' &&
        payload.charts &&
        Array.isArray(payload.charts)
      ) {
        this.logger.log(
          `[Agent:Dashboard] Persisting unified dashboard entity: ${payload.title}`,
        );
        await this.toolExecutor.generateDashboard(tenantId, userId, {
          title: payload.title || 'Strategic Dashboard',
          description:
            payload.description || 'Generated dashboard orchestration',
          charts: payload.charts,
        });
      } else if (
        cmdName === 'SAVE_INSIGHT' ||
        payload.type === 'dashboard' ||
        payload.type === 'line' ||
        payload.type === 'bar' ||
        payload.type === 'pie' ||
        payload.type === 'metric' ||
        payload.type === 'table'
      ) {
        await this.toolExecutor.saveInsightToDashboard(tenantId, payload);
      } else if (cmdName === 'QUERY_SQL') {
        const result = await this.toolExecutor.queryFinancialDatabase(
          tenantId,
          payload,
        );
        this.logger.debug(
          `[Agent:SQL] Fact-check result: ${result.count} rows found.`,
        );
      }
    } catch (e: any) {
      this.logger.warn(
        `[Agent:Command] Failed to execute ${cmdName}: ${e.message}`,
      );
    }
  }

  /**
   * cleanJson — Resilience helper for LLM malformations
   */
  private cleanJson(raw: string): string {
    return raw
      .trim()
      .replace(/,\s*([\]}])/g, '$1') // Remove trailing commas
      .replace(/[\u0000-\u001F\u007F-\u009F]/g, '') // Remove control characters
      .replace(/\\n/g, ' ') // Flatten newlines within strings if problematic
      .trim();
  }

  /**
   * Health check for agent layer
   */
  async healthCheck() {
    let ollamaStatus = false;
    try {
      const res = await fetch(`${this.OLLAMA_URL}/api/tags`);
      ollamaStatus = res.ok;
    } catch {
      ollamaStatus = false;
    }
    const backendLabel = getLlmProviderLabel(this.llmProvider);

    return {
      status: 'ok',
      layer: 'agent',
      ollama: ollamaStatus,
      provider: this.llmProvider,
      backendUrl: this.OLLAMA_URL,
      engine: this.OLLAMA_MODEL,
      uptime: process.uptime(),
      advisory: ollamaStatus
        ? `Numeriqu Intelligence ready — ${backendLabel}: ${this.OLLAMA_MODEL}`
        : `${backendLabel} offline at ${this.OLLAMA_URL}`,
      mode: ollamaStatus ? 'agentic-active' : 'heuristic-fallback',
    };
  }

  // ─── Private Helpers ─────────────────────────────────────────────────────

  private chunk(type: string, payload: any): string {
    return JSON.stringify({ type, ...payload }) + '\n';
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
}
