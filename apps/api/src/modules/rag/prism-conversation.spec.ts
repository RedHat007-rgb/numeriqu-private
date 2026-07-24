import { generatePrismGreeting } from './prism-conversation';
import type { PrismModelPort } from './prism-model.gateway';

const modelReturning = (value: unknown): PrismModelPort => ({
  generateJson: async () => value,
});

const modelThrowing = (): PrismModelPort => ({
  generateJson: async () => {
    throw new Error('timeout');
  },
});

describe('generatePrismGreeting', () => {
  it('returns model-generated greeting prose', async () => {
    const text = await generatePrismGreeting(
      modelReturning({
        message: 'Hi, I am Prism — ask me about revenue, cash, or receivables.',
      }),
      'professional',
      'hi',
    );
    expect(text).toBe(
      'Hi, I am Prism — ask me about revenue, cash, or receivables.',
    );
  });

  it('rejects a greeting that leaks a financial figure (numbers are never model-authored)', async () => {
    expect(
      await generatePrismGreeting(
        modelReturning({ message: 'Revenue is $1.2M this quarter.' }),
        'executive',
        'hi',
      ),
    ).toBeNull();
    expect(
      await generatePrismGreeting(
        modelReturning({ message: 'Margin sits at 42%.' }),
        'executive',
        'hi',
      ),
    ).toBeNull();
  });

  it('returns null on model failure so the caller falls back to the canned greeting', async () => {
    expect(
      await generatePrismGreeting(modelThrowing(), 'friendly', 'hello'),
    ).toBeNull();
  });

  it('returns null on malformed or empty output', async () => {
    expect(
      await generatePrismGreeting(modelReturning({}), 'professional', 'hi'),
    ).toBeNull();
    expect(
      await generatePrismGreeting(
        modelReturning({ message: 42 }),
        'professional',
        'hi',
      ),
    ).toBeNull();
    expect(
      await generatePrismGreeting(
        modelReturning({ message: '   ' }),
        'professional',
        'hi',
      ),
    ).toBeNull();
  });
});
