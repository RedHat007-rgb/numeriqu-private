"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useNumeriquApi } from "../../../lib/useNumeriquApi";
import { SELECTED_ORG_ID_KEY, setSelectedOrganizationCookie } from "../../../lib/api/base";
import type { WorkspaceSummary } from "../../../lib/api/types";
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
  const { isAuthenticated, signOut, useDevToken, loading, currentUser, organization, refreshSession, authError } = useNumeriquApi();
  const [tenantLabel, setTenantLabel] = useState<string>("Loading workspace...");
  const [userLabel, setUserLabel] = useState<string>("");
  const [toast, setToast] = useState<Toast>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);

  // Retry counter for transient API failures — resets on successful auth
  const retryCount = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  // ── Auth guard ────────────────────────────────────────────────────────────────
  // Only runs after loading completes. Handles three cases:
  //   1. Authenticated → reset retry state, continue normally.
  //   2. True 401 (authError is null) → redirect to /login.
  //   3. Transient error (authError set) → silently retry up to 3 times with
  //      exponential backoff before giving up and redirecting to /login.
  useEffect(() => {
    if (loading) return;

    if (isAuthenticated) {
      retryCount.current = 0;
      return;
    }

    // Clear any pending retry timer
    if (retryTimer.current) {
      clearTimeout(retryTimer.current);
      retryTimer.current = null;
    }

    // True session expiry (API returned 401, authError is null)
    if (!authError) {
      router.replace("/login");
      return;
    }

    // Transient error (500, network blip, API restart, etc.)
    // Retry up to 3 times with 2 s → 4 s → 6 s backoff before redirecting.
    if (retryCount.current < 3) {
      const delay = (retryCount.current + 1) * 2000;
      retryTimer.current = setTimeout(() => {
        retryCount.current += 1;
        void refreshSession();
      }, delay);
    } else {
      // Exhausted retries — send to login so user can re-authenticate
      router.replace("/login");
    }

    return () => {
      if (retryTimer.current) clearTimeout(retryTimer.current);
    };
  }, [loading, isAuthenticated, authError, refreshSession, router]);

  useEffect(() => {
    if (loading) return;
    if (!isAuthenticated) return;
    const tenantName = currentUser?.tenant?.name ?? "Workspace";
    const userIdent = currentUser?.user?.email ?? currentUser?.user?.id ?? "";
    setTenantLabel(tenantName);
    setUserLabel(userIdent);

    // Keep the org-selection cookie in sync with the backend-selected tenant so
    // server-side proxy injection scopes subsequent requests consistently.
    try {
      setSelectedOrganizationCookie(currentUser?.tenant?.id ?? null);
    } catch {
      // ignore
    }
  }, [currentUser, isAuthenticated, loading]);

  useEffect(() => {
    if (loading || !isAuthenticated) return;
    organization.listWorkspaces().then(setWorkspaces).catch(() => setWorkspaces([]));
  }, [isAuthenticated, loading, organization]);

  const selectWorkspace = async (organizationId: string) => {
    let previous: string | null = null;
    try {
      if (typeof window !== "undefined") {
        previous = window.localStorage.getItem(SELECTED_ORG_ID_KEY);
      }
    } catch {
      previous = null;
    }

    // Persist selection via cookie first so the server-side proxy can scope `/auth/me`.
    try {
      setSelectedOrganizationCookie(organizationId);
    } catch {
      // ignore
    }

    const result = await refreshSession();
    const tenantId = result?.me?.tenant?.id ?? null;

    if (tenantId && tenantId === organizationId) {
      try {
        if (typeof window !== "undefined") {
          window.localStorage.setItem(SELECTED_ORG_ID_KEY, organizationId);
        }
      } catch {
        // ignore
      }
      window.location.href = window.location.pathname;
      return;
    }

    // Revert selection if the requested workspace could not be activated.
    try {
      if (typeof window !== "undefined") {
        if (previous) window.localStorage.setItem(SELECTED_ORG_ID_KEY, previous);
        else window.localStorage.removeItem(SELECTED_ORG_ID_KEY);
      }
    } catch {
      // ignore
    }
    try {
      setSelectedOrganizationCookie(previous);
    } catch {
      // ignore
    }

    setToast({
      kind: "error",
      text:
        result?.message ||
        authError ||
        "Couldn't switch workspace. Your session is still active — please retry.",
    });
  };

  if (loading) return <DashboardSkeleton />;

  // Not authenticated: show skeleton while the auth-guard effect above handles
  // retry / redirect. Never render AuthPanel inside the dashboard — that was the bug.
  if (!isAuthenticated) return <DashboardSkeleton />;

  return (
    <DashboardShell
      tenantLabel={tenantLabel}
      userLabel={userLabel}
      onSignOut={signOut}
      accountType={currentUser?.tenant?.accountType ?? "ORGANIZATION"}
      currentWorkspaceId={currentUser?.tenant?.id ?? null}
      workspaces={workspaces}
      onSelectWorkspace={selectWorkspace}
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
