import {
  composePrismAnswer,
  numbersAreGrounded,
  type PrismComposeInput,
} from './prism-answer-composer';
import type { PrismModelPort } from './prism-model.gateway';

const model = (value: unknown): PrismModelPort => ({
  generateJson: async () => value,
});
const throwing = (): PrismModelPort => ({
  generateJson: async () => {
    throw new Error('provider error');
  },
});

const input: PrismComposeInput = {
  tone: 'professional',
  rangeLabel: 'All time',
  title: 'Total revenue',
  factLines: ['- Total Revenue: $131.56M'],
};

describe('numbersAreGrounded', () => {
  it('accepts figures copied verbatim from the facts', () => {
    expect(
      numbersAreGrounded('Revenue was $131.56M.', '- Total Revenue: $131.56M'),
    ).toBe(true);
  });

  it('rejects an invented or re-rounded figure', () => {
    expect(
      numbersAreGrounded('Revenue was $131.6M.', '- Total Revenue: $131.56M'),
    ).toBe(false);
    expect(
      numbersAreGrounded('Margin is 42%.', '- Gross Margin: 42.5%'),
    ).toBe(false);
  });

  it('ignores non-figure numbers such as years', () => {
    expect(
      numbersAreGrounded('Revenue grew across 2024.', '- Total Revenue: $131.56M'),
    ).toBe(true);
  });
});

describe('composePrismAnswer', () => {
  it('returns grounded model prose', async () => {
    const text = await composePrismAnswer(
      model({ message: 'Total revenue was $131.56M — a strong result.' }),
      input,
    );
    expect(text).toContain('$131.56M');
  });

  it('rejects prose that invents a number, so the caller falls back', async () => {
    expect(
      await composePrismAnswer(
        model({ message: 'Revenue was about $200M this period.' }),
        input,
      ),
    ).toBeNull();
  });

  it('returns null when there are no verified facts', async () => {
    expect(
      await composePrismAnswer(model({ message: 'x' }), {
        ...input,
        factLines: [],
      }),
    ).toBeNull();
  });

  it('returns null on model failure', async () => {
    expect(await composePrismAnswer(throwing(), input)).toBeNull();
  });
});
