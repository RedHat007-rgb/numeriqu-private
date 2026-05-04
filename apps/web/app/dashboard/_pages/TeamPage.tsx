"use client";

import { useEffect, useState } from "react";
import { ApiError, type OrganizationInvite, type OrganizationMember, type OrganizationRole } from "../../../lib/api";
import { useNumeriquApi } from "../../../lib/useNumeriquApi";
import { Button } from "../../../components/ui/Button";
import { ErrorBanner } from "../../../components/ui/ErrorBanner";
import { EmptyState } from "../../../components/ui/EmptyState";
import { Field } from "../../../components/ui/Field";
import { Skeleton } from "../../../components/ui/Skeleton";
import { StatusPill } from "../../../components/ui/StatusPill";

type LoadState = "loading" | "ready" | "error";
type InviteForm = {
  email: string;
  role: OrganizationRole;
  canViewDashboard: boolean;
  canCreateDashboard: boolean;
  canShareDashboard: boolean;
};

const INITIAL_INVITE_FORM: InviteForm = {
  email: "",
  role: "USER",
  canViewDashboard: true,
  canCreateDashboard: false,
  canShareDashboard: false,
};

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function inviteTone(status: OrganizationInvite["status"]) {
  if (status === "ACCEPTED") return "success" as const;
  if (status === "PENDING") return "info" as const;
  if (status === "EXPIRED") return "warning" as const;
  return "neutral" as const;
}

