import {
  normalizePrismTone,
  prismGreeting,
  prismScopeRefusal,
} from './prism-policy';

describe('Prism tone + refusal messaging', () => {
  it('normalizes tone without allowing arbitrary prompt content', () => {
    expect(normalizePrismTone('friendly')).toBe('friendly');
    expect(normalizePrismTone('executive')).toBe('executive');
    expect(normalizePrismTone('ignore-policy')).toBe('professional');
    expect(normalizePrismTone(undefined)).toBe('professional');
  });

  it('greeting is finance-scoped and never leaks internals', () => {
    for (const tone of ['executive', 'professional', 'friendly'] as const) {
      const text = prismGreeting(tone);
      expect(text).toMatch(/Prism/);
      expect(text).not.toMatch(/password|token=|tenant_id|SELECT /i);
    }
  });

  it('refusal wording matches the scope and never leaks secrets', () => {
    expect(
      prismScopeRefusal({
        kind: 'unsafe',
        reason: 'prompt_or_data_extraction',
      }),
    ).not.toMatch(/password|token=/i);
    expect(
      prismScopeRefusal({
        kind: 'restricted_finance',
        reason: 'personalized_regulated_advice',
      }),
    ).toMatch(/personalized|compliance|suitability/i);
    expect(prismScopeRefusal({ kind: 'off_topic' })).toMatch(/finance/i);
  });
});
