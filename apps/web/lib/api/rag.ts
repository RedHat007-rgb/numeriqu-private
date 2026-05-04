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
    if (!response.ok) throw new ApiError("RAG health check failed.", response.status);
    return (await response.json()) as HealthResponse;
  }

  sessions() {
    return this.request<ChatSessionSummary[]>("/rag/sessions");
  }

  session(id: string) {
    return this.request<ChatSessionDetail>(`/rag/sessions/${id}`);
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
      },
      onDelta: params.onDelta,
      onMessage: params.onMessage,
    });
  }
}
