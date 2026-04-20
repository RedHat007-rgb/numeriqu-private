"use client";

export function classNames(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

export function cardClass(extra = "") {
  return classNames(
    "rounded-3xl border border-white/10 bg-slate-950/55 p-6 shadow-2xl shadow-blue-950/20 backdrop-blur-xl",
    extra,
  );
}

export function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-white/15 bg-white/[0.03] p-6 text-center">
      <p className="font-display text-lg text-white">{title}</p>
      <p className="mt-2 text-sm text-slate-400">{detail}</p>
    </div>
  );
}

