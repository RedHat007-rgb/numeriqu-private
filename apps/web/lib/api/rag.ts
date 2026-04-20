import { API_BASE_URL, ApiError, streamJsonSseLines, type TokenProvider } from "./base";
import type { ChatMessage, HealthResponse } from "./types";

export class RagApi {
  constructor(private readonly getToken: TokenProvider) {}

  async health(): Promise<HealthResponse> {
    const token = await this.getToken();
    if (!token) throw new ApiError("Sign in before calling the backend.", 401);

    // Health endpoints are protected by default in this project; keep the auth header consistent.
    const response = await fetch(`${API_BASE_URL}/rag/health`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!response.ok) throw new ApiError("RAG health check failed.", response.status);
    return (await response.json()) as HealthResponse;
  }

  async streamQuery(params: { query: string; history: ChatMessage[]; onDelta: (delta: string) => void }) {
    const token = await this.getToken();
    if (!token) throw new ApiError("Sign in before calling the backend.", 401);

    return streamJsonSseLines({
      path: "/rag/query",
      token,
      body: { query: params.query, history: params.history },
      onDelta: params.onDelta,
    });
  }
}
