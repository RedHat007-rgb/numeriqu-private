export function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;

  if (typeof value !== "string") return null;

  let text = value.trim();
  if (!text) return null;

  let negative = false;
  if (text.startsWith("(") && text.endsWith(")")) {
    negative = true;
    text = text.slice(1, -1).trim();
  }

  if (text.startsWith("+")) text = text.slice(1).trim();
  if (text.startsWith("-")) {
    negative = !negative;
    text = text.slice(1).trim();
  }

  text = text.replace(/[$,\s]/g, "");

  let multiplier = 1;
  const suffix = text.slice(-1).toLowerCase();
  if (suffix === "k" || suffix === "m" || suffix === "b" || suffix === "t") {
    multiplier =
      suffix === "k"
        ? 1_000
        : suffix === "m"
          ? 1_000_000
          : suffix === "b"
            ? 1_000_000_000
            : 1_000_000_000_000;
    text = text.slice(0, -1);
  }

  if (text.endsWith("%")) text = text.slice(0, -1);
  text = text.replace(/[^\d.eE+-]/g, "");
  if (!text) return null;

  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return null;

  return (negative ? -parsed : parsed) * multiplier;
}
