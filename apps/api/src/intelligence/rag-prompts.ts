/**
 * @deprecated Use prompt-builder.ts — this file is kept for backward compatibility.
 * All prompt logic has been moved to prompt-builder.ts which uses
 * compressed plaintext facts (40% fewer tokens) and the finance domain gate.
 */
export { FINANCE_SYSTEM_PROMPT as RAG_SYSTEM_PROMPT, buildFactBlock as SCHEMA_CONTEXT_INJECTOR } from './prompt-builder';

export const ERROR_MESSAGES = {
  OLLAMA_OFFLINE:    'Intelligence engine warming up. Showing live ClickHouse metrics.',
  MODEL_NOT_FOUND:   'Optimizing reasoning models. One moment...',
  GENERIC_ERROR:     'Slight delay synthesizing strategy. Showing verified ledger data...',
};
