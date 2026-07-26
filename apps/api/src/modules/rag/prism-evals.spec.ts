import { classifyPrismScopeWithModel } from './prism-conversation';
import type { PrismModelPort } from './prism-model.gateway';

const model = (scope: string): PrismModelPort => ({
  generateJson: async () => ({ scope }),
});
const throwing: PrismModelPort = {
  generateJson: async () => {
    throw new Error('model unavailable');
  },
};

describe('Prism model scope classification', () => {
  it.each([
    ['greeting', 'greeting'],
    ['finance', 'finance'],
    ['off_topic', 'off_topic'],
    ['unsafe', 'unsafe'],
    ['restricted', 'restricted_finance'],
  ])('maps model scope "%s" to decision kind "%s"', async (scope, kind) => {
    expect((await classifyPrismScopeWithModel(model(scope), 'q')).kind).toBe(
      kind,
    );
  });

  it('defaults to finance on an unknown scope value', async () => {
    expect(
      (await classifyPrismScopeWithModel(model('nonsense'), 'q')).kind,
    ).toBe('finance');
  });

  it('defaults to finance when the model is unavailable (never lose a real question)', async () => {
    expect((await classifyPrismScopeWithModel(throwing, 'q')).kind).toBe(
      'finance',
    );
  });
});
