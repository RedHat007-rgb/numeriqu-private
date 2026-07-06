"use client";

import type { ReactNode } from "react";
import { Activity, ArrowUpRight, Landmark, ShieldAlert } from "lucide-react";
import { cn } from "../../../../components/ui/cn";
import type { DashboardResponse } from "../../../../lib/api";
import { formatMoneyWithCurrency, formatPercentDelta } from "./format";

type DecisionItem = {
  label: string;
  summary: string;
  value: string;
  tone: "positive" | "warning" | "neutral";
};

function toneClass(tone: "positive" | "warning" | "neutral") {
  if (tone === "positive") return "border-feedback-success/25 bg-feedback-success/10 text-feedback-success";
  if (tone === "warning") return "border-[#f59e0b]/30 bg-[#f59e0b]/12 text-[#ffd089]";
  return "border-white/10 bg-white/5 text-[#d7e5fa]";
}

function safePercent(value: number | null | undefined) {
  return value && Number.isFinite(value) ? formatPercentDelta(value / 100) : "—";
}

function safeMoney(value: number | null | undefined, currency: string) {
  return value && Number.isFinite(value) ? formatMoneyWithCurrency(value, currency) : "—";
}

function safeDays(value: number | null | undefined) {
  return value && Number.isFinite(value) ? `${Math.round(value)}d` : "—";
}

function buildHeadline(cfo: DashboardResponse["cfo"]) {
  if (!cfo) return "Finance signal is still warming up";

  const concentration = cfo.topClientConcentrationPct ?? 0;
  const freeCashFlow = cfo.freeCashFlow ?? 0;
  const cashCycle = cfo.cashConversionDays ?? 0;

  if (freeCashFlow < 0 && concentration >= 25) return "Cash is tight and revenue dependence is too high";
  if (freeCashFlow < 0) return "Cash conversion needs intervention";
  if (cashCycle > 45) return "Revenue is strong, but cash is getting trapped";
  if (concentration >= 25) return "Growth is carrying concentration risk";
  return "Capital, margin, and collections are in control";
}

function buildNarrative(cfo: DashboardResponse["cfo"]) {
  if (!cfo) return "As live finance data lands, this deck should immediately tell a CFO where to push, where to protect, and what needs a call today.";

  const topClient = cfo.topClientName || "the largest client";
  const cashCycle = safeDays(cfo.cashConversionDays);

  return `Read treasury, exposure, and margin quality in one pass. Collections are cycling at ${cashCycle}, and ${topClient} remains the account to watch first.`;
}

function buildDecisionItems(dashboard: DashboardResponse, currency: string): DecisionItem[] {
  const cfo = dashboard.cfo;
  const items: DecisionItem[] = [];

  if ((dashboard.kpis.overdueAmount ?? 0) > 0) {
    items.push({
      label: "Release cash",
      summary: "Past-due invoices are already slowing treasury.",
      value: formatMoneyWithCurrency(dashboard.kpis.overdueAmount, currency),
      tone: "warning",
    });
  }

  if ((cfo?.topClientConcentrationPct ?? 0) >= 20) {
    items.push({
      label: "Reduce dependency",
      summary: `${cfo?.topClientName || "Top client"} is too large in the current mix.`,
      value: safePercent(cfo?.topClientConcentrationPct),
      tone: "warning",
    });
  }

  if ((cfo?.payrollToRevenuePct ?? 0) > 40) {
    items.push({
      label: "High Payroll to Revenue Percentage - Protect Margin",
      summary: "Labor load is climbing relative to revenue capacity.",
      value: safePercent(cfo?.payrollToRevenuePct),
      tone: "warning",
    });
  }

  if ((cfo?.cashConversionDays ?? 0) > 30) {
    items.push({
      label: "Shorten cycle",
      summary: "Collections are taking longer than a healthy operating rhythm.",
      value: safeDays(cfo?.cashConversionDays),
      tone: "warning",
    });
  }

  if (items.length < 3 && (cfo?.grossMarginPct ?? 0) > 0) {
    items.push({
      label: "Scale what works",
      summary: "Margin quality is healthy enough to identify repeatable pockets of strength.",
      value: safePercent(cfo?.grossMarginPct),
      tone: "positive",
    });
  }

  if (items.length < 3) {
    items.push({
      label: "Expand coverage",
      summary: "More finance feeds will sharpen entity-level decision quality.",
      value: `${dashboard.kpis.providerCount} live`,
      tone: "neutral",
    });
  }

  return items.slice(0, 3);
}

