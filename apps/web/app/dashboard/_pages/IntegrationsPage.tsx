"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "../../../components/ui/Button";
import { ErrorBanner } from "../../../components/ui/ErrorBanner";
import { Skeleton } from "../../../components/ui/Skeleton";
import { StatusPill } from "../../../components/ui/StatusPill";
import { EmptyState } from "../../../components/ui/EmptyState";
import { SyncJobsPanel } from "../_components/integrations/SyncJobsPanel";
import { IntegrationsHeader } from "../_components/integrations/IntegrationsHeader";
import { useIntegrations } from "../_hooks/useIntegrations";
import { useNumeriquApi } from "../../../lib/useNumeriquApi";
import type { Organization, OrgDetail, OrgMember } from "../../../lib/api";

function providerLabel(p: string) {
  if (p === "xero") return "Xero";
  if (p === "quickbooks") return "QuickBooks";
  if (p === "workday") return "Workday";
  if (p === "dynamics365") return "Dynamics 365";
  return p;
}

function providerColor(p: string) {
  if (p === "xero") return "bg-blue-500/10 text-blue-400 border-blue-500/20";
  if (p === "quickbooks") return "bg-green-500/10 text-green-400 border-green-500/20";
  if (p === "workday") return "bg-orange-500/10 text-orange-400 border-orange-500/20";
  if (p === "dynamics365") return "bg-purple-500/10 text-purple-400 border-purple-500/20";
  return "bg-text-muted/10 text-text-muted border-default";
}

// ── Invite modal ──────────────────────────────────────────────────────────────

