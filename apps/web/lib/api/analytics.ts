import { createRequester, type TokenProvider } from "./base";
import type { DashboardResponse } from "./types";

export class AnalyticsApi {
  private readonly request: ReturnType<typeof createRequester>;

  constructor(getToken: TokenProvider) {
    this.request = createRequester(getToken);
  }

  dashboard() {
    return this.request<DashboardResponse>("/analytics/dashboard");
  }

  insights() {
    return this.request<unknown>("/analytics/insights");
  }
}
