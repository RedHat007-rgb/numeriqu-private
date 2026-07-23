import {
  formatPrismMoney,
  formatPrismPercentage,
  safePercentage,
} from './prism-calculations';

describe('Prism deterministic finance calculations', () => {
  it('calculates a percentage as a ratio, not a currency value', () => {
    const result = safePercentage(25, 100);
    expect(result).toBe(25);
    expect(formatPrismPercentage(result)).toBe('25.0%');
    expect(formatPrismPercentage(result)).not.toContain('$');
  });

  it('does not turn a missing or zero denominator into 0%', () => {
    expect(safePercentage(25, 0)).toBeNull();
    expect(safePercentage(Number.NaN, 100)).toBeNull();
    expect(formatPrismPercentage(null)).toBe('Not calculable');
  });

  it('renders the supplied ISO currency instead of assuming USD', () => {
    expect(formatPrismMoney(1_250, 'EUR')).toMatch(/€|EUR/);
    expect(formatPrismMoney(1_250, 'EUR')).not.toContain('$');
    expect(formatPrismMoney(1_250, 'GBP')).toMatch(/£|GBP/);
  });

  it('labels an amount whose currency is unavailable', () => {
    expect(formatPrismMoney(1_250, null)).toBe('1,250 (currency unavailable)');
  });
});
