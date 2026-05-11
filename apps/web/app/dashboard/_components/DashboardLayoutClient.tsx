"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useNumeriquApi } from "../../../lib/useNumeriquApi";
import { Skeleton } from "../../../components/ui/Skeleton";
import { ErrorBanner } from "../../../components/ui/ErrorBanner";
import { AuthPanel } from "./AuthPanel";
import { DashboardShell } from "./DashboardShell";

type Toast = { kind: "success" | "error" | "info"; text: string } | null;

function formatBusMessage(value: string) {
  const cleaned = value.replaceAll("_", " ");
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

function DashboardSkeleton() {
  return (
    <div className="min-h-screen bg-transparent p-6 text-text-primary">
      <div className="mx-auto max-w-7xl space-y-6">
        <Skeleton height={48} width="40%" rounded="xl" />
        <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
          <div className="space-y-3">
            {Array.from({ length: 5 }).map((_, idx) => (
              <Skeleton key={idx} height={64} rounded="xl" />
            ))}
          </div>
          <div className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              {Array.from({ length: 4 }).map((_, idx) => (
                <Skeleton key={idx} height={140} rounded="xl" />
              ))}
            </div>
            <Skeleton height={320} rounded="xl" />
          </div>
        </div>
      </div>
    </div>
  );
}

export function DashboardLayoutClient({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { isAuthenticated, signOut, useDevToken, loading, currentUser } = useNumeriquApi();
  const [tenantLabel, setTenantLabel] = useState<string>("Loading workspace...");
  const [userLabel, setUserLabel] = useState<string>("");
  const [toast, setToast] = useState<Toast>(null);

  const success = searchParams.get("success");
  const error = searchParams.get("error");

  useEffect(() => {
    if (success) setToast({ kind: "success", text: formatBusMessage(success) });
    else if (error) setToast({ kind: "error", text: formatBusMessage(error) });
    else setToast(null);
  }, [success, error]);

  useEffect(() => {
    document.body.classList.add("nq-app");
    return () => {
      document.body.classList.remove("nq-app");
    };
  }, []);

  useEffect(() => {
    if (loading) return;
    if (!isAuthenticated) {
      router.push("/login");
      return;
    }
    const tenantName = currentUser?.tenant?.name ?? "Workspace";
    const userIdent = currentUser?.user?.email ?? currentUser?.user?.id ?? "";
    setTenantLabel(tenantName);
    setUserLabel(userIdent);
  }, [currentUser, isAuthenticated, loading, router]);

  if (loading) return <DashboardSkeleton />;
  if (!isAuthenticated) return <AuthPanel onDevToken={useDevToken} />;

  return (
    <DashboardShell
      tenantLabel={tenantLabel}
      userLabel={userLabel}
      onSignOut={signOut}
      accountType={currentUser?.tenant?.accountType ?? "ORGANIZATION"}
    >
      {toast ? (
        <ErrorBanner
          tone={toast.kind === "error" ? "danger" : toast.kind === "success" ? "info" : "info"}
          onDismiss={() => setToast(null)}
          className="mb-6"
        >
          {toast.text}
        </ErrorBanner>
      ) : null}
      {children}
    </DashboardShell>
  );
}
