import {
  getLlmProviderLabel,
  resolveLlmProvider,
  resolveLlmRuntimeConfig,
} from './llm-config';
import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

const nativeFetch = globalThis.fetch.bind(globalThis);
let installed = false;
const logger = new Logger('LLM');

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const getRequestUrl = (input: FetchInput): string => {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  if (input instanceof Request) return input.url;
  return String(input);
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
    },
  });

const isReasoningModel = (model: string) =>
  /^gpt-5/i.test(model) || /^o[134]/i.test(model);

const mapMessages = (
  messages: Array<{ role?: string; content?: unknown }> = [],
  model: string,
) => {
  const useDeveloperRole = isReasoningModel(model);

  return messages.map((message) => {
    const role = message?.role ?? 'user';
    if (useDeveloperRole && role === 'system') {
      return {
        role: 'developer',
        content: message?.content ?? '',
      };
    }

    return {
      role,
      content: message?.content ?? '',
    };
  });
};

const mapResponseFormat = (format: unknown) => {
  if (!format) return undefined;
  if (format === 'json' || format === 'json_object') {
    return { type: 'json_object' };
  }

  if (typeof format === 'object') {
    return {
      type: 'json_schema',
      json_schema: {
        name: 'ollama_format',
        strict: true,
        schema: format,
      },
    };
  }

  return undefined;
};

const mapChatOptions = (options: Record<string, unknown> | undefined) => {
  if (!options) return {};

  const mapped: Record<string, unknown> = {};

  if (typeof options.temperature === 'number') {
    mapped.temperature = options.temperature;
  }

  if (typeof options.top_p === 'number') {
    mapped.top_p = options.top_p;
  }

  if (typeof options.frequency_penalty === 'number') {
    mapped.frequency_penalty = options.frequency_penalty;
  }

  if (typeof options.presence_penalty === 'number') {
    mapped.presence_penalty = options.presence_penalty;
  }

  if (Array.isArray(options.stop) && options.stop.length > 0) {
    mapped.stop = options.stop;
  }

  if (typeof options.num_predict === 'number' && options.num_predict > 0) {
    mapped.max_completion_tokens = options.num_predict;
  }

  return mapped;
};

const readRequestBody = async (input: FetchInput, init?: FetchInit) => {
  if (typeof init?.body === 'string') {
    return init.body ? JSON.parse(init.body) : {};
  }

  if (init?.body instanceof Uint8Array) {
    const decoded = textDecoder.decode(init.body).trim();
    return decoded ? JSON.parse(decoded) : {};
  }

  if (input instanceof Request) {
    const cloned = input.clone();
    const raw = await cloned.text();
    return raw ? JSON.parse(raw) : {};
  }

  return {};
};

const normalizeText = (value: unknown): string => {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  return String(value);
};

const mapGeminiMessages = (
  messages: Array<{ role?: string; content?: unknown }> = [],
) => {
  const systemParts: string[] = [];
  const contents: Array<{
    role?: 'user' | 'model';
    parts: Array<{ text: string }>;
  }> = [];

  for (const message of messages) {
    const text = normalizeText(message?.content);
    if (!text.trim()) continue;

    const role = (message?.role ?? 'user').toLowerCase();
    if (role === 'system' || role === 'developer') {
      systemParts.push(text);
      continue;
    }

    contents.push({
      role: role === 'assistant' || role === 'model' ? 'model' : 'user',
      parts: [{ text }],
    });
  }

  return {
    systemInstruction: systemParts.length
      ? {
          parts: [{ text: systemParts.join('\n\n') }],
        }
      : undefined,
    contents,
  };
};

