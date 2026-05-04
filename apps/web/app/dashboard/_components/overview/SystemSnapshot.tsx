"use client";

import type { DashboardResponse } from "../../../../lib/api";
import { formatRelativeTime } from "./format";

export function SystemSnapshot({ meta }: { meta: DashboardResponse["meta"] }) {
  return (
    <section
      aria-label="Workspace status"
      className="surface-card flex flex-col gap-3 p-5 md:flex-row md:items-center md:justify-between"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-muted">
        <span>
          Last computed{" "}
          <span className="text-text-secondary">{formatRelativeTime(meta.computedAt)}</span>
        </span>
        <span aria-hidden>·</span>
        <span>
          API latency{" "}
          <span className="font-mono text-text-secondary">{meta.latencyMs}ms</span>
        </span>
        <span aria-hidden>·</span>
        <span>RAG + Agent run as independent layers</span>
      </div>
      {meta.error ? (
        <p className="text-xs text-feedback-warning">Last sync surfaced: {meta.error}</p>
      ) : null}
    </section>
  );
}
