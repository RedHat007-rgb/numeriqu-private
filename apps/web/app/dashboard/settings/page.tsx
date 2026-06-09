"use client";

import { useEffect, useState, useCallback, useId, useRef } from "react";
import {
  ApiError,
  type OrganizationContextResponse,
  type OrganizationMember,
  type OrganizationInvite,
  type Connection,
} from "../../../lib/api";
import { useNumeriquApi } from "../../../lib/useNumeriquApi";
import { Button } from "../../../components/ui/Button";
import { ErrorBanner } from "../../../components/ui/ErrorBanner";
import { Skeleton } from "../../../components/ui/Skeleton";
import { cn } from "../../../components/ui/cn";
import {
  DEFAULT_DASHBOARD_PREFERENCES,
  type DashboardPreferences,
  loadDashboardPreferences,
  saveDashboardPreferences,
} from "../_hooks/dashboardPreferences";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(value?: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, {
    month: "short", day: "numeric", year: "numeric",
  }).format(new Date(value));
}

function formatDateTime(value?: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, {
    month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit",
  }).format(new Date(value));
}

function avatarInitials(name?: string | null, email?: string) {
  const src = name ?? email ?? "?";
  const parts = src.split(/[\s@.]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  return src.slice(0, 2).toUpperCase();
}

function avatarColor(seed: string) {
  const colors = [
    "bg-violet-500", "bg-blue-500", "bg-cyan-500", "bg-emerald-500",
    "bg-amber-500", "bg-rose-500", "bg-indigo-500", "bg-teal-500",
  ];
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = seed.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length]!;
}

function CopyButton({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const resetTimer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimer.current) window.clearTimeout(resetTimer.current);
    };
  }, []);

  function copy() {
    setFailed(false);

    const finish = () => {
      setCopied(true);
      if (resetTimer.current) window.clearTimeout(resetTimer.current);
      resetTimer.current = window.setTimeout(() => {
        setCopied(false);
        resetTimer.current = null;
      }, 1800);
    };

    const fallbackCopy = () => {
      const textarea = document.createElement("textarea");
      textarea.value = value;
      textarea.setAttribute("readonly", "true");
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      textarea.style.pointerEvents = "none";
      document.body.appendChild(textarea);
      textarea.select();
      const success = document.execCommand("copy");
      document.body.removeChild(textarea);
      if (!success) throw new Error("Clipboard copy failed");
    };

    void (async () => {
      try {
        if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(value);
        else fallbackCopy();
        finish();
      } catch {
        setCopied(false);
        setFailed(true);
      }
    })();
  }
  return (
    <button
      type="button"
      onClick={copy}
      aria-live="polite"
      aria-label={failed ? "Copy failed, try again" : copied ? "Copied to clipboard" : label ? `Copy ${label.toLowerCase()}` : "Copy to clipboard"}
      className={cn(
        "ml-2 inline-flex items-center rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] transition-all",
        copied
          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
          : failed
            ? "border-rose-500/30 bg-rose-500/10 text-rose-400"
            : "border-default bg-bg-surface text-text-muted hover:border-accent-blue/30 hover:bg-bg-elevated/70 hover:text-text-primary",
      )}
    >
      {failed ? "Retry" : copied ? "Copied" : (label ?? "Copy")}
    </button>
  );
}

function Badge({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "success" | "warning" | "danger" | "info" | "neutral" | "violet" }) {
  const styles: Record<string, string> = {
    success: "bg-emerald-500/15 text-emerald-400 border-emerald-500/25",
    warning: "bg-amber-500/15 text-amber-400 border-amber-500/25",
    danger: "bg-rose-500/15 text-rose-400 border-rose-500/25",
    info: "bg-blue-500/15 text-blue-400 border-blue-500/25",
    neutral: "bg-bg-elevated text-text-muted border-default",
    violet: "bg-violet-500/15 text-violet-400 border-violet-500/25",
  };
  return (
    <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider", styles[tone])}>
      {children}
    </span>
  );
}

