"use client";

import type { SyncJob } from "../../../../lib/api";
import { EmptyState } from "../../../../components/ui/EmptyState";
import { StatusPill } from "../../../../components/ui/StatusPill";
import { formatRelativeTime } from "../overview/format";

function statusTone(status: string) {
  const lower = status.toLowerCase();
  if (lower === "completed" || lower === "success") return "success" as const;
  if (lower === "failed" || lower === "error") return "danger" as const;
  if (lower === "running" || lower === "queued" || lower === "pending") return "info" as const;
  return "neutral" as const;
}

function summarizeError(status: string) {
  const lower = status.toLowerCase();
  if (lower === "failed" || lower === "error") {
    return "Job failed. Open logs for technical details.";
  }
  return "Job encountered an issue. Retry once and check logs if it repeats.";
}

export function SyncJobsPanel({ jobs }: { jobs: SyncJob[] }) {
  const visible = jobs.slice(0, 12);
  return (
    <div className="surface-card p-6">
      <p className="text-sm font-semibold text-text-secondary">Latest sync jobs</p>
      <div className="mt-4 space-y-2">
        {visible.length === 0 ? (
          <EmptyState
            title="No sync jobs yet"
            detail="Jobs appear here after OAuth connect or a manual sync."
          />
        ) : (
          visible.map((job) => (
            <div
              key={job.id}
              className="flex items-center justify-between rounded-xl border border-default bg-surface-card/40 p-4 text-sm"
            >
              <div className="min-w-0">
                <p className="truncate font-medium text-text-primary">
                  {job.orgName ?? job.provider}
                </p>
                <p className="mt-1 text-xs text-text-muted">
                  {job.provider} · {job.recordsProcessed ?? 0} records ·{" "}
                  {job.completedAt
                    ? `finished ${formatRelativeTime(job.completedAt)}`
                    : job.startedAt
                      ? `started ${formatRelativeTime(job.startedAt)}`
                      : "queued"}
                </p>
                {job.errorDetails ? (
                  <p className="mt-1 truncate text-xs text-feedback-danger">
                    {summarizeError(job.status)}
                  </p>
                ) : null}
              </div>
              <StatusPill tone={statusTone(job.status)}>{job.status}</StatusPill>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
