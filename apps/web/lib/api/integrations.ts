import { createRequester, type TokenProvider } from "./base";
import type { Connection, SyncJob } from "./types";

export class IntegrationsApi {
  private readonly request: ReturnType<typeof createRequester>;

  constructor(getToken: TokenProvider) {
    this.request = createRequester(getToken);
  }

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
}