function InviteModal({
  org,
  onClose,
  onInvite,
}: {
  org: Organization;
  onClose: () => void;
  onInvite: (email: string, role: "admin" | "member") => Promise<void>;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "member">("member");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !/.+@.+\..+/.test(email)) {
      setError("Enter a valid email address.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await onInvite(email.trim(), role);
      toast.success(`Invite sent to ${email}`);
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to send invite.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
      <div className="w-full max-w-md rounded-2xl border border-default bg-surface-card p-6 shadow-2xl">
        <h2 className="mb-1 text-lg font-bold text-text-primary">Invite to {org.orgName}</h2>
        <p className="mb-5 text-sm text-text-muted">
          The invited person will only see data from this organisation.
        </p>

        {error && (
          <div className="mb-4 rounded-xl border border-feedback-danger/30 bg-feedback-danger/10 px-4 py-3 text-sm text-feedback-danger">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-text-secondary">
              Email address
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="colleague@company.com"
              className="w-full rounded-xl border border-default bg-surface-card/70 px-4 py-2.5 text-sm text-text-primary outline-none transition-colors focus:border-accent-blue/60"
              autoFocus
            />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-text-secondary">Role</label>
            <div className="grid grid-cols-2 gap-2">
              {(["member", "admin"] as const).map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setRole(r)}
                  className={`rounded-xl border px-3 py-2.5 text-sm font-medium transition-colors ${
                    role === r
                      ? "border-accent-blue bg-accent-blue/10 text-text-primary"
                      : "border-default bg-surface-card/40 text-text-muted hover:border-accent-blue/40"
                  }`}
                >
                  <span className="block capitalize">{r}</span>
                  <span className="block text-xs opacity-60 mt-0.5">
                    {r === "member" ? "View & chat only" : "Invite others too"}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="flex gap-3 pt-1">
            <Button type="submit" className="flex-1" loading={loading}>
              Send invite
            </Button>
            <Button type="button" variant="ghost" onClick={onClose} disabled={loading}>
              Cancel
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Member list row ───────────────────────────────────────────────────────────

function MemberRow({
  member,
  canRemove,
  onRemove,
}: {
  member: OrgMember;
  canRemove: boolean;
  onRemove: () => void;
}) {
  const initials = (member.name ?? member.email)
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className="flex items-center gap-3 py-2">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-blue/20 text-xs font-bold text-accent-blue">
        {initials}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-text-primary">
          {member.name ?? member.email}
        </p>
        {member.name && (
          <p className="truncate text-xs text-text-muted">{member.email}</p>
        )}
      </div>
      <span className="shrink-0 rounded-full border border-default px-2 py-0.5 text-xs text-text-muted capitalize">
        {member.role}
      </span>
      {canRemove && (
        <button
          onClick={onRemove}
          className="shrink-0 text-xs text-text-muted hover:text-feedback-danger transition-colors"
        >
          Remove
        </button>
      )}
    </div>
  );
}

// ── Organisation card ─────────────────────────────────────────────────────────

function OrgCard({
  org,
  userRole,
  onSync,
  onDelete,
  onInvite,
  onRemoveMember,
  pending,
}: {
  org: Organization;
  userRole: string;
  onSync: () => void;
  onDelete: () => void;
  onInvite: (email: string, role: "admin" | "member") => Promise<void>;
  onRemoveMember: (userId: string) => Promise<void>;
  pending: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState<OrgDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const { integrations } = useNumeriquApi();

  const loadDetail = useCallback(async () => {
    if (detail) return;
    setLoadingDetail(true);
    try {
      const d = await integrations.getOrganization(org.id);
      setDetail(d);
    } catch {
      // non-critical
    } finally {
      setLoadingDetail(false);
    }
  }, [detail, integrations, org.id]);

  const handleExpand = () => {
    const next = !expanded;
    setExpanded(next);
    if (next) void loadDetail();
  };

  const handleRemoveMember = async (userId: string) => {
    await onRemoveMember(userId);
    setDetail(null); // force reload on next expand
  };

  const canManage = userRole === "owner" || userRole === "admin";

  return (
    <>
      {inviteOpen && (
        <InviteModal
          org={org}
          onClose={() => setInviteOpen(false)}
          onInvite={onInvite}
        />
      )}

      <div className="rounded-2xl border border-default bg-surface-card/40">
        {/* Card header */}
        <div className="flex items-start gap-4 p-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="font-semibold text-text-primary truncate">{org.orgName}</p>
              <span
                className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${providerColor(org.provider)}`}
              >
                {providerLabel(org.provider)}
              </span>
            </div>
            <p className="mt-0.5 text-xs text-text-muted">
              {org.memberCount} {org.memberCount === 1 ? "member" : "members"}
            </p>
          </div>
          <StatusPill tone={org.isActive ? "success" : "danger"}>
            {org.isActive ? "active" : "inactive"}
          </StatusPill>
        </div>

        {/* Actions row */}
        <div className="flex flex-wrap items-center gap-2 border-t border-default/50 px-4 py-3">
          <Button size="sm" onClick={onSync} loading={pending} disabled={pending}>
            Sync now
          </Button>
          {canManage && (
            <Button size="sm" variant="secondary" onClick={() => setInviteOpen(true)}>
              + Invite member
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={handleExpand}
            className="ml-auto"
          >
            {expanded ? "Hide members ↑" : "Show members ↓"}
          </Button>
          {canManage && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onDelete}
              disabled={pending}
              className="hover:text-feedback-danger"
            >
              Disconnect
            </Button>
          )}
        </div>

        {/* Members panel */}
        {expanded && (
          <div className="border-t border-default/50 px-4 pb-4 pt-3">
            {loadingDetail ? (
              <div className="space-y-2">
                <Skeleton height={32} rounded="lg" />
                <Skeleton height={32} rounded="lg" />
              </div>
            ) : detail && detail.members.length > 0 ? (
              <div className="divide-y divide-default/30">
                {detail.members.map((m) => (
                  <MemberRow
                    key={m.userId}
                    member={m}
                    canRemove={canManage}
                    onRemove={() => void handleRemoveMember(m.userId)}
                  />
                ))}
              </div>
            ) : (
              <p className="text-sm text-text-muted py-2">
                No members yet.{" "}
                {canManage && (
                  <button
                    onClick={() => setInviteOpen(true)}
                    className="text-accent-blue hover:underline"
                  >
                    Invite someone
                  </button>
                )}
              </p>
            )}

            {/* Pending invites */}
            {detail && detail.invites.length > 0 && (
              <div className="mt-3 border-t border-default/30 pt-3">
                <p className="mb-2 text-xs font-medium text-text-muted uppercase tracking-wider">
                  Pending invites
                </p>
                {detail.invites.map((inv) => (
                  <div key={inv.id} className="flex items-center gap-2 py-1.5">
                    <div className="h-2 w-2 rounded-full bg-feedback-warning shrink-0" />
                    <p className="text-sm text-text-secondary flex-1 truncate">{inv.email}</p>
                    <span className="text-xs text-text-muted capitalize">{inv.role}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function IntegrationsPage() {
  const {
    state,
    connections,
    jobs,
    error,
    refresh,
    connectProvider,
    runSync,
    runSyncAll,
    deleteConnection,
    setError,
    pendingActionId,
    actionInFlight,
    hasLoadedOnce,
  } = useIntegrations();

  const { integrations } = useNumeriquApi();
  const [userRole, setUserRole] = useState<string>("owner");
  const [orgs, setOrgs] = useState<Organization[]>([]);

  // Keep orgs list in sync with connections (derive from the same source)
  useEffect(() => {
    if (connections.length === 0) {
      setOrgs([]);
      return;
    }
    integrations.listOrganizations().then(setOrgs).catch(() => {
      // fall back to deriving from connections
      setOrgs(
        connections.map((c) => ({
          id: c.id,
          orgName: c.orgName,
          provider: c.provider,
          providerAccountId: c.providerAccountId,
          isActive: c.isActive,
          updatedAt: c.updatedAt,
          memberCount: 0,
        })),
      );
    });
  }, [connections, integrations]);

  const handleInvite = async (
    connectionId: string,
    email: string,
    role: "admin" | "member",
  ) => {
    await integrations.inviteToOrganization(connectionId, email, role);
  };

  const handleRemoveMember = async (connectionId: string, userId: string) => {
    await integrations.removeMember(connectionId, userId);
    toast.success("Member removed.");
  };

  const initialLoading = state === "loading" && !hasLoadedOnce;

  return (
    <div className="space-y-6">
      <IntegrationsHeader
        isLoading={state === "loading"}
        actionInFlight={actionInFlight}
        hasConnections={connections.length > 0}
        onConnectXero={() => void connectProvider("xero")}
        onConnectQuickbooks={() => void connectProvider("quickbooks")}
        onSyncAll={() => void runSyncAll()}
        onRefresh={() => void refresh()}
      />

      {error ? (
        <ErrorBanner
          title={state === "error" ? "We couldn't load your integrations" : "Action failed"}
          tone="danger"
          onDismiss={() => setError(null)}
          action={
            <Button variant="secondary" size="sm" onClick={() => void refresh()}>
              Retry
            </Button>
          }
        >
          {error}
        </ErrorBanner>
      ) : null}

      {initialLoading ? (
        <div className="space-y-4">
          <Skeleton height={160} rounded="xl" />
          <Skeleton height={160} rounded="xl" />
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          {/* Organisations column */}
          <div>
            <p className="mb-3 text-sm font-semibold text-text-secondary">
              Organisations
              <span className="ml-2 text-xs font-normal text-text-muted">
                ({orgs.length})
              </span>
            </p>
            {orgs.length === 0 ? (
              <div className="surface-card p-6">
                <EmptyState
                  title="No organisations yet"
                  detail="Connect Xero or QuickBooks — each company becomes its own organisation you can invite teammates to."
                />
              </div>
            ) : (
              <div className="space-y-4">
                {orgs.map((org) => (
                  <OrgCard
                    key={org.id}
                    org={org}
                    userRole={userRole}
                    pending={pendingActionId === org.id}
                    onSync={() => void runSync(org.id)}
                    onDelete={() => void deleteConnection(org.id)}
                    onInvite={(email, role) => handleInvite(org.id, email, role)}
                    onRemoveMember={(userId) => handleRemoveMember(org.id, userId)}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Sync jobs column */}
          <SyncJobsPanel jobs={jobs} />
        </div>
      )}
    </div>
  );
}
