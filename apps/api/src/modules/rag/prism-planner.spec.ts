import { PRISM_POLICY_VERSION, PRISM_PROMPT_VERSION } from './prism-contracts';
import type { PrismModelPort } from './prism-model.gateway';
import { planPrismQuery } from './prism-planner';

describe('Prism typed planner', () => {
  it('accepts only a versioned allow-listed plan', async () => {
    const model: PrismModelPort = {
      generateJson: async (request) => {
        expect(request.dataClass).toBe('prompt_only');
        return {
          contractVersion: PRISM_PROMPT_VERSION,
          policyVersion: PRISM_POLICY_VERSION,
          intent: 'revenue_summary',
          timeRange: 'YTD',
          periodCount: 0,
          needsClarification: false,
          clarificationQuestion: '',
        };
      },
    };
    await expect(planPrismQuery('Revenue YTD', model)).resolves.toEqual(
      expect.objectContaining({ intent: 'revenue_summary', timeRange: 'YTD' }),
    );
  });

  it('rejects unversioned or unknown model output', async () => {
    const model: PrismModelPort = {
      generateJson: async () => ({ intent: 'run_sql', timeRange: 'ALL_TIME' }),
    };
    await expect(planPrismQuery('Do anything', model)).resolves.toBeNull();
  });
});