const mapGeminiGenerationConfig = (
  options: Record<string, unknown> | undefined,
  format: unknown,
) => {
  const generationConfig: Record<string, unknown> = {};

  if (!options) {
    if (format === 'json' || format === 'json_object') {
      generationConfig.responseMimeType = 'application/json';
    } else if (typeof format === 'object' && format) {
      generationConfig.responseMimeType = 'application/json';
      generationConfig.responseSchema = format;
    }
    return generationConfig;
  }

  if (typeof options.temperature === 'number') {
    generationConfig.temperature = options.temperature;
  }

  if (typeof options.top_p === 'number') {
    generationConfig.topP = options.top_p;
  }

  if (typeof options.top_k === 'number') {
    generationConfig.topK = options.top_k;
  }

  if (typeof options.num_predict === 'number' && options.num_predict > 0) {
    generationConfig.maxOutputTokens = options.num_predict;
  }

  if (typeof options.frequency_penalty === 'number') {
    generationConfig.frequencyPenalty = options.frequency_penalty;
  }

  if (typeof options.presence_penalty === 'number') {
    generationConfig.presencePenalty = options.presence_penalty;
  }

  if (Array.isArray(options.stop) && options.stop.length > 0) {
    generationConfig.stopSequences = options.stop.filter(
      (value): value is string => typeof value === 'string' && value.length > 0,
    );
  }

  if (format === 'json' || format === 'json_object') {
    generationConfig.responseMimeType = 'application/json';
  } else if (typeof format === 'object' && format) {
    generationConfig.responseMimeType = 'application/json';
    generationConfig.responseSchema = format;
  }

  return generationConfig;
};

const extractGeminiText = (payload: any): string => {
  const candidate = payload?.candidates?.[0];
  const parts = candidate?.content?.parts;
  if (!Array.isArray(parts)) return '';

  return parts
    .map((part) => normalizeText(part?.text))
    .filter((text) => text.length > 0)
    .join('');
};

const geminiBaseUrl = (baseUrl: string) => baseUrl.replace(/\/$/, '');

const geminiApiKey = () => process.env.GEMINI_API_KEY?.trim();

const translateGeminiSseToNdjson = async (
  upstream: Response,
  model: string,
  requestId: string,
  startedAt: number,
) => {
  const reader = upstream.body?.getReader();
  if (!reader) return upstream;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let carry = '';
      let finished = false;

      const finish = () => {
        if (finished) return;
        finished = true;
        logChatEnd({
          requestId,
          provider: 'gemini',
          model,
          status: upstream.status,
          stream: true,
          durationMs: Date.now() - startedAt,
        });
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          carry += textDecoder.decode(value, { stream: true });
          const lines = carry.split(/\r?\n/);
          carry = lines.pop() ?? '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data:')) continue;

            const payload = trimmed.slice(5).trim();
            if (!payload || payload === '[DONE]') {
              finish();
              controller.enqueue(
                textEncoder.encode(
                  JSON.stringify({
                    model,
                    done: true,
                    message: { role: 'assistant', content: '' },
                  }) + '\n',
                ),
              );
              controller.close();
              return;
            }

            let parsed: any;
            try {
              parsed = JSON.parse(payload);
            } catch {
              continue;
            }

            const token = extractGeminiText(parsed);
            if (token) {
              controller.enqueue(
                textEncoder.encode(
                  JSON.stringify({
                    model,
                    done: false,
                    message: { role: 'assistant', content: token },
                  }) + '\n',
                ),
              );
            }

            if (parsed?.candidates?.some((candidate: any) => candidate?.finishReason)) {
              finish();
              controller.enqueue(
                textEncoder.encode(
                  JSON.stringify({
                    model,
                    done: true,
                    message: { role: 'assistant', content: '' },
                  }) + '\n',
                ),
              );
              controller.close();
              return;
            }
          }
        }

        finish();
        controller.enqueue(
          textEncoder.encode(
            JSON.stringify({
              model,
              done: true,
              message: { role: 'assistant', content: '' },
            }) + '\n',
          ),
        );
        controller.close();
      } catch (error) {
        finish();
        controller.error(error);
      }
    },
  });

  return new Response(stream, {
    status: upstream.status,
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
    },
  });
};

