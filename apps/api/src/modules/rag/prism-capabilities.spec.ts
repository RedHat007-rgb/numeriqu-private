import {
  PRISM_CAPABILITIES,
  PRISM_INTENTS,
  capabilityById,
  capabilityPlannerGuidance,
  followUpActionsFor,
} from './prism-capabilities';

describe('prism capability registry', () => {
  it('is the single source of truth for the allow-listed intents', () => {
    expect([...PRISM_INTENTS]).toEqual(
      PRISM_CAPABILITIES.map((capability) => capability.intent),
    );
  });

  it('preserves the exact governed intent set (no silent additions/removals)', () => {
    expect(new Set(PRISM_INTENTS)).toEqual(
      new Set([
        'revenue_summary',
        'revenue_trend',
        'receivables',
        'invoice_status',
        'entity_breakdown',
        'profitability',
        'liquidity_runway',
        'finance_explanation',
        'clarify',
      ]),
    );
  });

  it('has unique intents', () => {
    expect(new Set(PRISM_INTENTS).size).toBe(PRISM_INTENTS.length);
  });

  it('resolves capabilities by intent and returns undefined for unknown', () => {
    expect(capabilityById('revenue_summary')?.label).toBe('Revenue summary');
    expect(capabilityById('not_a_real_intent')).toBeUndefined();
  });

  it('offers no follow-ups for control/explanation intents', () => {
    expect(capabilityById('clarify')?.followUps).toEqual([]);
    expect(capabilityById('finance_explanation')?.followUps).toEqual([]);
    expect(followUpActionsFor('anything', 'clarify')).toEqual([]);
  });

  it('produces the same three follow-up actions the presenter used to emit', () => {
    // Behaviour-preservation guard for the presenter refactor.
    expect(followUpActionsFor('Q2 revenue')).toEqual([
      {
        id: 'compare_period',
        label: 'Compare period',
        prompt: 'Compare Q2 revenue with the previous period.',
      },
      {
        id: 'explain_drivers',
        label: 'Explain drivers',
        prompt: 'Explain the verified drivers of Q2 revenue.',
      },
      {
        id: 'create_briefing',
        label: 'Create briefing',
        prompt: 'Create an executive finance briefing for Q2 revenue.',
      },
    ]);
  });

  it('falls back to the full action set for an unknown intent', () => {
    expect(followUpActionsFor('X', 'not_a_real_intent').map((a) => a.id)).toEqual(
      ['compare_period', 'explain_drivers', 'create_briefing'],
    );
  });

  it('lists every intent in the planner guidance', () => {
    const guidance = capabilityPlannerGuidance();
    for (const capability of PRISM_CAPABILITIES) {
      expect(guidance).toContain(capability.intent);
    }
  });
});
