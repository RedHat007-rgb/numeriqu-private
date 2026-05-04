import { createRequester, type TokenProvider } from "./base";
import type { WorkspaceDashboardSummary } from "./types";

export class DashboardsApi {
  private readonly request: ReturnType<typeof createRequester>;

  constructor(getToken: TokenProvider) {
    this.request = createRequester(getToken);
  }

  list() {
    return this.request<WorkspaceDashboardSummary[]>("/dashboards");
  }

  refresh(dashboardId: string) {
    return this.request<{ success: true }>(`/dashboards/${dashboardId}/refresh`, {
      method: "PATCH",
    });
  }
}
