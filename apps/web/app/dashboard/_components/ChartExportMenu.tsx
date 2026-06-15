"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Download, FileImage, FileCode2, Sheet, Clipboard, Loader2, Check } from "lucide-react";
import {
  chartFilename,
  exportChartPng,
  exportChartSvg,
  exportChartCsv,
  copyChartImage,
} from "../_lib/chartExport";

type Kind = "png" | "svg" | "csv" | "copy";

type Props = {
  /** id of the element wrapping the chart canvas (`chart-canvas-<id>`). */
  canvasId: string;
  /** Filename parts, e.g. [dashboardTitle, chartTitle]. */
  nameParts: Array<string | undefined>;
  data: Array<Record<string, unknown>>;
  /** Visual size of the trigger button. */
  size?: "sm" | "md";
};

export default function ChartExportMenu({ canvasId, nameParts, data, size = "sm" }: Props) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<null | Kind>(null);
  const [done, setDone] = useState<null | Kind>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const flashDone = (kind: Kind) => {
    setDone(kind);
    setTimeout(() => setDone((d) => (d === kind ? null : d)), 1400);
  };

  const run = async (kind: Kind) => {
    try {
      setBusy(kind);
      const node = () => document.getElementById(`chart-canvas-${canvasId}`) as HTMLElement | null;
      if (kind === "csv") {
        exportChartCsv(data, chartFilename(nameParts, "csv"));
        toast.success("CSV downloaded");
      } else if (kind === "copy") {
        const n = node();
        if (!n) return;
        const ok = await copyChartImage(n);
        toast[ok ? "success" : "error"](
          ok ? "Chart copied to clipboard" : "Clipboard not available in this browser",
        );
      } else {
        const n = node();
        if (!n) return;
        if (kind === "png") await exportChartPng(n, chartFilename(nameParts, "png"));
        else await exportChartSvg(n, chartFilename(nameParts, "svg"));
        toast.success(`${kind.toUpperCase()} downloaded`);
      }
      flashDone(kind);
    } catch {
      toast.error("Export failed — please try again");
    } finally {
      setBusy(null);
      setOpen(false);
    }
  };

  const items: Array<{ kind: Kind; label: string; icon: typeof FileImage; hint: string }> = [
    { kind: "png", label: "PNG image", icon: FileImage, hint: "For slides & docs" },
    { kind: "copy", label: "Copy image", icon: Clipboard, hint: "Paste into Slack/email" },
    { kind: "svg", label: "SVG vector", icon: FileCode2, hint: "Scales crisply" },
    { kind: "csv", label: "CSV data", icon: Sheet, hint: "Underlying numbers" },
  ];

  const trigger = size === "md" ? "p-2" : "p-1";

  return (
    <div
      ref={wrapRef}
      data-export-ignore="true"
      className="relative"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        title="Export chart"
        aria-label="Export chart"
        onClick={() => setOpen((o) => !o)}
        className={`rounded-lg border border-default bg-bg-elevated/40 text-text-muted transition-colors hover:border-accent-violet/25 hover:text-text-primary ${trigger}`}
      >
        {busy ? (
          <Loader2 size={size === "md" ? 14 : 12} className="animate-spin" />
        ) : (
          <Download size={size === "md" ? 14 : 12} />
        )}
      </button>

      {open ? (
        <div className="absolute right-0 z-50 mt-1.5 w-44 overflow-hidden rounded-xl border border-default bg-bg-card shadow-xl">
          <p className="px-3 pb-1 pt-2 text-[10px] font-bold uppercase tracking-wider text-text-muted">
            Export
          </p>
          {items.map(({ kind, label, icon: Icon, hint }) => (
            <button
              key={kind}
              type="button"
              disabled={busy !== null}
              onClick={() => run(kind)}
              className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-xs text-text-secondary transition-colors hover:bg-bg-elevated/60 disabled:opacity-50"
            >
              <Icon size={14} className="shrink-0 text-text-muted" />
              <span className="flex-1">
                <span className="block font-medium text-text-primary">{label}</span>
                <span className="block text-[10px] text-text-muted">{hint}</span>
              </span>
              {done === kind ? <Check size={13} className="text-emerald-400" /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
