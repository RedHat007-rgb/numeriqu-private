import { createRequester, type TokenProvider } from "./base";
import type {
  Connection,
  SyncJob,
  Organization,
  OrgDetail,
  InviteDetails,
} from "./types";

export class IntegrationsApi {
  private readonly request: ReturnType<typeof createRequester>;

  constructor(getToken: TokenProvider) {
    this.request = createRequester(getToken);
  }

  // ── Connections (raw integration list) ────────────────────────────────────

  connections() {
    return this.request<Connection[]>("/integrations/connections");
  }

  syncJobs() {
    return this.request<SyncJob[]>("/integrations/connections/jobs");
  }

  syncConnection(id: string) {
    return this.request<{ status: string; message: string }>(`/integrations/connections/${id}/sync`, {
      method: "POST",
    });
  }

  syncAllConnections() {
    return this.request<{ status: string; message: string }>("/integrations/connections/sync-all", {
      method: "POST",
    });
  }

  deleteConnection(id: string) {
    return this.request<{ status: string; message: string }>(`/integrations/connections/${id}`, {
      method: "DELETE",
    });
  }

  connectProvider(provider: "xero" | "quickbooks", startDate?: string) {
    return this.request<{ url: string }>(`/auth/${provider}/connect`, {
      method: "POST",
      body: JSON.stringify(startDate ? { startDate } : {}),
    });
  }

  // ── Organisations (each connection = one org) ──────────────────────────────

  /** List all organizations for the current tenant. */
  listOrganizations() {
    return this.request<Organization[]>("/org/organizations");
  }

  /** Get one organization with full member list and pending invites. */
  getOrganization(connectionId: string) {
    return this.request<OrgDetail>(`/org/organizations/${connectionId}`);
  }

  /** Invite a user by email to a specific organization. */
  inviteToOrganization(connectionId: string, email: string, role: "admin" | "member" = "member") {
    return this.request<{ inviteId: string; token: string }>(
      `/org/organizations/${connectionId}/invite`,
      {
        method: "POST",
        body: JSON.stringify({ email, role }),
      },
    );
  }

  /** Remove a member from a specific organization. */
  removeMember(connectionId: string, userId: string) {
    return this.request<{ status: string }>(
      `/org/organizations/${connectionId}/members/${userId}`,
      { method: "DELETE" },
    );
  }

  // ── Invite accept flow (called without auth on the GET, with auth on POST) ──

  /** Accept an invite. Must be authenticated as the invited email. */
  acceptInvite(token: string, connectionId: string) {
    return this.request<{ success: boolean; orgName: string }>(
      `/org/invite/${token}/accept?org=${connectionId}`,
      { method: "POST" },
    );
  }
}

// Public function — no auth token required.
export async function getInviteDetails(token: string): Promise<InviteDetails> {
  const baseUrl =
    process.env.NEXT_PUBLIC_API_BASE_URL?.trim() ||
    process.env.NEXT_PUBLIC_API_URL?.trim() ||
    (typeof window !== "undefined"
      ? `${window.location.origin}/api/internal`
      : "http://127.0.0.1:3000");

  const res = await fetch(`${baseUrl}/org/invite/${token}`, { cache: "no-store" });
  if (!res.ok) throw new Error("Invite not found.");
  return res.json() as Promise<InviteDetails>;
}
