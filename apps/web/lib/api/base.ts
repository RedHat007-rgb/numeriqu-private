export type ApiErrorPayload = {
  statusCode?: number;
  message?: string | string[];
  error?: string;
};

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly payload?: ApiErrorPayload,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export type TokenProvider = () => Promise<string | null>;

export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL ??
  process.env.NEXT_PUBLIC_API_URL ??
  "http://localhost:3000";

function normalizeMessage(payload: ApiErrorPayload | undefined, fallback: string) {
  if (!payload?.message) return payload?.error ?? fallback;
  return Array.isArray(payload.message) ? payload.message.join(" ") : payload.message;
}

export function createRequester(getToken: TokenProvider) {
  return async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = await getToken();
    if (!token) throw new ApiError("Sign in before calling the backend.", 401);

    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");

    const response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers,
      cache: "no-store",
    });

    if (!response.ok) {
      let payload: ApiErrorPayload | undefined;
      try {
        payload = (await response.json()) as ApiErrorPayload;
      } catch {
        payload = undefined;
      }
      throw new ApiError(normalizeMessage(payload, response.statusText), response.status, payload);
    }

    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  };
}

export async function streamJsonSseLines(params: {
  path: string;
  token: string;
  body: unknown;
  onDelta: (delta: string) => void;
}) {
  const response = await fetch(`${API_BASE_URL}${params.path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(params.body),
  });

  if (!response.ok || !response.body) {
    throw new ApiError(`Chat stream failed with ${response.status}.`, response.status);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const clean = line.startsWith("data:") ? line.slice(5).trim() : line.trim();
      if (!clean || clean === "[DONE]") continue;
      try {
        const parsed = JSON.parse(clean) as {
          type?: string;
          token?: string;
          content?: string;
          message?: string;
        };
        if (parsed.type === "error") throw new Error(parsed.message ?? "Stream interrupted.");
        params.onDelta(parsed.token ?? parsed.content ?? parsed.message ?? "");
      } catch (error) {
        if (error instanceof SyntaxError) params.onDelta(clean);
        else throw error;
      }
    }
  }
}
