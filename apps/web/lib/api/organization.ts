import { createRequester, type TokenProvider } from "./base";
import type {
  OrganizationContextResponse,
  OrganizationInvite,
  OrganizationMember,
  OrganizationRole,
  PermissionCode,
  WorkspaceSummary,
} from "./types";

export class OrganizationApi {
  private readonly request: ReturnType<typeof createRequester>;

  constructor(getToken: TokenProvider) {
    this.request = createRequester(getToken);
  }

  current() {
    return this.request<OrganizationContextResponse>("/organizations/current");
  }

  listWorkspaces() {
    return this.request<WorkspaceSummary[]>("/organizations");
  }

  members() {
    return this.request<OrganizationMember[]>("/organizations/members");
  }

  invites() {
    return this.request<OrganizationInvite[]>("/organizations/invites");
  }

  createInvite(payload: {
    email: string;
    role: OrganizationRole;
    canViewDashboard?: boolean;
    canCreateDashboard?: boolean;
    canShareDashboard?: boolean;
  }) {
    return this.request<{ id: string; email: string; status: string; expiresAt: string }>(
      "/organizations/invites",
      { method: "POST", body: JSON.stringify(payload) },
    );
  }

  resendInvite(id: string) {
    return this.request<{ success: true }>(`/organizations/invites/${id}/resend`, {
      method: "POST",
    });
  }

  revokeInvite(id: string) {
    return this.request<{ success: true }>(`/organizations/invites/${id}`, {
      method: "DELETE",
    });
  }

  acceptInvite(token: string) {
    return this.request<{ organizationId: string; organizationName: string }>(
      "/organizations/invites/accept",
      { method: "POST", body: JSON.stringify({ token }) },
    );
  }

  grantPermission(membershipId: string, permission: PermissionCode) {
    return this.request<{ success: true }>(`/organizations/members/${membershipId}/permissions`, {
      method: "PATCH",
      body: JSON.stringify({ permission }),
    });
  }

  revokePermission(membershipId: string, permission: PermissionCode) {
    return this.request<{ success: true }>(
      `/organizations/members/${membershipId}/permissions/${permission}`,
      { method: "DELETE" },
    );
  }
}
