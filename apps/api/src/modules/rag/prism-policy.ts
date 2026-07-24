export const PRISM_TONES = ['executive', 'professional', 'friendly'] as const;

export type PrismTone = (typeof PRISM_TONES)[number];

export type PrismScopeDecision =
  | { kind: 'greeting' }
  | { kind: 'finance'; domains: string[] }
  | { kind: 'restricted_finance'; reason: 'personalized_regulated_advice' }
  | { kind: 'unsafe'; reason: 'prompt_or_data_extraction' }
  | { kind: 'off_topic' };

export type PrismRiskDecision = {
  disposition: 'read_only' | 'human_review' | 'blocked';
  reason: string;
};

const FINANCE_DOMAINS: ReadonlyArray<{
  id: string;
  patterns: readonly RegExp[];
}> = [
  {
    id: 'financial_reporting',
    patterns: [
      /\b(financial statement|income statement|balance sheet|cash flow statement|p&l|profit and loss|general ledger|trial balance)\b/i,
      /\b(revenue|sales|income|expenses?|costs?|profit(?:ability|able|s)?|loss|margins?|ebitda|ebit|gross profit|net income)\b/i,
    ],
  },
  {
    id: 'planning',
    patterns: [
      /\b(budget|forecast|plan vs actual|actual vs plan|variance|scenario|sensitivity|projection|outlook)\b/i,
      /\b(month over month|quarter over quarter|year over year|mom|qoq|yoy|trend|growth rate)\b/i,
    ],
  },
  {
    id: 'treasury',
    patterns: [
      /\b(cash|liquidity|runway|burn rate|treasury|bank balance|working capital|cash conversion cycle)\b/i,
      /\b(dso|dpo|days sales outstanding|days payable outstanding)\b/i,
    ],
  },
  {
    id: 'finance_operations',
    patterns: [
      /\b(invoice|billing|accounts receivable|accounts payable|receivable|payable|collections?|overdue|aging|reconcil(?:e|iation))\b/i,
      /\b(journal entr(?:y|ies)|close process|purchase order|payment|vendor|customer concentration)\b/i,
    ],
  },
  {
    id: 'corporate_finance',
    patterns: [
      /\b(valuation|discounted cash flow|dcf|npv|irr|roi|return on investment|capital allocation|cost of capital|wacc)\b/i,
      /\b(debt|equity|financing|funding|covenant|leverage|solvency|acquisition|merger|dividend)\b/i,
    ],
  },
  {
    id: 'unit_economics',
    patterns: [
      /\b(arr|mrr|churn|retention|cac|ltv|unit economics|payback period|contribution margin|breakeven)\b/i,
    ],
  },
  {
    id: 'risk_controls_tax',
    patterns: [
      /\b(financial risk|credit risk|market risk|currency risk|fx risk|exposure|internal control|audit|fraud|materiality)\b/i,
      /\b(tax|vat|gst|withholding|transfer pricing)\b/i,
    ],
  },
  {
    id: 'accounting_systems',
    patterns: [
      /\b(quickbooks|xero|erp|accounting system|chart of accounts|fiscal year|fiscal quarter)\b/i,
    ],
  },
  {
    id: 'multilingual_finance',
    patterns: [
      /\b(ingresos|beneficio|margen|gastos|flujo de caja|facturas?)\b/i,
      /\b(chiffre d'affaires|bénéfice|marge|dépenses|trésorerie|factures?)\b/i,
      /\b(umsatz|gewinn|marge|kosten|cashflow|rechnungen?)\b/i,
      /(?:राजस्व|लाभ|मार्जिन|खर्च|नकदी प्रवाह|चालान)/i,
      /(?:الإيرادات|الربح|الهامش|المصروفات|التدفق النقدي|الفواتير)/i,
    ],
  },
];

/** Ids of the governed finance domains, for cross-module consistency checks. */
export const FINANCE_DOMAIN_IDS: readonly string[] = FINANCE_DOMAINS.map(
  (domain) => domain.id,
);

const GREETING =
  /^(hi|hello|hey|good (morning|afternoon|evening)|who are you|what can you do|help)[!.?\s]*$/i;

const PROMPT_OR_DATA_EXTRACTION =
  /\b(system prompt|developer message|hidden instruction|ignore (all|your|the) (previous|prior|system)|reveal (your|the) prompt|dump (the )?(database|credentials|secrets)|database credentials|tenant_id|encode.{0,30}(credentials|secrets)|(?:an)?other (customer|tenant|organization).{0,30}(data|records|prompt|invoices?))\b/i;

const PERSONALIZED_REGULATED_ADVICE =
  /\b(what|which).{0,24}(stock|share|bond|fund|etf|crypto).{0,24}(should i|to buy|to sell)|\b(buy|sell|short).{0,20}(stock|share|bond|fund|etf|crypto)|\b(file|prepare|submit).{0,16}\bmy (?:personal )?(?:tax return|taxes|tax)\b/i;

export function normalizePrismTone(value: unknown): PrismTone {
  return typeof value === 'string' &&
    (PRISM_TONES as readonly string[]).includes(value)
    ? (value as PrismTone)
    : 'professional';
}

export function classifyPrismScope(query: string): PrismScopeDecision {
  const normalized = query.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (GREETING.test(normalized)) return { kind: 'greeting' };
  if (PROMPT_OR_DATA_EXTRACTION.test(normalized)) {
    return { kind: 'unsafe', reason: 'prompt_or_data_extraction' };
  }
  if (PERSONALIZED_REGULATED_ADVICE.test(normalized)) {
    return {
      kind: 'restricted_finance',
      reason: 'personalized_regulated_advice',
    };
  }

  const domains = FINANCE_DOMAINS.filter(({ patterns }) =>
    patterns.some((pattern) => pattern.test(normalized)),
  ).map(({ id }) => id);

  return domains.length > 0
    ? { kind: 'finance', domains }
    : { kind: 'off_topic' };
}

export function assessPrismRisk(query: string): PrismRiskDecision {
  const scope = classifyPrismScope(query);
  if (scope.kind === 'finance' || scope.kind === 'greeting') {
    return { disposition: 'read_only', reason: scope.kind };
  }
  if (scope.kind === 'restricted_finance') {
    return {
      disposition: 'human_review',
      reason: 'personalized_regulated_advice',
    };
  }
  return { disposition: 'blocked', reason: scope.kind };
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
