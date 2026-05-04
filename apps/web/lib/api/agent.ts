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
} from "./types";

export class AgentApi {
  private readonly request: ReturnType<typeof createRequester>;

  constructor(private readonly getToken: TokenProvider) {
    this.request = createRequester(getToken);
  }

  async health(): Promise<HealthResponse> {
    const token = await this.getToken();
    if (!token) throw new ApiError("Sign in before calling the backend.", 401);

    const response = await fetch(`${getApiBaseURL()}/agent/health`, {
      headers: { Authorization: `Bearer ${token}` },
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

  getMetrics(metric: string, grouping: string) {
    const params = new URLSearchParams({ metric, grouping });
    return this.request<MetricsResponse>(`/agent/metrics?${params.toString()}`);
  }

  async streamQuery(params: StreamQueryParams) {
    const token = await this.getToken();
    if (!token) throw new ApiError("Sign in before calling the backend.", 401);

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
