export type LlmProvider = 'ollama' | 'openai' | 'gemini';

export type LlmRuntimeConfig = {
  provider: LlmProvider;
  url: string;
  model: string;
};

const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_OPENAI_MODEL = 'gpt-5.4-mini';
const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';

const normalize = (value: string | undefined) =>
  (value ?? '').trim().toLowerCase();

export function resolveLlmProvider(): LlmProvider {
  const provider = normalize(process.env.LLM_PROVIDER);
  if (provider === 'openai') return 'openai';
  if (provider === 'gemini') return 'gemini';
  return 'ollama';
}

export function resolveLlmRuntimeConfig(
  defaultOllamaModel: string,
): LlmRuntimeConfig {
  const provider = resolveLlmProvider();

  if (provider === 'openai') {
    return {
      provider,
      url: process.env.OPENAI_BASE_URL?.trim() || DEFAULT_OPENAI_BASE_URL,
      model: process.env.OPENAI_MODEL?.trim() || DEFAULT_OPENAI_MODEL,
    };
  }

  if (provider === 'gemini') {
    return {
      provider,
      url: process.env.GEMINI_BASE_URL?.trim() || DEFAULT_GEMINI_BASE_URL,
      model: process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL,
    };
  }

  return {
    provider,
    url: process.env.OLLAMA_URL?.trim() || DEFAULT_OLLAMA_URL,
    model: process.env.OLLAMA_MODEL?.trim() || defaultOllamaModel,
  };
}

export function getLlmProviderLabel(provider: LlmProvider): string {
  if (provider === 'openai') return 'OpenAI';
  if (provider === 'gemini') return 'Gemini';
  return 'Ollama';
}
