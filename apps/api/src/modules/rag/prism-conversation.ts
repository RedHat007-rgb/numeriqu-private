import type { PrismModelPort } from './prism-model.gateway';
import type { PrismTone } from './prism-policy';

/**
 * Model-generated conversational prose for Prism (greetings today; concept
 * explanations next). The model writes the WORDS; it never produces a
 * financial figure — any output containing a currency/percent number is
 * rejected so the caller falls back to the deterministic text. Numbers only
 * ever come from the governed calculation engine.
 */

const MESSAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['message'],
  properties: { message: { type: 'string', maxLength: 600 } },
} as const;

const TONE_STYLE: Record<PrismTone, string> = {
  executive: 'in one crisp, outcome-oriented sentence',
  professional: 'in one or two precise sentences',
  friendly: 'in a warm, conversational sentence or two',
};

/**
 * A conversational line must never carry a company-specific figure. If the
 * model slips a currency/percent number in, treat the output as unusable.
 */
const CONTAINS_FIGURE = /[$€£]\s?\d|\d[\d.,]*\s?(?:%|percent|usd|eur|gbp)/i;

function safeMessage(result: unknown): string | null {
  const message = (result as { message?: unknown })?.message;
  if (typeof message !== 'string') return null;
  const trimmed = message.trim();
  if (!trimmed || trimmed.length > 600 || CONTAINS_FIGURE.test(trimmed)) {
    return null;
  }
  return trimmed;
}

/**
 * Generate a tone-aware Prism greeting via the model. Returns null on any
 * failure (timeout, provider error, unusable output) so the caller can fall
 * back to the deterministic greeting — a greeting must never fail a request.
 */
export async function generatePrismGreeting(
  model: PrismModelPort,
  tone: PrismTone,
  userText: string,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const result = await model.generateJson({
      dataClass: 'prompt_only',
      schema: MESSAGE_SCHEMA as unknown as Record<string, unknown>,
      system:
        `You are Prism, NumeriQ's finance-only decision advisor. ` +
        `Greet the user ${TONE_STYLE[tone]} and invite a finance question ` +
        `(revenue, cash and liquidity, receivables, profitability, budgets, forecasts). ` +
        `Introduce yourself as Prism. Do NOT state any specific number, currency amount, ` +
        `percentage, or company data. Do NOT mention non-finance topics or internal ` +
        `systems. Put the greeting in the "message" field as plain text.`,
      user: userText,
      signal,
    });
    return safeMessage(result);
  } catch {
    return null;
  }
}
