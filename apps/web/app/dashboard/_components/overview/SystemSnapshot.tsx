"use client";

import type { DashboardResponse } from "../../../../lib/api";
import { cardClass } from "../ui";

export function SystemSnapshot({ meta }: { meta: DashboardResponse["meta"] }) {
  return (
    <section className={cardClass()}>
      <p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-300">Status</p>
      <h2 className="mt-2 font-display text-2xl font-bold">System snapshot</h2>
      <div className="mt-4 grid gap-4 md:grid-cols-3">
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
          <p className="text-sm text-slate-300">Computed At</p>
          <p className="mt-2 font-mono text-xs text-cyan-200">{meta.computedAt}</p>
        </div>
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
          <p className="text-sm text-slate-300">Architecture</p>
          <p className="mt-2 text-sm text-white">Independent RAG + Agent layers</p>
        </div>
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
          <p className="text-sm text-slate-300">Refresh model</p>
          <p className="mt-2 text-sm text-white">Sync jobs drive analytics refresh</p>
        </div>
      </div>
    </section>
  );
}

