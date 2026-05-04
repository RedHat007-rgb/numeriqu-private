"use client";

import { useEffect, useState } from "react";
import { ApiError, type OrganizationContextResponse } from "../../../lib/api";
import { useNumeriquApi } from "../../../lib/useNumeriquApi";
import { Button } from "../../../components/ui/Button";
import { ErrorBanner } from "../../../components/ui/ErrorBanner";
import { Skeleton } from "../../../components/ui/Skeleton";

function formatDate(value?: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

export default function SettingsPage() {
  const { currentUser, organization, refreshSession } = useNumeriquApi();
  const [context, setContext] = useState<OrganizationContextResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function loadContext() {
    setLoading(true);
    setError(null);
    try {
      const payload = await organization.current();
      setContext(payload);
    } catch (caught) {
      const message =
        caught instanceof ApiError
          ? caught.toUserMessage("We couldn't load workspace settings right now.")
          : "We couldn't load workspace settings right now.";
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadContext();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-accent-blue">Settings</p>
        <h2 className="font-display text-2xl font-bold text-text-primary md:text-3xl">
          Workspace and session settings
        </h2>
        <p className="text-sm text-text-muted">
          Review your current workspace context and session identity.
        </p>
      </header>

      {error ? (
        <ErrorBanner title="Settings unavailable" tone="danger" onDismiss={() => setError(null)}>
          {error}
        </ErrorBanner>
      ) : null}

      <section className="grid gap-6 lg:grid-cols-2">
        <div className="surface-card p-6">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-lg font-semibold text-text-primary">Identity</h3>
            <Button variant="secondary" size="sm" onClick={() => void refreshSession()}>
              Refresh session
            </Button>
          </div>

          <dl className="mt-4 space-y-3 text-sm">
            <div className="rounded-xl border border-default bg-bg-elevated/40 px-4 py-3">
              <dt className="text-xs uppercase tracking-[0.14em] text-text-muted">Email</dt>
              <dd className="mt-1 font-medium text-text-primary">{currentUser?.user.email ?? "—"}</dd>
            </div>
            <div className="rounded-xl border border-default bg-bg-elevated/40 px-4 py-3">
              <dt className="text-xs uppercase tracking-[0.14em] text-text-muted">User ID</dt>
              <dd className="mt-1 break-all font-medium text-text-primary">{currentUser?.user.id ?? "—"}</dd>
            </div>
            <div className="rounded-xl border border-default bg-bg-elevated/40 px-4 py-3">
              <dt className="text-xs uppercase tracking-[0.14em] text-text-muted">Account Type</dt>
              <dd className="mt-1 font-medium text-text-primary">{currentUser?.tenant.accountType ?? "ORGANIZATION"}</dd>
            </div>
          </dl>
        </div>

        <div className="surface-card p-6">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-lg font-semibold text-text-primary">Organization context</h3>
            <Button variant="secondary" size="sm" onClick={() => void loadContext()} loading={loading}>
              Reload
            </Button>
          </div>

          {loading ? (
            <div className="mt-4 space-y-3">
              <Skeleton height={72} rounded="xl" />
              <Skeleton height={72} rounded="xl" />
              <Skeleton height={72} rounded="xl" />
            </div>
          ) : context ? (
            <dl className="mt-4 space-y-3 text-sm">
              <div className="rounded-xl border border-default bg-bg-elevated/40 px-4 py-3">
                <dt className="text-xs uppercase tracking-[0.14em] text-text-muted">Organization</dt>
                <dd className="mt-1 font-medium text-text-primary">{context.organization.name}</dd>
              </div>
              <div className="rounded-xl border border-default bg-bg-elevated/40 px-4 py-3">
                <dt className="text-xs uppercase tracking-[0.14em] text-text-muted">Role</dt>
                <dd className="mt-1 font-medium text-text-primary">{context.membership.role}</dd>
              </div>
              <div className="rounded-xl border border-default bg-bg-elevated/40 px-4 py-3">
                <dt className="text-xs uppercase tracking-[0.14em] text-text-muted">Permissions</dt>
                <dd className="mt-1 text-text-primary">
                  View: {context.membership.canViewDashboard ? "Yes" : "No"} · Create:{" "}
                  {context.membership.canCreateDashboard ? "Yes" : "No"} · Share:{" "}
                  {context.membership.canShareDashboard ? "Yes" : "No"}
                </dd>
              </div>
              <div className="rounded-xl border border-default bg-bg-elevated/40 px-4 py-3">
                <dt className="text-xs uppercase tracking-[0.14em] text-text-muted">Created</dt>
                <dd className="mt-1 text-text-primary">{formatDate(context.organization.createdAt)}</dd>
              </div>
            </dl>
          ) : (
            <p className="mt-4 text-sm text-text-muted">No organization context available.</p>
          )}
        </div>
      </section>
    </div>
  );
}
