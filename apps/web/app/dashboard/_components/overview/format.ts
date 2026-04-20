const currency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 1,
});

const numberCompact = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

export function formatMoney(value: number | null | undefined) {
  return currency.format(value ?? 0);
}

export function formatNumber(value: number | null | undefined) {
  return numberCompact.format(value ?? 0);
}

