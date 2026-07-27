import type { PrismModelPort } from './prism-model.gateway';
import type { PrismTone } from './prism-policy';

/**
 * Turns VERIFIED figures into a natural-language explanation with OpenAI.
 *
 * The model writes the reasoning and prose; it does NOT produce the numbers.
 * It receives the exact, pre-formatted figures computed by the governed engine
 * and is instructed to copy them verbatim. As a hard backstop, any financial
 * figure in the model's output that is not present in the verified facts causes
 * the whole composition to be rejected — the caller then falls back to the
 * deterministic template. Numbers are therefore never model-authored.
 */

const MESSAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['message'],
  properties: { message: { type: 'string', maxLength: 1600 } },
} as const;

const TONE_STYLE: Record<PrismTone, string> = {
  executive: 'Lead with the outcome and its business implication; be brief.',
  professional:
    'Be precise and structured; use finance terms with a plain explanation.',
  friendly: 'Be warm and educational without being casual about risk.',
};

/** Currency- or percent-shaped figure tokens (what a fabricated number looks like). */
const FIGURE_TOKEN =
  /[$€£]\s?\d[\d.,]*\s?(?:k|m|bn|b|tn|t|million|billion|trillion)?|\d[\d.,]*\s?%/gi;

const normalize = (value: string): string =>
  value.toLowerCase().replace(/\s+/g, '');

/**
 * Every currency/percent figure in the output must appear in the verified
 * facts. Prevents the model from inventing or re-rounding a number.
 */
export function numbersAreGrounded(output: string, factsBlob: string): boolean {
  const facts = normalize(factsBlob);
  const tokens = output.match(FIGURE_TOKEN) ?? [];
  return tokens.every((token) => facts.includes(normalize(token)));
}

export interface PrismComposeInput {
  tone: PrismTone;
  rangeLabel: string;
  title: string;
  /** Pre-formatted, verified fact lines (e.g. "- Client: Acme · Revenue: $1.2M"). */
  factLines: string[];
  /** Optional note, e.g. row-truncation disclosure. */
  note?: string;
}

/**
 * Compose a Prism answer with OpenAI over verified facts. Returns null on any
 * failure (no facts, timeout, provider error, or an ungrounded number) so the
 * caller falls back to the deterministic answer — a query never fails because
 * the explanation could not be generated.
 */
export async function composePrismAnswer(
  model: PrismModelPort,
  input: PrismComposeInput,
  signal?: AbortSignal,
): Promise<string | null> {
  if (input.factLines.length === 0) return null;
  const factsBlob = input.factLines.join('\n');
  try {
    const result = await model.generateJson({
      dataClass: 'prompt_only',
      schema: MESSAGE_SCHEMA as unknown as Record<string, unknown>,
      system:
        `You are Prism, a sharp finance analyst talking directly to a CFO. ${TONE_STYLE[input.tone]} ` +
        `You are given VERIFIED figures for "${input.title}" over ${input.rangeLabel}. ` +
        `Reply like a real person in chat — natural, flowing prose, usually 1-3 sentences. Lead with the ` +
        `number and what it means for the business, then add a caveat only if it genuinely matters. ` +
        `Do NOT use numbered lists, bullet points, headers, or labels like "Direct answer" or "(1) (2) (3)" — ` +
        `just talk. STRICT RULES: use ONLY the figures provided, copied verbatim — never invent, re-round, or add ` +
        `any number, currency amount, or percentage that is not in the provided facts. Do not output SQL, table ` +
        `names, column names, tenant ids, or any internal system detail. Put the full answer in the "message" field.`,
      user: `Verified figures:\n${factsBlob}${input.note ? `\n\n${input.note}` : ''}`,
      signal,
    });
    const message = (result as { message?: unknown })?.message;
    if (typeof message !== 'string') return null;
    const trimmed = message.trim();
    if (!trimmed) return null;
    // Hard backstop: reject any figure the model introduced beyond the verified set.
    if (!numbersAreGrounded(trimmed, factsBlob)) return null;
    return trimmed;
  } catch {
    return null;
  }
}
