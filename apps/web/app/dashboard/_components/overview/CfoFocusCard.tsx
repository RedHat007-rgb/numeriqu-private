"use client";

import { Shield, Target, Wallet } from "lucide-react";
import { cn } from "../../../../components/ui/cn";
import type { DashboardResponse } from "../../../../lib/api";
import { formatMoneyWithCurrency, formatPercentDelta } from "./format";

type Tone = "neutral" | "positive" | "warning";
type FocusItem = { label: string; value: string; hint: string; tone?: Tone };

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
}: {
  title: string;
  eyebrow: string;
  items: FocusItem[];
}) {
  const Icon = iconForEyebrow(eyebrow);

  return (
    <section className="dashboard-focus-card h-full overflow-hidden p-5">
      <div className="flex items-start justify-between gap-4 border-b border-white/8 pb-4">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[#7ecaff]">{eyebrow}</p>
          <h2 className="mt-2 max-w-[24ch] font-display text-[1.35rem] font-bold leading-tight text-white md:text-[1.5rem]">
            {title}
          </h2>
        </div>
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.04] text-[#8bd3ff]">
          <Icon className="h-5 w-5" />
        </div>
      </div>

      <div className="mt-4 space-y-3">
        {items.map((item, index) => (
          <div key={item.label} className={cn("rounded-[1.1rem] border p-4", toneClass(item.tone ?? "neutral"))}>
            <div className="grid gap-4 md:grid-cols-[auto_1fr_auto] md:items-center">
              <div className="flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-[#09162f] text-[11px] font-semibold text-[#8dbfff]">
                {String(index + 1).padStart(2, "0")}
              </div>
              <div className="min-w-0">
                <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#86a7d0]">{item.label}</p>
                <p className="mt-2 text-sm leading-6 text-[#bfd0eb]">{item.hint}</p>
              </div>
              <div className="text-left md:text-right">
                <p className="text-[1.6rem] font-bold leading-none tracking-[-0.04em] text-white">{item.value}</p>
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export function makeCashDisciplineItems(dashboard: DashboardResponse, currency: string): FocusItem[] {
  const cfo = dashboard.cfo;
  return [
    {
      label: "Free cash flow",
      value: formatMoneyWithCurrency(cfo?.freeCashFlow ?? 0, currency),
      hint: "Cash left after operating and investing load. This is the first answer to whether growth is actually usable.",
      tone: (cfo?.freeCashFlow ?? 0) >= 0 ? "positive" : "warning",
    },
    {
      label: "Operating cash flow",
      value: formatMoneyWithCurrency(cfo?.operatingCashFlow ?? 0, currency),
      hint: `The operating engine is converting revenue through a ${Math.round(cfo?.cashConversionDays ?? 0)} day cycle.`,
      tone: (cfo?.operatingCashFlow ?? 0) >= 0 ? "positive" : "neutral",
    },
    {
      label: "DSO / DPO spread",
      value: `${Math.round(cfo?.dsoDays ?? 0)}d / ${Math.round(cfo?.dpoDays ?? 0)}d`,
      hint: "If receivables remain open materially longer than payables, treasury pressure compounds quickly.",
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
      hint: cfo?.topClientRevenue
        ? `${formatMoneyWithCurrency(cfo.topClientRevenue, currency)} of scoped revenue is concentrated here.`
        : "The largest revenue dependency appears here once mix data is available.",
      tone: (cfo?.topClientConcentrationPct ?? 0) >= 25 ? "warning" : "neutral",
    },
    {
      label: "Revenue share",
      value:
        (cfo?.topClientConcentrationPct ?? 0) > 0
          ? formatPercentDelta((cfo?.topClientConcentrationPct ?? 0) / 100)
          : "—",
      hint: "This should never become a surprise board conversation. The dependency needs to be visible early.",
      tone: (cfo?.topClientConcentrationPct ?? 0) >= 25 ? "warning" : "neutral",
    },
    {
      label: "Best margin unit",
      value:
        cfo?.topBusinessUnitName || cfo?.topBusinessUnitMarginPct
          ? `${cfo?.topBusinessUnitName || "—"} · ${formatPercentDelta((cfo?.topBusinessUnitMarginPct ?? 0) / 100)}`
          : "—",
      hint: "Use the strongest unit as the internal pricing and operating benchmark for the rest of the business.",
      tone: "positive",
    },
  ];
}

export function makeServiceLevelItems(dashboard: DashboardResponse): FocusItem[] {
  const cfo = dashboard.cfo;
  return [
    {
      label: "SLA compliance",
      value: formatPercentDelta((cfo?.slaCompliancePct ?? 0) / 100),
      hint: "Service misses turn into credits, churn risk, and margin erosion long before accounting catches up.",
      tone: (cfo?.slaCompliancePct ?? 0) < 95 ? "warning" : "positive",
    },
    {
      label: "Utilization",
      value: formatPercentDelta((cfo?.utilizationPct ?? 0) / 100),
      hint: "Finance should see whether labor is underused or whether delivery is drifting into operational strain.",
      tone: "neutral",
    },
    {
      label: "CSAT",
      value: formatPercentDelta((cfo?.csatPct ?? 0) / 100),
      hint: "Customer sentiment matters here because renewal confidence and expansion economics depend on it.",
      tone: "neutral",
    },
  ];
}
