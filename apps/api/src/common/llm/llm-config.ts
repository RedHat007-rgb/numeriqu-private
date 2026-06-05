export type LlmProvider = 'ollama' | 'openai';

export type LlmRuntimeConfig = {
  provider: LlmProvider;
  url: string;
  model: string;
};

const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_OPENAI_MODEL = 'gpt-5.4-mini';

const normalize = (value: string | undefined) =>
  (value ?? '').trim().toLowerCase();

export function resolveLlmProvider(): LlmProvider {
  return normalize(process.env.LLM_PROVIDER) === 'openai' ? 'openai' : 'ollama';
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

  return {
    provider,
    url: process.env.OLLAMA_URL?.trim() || DEFAULT_OLLAMA_URL,
    model: process.env.OLLAMA_MODEL?.trim() || defaultOllamaModel,
  };
}
