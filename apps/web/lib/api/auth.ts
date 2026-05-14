import { createRequester, type TokenProvider } from "./base";
import type { CurrentUserResponse } from "./types";

export class AuthApi {
  private readonly request: ReturnType<typeof createRequester>;

  constructor(getToken: TokenProvider) {
    this.request = createRequester(getToken);
  }

  me(options?: { organizationId?: string | null }) {
    const organizationId = options?.organizationId;
    if (organizationId === undefined) {
      return this.request<CurrentUserResponse>("/auth/me");
    }
    // NOTE: We intentionally avoid forcing `x-organization-id` from the browser.
    // Some extensions/privacy tools block requests with certain custom headers.
    // Instead, workspace selection is propagated via cookie and injected server-side
    // by the Next.js `/api/internal/*` proxy.
    return this.request<CurrentUserResponse>("/auth/me");
  }
}
