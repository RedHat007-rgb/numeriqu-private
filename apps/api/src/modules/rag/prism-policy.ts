export const PRISM_TONES = ['executive', 'professional', 'friendly'] as const;

export type PrismTone = (typeof PRISM_TONES)[number];

export type PrismScopeDecision =
  | { kind: 'greeting' }
  | { kind: 'finance'; domains: string[] }
  | { kind: 'restricted_finance'; reason: 'personalized_regulated_advice' }
  | { kind: 'unsafe'; reason: 'prompt_or_data_extraction' }
  | { kind: 'off_topic' };

// Scope classification (greeting / finance / off-topic / unsafe / regulated) is
// performed entirely by the model — see classifyPrismScopeWithModel in
// prism-conversation.ts. No keyword or pattern lists live here. The load-bearing
// safety controls are structural (no model-authored SQL, tenant-scoped reads,
// output validation), not pattern matching.

export function normalizePrismTone(value: unknown): PrismTone {
  return typeof value === 'string' &&
    (PRISM_TONES as readonly string[]).includes(value)
    ? (value as PrismTone)
    : 'professional';
}

export function prismGreeting(tone: PrismTone): string {
  if (tone === 'friendly') {
    return "Hi — I'm **Prism**, your finance decision partner. Ask me about revenue, cash, receivables, performance, or a finance decision. I'll use verified company data and show the calculation in plain language.";
  }
  if (tone === 'executive') {
    return "I'm **Prism** — finance decision intelligence for your business. Ask a financial question and I'll return the verified result, business implication, and calculation.";
  }
  return "I'm **Prism**, NumeriQ's finance decision advisor. I analyze authorized financial data, calculate results deterministically, and explain the business implication, assumptions, and material limitations.";
}

export function prismScopeRefusal(decision: PrismScopeDecision): string {
  if (decision.kind === 'unsafe') {
    return "I can't reveal internal instructions, credentials, or another organization's data. I can help with an authorized financial analysis for your organization.";
  }
  if (decision.kind === 'restricted_finance') {
    return "I can't provide a personalized buy/sell recommendation or prepare a personal tax filing without the required suitability, jurisdiction, and compliance controls. I can explain the financial concept or analyze authorized business-finance data.";
  }
  return 'Prism is exclusively for finance. Ask me about financial performance, cash and liquidity, budgets and forecasts, working capital, profitability, valuation, risk, or finance operations.';
}