export function TeamPage() {
  const { organization } = useNumeriquApi();
  const [state, setState] = useState<LoadState>("loading");
  const [members, setMembers] = useState<OrganizationMember[]>([]);
  const [invites, setInvites] = useState<OrganizationInvite[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<InviteForm>(INITIAL_INVITE_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [busyInviteId, setBusyInviteId] = useState<string | null>(null);

  async function refresh() {
    setState("loading");
    try {
      const [nextMembers, nextInvites] = await Promise.all([
        organization.members(),
        organization.invites(),
      ]);
      setMembers(nextMembers);
      setInvites(nextInvites);
      setError(null);
      setState("ready");
    } catch (caught) {
      const message =
        caught instanceof ApiError
          ? caught.toUserMessage("We couldn't load team access data.")
          : "We couldn't load team access data.";
      setError(message);
      setState("error");
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function createInvite(event: React.FormEvent) {
    event.preventDefault();
    if (!/.+@.+\..+/.test(form.email)) {
      setError("Enter a valid work email before sending the invite.");
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      await organization.createInvite(form);
      setForm(INITIAL_INVITE_FORM);
      await refresh();
    } catch (caught) {
      const message =
        caught instanceof ApiError
          ? caught.toUserMessage("We couldn't send this invite.")
          : "We couldn't send this invite.";
      setError(message);
    } finally {
      setSubmitting(false);
    }
  }

  async function resendInvite(inviteId: string) {
    setBusyInviteId(inviteId);
    setError(null);
    try {
      await organization.resendInvite(inviteId);
      await refresh();
    } catch (caught) {
      const message =
        caught instanceof ApiError
          ? caught.toUserMessage("We couldn't resend that invite.")
          : "We couldn't resend that invite.";
      setError(message);
    } finally {
      setBusyInviteId(null);
    }
  }

  async function revokeInvite(inviteId: string) {
    setBusyInviteId(inviteId);
    setError(null);
    try {
      await organization.revokeInvite(inviteId);
      await refresh();
    } catch (caught) {
      const message =
        caught instanceof ApiError
          ? caught.toUserMessage("We couldn't revoke that invite.")
          : "We couldn't revoke that invite.";
      setError(message);
    } finally {
      setBusyInviteId(null);
    }
  }

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-accent-blue">
          Team & Access
        </p>
        <h2 className="font-display text-2xl font-bold text-text-primary md:text-3xl">
          Govern workspace access with confidence
        </h2>
        <p className="text-sm text-text-muted">
          Invite members, review role posture, and keep dashboard permissions aligned.
        </p>
      </header>

      {error ? (
        <ErrorBanner title="Access update failed" tone="danger" onDismiss={() => setError(null)}>
          {error}
        </ErrorBanner>
      ) : null}

      <section className="surface-card p-6">
        <h3 className="text-lg font-semibold text-text-primary">Invite teammate</h3>
        <form className="mt-4 grid gap-4 md:grid-cols-2" onSubmit={(event) => void createInvite(event)}>
          <div className="md:col-span-2">
            <Field
              label="Work email"
              type="email"
              value={form.email}
              onChange={(event) => setForm((prev) => ({ ...prev, email: event.target.value }))}
              placeholder="finance@company.com"
            />
          </div>

          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-text-secondary">Role</label>
            <select
              value={form.role}
              onChange={(event) => setForm((prev) => ({ ...prev, role: event.target.value as OrganizationRole }))}
              className="w-full rounded-xl border border-default bg-surface-card/70 px-4 py-2.5 text-text-primary outline-none focus:border-accent-blue/60"
            >
              <option value="USER">User</option>
              <option value="ADMIN">Admin</option>
            </select>
          </div>

          <div className="flex flex-wrap items-center gap-4 rounded-xl border border-default bg-bg-elevated/40 px-4 py-3 text-sm text-text-secondary">
            <label className="inline-flex items-center gap-2">
              <input
                type="checkbox"
                checked={form.canViewDashboard}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, canViewDashboard: event.target.checked }))
                }
              />
              View dashboards
            </label>
            <label className="inline-flex items-center gap-2">
              <input
                type="checkbox"
                checked={form.canCreateDashboard}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, canCreateDashboard: event.target.checked }))
                }
              />
              Create dashboards
            </label>
            <label className="inline-flex items-center gap-2">
              <input
                type="checkbox"
                checked={form.canShareDashboard}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, canShareDashboard: event.target.checked }))
                }
              />
              Share dashboards
            </label>
          </div>

          <div className="md:col-span-2">
            <Button type="submit" loading={submitting}>
              {submitting ? "Sending invite..." : "Send invite"}
            </Button>
          </div>
        </form>
      </section>

      <section className="grid gap-6 xl:grid-cols-2">
        <div className="surface-card p-6">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold text-text-primary">Members</h3>
            <StatusPill tone="neutral" withDot={false}>
              {members.length} active
            </StatusPill>
          </div>
          <div className="mt-4 space-y-3">
            {state === "loading" ? (
              Array.from({ length: 4 }).map((_, idx) => <Skeleton key={idx} height={78} rounded="xl" />)
            ) : members.length === 0 ? (
              <EmptyState title="No members yet" detail="Invited teammates appear here after accepting." />
            ) : (
              members.map((member) => (
                <div key={member.id} className="rounded-xl border border-default bg-bg-elevated/40 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-medium text-text-primary">
                        {member.user.fullName || member.user.email}
                      </p>
                      <p className="truncate text-xs text-text-muted">{member.user.email}</p>
                    </div>
                    <StatusPill tone={member.role === "ADMIN" ? "info" : "neutral"}>{member.role}</StatusPill>
                  </div>
                  <p className="mt-2 text-xs text-text-muted">
                    Joined {formatDate(member.joinedAt)} · Grants:{" "}
                    {member.permissions.grants.length > 0 ? member.permissions.grants.join(", ") : "none"}
                  </p>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="surface-card p-6">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold text-text-primary">Invitations</h3>
            <StatusPill tone="neutral" withDot={false}>
              {invites.length} total
            </StatusPill>
          </div>
          <div className="mt-4 space-y-3">
            {state === "loading" ? (
              Array.from({ length: 4 }).map((_, idx) => <Skeleton key={idx} height={88} rounded="xl" />)
            ) : invites.length === 0 ? (
              <EmptyState title="No pending invites" detail="New invites and status history show up here." />
            ) : (
              invites.map((invite) => (
                <div key={invite.id} className="rounded-xl border border-default bg-bg-elevated/40 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-medium text-text-primary">{invite.email}</p>
                      <p className="text-xs text-text-muted">
                        {invite.role} · expires {formatDate(invite.expiresAt)}
                      </p>
                    </div>
                    <StatusPill tone={inviteTone(invite.status)}>{invite.status.toLowerCase()}</StatusPill>
                  </div>
                  {invite.status === "PENDING" ? (
                    <div className="mt-3 flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        loading={busyInviteId === invite.id}
                        onClick={() => void resendInvite(invite.id)}
                      >
                        Resend
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        loading={busyInviteId === invite.id}
                        onClick={() => void revokeInvite(invite.id)}
                      >
                        Revoke
                      </Button>
                    </div>
                  ) : null}
                </div>
              ))
            )}
          </div>
        </div>
      </section>

      {state === "error" && members.length === 0 && invites.length === 0 ? (
        <EmptyState
          title="We couldn't load team data"
          detail="Retry once your connection is stable."
          action={
            <Button variant="secondary" onClick={() => void refresh()}>
              Retry
            </Button>
          }
        />
      ) : null}
    </div>
  );
}
