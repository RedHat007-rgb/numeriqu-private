"use client";

import { useState } from "react";
import { Info, Shield, Target, Wallet } from "lucide-react";
import { cn } from "../../../../components/ui/cn";
import type { DashboardResponse } from "../../../../lib/api";
import type { CardGlossary } from "../../_lib/glossary";
import { GlossaryBackFace } from "./GlossaryBackFace";
import { formatMoneyWithCurrency, formatNumber, formatPercentDelta } from "./format";

type Tone = "neutral" | "positive" | "warning";
type FocusItem = { label: string; value: string; tone?: Tone };

function toneClass(tone: Tone) {
  if (tone === "positive") return "border-feedback-success/25 bg-feedback-success/10";
  if (tone === "warning") return "border-[#f59e0b]/30 bg-[#f59e0b]/10";
  return "border-white/10 bg-white/[0.03]";
}

function iconForEyebrow(eyebrow: string) {
  const lower = eyebrow.toLowerCase();
  if (lower.includes("treasury")) return Wallet;
  if (lower.includes("concentration")) return Shield;
  return Target;
}

export function CfoFocusCard({
  title,
  eyebrow,
  items,
  glossary,
  interactive = false,
}: {
  title: string;
  eyebrow: string;
  items: FocusItem[];
  glossary?: CardGlossary | null;
  interactive?: boolean;
}) {
  const Icon = iconForEyebrow(eyebrow);
  const [showInfo, setShowInfo] = useState(false);
  const canFlip = interactive && Boolean(glossary);

  return (
    <section
      className={cn(
        "dashboard-focus-card relative h-full overflow-hidden p-5",
        canFlip && "cursor-pointer transition hover:border-accent-blue/40",
      )}
      onClick={canFlip ? () => setShowInfo((v) => !v) : undefined}
      role={canFlip ? "button" : undefined}
      tabIndex={canFlip ? 0 : undefined}
      aria-expanded={canFlip ? showInfo : undefined}
      onKeyDown={
        canFlip
          ? (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                setShowInfo((v) => !v);
              }
            }
          : undefined
      }
    >
      <div className="flex items-start justify-between gap-4 border-b border-white/8 pb-4">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[#7ecaff]">{eyebrow}</p>
          <h2 className="mt-2 max-w-[24ch] font-display text-[1.35rem] font-bold leading-tight text-white md:text-[1.5rem]">
            {title}
          </h2>
        </div>
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.04] text-[#8bd3ff]">
          {canFlip ? <Info className="h-5 w-5" aria-hidden /> : <Icon className="h-5 w-5" />}
        </div>
      </div>

      <div className="mt-4 grid gap-3 md:auto-rows-fr md:grid-cols-3">
        {items.map((item, index) => (
          <div
            key={item.label}
            className={cn(
              "flex h-full min-h-[10.75rem] flex-col rounded-[1.1rem] border p-4",
              toneClass(item.tone ?? "neutral"),
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-white/10 bg-[#09162f] text-[11px] font-semibold text-[#8dbfff]">
                {String(index + 1).padStart(2, "0")}
              </div>
              <div className="min-w-0 flex-1 text-right">
                <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#86a7d0]">{item.label}</p>
              </div>
            </div>

            <div className="mt-auto flex min-h-[4.75rem] items-end justify-end pt-4">
              <p
                className={cn(
                  "max-w-full text-right font-bold tracking-[-0.04em] text-white",
                  item.value.length > 12 || item.value.includes("·") || item.value.includes(" ")
                    ? "text-[1.25rem] leading-[1.02] md:text-[1.45rem]"
                    : "text-[1.65rem] leading-none md:text-[1.9rem]",
                )}
                style={{ overflowWrap: "anywhere" }}
              >
                {item.value}
              </p>
            </div>
          </div>
        ))}
      </div>

      {canFlip && showInfo && glossary ? (
        <GlossaryBackFace glossary={glossary} onClose={() => setShowInfo(false)} />
      ) : null}
    </section>
  );
}

export function makeCashDisciplineItems(dashboard: DashboardResponse, currency: string): FocusItem[] {
  const cfo = dashboard.cfo;
  return [
    {
      label: "Free cash flow",
      value: formatMoneyWithCurrency(cfo?.freeCashFlow ?? 0, currency),
      tone: (cfo?.freeCashFlow ?? 0) >= 0 ? "positive" : "warning",
    },
    {
      label: "Operating cash flow",
      value: formatMoneyWithCurrency(cfo?.operatingCashFlow ?? 0, currency),
      tone: (cfo?.operatingCashFlow ?? 0) >= 0 ? "positive" : "neutral",
    },
    {
      label: "DSO / DPO spread",
      value: `${Math.round(cfo?.dsoDays ?? 0)}d / ${Math.round(cfo?.dpoDays ?? 0)}d`,
      tone: (cfo?.dsoDays ?? 0) > (cfo?.dpoDays ?? 0) + 20 ? "warning" : "neutral",
    },
  ];
}

export function makeClientConcentrationItems(dashboard: DashboardResponse, currency: string): FocusItem[] {
  const cfo = dashboard.cfo;
  return [
    {
      label: "Largest account",
      value: cfo?.topClientName || "—",
      tone: (cfo?.topClientConcentrationPct ?? 0) >= 25 ? "warning" : "neutral",
    },
    {
      label: "Revenue share",
      value:
        (cfo?.topClientConcentrationPct ?? 0) > 0
          ? formatPercentDelta((cfo?.topClientConcentrationPct ?? 0) / 100)
          : "—",
      tone: (cfo?.topClientConcentrationPct ?? 0) >= 25 ? "warning" : "neutral",
    },
    {
      label: "Best margin unit",
      value:
        cfo?.topBusinessUnitName || cfo?.topBusinessUnitMarginPct
          ? `${cfo?.topBusinessUnitName || "—"} · ${formatPercentDelta((cfo?.topBusinessUnitMarginPct ?? 0) / 100)}`
          : "—",
      tone: "positive",
    },
  ];
}

export function makeServiceLevelItems(dashboard: DashboardResponse): FocusItem[] {
  const cfo = dashboard.cfo;
  const deliveryCenters = cfo?.deliveryCenters ?? [];
  const atRiskCenters = deliveryCenters.filter((center) => (center.slaPct ?? 0) < 95).length;

  return [
    {
      label: "SLA compliance",
      value: formatPercentDelta((cfo?.slaCompliancePct ?? 0) / 100),
      tone: (cfo?.slaCompliancePct ?? 0) < 95 ? "warning" : "positive",
    },
    {
      label: "Utilization",
      value: formatPercentDelta((cfo?.utilizationPct ?? 0) / 100),
      tone: "neutral",
    },
    {
      label: "CSAT",
      value: formatPercentDelta((cfo?.csatPct ?? 0) / 100),
      tone: (cfo?.csatPct ?? 0) < 80 ? "warning" : "neutral",
    },
    {
      label: "Average handle time",
      value: (cfo?.avgHandleTimeMinutes ?? 0) > 0 ? `${cfo?.avgHandleTimeMinutes} min` : "—",
      tone: (cfo?.avgHandleTimeMinutes ?? 0) > 10 ? "warning" : "neutral",
    },
    {
      label: "Tickets raised",
      value: (cfo?.ticketsResolved ?? 0) > 0 ? formatNumber(cfo?.ticketsResolved) : "—",
      tone: "neutral",
    },
    {
      label: "At-risk centers",
      value: deliveryCenters.length > 0 ? `${atRiskCenters} / ${deliveryCenters.length}` : "—",
      tone: atRiskCenters > 0 ? "warning" : "positive",
    },
  ];
}