function MetricPill({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "positive" | "warning" | "neutral";
}) {
  return (
    <div className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-2">
      <div className="flex items-center gap-2">
        <span className={cn("h-2 w-2 rounded-full border", toneClass(tone))} />
        <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#8eacd4]">{label}</span>
      </div>
      <p className="mt-1 text-sm font-semibold text-white">{value}</p>
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  meta,
  tone,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  meta: string;
  tone: "positive" | "warning" | "neutral";
}) {
  return (
    <div className="dashboard-brief-stat rounded-[1.15rem] p-4">
      <div className="flex items-center justify-between gap-3">
        <div className={cn("flex h-9 w-9 items-center justify-center rounded-2xl border", toneClass(tone))}>
          {icon}
        </div>
        <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#8eacd4]">{label}</p>
      </div>
      <p className="mt-4 text-[1.85rem] font-bold tracking-[-0.04em] text-white">{value}</p>
      <p className="mt-2 text-sm leading-6 text-[#b8c8e4]">{meta}</p>
    </div>
  );
}

function DecisionRow({ item, index }: { item: DecisionItem; index: number }) {
  return (
    <div className="rounded-[1rem] border border-white/10 bg-white/[0.04] p-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#86a7d0]">
              {String(index + 1).padStart(2, "0")}
            </span>
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#86a7d0]">{item.label}</p>
          </div>
          <p className="mt-2 text-sm leading-6 text-[#bfd0eb]">{item.summary}</p>
        </div>
        <span
          className={cn(
            "min-w-fit rounded-full border px-3 py-1.5 text-base font-bold leading-none tracking-[-0.02em] md:text-lg",
            toneClass(item.tone),
          )}
        >
          {item.value}
        </span>
      </div>
    </div>
  );
}