function Field({ label, value, mono = false, copiable = false }: {
  label: string; value?: string | null; mono?: boolean; copiable?: boolean;
}) {
  return (
    <div className="rounded-xl border border-default bg-bg-elevated/40 px-4 py-3">
      <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-text-muted">{label}</p>
      <div className="mt-1 flex items-center">
        <span className={cn("text-sm font-medium text-text-primary", mono && "font-mono break-all text-xs")}>
          {value ?? "—"}
        </span>
        {copiable && value ? <CopyButton value={value} /> : null}
      </div>
    </div>
  );
}

function SectionHeader({ title, description }: { title: string; description?: string }) {
  return (
    <div className="mb-5 border-b border-default pb-4">
      <h3 className="text-base font-semibold text-text-primary">{title}</h3>
      {description ? <p className="mt-1 text-sm text-text-muted">{description}</p> : null}
    </div>
  );
}

// ─── Tab definitions ──────────────────────────────────────────────────────────

type Tab = "workspace" | "profile" | "members" | "security" | "preferences" | "danger";

const TABS: { id: Tab; label: string; description: string }[] = [
  { id: "workspace",   label: "Workspace",   description: "Org identity and plan" },
  { id: "profile",     label: "Profile",     description: "Your identity and session" },
  { id: "members",     label: "Members",     description: "Team and permissions" },
  { id: "security",    label: "Security",    description: "Access and sessions" },
  { id: "preferences", label: "Preferences", description: "Display and fiscal settings" },
  { id: "danger",      label: "Danger zone", description: "Destructive actions" },
];

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const { currentUser, organization, integrations, refreshSession, signOut } = useNumeriquApi();
  const [tab, setTab] = useState<Tab>("workspace");
  const [context, setContext] = useState<OrganizationContextResponse | null>(null);
  const [members, setMembers] = useState<OrganizationMember[]>([]);
  const [invites, setInvites] = useState<OrganizationInvite[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [loading, setLoading] = useState(true);
  const [membersLoading, setMembersLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<DashboardPreferences>(DEFAULT_DASHBOARD_PREFERENCES);

  useEffect(() => { setPrefs(loadDashboardPreferences()); }, []);

  const loadWorkspace = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [ctx, conns] = await Promise.all([
        organization.current(),
        integrations.connections().catch(() => [] as Connection[]),
      ]);
      setContext(ctx);
      setConnections(conns);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.toUserMessage("Couldn't load workspace.") : "Couldn't load workspace.");
    } finally {
      setLoading(false);
    }
  }, [organization, integrations]);

  const loadMembers = useCallback(async () => {
    setMembersLoading(true);
    try {
      const [m, i] = await Promise.all([
        organization.members(),
        organization.invites(),
      ]);
      setMembers(m);
      setInvites(i);
    } catch { /* non-fatal */ }
    finally { setMembersLoading(false); }
  }, [organization]);

  useEffect(() => { void loadWorkspace(); }, [loadWorkspace]);
  useEffect(() => { if (tab === "members") void loadMembers(); }, [tab, loadMembers]);

  function updatePref<K extends keyof DashboardPreferences>(key: K, value: DashboardPreferences[K]) {
    const next = { ...prefs, [key]: value };
    setPrefs(next);
    saveDashboardPreferences(next);
    flash("Preference saved.");
  }

  function flash(msg: string) {
    setActionMsg(msg);
    setTimeout(() => setActionMsg(null), 3000);
  }

  async function handleResendInvite(id: string) {
    try {
      await organization.resendInvite(id);
      flash("Invite resent.");
    } catch { flash("Failed to resend invite."); }
  }

  async function handleRevokeInvite(id: string) {
    try {
      await organization.revokeInvite(id);
      setInvites((prev) => prev.filter((i) => i.id !== id));
      flash("Invite revoked.");
    } catch { flash("Failed to revoke invite."); }
  }

  const user = currentUser?.user;
  const isAdmin = context?.membership.role === "ADMIN";

  return (
    <div className="space-y-6">
      {/* Header */}
      <header className="space-y-1">
        <p className="text-[10px] font-bold uppercase tracking-[0.24em] text-accent-blue">Settings</p>
        <h2 className="font-display text-2xl font-bold text-text-primary md:text-3xl">Workspace settings</h2>
        <p className="text-sm text-text-muted">Manage your workspace, team, preferences, and account security.</p>
      </header>

      {error ? (
        <ErrorBanner title="Error" tone="danger" onDismiss={() => setError(null)}>{error}</ErrorBanner>
      ) : null}

      {actionMsg ? (
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-2.5 text-sm font-medium text-emerald-400">
          {actionMsg}
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[220px_1fr]">
        {/* Tab nav */}
        <aside>
          <nav className="space-y-1" role="tablist" aria-label="Settings sections">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                role="tab"
                aria-selected={tab === t.id}
                className={cn(
                  "w-full rounded-xl border px-3.5 py-3 text-left text-sm transition-all",
                  tab === t.id
                    ? "border-accent-blue/40 bg-accent-blue/10 text-text-primary shadow-sm"
                    : "border-default bg-bg-surface text-text-secondary hover:border-strong hover:bg-bg-elevated hover:text-text-primary",
                  t.id === "danger" && tab !== "danger" && "border-rose-500/20 text-rose-400 hover:bg-rose-500/5",
                  t.id === "danger" && tab === "danger" && "border-rose-500/50 bg-rose-500/10 text-rose-300",
                )}
              >
                <span className="font-medium">{t.label}</span>
                <p className="mt-0.5 text-[11px] text-text-muted">{t.description}</p>
              </button>
            ))}
          </nav>
        </aside>

        {/* Tab content */}
        <main className="min-w-0">
          {tab === "workspace" && (
            <WorkspaceTab context={context} connections={connections} loading={loading} onReload={() => void loadWorkspace()} />
          )}
          {tab === "profile" && (
            <ProfileTab user={user} context={context} onRefreshSession={() => void refreshSession()} />
          )}
          {tab === "members" && (
            <MembersTab
              members={members}
              invites={invites}
              loading={membersLoading}
              isAdmin={isAdmin}
              onResend={handleResendInvite}
              onRevoke={handleRevokeInvite}
              context={context}
            />
          )}
          {tab === "security" && (
            <SecurityTab user={user} context={context} onRefreshSession={() => void refreshSession()} />
          )}
          {tab === "preferences" && (
            <PreferencesTab prefs={prefs} onUpdate={updatePref} />
          )}
          {tab === "danger" && (
            <DangerTab onSignOut={() => void signOut()} />
          )}
        </main>
      </div>
    </div>
  );
}

