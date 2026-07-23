import {
  PRISM_CONTRACT_VERSION,
  PRISM_POLICY_VERSION,
  PRISM_PROMPT_VERSION,
  PRISM_SEMANTIC_VERSION,
} from './prism-contracts';

describe('Prism public contract versions', () => {
  it('uses explicit immutable versions for independently evolving boundaries', () => {
    expect(PRISM_CONTRACT_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(PRISM_POLICY_VERSION).toMatch(/^finance-policy-\d+$/);
    expect(PRISM_PROMPT_VERSION).toMatch(/^finance-planner-\d+$/);
    expect(PRISM_SEMANTIC_VERSION).toMatch(/^governed-semantic-\d+$/);
  });
});
