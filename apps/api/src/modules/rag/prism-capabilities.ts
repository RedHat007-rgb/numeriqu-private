/**
 * The single declarative source of truth for Prism's finance capabilities.
 *
 * Adding a capability (e.g. "investments", "tax_analysis") is a NEW ENTRY in
 * `PRISM_CAPABILITIES` — not edits scattered across the planner (allow-listed
 * intents), the presenter (follow-up actions), and the answer service. The
 * planner's JSON-schema intent enum, the planner prompt guidance, and the
 * per-answer follow-up actions are all derived from this file.
 *
 * This module is DATA + PURE HELPERS only: no I/O, no ClickHouse, no model
 * provider, no tenant state. It never widens what Prism can access; it only
 * describes the governed, finance-only capability catalog.
 */

/** Follow-up action ids offered beneath a Prism answer. */
export type PrismFollowUpActionId =
  | 'compare_period'
  | 'explain_drivers'
  | 'create_briefing';

export interface PrismFollowUpAction {
  id: PrismFollowUpActionId;
  label: string;
  prompt: string;
}

export interface PrismCapability {
  /** Allow-listed intent the planner may return. */
  intent: string;
  /** Human-facing label. */
  label: string;
  /**
   * Finance domains (ids from prism-policy `FINANCE_DOMAINS`) this capability
   * serves. Kept in sync with the scope classifier by a registry test.
   */
  domains: readonly string[];
  /** One-line planner guidance: when to choose this intent. */
  plannerHint: string;
  /** Which follow-up actions this capability offers, in display order. */
  followUps: readonly PrismFollowUpActionId[];
}

/** Standard follow-up action templates. `prompt` is templated per answer title. */
const FOLLOW_UP_TEMPLATES: Record<
  PrismFollowUpActionId,
  { label: string; prompt: (title: string) => string }
> = {
  compare_period: {
    label: 'Compare period',
    prompt: (title) => `Compare ${title} with the previous period.`,
  },
  explain_drivers: {
    label: 'Explain drivers',
    prompt: (title) => `Explain the verified drivers of ${title}.`,
  },
  create_briefing: {
    label: 'Create briefing',
    prompt: (title) => `Create an executive finance briefing for ${title}.`,
  },
};

const ALL_FOLLOW_UPS: PrismFollowUpActionId[] = [
  'compare_period',
  'explain_drivers',
  'create_briefing',
];

/**
 * The governed capability catalog. `clarify` is a control intent (ask one
 * high-value question), not a data capability, so it carries no domains or
 * follow-ups.
 */
export const PRISM_CAPABILITIES = [
  {
    intent: 'revenue_summary',
    label: 'Revenue summary',
    domains: ['financial_reporting'],
    plannerHint: 'Total or headline revenue for a period.',
    followUps: ALL_FOLLOW_UPS,
  },
  {
    intent: 'revenue_trend',
    label: 'Revenue trend',
    domains: ['financial_reporting', 'planning'],
    plannerHint: 'Revenue over time (monthly/quarterly/yearly trend or growth).',
    followUps: ALL_FOLLOW_UPS,
  },
  {
    intent: 'receivables',
    label: 'Receivables',
    domains: ['finance_operations', 'treasury'],
    plannerHint: 'Accounts receivable, overdue/aging, or collections.',
    followUps: ALL_FOLLOW_UPS,
  },
  {
    intent: 'invoice_status',
    label: 'Invoice status',
    domains: ['finance_operations'],
    plannerHint: 'Invoice counts or amounts broken down by status.',
    followUps: ALL_FOLLOW_UPS,
  },
  {
    intent: 'entity_breakdown',
    label: 'Entity breakdown',
    domains: ['financial_reporting'],
    plannerHint:
      'A metric split by an entity such as client, customer, or business unit.',
    followUps: ALL_FOLLOW_UPS,
  },
  {
    intent: 'profitability',
    label: 'Profitability',
    domains: ['financial_reporting'],
    plannerHint: 'Profit, margin, or cost-vs-revenue performance.',
    followUps: ALL_FOLLOW_UPS,
  },
  {
    intent: 'liquidity_runway',
    label: 'Liquidity & runway',
    domains: ['treasury'],
    plannerHint: 'Cash position, liquidity, burn, or runway.',
    followUps: ALL_FOLLOW_UPS,
  },
  {
    intent: 'finance_explanation',
    label: 'Finance explanation',
    domains: [],
    plannerHint:
      'A general finance concept explanation that needs no company data.',
    followUps: [],
  },
  {
    intent: 'clarify',
    label: 'Clarify',
    domains: [],
    plannerHint:
      'Only when a material choice (period, entity, currency, basis) is missing.',
    followUps: [],
  },
] as const satisfies ReadonlyArray<PrismCapability>;

export type PrismIntent = (typeof PRISM_CAPABILITIES)[number]['intent'];

/** Allow-listed intents, derived from the catalog (planner schema source). */
export const PRISM_INTENTS: readonly PrismIntent[] = PRISM_CAPABILITIES.map(
  (capability) => capability.intent,
);

const CAPABILITY_BY_INTENT = new Map<string, PrismCapability>(
  PRISM_CAPABILITIES.map((capability) => [capability.intent, capability]),
);

export const capabilityById = (
  intent: string,
): PrismCapability | undefined => CAPABILITY_BY_INTENT.get(intent);

/**
 * Follow-up actions for an answer, resolved from the capability catalog.
 * Falls back to the full set when the capability is unknown, preserving the
 * previous always-three-actions behaviour.
 */
export const followUpActionsFor = (
  title: string,
  intent?: string,
): PrismFollowUpAction[] => {
  const capability = intent ? capabilityById(intent) : undefined;
  const ids = capability ? capability.followUps : ALL_FOLLOW_UPS;
  return ids.map((id) => ({
    id,
    label: FOLLOW_UP_TEMPLATES[id].label,
    prompt: FOLLOW_UP_TEMPLATES[id].prompt(title),
  }));
};

/** Prose capability list injected into the planner system prompt. */
export const capabilityPlannerGuidance = (): string => {
  const lines = PRISM_CAPABILITIES.map(
    (capability) => `- ${capability.intent}: ${capability.plannerHint}`,
  ).join('\n');
  return `Choose exactly one intent from the governed capability catalog:\n${lines}`;
};