export function ExecutiveBriefCard({
  dashboard,
  currency,
}: {
  dashboard: DashboardResponse;
  currency: string;
}) {
  const cfo = dashboard.cfo;
  const concentration = cfo?.topClientConcentrationPct ?? 0;
  const cashBalance = safeMoney(cfo?.cashBalance ?? dashboard.venture.cashOnHand, currency);
  const workingCapital = safeMoney(cfo?.workingCapital, currency);
  const topClientExposure = concentration > 0 ? safePercent(concentration) : "—";
  const overdueAmount = safeMoney(dashboard.kpis.overdueAmount, currency);
  const openInvoiceAmount = safeMoney(dashboard.kpis.openInvoiceAmount, currency);
  const headline = buildHeadline(cfo);
  const narrative = buildNarrative(cfo);
  const decisionItems = buildDecisionItems(dashboard, currency);

  return (
    <section className="dashboard-command-card relative overflow-hidden p-5 md:p-6">
      <div className="relative z-[1] space-y-5">
        <div className="flex flex-col gap-4 border-b border-white/8 pb-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="max-w-[46rem]">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-[#8ad7ff]/16 bg-[#8ad7ff]/8 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.28em] text-[#8ad7ff]">
                CFO command brief
              </span>
              <span className="rounded-full border border-white/10 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.22em] text-[#d7e5fa]">
                {cfo?.mode === "ebpo" ? "Live EBPO finance stream" : "Awaiting live finance stream"}
              </span>
            </div>
            <h2 className="mt-4 max-w-[14ch] font-display text-[2rem] font-bold leading-[1.02] tracking-[-0.045em] text-white md:text-[2.9rem]">
              {headline}
            </h2>
            <p className="mt-4 max-w-[68ch] text-sm leading-7 text-[#bfd0eb] md:text-[0.98rem]">
              {narrative}
            </p>
          </div>

          <div className="grid gap-2 sm:grid-cols-3 lg:w-[25rem] lg:grid-cols-1">
            <MetricPill
              label="Cash balance"
              value={cashBalance}
              tone={(cfo?.cashBalance ?? 0) > 0 ? "positive" : "neutral"}
            />
            <MetricPill
              label="Working capital"
              value={workingCapital}
              tone={(cfo?.workingCapital ?? 0) >= 0 ? "positive" : "warning"}
            />
            <MetricPill
              label="Top exposure"
              value={topClientExposure}
              tone={concentration >= 25 ? "warning" : "neutral"}
            />
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-3">
          <StatCard
            icon={<Landmark className="h-4 w-4" />}
            label="Treasury"
            value={cashBalance}
            meta={`Working capital ${workingCapital}`}
            tone={(cfo?.workingCapital ?? 0) >= 0 ? "positive" : "warning"}
          />
          <StatCard
            icon={<ArrowUpRight className="h-4 w-4" />}
            label="Collections"
            value={safeDays(cfo?.cashConversionDays)}
            meta={`DSO ${safeDays(cfo?.dsoDays)} against DPO ${safeDays(cfo?.dpoDays)}`}
            tone={(cfo?.cashConversionDays ?? 0) > 45 ? "warning" : "neutral"}
          />
          <StatCard
            icon={<ShieldAlert className="h-4 w-4" />}
            label="Concentration"
            value={topClientExposure}
            meta={
              cfo?.topClientName
                ? `${cfo.topClientName} is the largest account in scope`
                : "Largest-account dependence will appear once mix data is live"
            }
            tone={concentration >= 25 ? "warning" : "neutral"}
          />
        </div>

        <div className="grid gap-3 xl:grid-cols-2">
          <div className="dashboard-brief-aside rounded-[1.35rem] p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#9bcfff]">
                  Decision queue
                </p>
                <h3 className="mt-2 text-lg font-semibold text-white">What the CFO should move today</h3>
              </div>
              <div className="flex h-10 w-10 items-center justify-center rounded-2xl border border-[#8ad7ff]/15 bg-[#8ad7ff]/8 text-[#8ad7ff]">
                <Activity className="h-4 w-4" />
              </div>
            </div>

            <div className="mt-4 space-y-3">
              {decisionItems.map((item, index) => (
                <DecisionRow key={`${item.label}-${index}`} item={item} index={index} />
              ))}
            </div>
          </div>

          <div className="dashboard-brief-aside rounded-[1.35rem] p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#9bcfff]">
                  Board watchlist
                </p>
                <h3 className="mt-2 text-lg font-semibold text-white">What can hurt cash first</h3>
              </div>
              <div className="flex h-10 w-10 items-center justify-center rounded-2xl border border-[#8ad7ff]/15 bg-[#8ad7ff]/8 text-[#8ad7ff]">
                <Activity className="h-4 w-4" />
              </div>
            </div>

            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              <div className="rounded-[1rem] border border-white/10 bg-[#08152f]/70 p-4">
                <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#86a7d0]">Receivables open</p>
                <p className="mt-2 text-[1.75rem] font-bold tracking-[-0.04em] text-white">{openInvoiceAmount}</p>
              </div>
              <div className="rounded-[1rem] border border-white/10 bg-[#08152f]/70 p-4">
                <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#86a7d0]">Past due now</p>
                <p className="mt-2 text-[1.75rem] font-bold tracking-[-0.04em] text-white">{overdueAmount}</p>
              </div>
            </div>

            <div className="mt-3 rounded-[1rem] border border-white/10 bg-[#07132d]/70 p-4">
              <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#86a7d0]">Margin discipline</p>
              <div className="mt-3 grid grid-cols-2 gap-3">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#86a7d0]">Gross margin</p>
                  <p className="mt-2 text-2xl font-bold text-white">{safePercent(cfo?.grossMarginPct ?? dashboard.kpis.profitMargin)}</p>
                </div>
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#86a7d0]">Payroll / revenue</p>
                  <p className="mt-2 text-2xl font-bold text-white">{safePercent(cfo?.payrollToRevenuePct)}</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
