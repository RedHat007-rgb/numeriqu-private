"use client";

import type { SyncJob } from "../../../../lib/api";
import { cardClass, EmptyState } from "../ui";

export function SyncJobsPanel({ jobs }: { jobs: SyncJob[] }) {
  return (
    <div className={cardClass()}>
      <p className="text-sm font-semibold text-slate-200">Latest sync jobs</p>
      <div className="mt-4 space-y-3">
        {jobs.length === 0 ? (
          <EmptyState title="No sync jobs yet" detail="Jobs appear here after OAuth connect or manual sync." />
        ) : (
          jobs.slice(0, 10).map((job) => (
            <div
              key={job.id}
              className="flex items-center justify-between rounded-2xl border border-white/10 bg-slate-900/50 p-4 text-sm"
            >
              <div className="min-w-0">
                <p className="truncate font-medium text-white">{job.orgName ?? job.provider}</p>
                <p className="text-slate-400">
                  {job.provider} · {job.recordsProcessed ?? 0} records
                </p>
              </div>
              <span className="rounded-full bg-white/10 px-3 py-1 text-xs text-slate-200">{job.status}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

