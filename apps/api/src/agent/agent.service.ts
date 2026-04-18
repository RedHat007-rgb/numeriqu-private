import { Injectable, Logger } from '@nestjs/common';
import { FinancialDataService } from '../financial-data/financial-data.service';
import { AgentToolExecutor } from './agent-tool.executor';
import { buildAgentMessages } from './agent-prompt.builder';
import type { FinancialProfile } from '../financial-data/financial-data.service';

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
@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);
  private readonly OLLAMA_URL: string;
  private readonly OLLAMA_MODEL: string;

  constructor(
    private readonly financialData: FinancialDataService,
    private readonly toolExecutor: AgentToolExecutor,
  ) {
    this.OLLAMA_URL  = process.env.OLLAMA_URL   || 'http://localhost:11434';
    this.OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.2:3b';
  }

  /**
   * Main entry: SSE generator for Agent mode.
   * Includes [COMMAND:] parsing and tool execution.
   */
  async *query(
    tenantId: string,
    userId: string,
    userQuery: string,
    sessionHistory: { role: string; content: string }[] = [],
  ): AsyncGenerator<string> {
    const startTime = Date.now();

    try {
      // ── STEP 1: FRESH DATA (No cache — agent needs real-time accuracy) ──
      yield this.chunk('status', { message: 'Gathering live financial data...' });

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
          totalRevenue:   profile.revenue.totalRevenue,
          totalExpenses:  profile.expenses.totalExpenses,
          netProfit:      profile.netProfit,
          profitMargin:   profile.profitMargin,
          fetchTimeMs:    Date.now() - startTime,
        },
      });

      // ── STEP 2: BUILD AGENT MESSAGES (with session history) ──
      yield this.chunk('status', { message: 'Strategic analysis in progress...' });

      const messages = buildAgentMessages(profile, monthlyTrend, sessionHistory, userQuery);

      const controller = new AbortController();
      // PRODUCTION FIX: Increase absolute execution timeout from 60s to 300s (5 minutes)
      // The new elite persona requires generating heavy analytical blocks AND multiple JSON
      // chart configurations, which legitimately takes > 60s on local models. 
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

      // ── STEP 3: STREAM WITH COMMAND PARSING ──
      const decoder = new TextDecoder();
      let streamBuffer = '';
      let isCapturingCommand = false;
      let isCapturingNakedJson = false;
      let commandBuffer = '';
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
          } catch { continue; }

          const token = parsed.message?.content;
          if (token) {
            if (!isCapturingCommand && !isCapturingNakedJson) {
              streamBuffer += token;
              if (streamBuffer.includes('[COMMAND:')) {
                const startIdx = streamBuffer.indexOf('[COMMAND:');
                const textBefore = streamBuffer.substring(0, startIdx);
                const sanitizedTextBefore = textBefore
                  .replace(/Here is the( exact)? JSON command[\s\S]*$/i, '')
                  .replace(/the \[COMMAND:[\s\S]*$/i, '');
                  
                if (sanitizedTextBefore.trim()) {
                  yield this.chunk('token', { content: sanitizedTextBefore });
                  tokensGenerated++;
                }
                isCapturingCommand = true;
                commandBuffer = streamBuffer.substring(startIdx);
                streamBuffer = '';
              } else if (streamBuffer.includes('{\n') || streamBuffer.includes('{"')) {
                // LLM hallucination trap: intercept naked JSON without [COMMAND:] wrapper
                const startIdx = streamBuffer.indexOf('{');
                const textBefore = streamBuffer.substring(0, startIdx);
                if (textBefore.trim()) {
                  yield this.chunk('token', { content: textBefore });
                  tokensGenerated++;
                }
                isCapturingNakedJson = true;
                commandBuffer = streamBuffer.substring(startIdx);
                streamBuffer = '';
              } else {
                // Flush visible narrative text in batches
                if (streamBuffer.length > 20 && !streamBuffer.includes('[')) {
                  if (!streamBuffer.match(/Here is the( exact)? JSON command/i)) {
                    yield this.chunk('token', { content: streamBuffer });
                    tokensGenerated++;
                  }
                  streamBuffer = '';
                }
              }
            } else if (isCapturingNakedJson) {
              commandBuffer += token;
              
              let open = 0;
              let closed = 0;
              for (let i = 0; i < commandBuffer.length; i++) {
                if (commandBuffer[i] === '{') open++;
                if (commandBuffer[i] === '}') closed++;
              }
              
              if (open > 0 && open === closed) {
                // Bracket parity achieved, test parsing
                try {
                  const cmdJson = commandBuffer;
                  const payload = JSON.parse(cmdJson);
                  if ((payload.type && payload.config) || (payload.charts && Array.isArray(payload.charts))) {
                    this.logger.log(`[Agent:Command] Intercepted Naked JSON configuration.`);
                    const interceptCmd = payload.charts ? 'GENERATE_DASHBOARD' : 'SAVE_INSIGHT';
                    await this.executeCommand(tenantId, userId, interceptCmd, cmdJson);
                    yield this.chunk('system', { action: 'DASHBOARD_REFRESH' });
                  } else {
                    // False alarm, yield back
                    yield this.chunk('token', { content: commandBuffer });
                  }
                  isCapturingNakedJson = false;
                  commandBuffer = '';
                } catch {
                  // Keep accumulating
                }
              } else if (commandBuffer.length > 3000) {
                // Failsafe: if stream exceeds reasonable JSON limits, dump and break capture
                yield this.chunk('token', { content: commandBuffer });
                isCapturingNakedJson = false;
                commandBuffer = '';
              }
            } else if (isCapturingCommand) {
              commandBuffer += token;
              
              if (commandBuffer.includes('}') && (commandBuffer.endsWith(']') || commandBuffer.includes(']'))) {
                const firstBrace = commandBuffer.indexOf('{');
                const lastBrace = commandBuffer.lastIndexOf('}');
                
                if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
                   try {
                     const cmdJson = commandBuffer.substring(firstBrace, lastBrace + 1);
                     JSON.parse(cmdJson);
                     
                     const rawJson = commandBuffer.replace('[COMMAND:', '').trim();
                     const cmdName = rawJson.substring(0, rawJson.indexOf('{')).trim() || 'UNKNOWN';

                     this.logger.log(`[Agent:Command] Executing: ${cmdName}`);
                     await this.executeCommand(tenantId, userId, cmdName, cmdJson);
                     yield this.chunk('system', { action: 'DASHBOARD_REFRESH' });

                     isCapturingCommand = false;
                     const closingTagIdx = commandBuffer.lastIndexOf(']', lastBrace + 10);
                     streamBuffer = closingTagIdx !== -1 ? commandBuffer.substring(closingTagIdx + 1) : '';
                     commandBuffer = '';
                     continue;
                   } catch {
                     // incomplete, wait for more tokens
                   }
                } else if (commandBuffer.endsWith(']')) {
                   const rawContent = commandBuffer.replace('[COMMAND:', '').replace(']', '').trim();
                   if (!rawContent.includes('{')) {
                      await this.executeCommand(tenantId, userId, rawContent, '{}');
                      isCapturingCommand = false;
                      streamBuffer = '';
                      commandBuffer = '';
                   }
                }
              }
            }
          }
          if (parsed.done === true) break;
        }
      }

      // Final flush
      if (streamBuffer && !isCapturingCommand) {
        yield this.chunk('token', { content: streamBuffer });
      }

      yield this.chunk('done', {
        metrics: {
          totalMs: Date.now() - startTime,
          tokens: tokensGenerated,
          mode: 'strategic-agent',
        },
      });

      clearTimeout(timeout);

    } catch (e: any) {
      // INTERCEPT DOMException THROWN BY reader.read() WHEN ABORTED
      if (e.name === 'AbortError' || e.message === 'This operation was aborted') {
        e.message = 'AI_TIMEOUT';
      }

      this.logger.error(`[Agent:Fatal] Query failure: ${e.message}`);

      let userMessage: string;

      if (e.message === 'AI_ENGINE_OFFLINE' || e.message?.includes('ECONNREFUSED')) {
        userMessage = "The AI engine is starting up. Please try again in a moment — your financial data is still accessible on the dashboard.";
      } else if (e.message === 'AI_TIMEOUT') {
        userMessage = "We’re analyzing your data. One part is taking longer than expected. Here’s what we’ve found so far.";
      } else if (e.message?.includes('DATABASE') || e.message?.includes('ClickHouse')) {
        userMessage = "I'm having trouble accessing your financial data. Please check your connection status on the Integrations page.";
      } else {
        userMessage = "I encountered an unexpected issue during analysis. Our team has been notified. Please try again shortly.";
      }

      yield this.chunk('error', { message: userMessage });
    }
  }

  /**
   * Execute an intercepted agent command.
   */
  private async executeCommand(tenantId: string, userId: string, cmdName: string, cmdJson: string): Promise<void> {
    try {
      const payload = JSON.parse(cmdJson.trim());

      if (cmdName === 'GENERATE_DASHBOARD' && payload.charts && Array.isArray(payload.charts)) {
        this.logger.log(`[Agent:Dashboard] Persisting unified dashboard entity: ${payload.title}`);
        await this.toolExecutor.generateDashboard(tenantId, userId, {
          title: payload.title || 'Strategic Dashboard',
          description: payload.description || 'Generated dashboard orchestration',
          charts: payload.charts
        });
      } else if (cmdName === 'SAVE_INSIGHT' || payload.type === 'dashboard' || payload.type === 'line' || payload.type === 'bar' || payload.type === 'pie' || payload.type === 'metric' || payload.type === 'table') {
        await this.toolExecutor.saveInsightToDashboard(tenantId, payload);
      } else if (cmdName === 'QUERY_SQL') {
        const result = await this.toolExecutor.queryFinancialDatabase(tenantId, payload);
        this.logger.debug(`[Agent:SQL] Fact-check result: ${result.count} rows found.`);
      }
    } catch (e: any) {
      this.logger.warn(`[Agent:Command] Failed to execute ${cmdName}: ${e.message}`);
    }
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

    return {
      status: 'ok',
      layer: 'agent',
      ollama: ollamaStatus,
      engine: this.OLLAMA_MODEL,
      uptime: process.uptime(),
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
}
