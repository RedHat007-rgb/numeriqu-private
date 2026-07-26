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
  HealthResponse,
  StreamQueryParams,
  PrismOpportunity,
  PrismScenarioResult,
} from "./types";

export class RagApi {
  private readonly request: ReturnType<typeof createRequester>;

  constructor(private readonly getToken: TokenProvider) {
    this.request = createRequester(getToken);
  }

  async health(): Promise<HealthResponse> {
    const token = await this.getToken();

    const response = await fetch(`${getApiBaseURL()}/rag/health`, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      credentials: "include",
      cache: "no-store",
    });
    if (!response.ok)
      throw new ApiError("RAG health check failed.", response.status);
    return (await response.json()) as HealthResponse;
  }

  sessions() {
    return this.request<ChatSessionSummary[]>("/rag/sessions");
  }

  session(id: string) {
    return this.request<ChatSessionDetail>(`/rag/sessions/${id}`);
  }

  createBriefing(prompt: string, period: string, idempotencyKey: string) {
    return this.request<{ id: string; status: string; createdAt: string }>(
      "/rag/jobs/briefings",
      {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({ prompt, period }),
      },
    );
  }

  job(id: string) {
    return this.request<{
      id: string;
      status: string;
      result?: Record<string, unknown> | null;
    }>(`/rag/jobs/${id}`);
  }

  opportunities() {
    return this.request<PrismOpportunity[]>("/rag/opportunities");
  }

  evaluateScenario(input: {
    baseline: string;
    unit: "currency" | "percent" | "number";
    currency?: string;
    assumptions: Array<{ label: string; basisPoints: number }>;
  }) {
    return this.request<PrismScenarioResult>(
      "/rag/decisions/scenarios/evaluate",
      { method: "POST", body: JSON.stringify(input) },
    );
  }

  async streamQuery(params: StreamQueryParams) {
    const token = await this.getToken();

    return streamJsonSseLines({
      path: "/rag/query",
      token,
      body: {
        query: params.query,
        history: params.history,
        sessionId: params.sessionId ?? undefined,
        tone: params.tone ?? "professional",
      },
      onDelta: params.onDelta,
      onMessage: params.onMessage,
      signal: params.signal,
      // Wait past a single slow model/engine step (server deadline is 90s) so
      // the browser doesn't abort a request the server would still answer.
      inactivityTimeoutMs: Number(
        process.env.NEXT_PUBLIC_PRISM_STREAM_TIMEOUT_MS ?? 120_000,
      ),
    });
  }
}
