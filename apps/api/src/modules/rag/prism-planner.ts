import { PRISM_POLICY_VERSION, PRISM_PROMPT_VERSION } from './prism-contracts';
import type { PrismModelPort } from './prism-model.gateway';
import {
  PRISM_INTENTS,
  capabilityPlannerGuidance,
  type PrismIntent,
} from './prism-capabilities';

// The capability catalog (prism-capabilities.ts) is the single source of truth
// for allow-listed intents. Re-exported here so existing consumers are stable.
export { PRISM_INTENTS };
export type { PrismIntent };

export type PrismPlan = {
  contractVersion: typeof PRISM_PROMPT_VERSION;
  policyVersion: typeof PRISM_POLICY_VERSION;
  intent: PrismIntent;
  timeRange:
    | 'UNSPECIFIED'
    | 'ALL_TIME'
    | 'MTD'
    | 'QTD'
    | 'YTD'
    | 'LAST_N_DAYS'
    | 'LAST_N_WEEKS'
    | 'LAST_N_MONTHS'
    | 'LAST_N_QUARTERS'
    | 'LAST_N_YEARS';
  periodCount: number;
  needsClarification: boolean;
  clarificationQuestion: string;
};

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'intent',
    'timeRange',
    'periodCount',
    'needsClarification',
    'clarificationQuestion',
    'contractVersion',
    'policyVersion',
  ],
  properties: {
    contractVersion: { type: 'string', enum: [PRISM_PROMPT_VERSION] },
    policyVersion: { type: 'string', enum: [PRISM_POLICY_VERSION] },
    intent: { type: 'string', enum: [...PRISM_INTENTS] },
    timeRange: {
      type: 'string',
      enum: [
        'UNSPECIFIED',
        'ALL_TIME',
        'MTD',
        'QTD',
        'YTD',
        'LAST_N_DAYS',
        'LAST_N_WEEKS',
        'LAST_N_MONTHS',
        'LAST_N_QUARTERS',
        'LAST_N_YEARS',
      ],
    },
    periodCount: { type: 'integer', minimum: 0, maximum: 120 },
    needsClarification: { type: 'boolean' },
    clarificationQuestion: { type: 'string', maxLength: 240 },
  },
} as const;

function isPlan(value: unknown): value is PrismPlan {
  if (!value || typeof value !== 'object') return false;
  const plan = value as Record<string, unknown>;
  return (
    plan.contractVersion === PRISM_PROMPT_VERSION &&
    plan.policyVersion === PRISM_POLICY_VERSION &&
    typeof plan.intent === 'string' &&
    (PRISM_INTENTS as readonly string[]).includes(plan.intent) &&
    typeof plan.timeRange === 'string' &&
    [
      'UNSPECIFIED',
      'ALL_TIME',
      'MTD',
      'QTD',
      'YTD',
      'LAST_N_DAYS',
      'LAST_N_WEEKS',
      'LAST_N_MONTHS',
      'LAST_N_QUARTERS',
      'LAST_N_YEARS',
    ].includes(plan.timeRange) &&
    Number.isInteger(plan.periodCount) &&
    Number(plan.periodCount) >= 0 &&
    Number(plan.periodCount) <= 120 &&
    typeof plan.needsClarification === 'boolean' &&
    typeof plan.clarificationQuestion === 'string'
  );
}

/**
 * OpenAI is used only to translate natural language into an allow-listed plan.
 * It never receives database credentials, table names, raw rows, or permission
 * to calculate a financial result. All values are computed after this step.
 */
export async function planPrismQuery(
  query: string,
  model: PrismModelPort,
  signal?: AbortSignal,
): Promise<PrismPlan | null> {
  const parsed = await model.generateJson({
    dataClass: 'prompt_only',
    schema: PLAN_SCHEMA as unknown as Record<string, unknown>,
    signal,
    system:
      `You are the intent planner for Prism, a finance-only business advisor. ` +
      `Return contractVersion=${PRISM_PROMPT_VERSION} and policyVersion=${PRISM_POLICY_VERSION}. ` +
      'Never answer the question, invent a value, write SQL, request internal system details, or broaden access. Map the request to one allow-listed intent.\n' +
      `${capabilityPlannerGuidance()}\n` +
      'Use UNSPECIFIED when the user did not state a time range. periodCount is zero unless a LAST_N_* range was explicitly stated. Clarify only when executing the financial request would require a material missing choice.',
    user: query,
  });
  return isPlan(parsed) ? parsed : null;
}
