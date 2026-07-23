import {
  PRISM_CONTRACT_VERSION,
  PRISM_SEMANTIC_VERSION,
  type PrismAnswerEnvelope,
} from './prism-contracts';
import { validatePrismOutput } from './prism-output-validator';

const answer: PrismAnswerEnvelope = {
  contractVersion: PRISM_CONTRACT_VERSION,
  semanticVersion: PRISM_SEMANTIC_VERSION,
  tone: 'professional',
  title: 'Gross Margin',
  period: 'Q2 2026',
  metrics: [
    {
      key: 'gross_margin_pct',
      label: 'Gross Margin %',
      value: 42.5,
      formattedValue: '42.5%',
      unit: 'percent',
    },
  ],
  evidence: {
    status: 'verified',
    period: 'Q2 2026',
    calculatedAt: '2026-07-22T00:00:00.000Z',
    checks: [],
    limitations: [],
  },
  actions: [],
};

describe('Prism output validation', () => {
  it('accepts a unit-consistent, presentation-safe answer', () => {
    expect(validatePrismOutput(answer, 'Gross margin is 42.5%.')).toEqual({
      ok: true,
    });
  });

  it('rejects internal implementation disclosure', () => {
    expect(
      validatePrismOutput(answer, 'SELECT x FROM table WHERE tenant_id = 1'),
    ).toEqual(expect.objectContaining({ ok: false }));
  });

  it('rejects a percentage formatted as money', () => {
    expect(
      validatePrismOutput(
        {
          ...answer,
          metrics: [{ ...answer.metrics[0]!, formattedValue: '$42.50' }],
        },
        'Gross margin',
      ),
    ).toEqual(expect.objectContaining({ ok: false }));
  });
});
