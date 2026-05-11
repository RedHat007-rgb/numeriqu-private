import {
  ApiError,
  createRequester,
  getApiBaseURL,
  streamJsonSseLines,
  type TokenProvider,
} from "./base";
import type {
  ChatSessionDetail,
  ChatSessionSummary,
  GeneratedDashboard,
  HealthResponse,
  MetricsResponse,
  StreamQueryParams,
  Breakdown,
  TimeRange,
} from "./types";

export class AgentApi {
  private readonly request: ReturnType<typeof createRequester>;

  constructor(private readonly getToken: TokenProvider) {
    this.request = createRequester(getToken);
  }

  async health(): Promise<HealthResponse> {
    const token = await this.getToken();

    const response = await fetch(`${getApiBaseURL()}/agent/health`, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      credentials: "include",
      cache: "no-store",
    });
    if (!response.ok) throw new ApiError("Agent health check failed.", response.status);
    return (await response.json()) as HealthResponse;
  }

  sessions() {
    return this.request<ChatSessionSummary[]>("/agent/sessions");
  }

  session(id: string) {
    return this.request<ChatSessionDetail>(`/agent/sessions/${id}`);
  }

  latestDashboard() {
    return this.request<GeneratedDashboard | null>("/agent/dashboards/latest");
  }

  getDashboardSession(dashboardId: string) {
    return this.request<{ sessionId: string; sessionTitle: string } | null>(
      `/agent/dashboards/${dashboardId}/session`,
    );
  }

  getMetrics(
    metric: string,
    grouping: string,
    timeRange?: TimeRange | null,
    providerHint?: string | null,
    clientName?: string | null,
    clientNames?: string[] | null,
    orgId?: string | null,
    breakdown?: Breakdown | null,
    topN?: number | null,
  ) {
    const params = new URLSearchParams({ metric, grouping });
    if (providerHint) params.set("providerHint", providerHint);
    if (clientName) params.set("clientName", clientName);
    if (Array.isArray(clientNames) && clientNames.length > 0) {
      params.set("clientNames", JSON.stringify(clientNames.slice(0, 5)));
    }
    if (orgId) params.set("orgId", orgId);
    if (breakdown) params.set("breakdown", breakdown);
    if (typeof topN === "number" && Number.isFinite(topN)) {
      params.set("topN", String(topN));
    }
    if (timeRange?.kind) {
      params.set("rangeKind", String(timeRange.kind));
      if (timeRange.kind === "SINCE_DATE") {
        params.set("rangeStart", timeRange.start);
      }
      if (timeRange.kind === "BETWEEN_DATES") {
        params.set("rangeStart", timeRange.start);
        params.set("rangeEnd", timeRange.end);
      }

      const value = (() => {
        switch (timeRange.kind) {
          case "LAST_N_DAYS":
            return timeRange.days;
          case "LAST_N_WEEKS":
            return timeRange.weeks;
          case "LAST_N_MONTHS":
            return timeRange.months;
          case "LAST_N_QUARTERS":
            return timeRange.quarters;
          case "LAST_N_YEARS":
            return timeRange.years;
          default:
            return null;
        }
      })();
      if (typeof value === "number" && Number.isFinite(value)) {
        params.set("rangeValue", String(value));
      }
    }
    return this.request<MetricsResponse>(`/agent/metrics?${params.toString()}`);
  }

  async streamQuery(params: StreamQueryParams) {
    const token = await this.getToken();

    return streamJsonSseLines({
      path: "/agent/query",
      token,
      body: {
        query: params.query,
        history: params.history,
        sessionId: params.sessionId ?? undefined,
      },
      onDelta: params.onDelta,
      onMessage: params.onMessage,
    });
  }
}
