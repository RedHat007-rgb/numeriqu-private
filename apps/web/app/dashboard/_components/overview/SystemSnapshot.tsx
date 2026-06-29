"use client";

import type { DashboardResponse } from "../../../../lib/api";
import { formatRelativeTime } from "./format";
import { formatRange } from "./TimeRangeSelect";

function formatComputedAt(iso: string, timezone?: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: timezone,
  }).format(new Date(iso));
}

export function SystemSnapshot({
  meta,
  fiscalYearStart,
  timezone,
}: {
  meta: DashboardResponse["meta"];
  fiscalYearStart?: string;
  timezone?: string;
}) {
  return (
    <section
      aria-label="Workspace status"
      className="dashboard-surface dashboard-surface-muted flex flex-col gap-3 p-4 md:flex-row md:items-center md:justify-between"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-muted">
        <span>
          Last computed{" "}
          <span className="text-text-secondary">
            {formatComputedAt(meta.computedAt, timezone)} · {formatRelativeTime(meta.computedAt)}
          </span>
        </span>
        <span aria-hidden>·</span>
        <span>
          Scope{" "}
          <span className="text-text-secondary">{formatRange(meta.range, fiscalYearStart)}</span>
        </span>
        <span aria-hidden>·</span>
        <span>
          API latency{" "}
          <span className="font-mono text-text-secondary">{meta.latencyMs}ms</span>
        </span>
        <span aria-hidden>·</span>
        <span>Prism + Astra run as independent layers</span>
      </div>
      {meta.error ? (
        <p className="text-xs text-feedback-warning">Last sync surfaced: {meta.error}</p>
      ) : null}
    </section>
  );
}
