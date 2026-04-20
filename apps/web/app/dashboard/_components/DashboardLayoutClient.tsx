"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { DashboardShell } from "./DashboardShell";
import { AuthPanel } from "./AuthPanel";
import { useNumeriquApi } from "../../../lib/useNumeriquApi";

type Toast = { kind: "success" | "error" | "info"; text: string } | null;

export function DashboardLayoutClient({ children }: { children: React.ReactNode }) {
  const searchParams = useSearchParams();
  const { auth, isAuthenticated, signOut, useDevToken, loading } = useNumeriquApi();
  const [tenantLabel, setTenantLabel] = useState<string>("Provisioning tenant...");
  const [toast, setToast] = useState<Toast>(null);

  const success = searchParams.get("success");
  const error = searchParams.get("error");

  useEffect(() => {
    if (success) setToast({ kind: "success", text: success.replaceAll("_", " ") });
    if (error) setToast({ kind: "error", text: error.replaceAll("_", " ") });
  }, [success, error]);

  useEffect(() => {
    if (loading || !isAuthenticated) return;
    auth
      .me()
      .then((payload) => setTenantLabel(`${payload.tenant.name} · ${payload.user.email ?? payload.user.id}`))
      .catch(() => setTenantLabel("Tenant context unavailable"));
  }, [auth, isAuthenticated, loading]);

  const toastClasses = useMemo(() => {
    if (!toast) return "";
    if (toast.kind === "error") return "border-rose-400/30 bg-rose-400/10 text-rose-100";
    if (toast.kind === "success") return "border-cyan-400/30 bg-cyan-400/10 text-cyan-100";
    return "border-white/10 bg-white/5 text-slate-100";
  }, [toast]);

  if (!isAuthenticated) return <AuthPanel onDevToken={useDevToken} />;

  return (
    <DashboardShell tenantLabel={tenantLabel} onSignOut={signOut}>
      {toast ? (
        <div className={`mb-6 rounded-2xl border p-4 text-sm ${toastClasses}`}>
          <div className="flex items-center justify-between gap-4">
            <span>{toast.text}</span>
            <button onClick={() => setToast(null)} className="text-white/70 hover:text-white">
              Dismiss
            </button>
          </div>
        </div>
      ) : null}
      {children}
    </DashboardShell>
  );
}
