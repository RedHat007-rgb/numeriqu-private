"use client";

import { useEffect } from "react";
import type { FigureEvidence } from "@/lib/api/types";

type Props = {
  open: boolean;
  loading: boolean;
  evidence: FigureEvidence | null;
  error: string | null;
  onClose: () => void;
};

function fmt(value: number, format: FigureEvidence["format"]): string {
  if (format === "percent") {
    const pct = Math.abs(value) <= 1 ? value * 100 : value;
    return `${pct.toFixed(1)}%`;
  }
  if (format === "currency") {
    const abs = Math.abs(value);
    const sign = value < 0 ? "-" : "";
    if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(1)}B`;
    if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
    if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
    return `${sign}$${abs.toFixed(0)}`;
  }
  return value.toLocaleString();
}

/** The trust stamp — the whole point of Glass Ledger. */
function TrustStamp({ evidence }: { evidence: FigureEvidence }) {
  const map = {
    match: { color: "--color-success", label: "Checked — adds up exactly", icon: "✓" },
    mismatch: { color: "--color-danger", label: "These don’t match", icon: "!" },
    unchecked: { color: "--color-info", label: "Recomputed from source", icon: "•" },
    not_applicable: { color: "--color-text-muted", label: "Shown over time", icon: "≈" },
  } as const;
  const s = map[evidence.reconciled];
  return (
    <div
      role="status"
      className="flex items-start gap-2 rounded-lg px-3 py-2.5"
      style={{
        background: `rgb(var(${s.color}) / 0.12)`,
        border: `1px solid rgb(var(${s.color}) / 0.35)`,
      }}
    >
      <span
        aria-hidden
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold"
        style={{ background: `rgb(var(${s.color}))`, color: "#0A1128" }}
      >
        {s.icon}
      </span>
      <div className="min-w-0">
        <p className="text-xs font-semibold" style={{ color: `rgb(var(${s.color}))` }}>
          {s.label}
        </p>
        <p className="mt-0.5 text-[11px] leading-snug" style={{ color: "rgb(var(--color-text-secondary))" }}>
          {evidence.reconcileNote}
        </p>
      </div>
    </div>
  );
}

export function ProvenanceDrawer({ open, loading, evidence, error, onClose }: Props) {
  // Esc to close.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const maxRow =
    evidence && evidence.rows.length
      ? Math.max(...evidence.rows.map((r) => Math.abs(r.value)), 1)
      : 1;

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="Number provenance">
      {/* Overlay */}
      <button
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 h-full w-full cursor-default"
        style={{ background: "rgb(10 17 40 / 0.55)", backdropFilter: "blur(2px)" }}
      />
      {/* Panel */}
      <aside
        className="relative flex h-full w-full max-w-[420px] flex-col shadow-2xl animate-[slideIn_.22s_cubic-bezier(0,0,0.2,1)]"
        style={{
          background: "rgb(var(--color-bg-card))",
          borderLeft: "1px solid rgb(var(--color-accent-blue) / 0.25)",
        }}
      >
        <style>{`@keyframes slideIn{from{transform:translateX(24px);opacity:.4}to{transform:translateX(0);opacity:1}}`}</style>

        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b px-5 py-4" style={{ borderColor: "rgb(var(--color-border-subtle) / 0.08)" }}>
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: "rgb(var(--color-accent-cyan))" }}>
              Where this number comes from
            </p>
            <h2 className="mt-1 truncate text-sm font-bold" style={{ color: "rgb(var(--color-text-primary))" }}>
              {loading ? "Tracing the figure…" : evidence?.ok ? evidence.headline : "Provenance"}
            </h2>
          </div>
          <button
            onClick={onClose}
            aria-label="Close panel"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-lg leading-none transition-colors hover:opacity-80"
            style={{ color: "rgb(var(--color-text-muted))", background: "rgb(var(--color-bg-elevated) / 0.6)" }}
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="space-y-3" aria-hidden>
              {[...Array(5)].map((_, i) => (
                <div key={i} className="h-9 w-full animate-pulse rounded-md" style={{ background: "rgb(var(--color-bg-elevated) / 0.5)" }} />
              ))}
            </div>
          ) : error || !evidence?.ok ? (
            <div className="rounded-lg px-4 py-3 text-sm" style={{ background: "rgb(var(--color-warning) / 0.1)", color: "rgb(var(--color-text-secondary))" }}>
              {error || evidence?.error || "Couldn’t trace this figure."}
            </div>
          ) : (
            <>
              {/* Definition */}
              <p className="text-xs leading-relaxed" style={{ color: "rgb(var(--color-text-secondary))" }}>
                {evidence.definition}
              </p>

              {/* Trust stamp */}
              <div className="mt-3">
                <TrustStamp evidence={evidence} />
              </div>

              {/* The proof — the actual rows */}
              <div className="mt-5">
                <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider" style={{ color: "rgb(var(--color-text-muted))" }}>
                  The rows behind it
                </p>
                <ul className="space-y-1.5">
                  {evidence.rows.map((r, i) => (
                    <li key={i} className="flex items-center gap-2">
                      <span className="w-16 shrink-0 text-[11px]" style={{ color: "rgb(var(--color-text-muted))" }}>
                        {r.label}
                      </span>
                      <span className="relative h-5 flex-1 overflow-hidden rounded" style={{ background: "rgb(var(--color-bg-elevated) / 0.4)" }}>
                        <span
                          className="absolute inset-y-0 left-0 rounded"
                          style={{
                            width: `${Math.max(2, (Math.abs(r.value) / maxRow) * 100)}%`,
                            background: "linear-gradient(90deg, rgb(var(--color-accent-blue)), rgb(var(--color-accent-violet)))",
                          }}
                        />
                      </span>
                      <span className="w-20 shrink-0 text-right text-[11px] font-semibold tabular-nums" style={{ color: "rgb(var(--color-text-primary))" }}>
                        {fmt(r.value, evidence.rowsFormat ?? evidence.format)}
                      </span>
                    </li>
                  ))}
                </ul>

                {/* Total / result */}
                <div className="mt-3 flex items-center justify-between border-t pt-3" style={{ borderColor: "rgb(var(--color-border-subtle) / 0.1)" }}>
                  <span className="text-xs font-semibold" style={{ color: "rgb(var(--color-text-secondary))" }}>
                    {evidence.totalLabel ?? `Total (${evidence.rows.length} ${evidence.rows.length === 1 ? "row" : "rows"})`}
                  </span>
                  <span className="text-sm font-bold tabular-nums" style={{ color: "rgb(var(--color-accent-cyan))" }}>
                    {evidence.reconciled === "not_applicable" && !evidence.totalLabel ? "—" : fmt(evidence.total, evidence.format)}
                  </span>
                </div>
              </div>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}
