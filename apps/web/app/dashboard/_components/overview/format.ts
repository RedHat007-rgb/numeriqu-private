const numberCompact = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

const percentFormat = new Intl.NumberFormat("en-US", {
  style: "percent",
  maximumFractionDigits: 1,
  signDisplay: "auto",
});

export function formatMoney(value: number | null | undefined) {
  return formatMoneyWithCurrency(value, "USD");
}

export function formatMoneyFull(value: number | null | undefined) {
  return formatMoneyWithCurrencyFull(value, "USD");
}

export function formatMoneyWithCurrency(value: number | null | undefined, currency: string) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency || "USD",
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value ?? 0);
}

export function formatMoneyWithCurrencyFull(value: number | null | undefined, currency: string) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency || "USD",
    maximumFractionDigits: 0,
  }).format(value ?? 0);
}

export function formatMoneyAxis(value: number | null | undefined, currency: string) {
  const amount = value ?? 0;
  const abs = Math.abs(amount);

  if (abs >= 1_000_000_000) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency || "USD",
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(amount);
  }

  if (abs >= 1_000_000) return `${amount < 0 ? "-" : ""}$${(abs / 1_000_000).toFixed(abs >= 100_000_000 ? 0 : 1)}M`;
  if (abs >= 1_000) return `${amount < 0 ? "-" : ""}$${(abs / 1_000).toFixed(abs >= 100_000 ? 0 : 1)}K`;
  return `${amount < 0 ? "-" : ""}$${Math.round(abs)}`;
}

export function formatNumber(value: number | null | undefined) {
  return numberCompact.format(value ?? 0);
}

export function formatPercentDelta(ratio: number | null | undefined) {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return "—";
  return percentFormat.format(ratio);
}

export function formatRelativeTime(iso: string | null | undefined) {
  if (!iso) return "never";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "—";
  const diff = Date.now() - at.getTime();
  if (diff < 30_000) return "just now";
  const minutes = Math.round(diff / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return at.toLocaleDateString();
}
