"use client";

import { useCallback, useEffect, useState } from "react";
import { ApiError, type DashboardResponse, type TimeRange } from "../../../lib/api";
import { useNumeriquApi } from "../../../lib/useNumeriquApi";

export type LoadState = "idle" | "loading" | "ready" | "error";

const RANGE_STORAGE_KEY = "nq.dashboard.range";
const DEFAULT_RANGE: TimeRange = { kind: "LAST_N_DAYS", days: 90 };

function makeFallbackDashboard(): DashboardResponse {
  return {
    kpis: {
      totalRevenue: 0,
      totalExpenses: 0,
      netProfit: 0,
      profitMargin: 0,
      totalInvoices: 0,
      avgInvoiceValue: 0,
      openInvoiceAmount: 0,
      openInvoiceCount: 0,
      overdueAmount: 0,
      overdueCount: 0,
      orgCount: 0,
      providerCount: 0,
    },
    venture: { burnRate: 0, runwayMonths: 0, cashOnHand: 0, efficiencyMultiplier: 0 },
    cfo: {
      mode: "generic",
      headline: "Connect your finance systems to generate an executive brief.",
      cashBalance: 0,
      workingCapital: 0,
      freeCashFlow: 0,
      operatingCashFlow: 0,
      grossMarginPct: 0,
      payrollToRevenuePct: 0,
      dsoDays: 0,
      dpoDays: 0,
      cashConversionDays: 0,
      slaCompliancePct: 0,
      utilizationPct: 0,
      csatPct: 0,
      apOutstanding: 0,
      topClientName: null,
      topClientRevenue: 0,
      topClientConcentrationPct: 0,
      topBusinessUnitName: null,
      topBusinessUnitMarginPct: 0,
    },
    charts: { monthlyTrend: [], orgBreakdown: [], invoiceStatus: [], cashflowWaterfall: [] },
    connectedOrgs: [],
    insights: [],
    meta: { computedAt: new Date().toISOString(), latencyMs: 0, range: DEFAULT_RANGE },
  };
}

function safeParseRange(value: string | null): TimeRange | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<TimeRange> | null;
    if (!parsed || typeof parsed !== "object") return null;
    if (!("kind" in parsed) || typeof (parsed as any).kind !== "string") return null;
    const kind = (parsed as any).kind as TimeRange["kind"];

    if (kind === "ALL_TIME" || kind === "MTD" || kind === "QTD" || kind === "YTD") return { kind };
    if (kind === "LAST_N_DAYS" && Number.isFinite((parsed as any).days)) return { kind, days: Number((parsed as any).days) };
    if (kind === "LAST_N_WEEKS" && Number.isFinite((parsed as any).weeks)) return { kind, weeks: Number((parsed as any).weeks) };
    if (kind === "LAST_N_MONTHS" && Number.isFinite((parsed as any).months)) return { kind, months: Number((parsed as any).months) };
    if (kind === "LAST_N_QUARTERS" && Number.isFinite((parsed as any).quarters)) return { kind, quarters: Number((parsed as any).quarters) };
    if (kind === "LAST_N_YEARS" && Number.isFinite((parsed as any).years)) return { kind, years: Number((parsed as any).years) };
    return null;
  } catch {
    return null;
  }
}

export function useDashboard() {
  const { analytics, loading } = useNumeriquApi();
  const [state, setState] = useState<LoadState>("idle");
  const [dashboard, setDashboard] = useState<DashboardResponse>(() => makeFallbackDashboard());
  const [error, setError] = useState<string | null>(null);
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  const [range, setRange] = useState<TimeRange>(DEFAULT_RANGE);
  const [rangeReady, setRangeReady] = useState(false);

  useEffect(() => {
    const stored = safeParseRange(window.localStorage.getItem(RANGE_STORAGE_KEY));
    if (stored) setRange(stored);
    setRangeReady(true);
  }, []);

  const refresh = useCallback(async (nextRange?: TimeRange) => {
    setState("loading");
    try {
      const payload = await analytics.dashboard(nextRange ?? range);
      setDashboard(payload);
      setError(null);
      setState("ready");
      setHasLoadedOnce(true);
    } catch (caught) {
      if (caught instanceof ApiError) {
        setError(caught.toUserMessage("We could not load your financial overview."));
      } else {
        setError("We could not load your financial overview. Please retry.");
      }
      setState("error");
    }
  }, [analytics, range]);

  const updateRange = useCallback(
    (next: TimeRange) => {
      setRange(next);
      try {
        window.localStorage.setItem(RANGE_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // ignore
      }
      void refresh(next);
    },
    [refresh],
  );

  useEffect(() => {
    if (loading || !rangeReady) return;
    void refresh(range);
  }, [refresh, loading, range, rangeReady]);

  return { state, dashboard, error, refresh, hasLoadedOnce, range, setRange: updateRange };
}
