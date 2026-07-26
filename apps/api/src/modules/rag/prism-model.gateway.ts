import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { resolveLlmRuntimeConfig } from '../../common/llm/llm-config';

export type PrismModelRequest = {
  dataClass: 'prompt_only';
  schema: Record<string, unknown>;
  system: string;
  user: string;
  signal?: AbortSignal;
};

export interface PrismModelPort {
  generateJson(request: PrismModelRequest): Promise<unknown>;
}

@Injectable()
export class PrismModelGateway implements PrismModelPort {
  constructor(private readonly config: ConfigService) {}

  async generateJson(request: PrismModelRequest): Promise<unknown> {
    const runtime = resolveLlmRuntimeConfig('llama3:latest');
    const timeoutMs = this.positiveInt('PRISM_MODEL_TIMEOUT_MS', 15_000);
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = request.signal
      ? AbortSignal.any([request.signal, timeout])
      : timeout;

    if (runtime.provider === 'openai') {
      const apiKey = this.config.get<string>('OPENAI_API_KEY')?.trim();
      if (!apiKey) throw new Error('OpenAI is not configured.');
      // Prism's model tasks (scope, intent, prose) are shallow — force a low
      // reasoning budget on reasoning-class models so they answer in ~1-2s
      // instead of "thinking" for tens of seconds. The field is only sent for
      // reasoning-class models (gpt-5*/o-series); others ignore it.
      const isReasoningModel = /^(gpt-5|o[134])/i.test(runtime.model);
      const reasoningEffort =
        this.config.get<string>('PRISM_REASONING_EFFORT')?.trim() || 'low';
      const url = `${runtime.url.replace(/\/$/, '')}/chat/completions`;
      const buildInit = (includeEffort: boolean): RequestInit => ({
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        signal,
        body: JSON.stringify({
          model: runtime.model,
          temperature: 0,
          ...(includeEffort && isReasoningModel
            ? { reasoning_effort: reasoningEffort }
            : {}),
          max_completion_tokens: this.positiveInt(
            'PRISM_MODEL_MAX_OUTPUT_TOKENS',
            800,
          ),
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'prism_finance_plan',
              strict: true,
              schema: request.schema,
            },
          },
          messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: request.user },
          ],
        }),
      });
      let response = await this.fetchWithRetry(url, buildInit(true));
      // reasoning_effort isn't accepted by every model/endpoint. If it 400s,
      // retry once WITHOUT it so this optimization can never turn a working
      // call into a failure.
      if (response.status === 400 && isReasoningModel) {
        await response.body?.cancel().catch(() => undefined);
        response = await this.fetchWithRetry(url, buildInit(false));
      }
      if (!response.ok)
        throw new Error(`Model gateway returned ${response.status}.`);
      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      return this.parse(payload.choices?.[0]?.message?.content);
    }

    if (runtime.provider === 'ollama') {
      const response = await this.fetchWithRetry(
        `${runtime.url.replace(/\/$/, '')}/api/chat`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal,
          body: JSON.stringify({
            model: runtime.model,
            stream: false,
            format: request.schema,
            messages: [
              { role: 'system', content: request.system },
              { role: 'user', content: request.user },
            ],
          }),
        },
      );
      if (!response.ok)
        throw new Error(`Model gateway returned ${response.status}.`);
      const payload = (await response.json()) as {
        message?: { content?: string };
      };
      return this.parse(payload.message?.content);
    }

    throw new Error('The configured model provider is not enabled for Prism.');
  }

  private parse(content: string | undefined): unknown {
    if (!content?.trim())
      throw new Error('Model gateway returned no structured output.');
    return JSON.parse(content);
  }

  private positiveInt(key: string, fallback: number): number {
    const value = Number(this.config.get<string>(key));
    return Number.isInteger(value) && value > 0 ? value : fallback;
  }

  private async fetchWithRetry(
    url: string,
    init: RequestInit,
  ): Promise<Response> {
    const maxAttempts = this.positiveInt('PRISM_MODEL_MAX_ATTEMPTS', 2);
    let lastResponse: Response | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const response = await fetch(url, init);
      lastResponse = response;
      const retryable = response.status === 429 || response.status >= 500;
      if (response.ok || !retryable || attempt === maxAttempts) return response;
      await response.body?.cancel().catch(() => undefined);
      const retryAfterSeconds = Number(response.headers.get('retry-after'));
      const delayMs = Number.isFinite(retryAfterSeconds)
        ? retryAfterSeconds * 1_000
        : Math.min(250 * 2 ** (attempt - 1), 2_000);
      await this.abortableDelay(delayMs, init.signal);
    }
    return lastResponse!;
  }

  private async abortableDelay(
    delayMs: number,
    signal?: AbortSignal | null,
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal?.reason ?? new Error('Request aborted.'));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, delayMs);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}
