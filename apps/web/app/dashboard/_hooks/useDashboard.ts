"use client";

import { useCallback, useEffect, useState } from "react";
import { ApiError, type DashboardResponse } from "../../../lib/api";
import { useNumeriquApi } from "../../../lib/useNumeriquApi";

type LoadState = "idle" | "loading" | "ready" | "error";

function makeFallbackDashboard(): DashboardResponse {
  return {
    kpis: {
      totalRevenue: 0,
      totalExpenses: 0,
      netProfit: 0,
      profitMargin: 0,
      totalInvoices: 0,
      avgInvoiceValue: 0,
      overdueAmount: 0,
      overdueCount: 0,
      orgCount: 0,
      providerCount: 0,
    },
    venture: { burnRate: 0, runwayMonths: 0, cashOnHand: 0, efficiencyMultiplier: 0 },
    charts: { monthlyTrend: [], orgBreakdown: [], invoiceStatus: [], cashflowWaterfall: [] },
    connectedOrgs: [],
    insights: [],
    meta: { computedAt: new Date().toISOString(), latencyMs: 0 },
  };
}

export function useDashboard() {
  const { analytics, loading } = useNumeriquApi();
  const [state, setState] = useState<LoadState>("idle");
  const [dashboard, setDashboard] = useState<DashboardResponse>(() => makeFallbackDashboard());
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setState("loading");
    try {
      const payload = await analytics.dashboard();
      setDashboard(payload);
      setError(null);
      setState("ready");
    } catch (caught) {
      setDashboard(makeFallbackDashboard());
      setError(caught instanceof ApiError ? caught.message : "Could not load backend data.");
      setState("error");
    }
  }, [analytics]);

  useEffect(() => {
    if (loading) return;
    void refresh();
  }, [refresh, loading]);

  return { state, dashboard, error, refresh };
}

