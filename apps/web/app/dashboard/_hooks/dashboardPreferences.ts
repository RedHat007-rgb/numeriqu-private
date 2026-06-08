"use client";

import { useCallback, useEffect, useState } from "react";

export type DashboardPreferences = {
  fiscalYearStart: string;
  timezone: string;
  dateFormat: string;
  currencyDisplay: string;
  notifySyncFailures: boolean;
  notifyOverdueInvoices: boolean;
  notifyRevenueMilestones: boolean;
  weeklyDigest: boolean;
};

export const DEFAULT_DASHBOARD_PREFERENCES: DashboardPreferences = {
  fiscalYearStart: "January",
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  dateFormat: "MMM D, YYYY",
  currencyDisplay: "USD",
  notifySyncFailures: true,
  notifyOverdueInvoices: true,
  notifyRevenueMilestones: false,
  weeklyDigest: false,
};

const STORAGE_KEY = "nq_prefs";

function mergePreferences(value: unknown): DashboardPreferences {
  if (!value || typeof value !== "object") return DEFAULT_DASHBOARD_PREFERENCES;
  return {
    ...DEFAULT_DASHBOARD_PREFERENCES,
    ...(value as Partial<DashboardPreferences>),
  };
}

export function loadDashboardPreferences(): DashboardPreferences {
  if (typeof window === "undefined") return DEFAULT_DASHBOARD_PREFERENCES;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_DASHBOARD_PREFERENCES;
    return mergePreferences(JSON.parse(raw));
  } catch {
    return DEFAULT_DASHBOARD_PREFERENCES;
  }
}

export function saveDashboardPreferences(prefs: DashboardPreferences) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
}

export function useDashboardPreferences() {
  const [prefs, setPrefs] = useState<DashboardPreferences>(DEFAULT_DASHBOARD_PREFERENCES);

  useEffect(() => {
    setPrefs(loadDashboardPreferences());
  }, []);

  useEffect(() => {
    function onStorage(event: StorageEvent) {
      if (event.key !== STORAGE_KEY) return;
      setPrefs(loadDashboardPreferences());
    }

    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const updatePrefs = useCallback((next: DashboardPreferences) => {
    setPrefs(next);
    saveDashboardPreferences(next);
  }, []);

  return { prefs, setPrefs: updatePrefs };
}
