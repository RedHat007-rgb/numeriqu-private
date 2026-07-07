"use client";

import type { ChangeEvent } from "react";
import type { TimeRange } from "../../../../lib/api";
import { cn } from "../../../../components/ui/cn";

type Option = { id: string; label: string; range: TimeRange };

// Windows are anchored server-side to the latest available data month (not
// today), so "Last 3 months" always lands on the most recent 3 months of data.
const OPTIONS: Option[] = [
  { id: "LAST_N_MONTHS:3", label: "Last 3 months", range: { kind: "LAST_N_MONTHS", months: 3 } },
  { id: "LAST_N_MONTHS:6", label: "Last 6 months", range: { kind: "LAST_N_MONTHS", months: 6 } },
  { id: "LAST_N_MONTHS:12", label: "Last 12 months", range: { kind: "LAST_N_MONTHS", months: 12 } },
  { id: "QTD", label: "Quarter to date", range: { kind: "QTD" } },
  { id: "YTD", label: "Year to date", range: { kind: "YTD" } },
  { id: "ALL_TIME", label: "All time", range: { kind: "ALL_TIME" } },
];

function toId(range: TimeRange): string {
  if (range.kind === "LAST_N_DAYS") return `LAST_N_DAYS:${range.days}`;
  if (range.kind === "LAST_N_WEEKS") return `LAST_N_WEEKS:${range.weeks}`;
  if (range.kind === "LAST_N_MONTHS") return `LAST_N_MONTHS:${range.months}`;
  if (range.kind === "LAST_N_QUARTERS") return `LAST_N_QUARTERS:${range.quarters}`;
  if (range.kind === "LAST_N_YEARS") return `LAST_N_YEARS:${range.years}`;
  return range.kind;
}

function fromId(id: string): TimeRange {
  const match = OPTIONS.find((opt) => opt.id === id);
  return match?.range ?? { kind: "ALL_TIME" };
}

export function TimeRangeSelect({
  value,
  onChange,
  className,
}: {
  value: TimeRange;
  onChange: (next: TimeRange) => void;
  className?: string;
}) {
  const selected = toId(value);

  function handleChange(event: ChangeEvent<HTMLSelectElement>) {
    onChange(fromId(event.target.value));
  }

  return (
    <label className={cn("flex items-center gap-2 text-xs text-text-muted", className)}>
      <span className="hidden font-semibold uppercase tracking-[0.2em] md:inline">Range</span>
      <select
        value={selected}
        onChange={handleChange}
        className={cn(
          "h-9 rounded-xl border border-default bg-bg-surface px-3 text-xs font-semibold text-text-secondary outline-none",
          "shadow-sm transition-colors focus:border-accent-blue/60",
        )}
      >
        {OPTIONS.map((opt) => (
          <option key={opt.id} value={opt.id}>
            {opt.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function formatRange(range: TimeRange | null | undefined, fiscalYearStart?: string): string {
  if (!range) return "All time";
  if (range.kind === "MTD") return "Month to date";
  if (range.kind === "QTD") return "Quarter to date";
  if (range.kind === "YTD") {
    if (fiscalYearStart && fiscalYearStart !== "January") {
      return `Year to date · FY starts ${fiscalYearStart}`;
    }
    return "Year to date";
  }
  if (range.kind === "LAST_N_DAYS") return `Last ${range.days} days`;
  if (range.kind === "LAST_N_WEEKS") return `Last ${range.weeks} weeks`;
  if (range.kind === "LAST_N_MONTHS") return `Last ${range.months} months`;
  if (range.kind === "LAST_N_QUARTERS") return `Last ${range.quarters} quarters`;
  if (range.kind === "LAST_N_YEARS") return `Last ${range.years} years`;
  return "All time";
}
