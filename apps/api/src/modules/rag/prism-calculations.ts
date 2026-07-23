export function safePercentage(
  numerator: number,
  denominator: number,
): number | null {
  if (
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    denominator === 0
  ) {
    return null;
  }
  return (numerator / denominator) * 100;
}

export function formatPrismMoney(
  value: number,
  currency: string | null,
): string {
  if (!Number.isFinite(value)) return 'Unavailable';
  if (!currency || !/^[A-Z]{3}$/.test(currency)) {
    return `${new Intl.NumberFormat('en', { maximumFractionDigits: 2 }).format(value)} (currency unavailable)`;
  }
  try {
    return new Intl.NumberFormat('en', {
      style: 'currency',
      currency,
      notation: Math.abs(value) >= 1_000_000 ? 'compact' : 'standard',
      maximumFractionDigits: Math.abs(value) >= 1_000_000 ? 2 : 0,
    }).format(value);
  } catch {
    return `${currency} ${new Intl.NumberFormat('en', { maximumFractionDigits: 2 }).format(value)}`;
  }
}

export function formatPrismPercentage(value: number | null): string {
  return value === null || !Number.isFinite(value)
    ? 'Not calculable'
    : `${value.toFixed(1)}%`;
}
