"use client";

import type { DashboardResponse } from "../../../../lib/api";
import { EmptyState } from "../../../../components/ui/EmptyState";
import { StatusPill } from "../../../../components/ui/StatusPill";
import { formatMoneyWithCurrency, formatRelativeTime } from "./format";

type Tone = "info" | "warning" | "success" | "danger" | "neutral";

export function toneFromType(type: string): Tone {
  const lower = type.toLowerCase();
  if (lower.includes("error") || lower.includes("anomaly")) return "danger";
  if (lower.includes("warn")) return "warning";
  if (lower.includes("ok") || lower.includes("success")) return "success";
  if (lower.includes("info") || lower.includes("note")) return "info";
  return "neutral";
}

export function deriveInsights(kpis: DashboardResponse["kpis"], currency: string): DashboardResponse["insights"] {
  const now = new Date().toISOString();
  const openAmount = kpis.openInvoiceAmount ?? kpis.totalExpenses ?? 0;
  const openCount = kpis.openInvoiceCount ?? 0;

  const generated: DashboardResponse["insights"] = [];

  if (kpis.totalRevenue === 0 && kpis.totalInvoices === 0) {
    generated.push({
      id: "nq:connect-source",
      title: "Connect a finance source to unlock metrics",
      description: "Once data is synced, this overview will populate spend, overdue exposure, and invoice status.",
      type: "Info",
      createdAt: now,
    });
  }

  if (kpis.overdueAmount > 0) {
    generated.push({
      id: "nq:overdue-followup",
      title: "Chase overdue invoices",
      description: `${formatMoneyWithCurrency(kpis.overdueAmount, currency)} is overdue across ${kpis.overdueCount} invoices. Prioritize the largest balances and set follow-up reminders.`,
      type: "Warning",
      createdAt: now,
    });
  } else if (openAmount > 0) {
    generated.push({
      id: "nq:open-invoices",
      title: "Review open invoices",
      description: `${formatMoneyWithCurrency(openAmount, currency)} is currently open across ${openCount || "multiple"} invoices. Confirm due dates and expected collection windows.`,
      type: "Note",
      createdAt: now,
    });
  }

  if (kpis.providerCount === 0 || kpis.orgCount === 0) {
    generated.push({
      id: "nq:entities",
      title: "Finish connecting entities",
      description: "Connect all business entities to avoid missing spend or exposure in this overview.",
      type: "Info",
      createdAt: now,
    });
  }

  return generated;
}

export function NextActionsCard({
  insights,
  kpis,
  currency,
}: {
  insights: DashboardResponse["insights"];
  kpis: DashboardResponse["kpis"];
  currency: string;
}) {
  const computed = insights.length > 0 ? insights : deriveInsights(kpis, currency);
  const top = computed.slice(0, 5);

  return (
    <div className="dashboard-focus-card h-full p-5">
      <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[#91a2ff]">
        CFO agenda
      </p>
      <h2 className="mt-2 font-display text-[1.45rem] font-bold text-white md:text-[1.55rem]">
        Decisions that deserve today
      </h2>

      <div className="mt-4">
        {top.length === 0 ? (
          <EmptyState
            title="No outstanding actions"
            detail="When syncs complete and the advisor finds anomalies, they appear here."
            className="p-5"
          />
        ) : (
          <ul className="space-y-2.5">
            {top.slice(0, 3).map((insight) => (
              <li
                key={insight.id}
                className="flex items-start gap-3 rounded-[1rem] border border-white/10 bg-white/[0.04] p-4"
              >
                <StatusPill tone={toneFromType(insight.type)} className="mt-0.5">
                  {insight.type}
                </StatusPill>
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-white">{insight.title}</p>
                  {insight.description ? (
                    <p className="mt-1 text-sm text-[#bfd0eb] line-clamp-2">
                      {insight.description}
                    </p>
                  ) : null}
                  <p className="mt-2 text-xs text-[#8ea9d0]">
                    {formatRelativeTime(insight.createdAt)}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
