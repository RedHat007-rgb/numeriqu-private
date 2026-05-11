import { createRequester, type TokenProvider } from "./base";
import type { DashboardResponse, TimeRange } from "./types";

export class AnalyticsApi {
  private readonly request: ReturnType<typeof createRequester>;

  constructor(getToken: TokenProvider) {
    this.request = createRequester(getToken);
  }

  dashboard(range?: TimeRange | null) {
    const params = new URLSearchParams();

    if (range && range.kind !== "ALL_TIME") {
      params.set("rangeKind", range.kind);
      if ("days" in range) params.set("rangeValue", String(range.days));
      else if ("weeks" in range) params.set("rangeValue", String(range.weeks));
      else if ("months" in range) params.set("rangeValue", String(range.months));
      else if ("quarters" in range) params.set("rangeValue", String(range.quarters));
      else if ("years" in range) params.set("rangeValue", String(range.years));
    }

    const query = params.toString();
    return this.request<DashboardResponse>(`/analytics/dashboard${query ? `?${query}` : ""}`);
  }

  insights() {
    return this.request<unknown>("/analytics/insights");
  }
}