// ─── Workspace Tab ────────────────────────────────────────────────────────────

function WorkspaceTab({
  context, connections, loading, onReload,
}: {
  context: OrganizationContextResponse | null;
  connections: Connection[];
  loading: boolean;
  onReload: () => void;
}) {
  return (
    <div className="space-y-6">
      <div className="surface-card p-6">
        <div className="flex items-center justify-between">
          <SectionHeader title="Organization" description="Your workspace identity and plan details." />
          <Button variant="secondary" size="sm" onClick={onReload} loading={loading}>Refresh</Button>
        </div>
        {loading ? (
          <div className="space-y-3"><Skeleton height={60} rounded="xl" /><Skeleton height={60} rounded="xl" /><Skeleton height={60} rounded="xl" /></div>
        ) : context ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Organization name" value={context.organization.name} />
            <Field label="Organization ID" value={context.organization.id} mono copiable />
            <Field label="Account type" value={context.organization.accountType ?? "ORGANIZATION"} />
            <Field label="Plan" value="Professional" />
            <Field label="Created" value={formatDate(context.organization.createdAt)} />
            <Field label="Last updated" value={formatDateTime(context.organization.updatedAt)} />
          </div>
        ) : (
          <p className="text-sm text-text-muted">No organization context available.</p>
        )}
      </div>

      <div className="surface-card p-6">
        <SectionHeader title="Connected integrations" description="ERP systems currently linked to this workspace." />
        {connections.length === 0 ? (
          <div className="rounded-xl border border-default bg-bg-elevated/30 px-4 py-8 text-center">
            <p className="text-sm text-text-muted">No integrations connected.</p>
            <a href="/dashboard/integrations" className="mt-2 inline-block text-sm font-medium text-accent-blue hover:underline">
              Connect your first integration →
            </a>
          </div>
        ) : (
          <div className="space-y-2">
            {connections.map((conn) => (
              <div key={conn.id} className="flex items-center justify-between rounded-xl border border-default bg-bg-elevated/40 px-4 py-3">
                <div>
                  <p className="text-sm font-semibold text-text-primary">{conn.orgName}</p>
                  <p className="mt-0.5 text-xs text-text-muted">
                    {conn.provider.toUpperCase()} · Last synced {formatDateTime(conn.updatedAt)}
                  </p>
                </div>
                <Badge tone={conn.isActive ? "success" : "warning"}>
                  {conn.isActive ? "Active" : "Inactive"}
                </Badge>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Profile Tab ──────────────────────────────────────────────────────────────

function ProfileTab({
  user, context, onRefreshSession,
}: {
  user?: { id: string; email?: string } | null;
  context: OrganizationContextResponse | null;
  onRefreshSession: () => void;
}) {
  const email = user?.email ?? "";
  const initials = avatarInitials(null, email);
  const color = avatarColor(email);

  return (
    <div className="space-y-6">
      <div className="surface-card p-6">
        <SectionHeader title="Your profile" description="Your identity within this workspace." />
        <div className="mb-5 flex items-center gap-4">
          <div className={cn("flex h-14 w-14 items-center justify-center rounded-full text-lg font-bold text-white", color)}>
            {initials}
          </div>
          <div>
            <p className="font-semibold text-text-primary">{email || "—"}</p>
            <p className="text-xs text-text-muted">
              {context?.membership.role === "ADMIN" ? "Workspace Admin" : "Member"} ·{" "}
              {context?.organization.name ?? "—"}
            </p>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Email address" value={user?.email} copiable />
          <Field label="User ID" value={user?.id} mono copiable />
          <Field label="Role" value={context?.membership.role ?? "—"} />
          <Field label="Account type" value="ORGANIZATION" />
        </div>
      </div>

      <div className="surface-card p-6">
        <SectionHeader title="Permissions" description="What you're authorized to do in this workspace." />
        <div className="grid gap-3 sm:grid-cols-3">
          {[
            { label: "View dashboards", granted: context?.membership.canViewDashboard },
            { label: "Create dashboards", granted: context?.membership.canCreateDashboard },
            { label: "Share dashboards", granted: context?.membership.canShareDashboard },
          ].map(({ label, granted }) => (
            <div key={label} className="rounded-xl border border-default bg-bg-elevated/40 px-4 py-3">
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-text-muted">{label}</p>
              <div className="mt-2">
                <Badge tone={granted ? "success" : "danger"}>{granted ? "Granted" : "Denied"}</Badge>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="surface-card p-6">
        <SectionHeader title="Session" description="Your current authentication session." />
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm text-text-primary">Supabase Auth session · Active now</p>
            <p className="mt-0.5 text-xs text-text-muted">
              Authenticated as {user?.email ?? "—"} · Session auto-refreshes every 60 minutes.
            </p>
          </div>
          <Button variant="secondary" size="sm" onClick={onRefreshSession}>
            Refresh session
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── Members Tab ──────────────────────────────────────────────────────────────

function MembersTab({
  members, invites, loading, isAdmin, onResend, onRevoke, context,
}: {
  members: OrganizationMember[];
  invites: OrganizationInvite[];
  loading: boolean;
  isAdmin: boolean;
  onResend: (id: string) => Promise<void>;
  onRevoke: (id: string) => Promise<void>;
  context: OrganizationContextResponse | null;
}) {
  const pendingInvites = invites.filter((i) => i.status === "PENDING");

  return (
    <div className="space-y-6">
      <div className="surface-card p-6">
        <div className="flex items-center justify-between">
          <SectionHeader
            title={`Team members (${members.length})`}
            description="Everyone with access to this workspace."
          />
          {isAdmin && (
            <a href="/dashboard/team">
              <Button variant="secondary" size="sm">Manage team →</Button>
            </a>
          )}
        </div>

        {loading ? (
          <div className="space-y-3">
            <Skeleton height={64} rounded="xl" />
            <Skeleton height={64} rounded="xl" />
          </div>
        ) : members.length === 0 ? (
          <p className="text-sm text-text-muted">No members found.</p>
        ) : (
          <div className="space-y-2">
            {members.map((m) => {
              const email = m.user.email;
              const initials = avatarInitials(m.user.fullName, email);
              const color = avatarColor(email);
              return (
                <div key={m.id} className="flex items-center gap-3 rounded-xl border border-default bg-bg-elevated/40 px-4 py-3">
                  <div className={cn("flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-xs font-bold text-white", color)}>
                    {initials}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-semibold text-text-primary">
                        {m.user.fullName ?? email}
                      </p>
                      <Badge tone={m.role === "ADMIN" ? "violet" : "neutral"}>{m.role}</Badge>
                    </div>
                    <p className="mt-0.5 text-xs text-text-muted">
                      {email} · Joined {formatDate(m.joinedAt)}
                    </p>
                  </div>
                  <div className="hidden gap-1.5 sm:flex">
                    {m.permissions.canViewDashboard && <Badge tone="info">View</Badge>}
                    {m.permissions.canCreateDashboard && <Badge tone="success">Create</Badge>}
                    {m.permissions.canShareDashboard && <Badge tone="violet">Share</Badge>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {pendingInvites.length > 0 && (
        <div className="surface-card p-6">
          <SectionHeader
            title={`Pending invites (${pendingInvites.length})`}
            description="Invitations awaiting acceptance."
          />
          <div className="space-y-2">
            {pendingInvites.map((invite) => (
              <div key={invite.id} className="flex items-center justify-between rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-3">
                <div>
                  <p className="text-sm font-semibold text-text-primary">{invite.email}</p>
                  <p className="mt-0.5 text-xs text-text-muted">
                    Invited as <span className="font-medium">{invite.role}</span> · Expires {formatDate(invite.expiresAt)}
                  </p>
                </div>
                {isAdmin && (
                  <div className="flex gap-2">
                    <Button variant="secondary" size="sm" onClick={() => void onResend(invite.id)}>Resend</Button>
                    <Button variant="secondary" size="sm" onClick={() => void onRevoke(invite.id)}>
                      <span className="text-rose-400">Revoke</span>
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {context && (
        <div className="surface-card p-6">
          <SectionHeader title="Your access summary" description="A snapshot of what you can do." />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Your role" value={context.membership.role} />
            <Field label="Membership ID" value={context.membership.id} mono copiable />
            <Field label="Org name" value={context.organization.name} />
            <Field label="Org ID" value={context.organization.id} mono copiable />
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Security Tab ─────────────────────────────────────────────────────────────

function SecurityTab({
  user, context, onRefreshSession,
}: {
  user?: { id: string; email?: string } | null;
  context: OrganizationContextResponse | null;
  onRefreshSession: () => void;
}) {
  const [loginTime] = useState(() => {
    if (typeof window === "undefined") return new Date().toISOString();
    return sessionStorage.getItem("nq_login_time") ?? new Date().toISOString();
  });

  return (
    <div className="space-y-6">
      <div className="surface-card p-6">
        <SectionHeader title="Active session" description="Details about your current authentication session." />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Authenticated as" value={user?.email} />
          <Field label="Session started" value={formatDateTime(loginTime)} />
          <Field label="Auth provider" value="Supabase Auth (JWT)" />
          <Field label="Session type" value="Bearer token · Auto-refresh" />
        </div>
        <div className="mt-4 flex gap-3">
          <Button variant="secondary" size="sm" onClick={onRefreshSession}>Force refresh token</Button>
        </div>
      </div>

      <div className="surface-card p-6">
        <SectionHeader title="Access control" description="Your role and permission set within this organization." />
        <div className="space-y-3">
          <div className="rounded-xl border border-default bg-bg-elevated/40 px-4 py-3">
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-text-muted">Role</p>
            <div className="mt-1.5 flex items-center gap-2">
              <Badge tone={context?.membership.role === "ADMIN" ? "violet" : "neutral"}>
                {context?.membership.role ?? "—"}
              </Badge>
              <span className="text-xs text-text-muted">
                {context?.membership.role === "ADMIN"
                  ? "Full administrative access to this workspace"
                  : "Standard member — limited to granted permissions"}
              </span>
            </div>
          </div>

          <div className="rounded-xl border border-default bg-bg-elevated/40 px-4 py-3">
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-text-muted">Data isolation</p>
            <p className="mt-1 text-sm text-text-primary">
              Tenant isolation is enforced — every query and dashboard is scoped to your workspace.
            </p>
          </div>

          <div className="rounded-xl border border-default bg-bg-elevated/40 px-4 py-3">
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-text-muted">Connected providers</p>
            <p className="mt-1 text-sm text-text-primary">
              OAuth tokens are encrypted at rest. Refresh happens server-side — credentials never touch the browser.
            </p>
          </div>
        </div>
      </div>

      <div className="surface-card p-6">
        <SectionHeader title="Security practices" description="How NumeriQ protects your financial data." />
        <div className="grid gap-3 sm:grid-cols-2">
          {[
            { label: "Encryption at rest", status: "AES-256 for tokens", ok: true },
            { label: "Transport security", status: "TLS 1.3 enforced", ok: true },
            { label: "Tenant isolation", status: "Row-level + query-level", ok: true },
            { label: "Auth provider", status: "Supabase (JWT RS256)", ok: true },
            { label: "Two-factor auth", status: "Via Supabase Auth", ok: true },
            { label: "Session expiry", status: "60 min auto-refresh", ok: true },
          ].map(({ label, status, ok }) => (
            <div key={label} className="flex items-start gap-3 rounded-xl border border-default bg-bg-elevated/40 px-4 py-3">
              <span className={cn("mt-0.5 text-sm", ok ? "text-emerald-400" : "text-amber-400")}>
                {ok ? "✓" : "⚠"}
              </span>
              <div>
                <p className="text-sm font-semibold text-text-primary">{label}</p>
                <p className="text-xs text-text-muted">{status}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Preferences Tab ──────────────────────────────────────────────────────────

function Toggle({ checked, onChange, label, description }: {
  checked: boolean; onChange: (v: boolean) => void; label: string; description?: string;
}) {
  const id = useId();
  return (
    <div className="flex items-center justify-between rounded-xl border border-default bg-bg-elevated/40 px-4 py-3">
      <div>
        <p id={`${id}-label`} className="text-sm font-semibold text-text-primary">{label}</p>
        {description ? <p id={`${id}-description`} className="mt-0.5 text-xs text-text-muted">{description}</p> : null}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={`${id}-label`}
        aria-describedby={description ? `${id}-description` : undefined}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200",
          checked ? "bg-accent-blue" : "bg-bg-base border border-strong",
        )}
      >
        <span className={cn(
          "pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200",
          checked ? "translate-x-4" : "translate-x-0",
        )} />
      </button>
    </div>
  );
}

function Select({ label, value, options, onChange, description }: {
  label: string; value: string; options: string[]; onChange: (v: string) => void; description?: string;
}) {
  return (
    <div className="rounded-xl border border-default bg-bg-elevated/40 px-4 py-3">
      <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-text-muted">{label}</p>
      {description ? <p className="mb-2 mt-0.5 text-xs text-text-muted">{description}</p> : null}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-lg border border-strong bg-bg-base px-3 py-1.5 text-sm text-text-primary outline-none focus:border-accent-blue"
      >
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  );
}

function PreferencesTab({ prefs, onUpdate }: {
  prefs: DashboardPreferences; onUpdate: <K extends keyof DashboardPreferences>(key: K, value: DashboardPreferences[K]) => void;
}) {
  return (
    <div className="space-y-6">
      <div className="surface-card p-6">
        <SectionHeader title="Financial settings" description="Control how your financial data is displayed across NumeriQ." />
        <div className="grid gap-3 sm:grid-cols-2">
          <Select
            label="Fiscal year start"
            value={prefs.fiscalYearStart}
            options={["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]}
            onChange={(v) => onUpdate("fiscalYearStart", v)}
            description="Affects YTD calculations and fiscal period labels."
          />
          <Select
            label="Default currency display"
            value={prefs.currencyDisplay}
            options={["USD", "EUR", "GBP", "AUD", "NZD", "CAD", "SGD", "JPY", "INR", "CHF"]}
            onChange={(v) => onUpdate("currencyDisplay", v)}
            description="Used when multi-currency data is not available."
          />
          <Select
            label="Date format"
            value={prefs.dateFormat}
            options={["MMM D, YYYY", "DD/MM/YYYY", "MM/DD/YYYY", "YYYY-MM-DD"]}
            onChange={(v) => onUpdate("dateFormat", v)}
            description="How dates appear across charts and reports."
          />
          <Select
            label="Timezone"
            value={prefs.timezone}
            options={["UTC", "America/New_York", "America/Chicago", "America/Los_Angeles", "Europe/London", "Europe/Paris", "Asia/Singapore", "Asia/Tokyo", "Australia/Sydney", prefs.timezone].filter((v, i, a) => a.indexOf(v) === i)}
            onChange={(v) => onUpdate("timezone", v)}
            description="Used for scheduled reports and time-based charts."
          />
        </div>
      </div>

      <div className="surface-card p-6">
        <SectionHeader title="Notifications" description="Control when NumeriQ sends you alerts. (Email delivery via backend — coming soon.)" />
        <div className="space-y-2">
          <Toggle
            checked={prefs.notifySyncFailures}
            onChange={(v) => onUpdate("notifySyncFailures", v)}
            label="Sync failure alerts"
            description="Get notified when an ERP sync fails or times out."
          />
          <Toggle
            checked={prefs.notifyOverdueInvoices}
            onChange={(v) => onUpdate("notifyOverdueInvoices", v)}
            label="Overdue invoice alerts"
            description="Alert when overdue receivables exceed your threshold."
          />
          <Toggle
            checked={prefs.notifyRevenueMilestones}
            onChange={(v) => onUpdate("notifyRevenueMilestones", v)}
            label="Revenue milestone notifications"
            description="Celebrate (and track) MRR, ARR and invoice count milestones."
          />
          <Toggle
            checked={prefs.weeklyDigest}
            onChange={(v) => onUpdate("weeklyDigest", v)}
            label="Weekly financial digest"
            description="A Monday morning summary of revenue, burn, and overdue AR."
          />
        </div>
        <p className="mt-3 text-xs text-text-muted">
          Preferences are saved locally. Email delivery backend is in progress.
        </p>
      </div>
    </div>
  );
}

// ─── Danger Zone Tab ──────────────────────────────────────────────────────────

function DangerTab({ onSignOut }: { onSignOut: () => void }) {
  const [confirmSignOut, setConfirmSignOut] = useState(false);

  return (
    <div className="space-y-6">
      <div className="surface-card border-rose-500/25 p-6">
        <SectionHeader
          title="Danger zone"
          description="These actions are immediate or hard to reverse. Proceed with caution."
        />

        <div className="space-y-4">
          {/* Sign out all devices */}
          <div className="flex flex-col gap-3 rounded-xl border border-rose-500/20 bg-rose-500/5 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="font-semibold text-rose-300">Sign out of all sessions</p>
              <p className="mt-0.5 text-xs text-text-muted">
                Invalidates your current session and signs you out immediately.
              </p>
            </div>
            {confirmSignOut ? (
              <div className="flex gap-2">
                <Button size="sm" onClick={onSignOut} className="bg-rose-600 hover:bg-rose-500 text-white">
                  Confirm sign out
                </Button>
                <Button variant="secondary" size="sm" onClick={() => setConfirmSignOut(false)}>Cancel</Button>
              </div>
            ) : (
              <Button variant="secondary" size="sm" onClick={() => setConfirmSignOut(true)}>
                <span className="text-rose-400">Sign out</span>
              </Button>
            )}
          </div>

          {/* Data export */}
          <div className="flex flex-col gap-3 rounded-xl border border-default bg-bg-elevated/40 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="font-semibold text-text-primary">Export workspace data</p>
              <p className="mt-0.5 text-xs text-text-muted">
                Download your invoices, expenses, and analytics data as CSV.
              </p>
            </div>
            <Badge tone="neutral">Coming soon</Badge>
          </div>

          {/* Delete org */}
          <div className="flex flex-col gap-3 rounded-xl border border-rose-500/20 bg-rose-500/5 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="font-semibold text-rose-300">Delete organization</p>
              <p className="mt-0.5 text-xs text-text-muted">
                Permanently deletes your organization, all members, integrations, and data. This cannot be undone.
              </p>
            </div>
            <Badge tone="danger">Admin only</Badge>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-default bg-bg-elevated/20 px-5 py-4">
        <p className="text-xs text-text-muted">
          Need to transfer ownership, merge organizations, or request a GDPR data deletion?{" "}
          <span className="text-accent-blue">Contact support</span> — these operations require identity verification.
        </p>
      </div>
    </div>
  );
}
