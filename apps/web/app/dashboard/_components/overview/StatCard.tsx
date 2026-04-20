"use client";

import { cardClass } from "../ui";

export function StatCard({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className={cardClass("relative overflow-hidden")}>
      <div className="absolute -right-10 -top-10 h-28 w-28 rounded-full bg-blue-500/20 blur-3xl" />
      <p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-400">{label}</p>
      <p className="mt-4 font-display text-3xl font-bold text-white">{value}</p>
      <p className="mt-2 text-sm text-slate-400">{detail}</p>
    </div>
  );
}