const handleGeminiTags = async (input: FetchInput, init?: FetchInit) => {
  const runtime = resolveLlmRuntimeConfig('llama3:latest');
  const apiKey = geminiApiKey();
  const requestId = randomUUID().slice(0, 8);
  const startedAt = Date.now();

  logTagsStart({
    requestId,
    provider: 'gemini',
    backendUrl: runtime.url,
  });

  if (!apiKey) {
    return jsonResponse(
      { error: 'GEMINI_API_KEY is required for Gemini mode.' },
      500,
    );
  }

  const upstream = await nativeFetch(
    `${geminiBaseUrl(runtime.url)}/models?pageSize=1000`,
    {
      method: 'GET',
      headers: {
        'x-goog-api-key': apiKey,
      },
      signal: init?.signal ?? (input instanceof Request ? input.signal : undefined),
    },
  );

  if (!upstream.ok) {
    logTagsEnd({
      requestId,
      provider: 'gemini',
      status: upstream.status,
      modelCount: 0,
      durationMs: Date.now() - startedAt,
    });
    return upstream;
  }

  const body = (await upstream.json()) as {
    models?: Array<{ name?: string; displayName?: string }>;
    nextPageToken?: string;
  };
  const models = (body.models ?? [])
    .map((entry) => entry.name || entry.displayName)
    .filter((name): name is string => Boolean(name))
    .map((name) => ({
      name: name.replace(/^models\//, ''),
      model: name.replace(/^models\//, ''),
    }));

  logTagsEnd({
    requestId,
    provider: 'gemini',
    status: upstream.status,
    modelCount: models.length,
    durationMs: Date.now() - startedAt,
  });

  return jsonResponse({
    models,
    data: models.map((entry) => ({ id: entry.model })),
    nextPageToken: body.nextPageToken,
  });
};

const handleGeminiChat = async (
  input: FetchInput,
  init?: FetchInit,
  requestBody?: {
    model?: string;
    messages?: Array<{ role?: string; content?: unknown }>;
    stream?: boolean;
    options?: Record<string, unknown>;
    format?: unknown;
  },
) => {
  const runtime = resolveLlmRuntimeConfig('llama3:latest');
  const apiKey = geminiApiKey();
  const requestId = randomUUID().slice(0, 8);
  const startedAt = Date.now();

  if (!apiKey) {
    return jsonResponse(
      { error: 'GEMINI_API_KEY is required for Gemini mode.' },
      500,
    );
  }

  const parsedBody =
    requestBody ??
    ((await readRequestBody(input, init)) as {
      model?: string;
      messages?: Array<{ role?: string; content?: unknown }>;
      stream?: boolean;
      options?: Record<string, unknown>;
      format?: unknown;
    });

  const model = parsedBody.model?.trim() || runtime.model;
  const stream = parsedBody.stream !== false;
  const { contents, systemInstruction } = mapGeminiMessages(parsedBody.messages);
  const generationConfig = mapGeminiGenerationConfig(
    parsedBody.options,
    parsedBody.format,
  );

  logChatStart({
    requestId,
    provider: 'gemini',
    backendUrl: runtime.url,
    model,
    stream,
    messageCount: parsedBody.messages?.length ?? 0,
  });

  const payload: Record<string, unknown> = {
    contents,
  };

  if (systemInstruction) {
    payload.systemInstruction = systemInstruction;
  }

  if (Object.keys(generationConfig).length > 0) {
    payload.generationConfig = generationConfig;
  }

  const upstream = await nativeFetch(
    `${geminiBaseUrl(runtime.url)}/models/${encodeURIComponent(model)}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      signal: init?.signal ?? (input instanceof Request ? input.signal : undefined),
      body: JSON.stringify(payload),
    },
  );

  if (!upstream.ok) {
    logChatEnd({
      requestId,
      provider: 'gemini',
      model,
      status: upstream.status,
      stream,
      durationMs: Date.now() - startedAt,
    });
    return upstream;
  }

  if (stream) {
    return translateGeminiSseToNdjson(upstream, model, requestId, startedAt);
  }

  const body = (await upstream.json()) as {
    candidates?: Array<{
      content?: {
        parts?: Array<{ text?: string }>;
      };
    }>;
  };

  const text = extractGeminiText(body);
  logChatEnd({
    requestId,
    provider: 'gemini',
    model,
    status: upstream.status,
    stream: false,
    durationMs: Date.now() - startedAt,
  });

  return jsonResponse({
    model,
    done: true,
    message: {
      role: 'assistant',
      content: text,
    },
  });
};

const formatProvider = () => {
  const provider = resolveLlmProvider();
  const runtime = resolveLlmRuntimeConfig('llama3:latest');
  return {
    provider,
    backendUrl: runtime.url,
    model: runtime.model,
  };
};

const logChatStart = (details: {
  requestId: string;
  provider: string;
  backendUrl: string;
  model: string;
  stream: boolean;
  messageCount: number;
}) => {
  logger.log(
    `[${details.requestId}] chat start provider=${details.provider} backend=${details.backendUrl} model=${details.model} stream=${details.stream} messages=${details.messageCount}`,
  );
};

const logChatEnd = (details: {
  requestId: string;
  provider: string;
  model: string;
  status: number;
  stream: boolean;
  durationMs: number;
}) => {
  logger.log(
    `[${details.requestId}] chat done provider=${details.provider} model=${details.model} status=${details.status} stream=${details.stream} durationMs=${details.durationMs}`,
  );
};

const logTagsStart = (details: {
  requestId: string;
  provider: string;
  backendUrl: string;
}) => {
  logger.log(
    `[${details.requestId}] tags start provider=${details.provider} backend=${details.backendUrl}`,
  );
};

const logTagsEnd = (details: {
  requestId: string;
  provider: string;
  status: number;
  modelCount: number;
  durationMs: number;
}) => {
  logger.log(
    `[${details.requestId}] tags done provider=${details.provider} status=${details.status} models=${details.modelCount} durationMs=${details.durationMs}`,
  );
};

const translateStreamedOpenAiResponse = async (
  upstream: Response,
  model: string,
  requestId: string,
  startedAt: number,
) => {
  const reader = upstream.body?.getReader();
  if (!reader) return upstream;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let carry = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          carry += textDecoder.decode(value, { stream: true });
          const lines = carry.split(/\r?\n/);
          carry = lines.pop() ?? '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data:')) continue;

            const payload = trimmed.slice(5).trim();
            if (payload === '[DONE]') {
              logChatEnd({
                requestId,
                provider: 'openai',
                model,
                status: upstream.status,
                stream: true,
                durationMs: Date.now() - startedAt,
              });
              controller.enqueue(
                textEncoder.encode(
                  JSON.stringify({
                    model,
                    done: true,
                    message: { role: 'assistant', content: '' },
                  }) + '\n',
                ),
              );
              controller.close();
              return;
            }

            let parsed: any;
            try {
              parsed = JSON.parse(payload);
            } catch {
              continue;
            }

            const token = parsed?.choices?.[0]?.delta?.content;
            if (token) {
              controller.enqueue(
                textEncoder.encode(
                  JSON.stringify({
                    model,
                    done: false,
                    message: { role: 'assistant', content: token },
                  }) + '\n',
                ),
              );
            }

            if (parsed?.choices?.[0]?.finish_reason) {
              logChatEnd({
                requestId,
                provider: 'openai',
                model,
                status: upstream.status,
                stream: true,
                durationMs: Date.now() - startedAt,
              });
              controller.enqueue(
                textEncoder.encode(
                  JSON.stringify({
                    model,
                    done: true,
                    message: { role: 'assistant', content: '' },
                  }) + '\n',
                ),
              );
              controller.close();
              return;
            }
          }
        }

        if (carry.trim()) {
          const trimmed = carry.trim();
          if (trimmed.startsWith('data:')) {
            const payload = trimmed.slice(5).trim();
            if (payload !== '[DONE]') {
              let parsed: any;
              try {
                parsed = JSON.parse(payload);
              } catch {
                parsed = null;
              }
              const token = parsed?.choices?.[0]?.delta?.content;
              if (token) {
                controller.enqueue(
                  textEncoder.encode(
                    JSON.stringify({
                      model,
                      done: false,
                      message: { role: 'assistant', content: token },
                    }) + '\n',
                  ),
                );
              }
            }
          }
        }

        logChatEnd({
          requestId,
          provider: 'openai',
          model,
          status: upstream.status,
          stream: true,
          durationMs: Date.now() - startedAt,
        });
        controller.enqueue(
          textEncoder.encode(
            JSON.stringify({
              model,
              done: true,
              message: { role: 'assistant', content: '' },
            }) + '\n',
          ),
        );
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });

  return new Response(stream, {
    status: upstream.status,
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
    },
  });
};

const translateChatResponse = async (
  upstream: Response,
  model: string,
  stream: boolean,
  requestId: string,
  startedAt: number,
) => {
  if (stream) {
    return translateStreamedOpenAiResponse(upstream, model, requestId, startedAt);
  }

  const body = (await upstream.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    model?: string;
  };

  logChatEnd({
    requestId,
    provider: 'openai',
    model,
    status: upstream.status,
    stream: false,
    durationMs: Date.now() - startedAt,
  });

  return jsonResponse({
    model: body.model ?? model,
    done: true,
    message: {
      role: 'assistant',
      content: body.choices?.[0]?.message?.content ?? '',
    },
  });
};

const handleOpenAiTags = async (input: FetchInput, init?: FetchInit) => {
  const runtime = resolveLlmRuntimeConfig('llama3:latest');
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  const requestId = randomUUID().slice(0, 8);
  const startedAt = Date.now();

  logTagsStart({
    requestId,
    provider: 'openai',
    backendUrl: runtime.url,
  });

  if (!apiKey) {
    return jsonResponse(
      { error: 'OPENAI_API_KEY is required for OpenAI mode.' },
      500,
    );
  }

  const upstream = await nativeFetch(`${runtime.url.replace(/\/$/, '')}/models`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    signal: init?.signal ?? (input instanceof Request ? input.signal : undefined),
  });

  if (!upstream.ok) {
    logTagsEnd({
      requestId,
      provider: 'openai',
      status: upstream.status,
      modelCount: 0,
      durationMs: Date.now() - startedAt,
    });
    return upstream;
  }

  const body = (await upstream.json()) as {
    data?: Array<{ id?: string }>;
  };
  const models = (body.data ?? [])
    .map((entry) => entry.id)
    .filter((id): id is string => Boolean(id))
    .map((id) => ({ name: id, model: id }));

  logTagsEnd({
    requestId,
    provider: 'openai',
    status: upstream.status,
    modelCount: models.length,
    durationMs: Date.now() - startedAt,
  });

  return jsonResponse({
    models,
    data: models.map((entry) => ({ id: entry.model })),
  });
};

const handleOpenAiChat = async (
  input: FetchInput,
  init?: FetchInit,
  requestBody?: {
    model?: string;
    messages?: Array<{ role?: string; content?: unknown }>;
    stream?: boolean;
    options?: Record<string, unknown>;
    format?: unknown;
  },
) => {
  const runtime = resolveLlmRuntimeConfig('llama3:latest');
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  const requestId = randomUUID().slice(0, 8);
  const startedAt = Date.now();

  if (!apiKey) {
    return jsonResponse(
      { error: 'OPENAI_API_KEY is required for OpenAI mode.' },
      500,
    );
  }

  const parsedBody =
    requestBody ??
    ((await readRequestBody(input, init)) as {
      model?: string;
      messages?: Array<{ role?: string; content?: unknown }>;
      stream?: boolean;
      options?: Record<string, unknown>;
      format?: unknown;
    });

  const model = parsedBody.model?.trim() || runtime.model;
  const stream = parsedBody.stream !== false;

  logChatStart({
    requestId,
    provider: 'openai',
    backendUrl: runtime.url,
    model,
    stream,
    messageCount: parsedBody.messages?.length ?? 0,
  });

  const upstream = await nativeFetch(
    `${runtime.url.replace(/\/$/, '')}/chat/completions`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      signal: init?.signal ?? (input instanceof Request ? input.signal : undefined),
      body: JSON.stringify({
        model,
        messages: mapMessages(parsedBody.messages, model),
        stream,
        ...mapChatOptions(parsedBody.options),
        response_format: mapResponseFormat(parsedBody.format),
      }),
    },
  );

  if (!upstream.ok) {
    logChatEnd({
      requestId,
      provider: 'openai',
      model,
      status: upstream.status,
      stream,
      durationMs: Date.now() - startedAt,
    });
    return upstream;
  }

  return translateChatResponse(upstream, model, stream, requestId, startedAt);
};

export function installLlmFetchInterceptor() {
  if (installed) return;
  installed = true;

  const runtime = formatProvider();
  logger.log(
    `LLM interceptor installed provider=${runtime.provider} backend=${runtime.backendUrl} model=${runtime.model}`,
  );

  globalThis.fetch = (async (input: FetchInput, init?: FetchInit) => {
    const url = new URL(getRequestUrl(input));
    const provider = resolveLlmProvider();

    if (url.pathname.endsWith('/api/chat')) {
      if (provider === 'openai') {
        const requestBody = (await readRequestBody(input, init)) as {
          model?: string;
          messages?: Array<{ role?: string; content?: unknown }>;
          stream?: boolean;
          options?: Record<string, unknown>;
          format?: unknown;
        };
        return handleOpenAiChat(input, init, requestBody);
      }

      if (provider === 'gemini') {
        const requestBody = (await readRequestBody(input, init)) as {
          model?: string;
          messages?: Array<{ role?: string; content?: unknown }>;
          stream?: boolean;
          options?: Record<string, unknown>;
          format?: unknown;
        };
        return handleGeminiChat(input, init, requestBody);
      }

      const requestBody = (await readRequestBody(input, init)) as {
        model?: string;
        messages?: Array<{ role?: string; content?: unknown }>;
        stream?: boolean;
      };
      const requestId = randomUUID().slice(0, 8);
      const runtime = resolveLlmRuntimeConfig('llama3:latest');
      const model = requestBody.model?.trim() || runtime.model;
      const stream = requestBody.stream !== false;
      logChatStart({
        requestId,
        provider: 'ollama',
        backendUrl: runtime.url,
        model,
        stream,
        messageCount: requestBody.messages?.length ?? 0,
      });
      const startedAt = Date.now();
      const response = await nativeFetch(input, init);
      logChatEnd({
        requestId,
        provider: 'ollama',
        model,
        status: response.status,
        stream,
        durationMs: Date.now() - startedAt,
      });
      return response;
    }

    if (url.pathname.endsWith('/api/tags')) {
      if (provider === 'openai') {
        return handleOpenAiTags(input, init);
      }

      if (provider === 'gemini') {
        return handleGeminiTags(input, init);
      }

      const requestId = randomUUID().slice(0, 8);
      const runtime = resolveLlmRuntimeConfig('llama3:latest');
      const startedAt = Date.now();
      logTagsStart({
        requestId,
        provider: 'ollama',
        backendUrl: runtime.url,
      });
      const response = await nativeFetch(input, init);
      logTagsEnd({
        requestId,
        provider: 'ollama',
        status: response.status,
        modelCount: response.ok ? 0 : 0,
        durationMs: Date.now() - startedAt,
      });
      return response;
    }

    return nativeFetch(input, init);
  }) as typeof globalThis.fetch;
}
