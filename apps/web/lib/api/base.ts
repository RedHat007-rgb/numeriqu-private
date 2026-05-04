export type ApiErrorPayload = {
  statusCode?: number;
  message?: string | string[];
  code?: string;
  traceId?: string;
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

  /**
   * Map a structured backend error to a user-friendly, calm message that does
   * not leak technical details. Falls back to a safe generic if nothing fits.
   */
  toUserMessage(fallback = "Something went wrong. Please try again."): string {
    const code = this.payload?.code;
    if (code === "INVITE_EXPIRED") return "This invite has expired. Ask an admin to resend it.";
    if (code === "EMAIL_MISMATCH") return "Use the same email address that received the invite.";
    if (code === "ALREADY_MEMBER") return "This user is already a member of the organization.";
    if (code === "VALIDATION_FAILED") return "Some details look incorrect. Please review and retry.";

    if (this.status === 401) return "Your session expired. Please sign in again.";
    if (this.status === 403) return "You do not have access to this resource.";
    if (this.status === 404) return "We could not find what you were looking for.";
    if (this.status === 400) return fallback;
    if (this.status === 429) return "Too many requests. Wait a moment and retry.";
    if (this.status >= 500) return "Our service is having trouble right now. Please retry shortly.";
    return fallback;
  }
}

export type TokenProvider = () => Promise<string | null>;

/**
 * Browser: same-origin `/api/numeriqu` (Next.js rewrite to Nest) unless NEXT_PUBLIC_API_*_URL is set.
 * Server: direct internal URL for any SSR usage.
 */
export function getApiBaseURL(): string {
  const explicit =
    process.env.NEXT_PUBLIC_API_BASE_URL?.trim() ||
    process.env.NEXT_PUBLIC_API_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");
  if (typeof window !== "undefined") {
    return `${window.location.origin.replace(/\/$/, "")}/api/numeriqu`;
  }
  const internal =
    process.env.API_INTERNAL_URL?.trim() ||
    process.env.API_PROXY_TARGET?.trim() ||
    "http://127.0.0.1:3000";
  return internal.replace(/\/$/, "");
}

/**
 * Streaming POSTs (SSE) must hit Nest directly. Next.js dev rewrites can buffer
 * the upstream response so the UI sees no tokens until completion.
 */
export function getStreamApiBaseURL(): string {
  const stream = process.env.NEXT_PUBLIC_API_STREAM_URL?.trim();
  if (stream) return stream.replace(/\/$/, "");
  const explicit =
    process.env.NEXT_PUBLIC_API_BASE_URL?.trim() ||
    process.env.NEXT_PUBLIC_API_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");
  if (typeof window !== "undefined") {
    return "http://localhost:3000";
  }
  return getApiBaseURL();
}

/** Backwards-compatible export so existing imports keep working. */
export const API_BASE_URL = getApiBaseURL();

function normalizeMessage(payload: ApiErrorPayload | undefined, fallback: string) {
  if (!payload?.message) return payload?.error ?? fallback;
  return Array.isArray(payload.message) ? payload.message.join(" ") : payload.message;
}

export function createRequester(getToken: TokenProvider) {
  return async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = await getToken();

    const headers = new Headers(init.headers);
    if (token) {
      headers.set("Authorization", `Bearer ${token}`);
    }
    if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");

    const response = await fetch(`${getApiBaseURL()}${path}`, {
      ...init,
      headers,
      credentials: "include",
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

export type StreamMessage = {
  type?: string;
  token?: string;
  content?: string;
  message?: string;
  action?: string;
  metrics?: { sessionId?: string } & Record<string, unknown>;
  [key: string]: unknown;
};

export type StreamCallbacks = {
  onDelta: (delta: string) => void;
  onMessage?: (msg: StreamMessage) => void;
};

export async function streamJsonSseLines(params: {
  path: string;
  token?: string | null;
  body: unknown;
  onDelta: (delta: string) => void;
  onMessage?: (msg: StreamMessage) => void;
}) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (params.token) {
    headers.Authorization = `Bearer ${params.token}`;
  }

  const response = await fetch(`${getStreamApiBaseURL()}${params.path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(params.body),
    credentials: "include",
  });

  if (!response.ok || !response.body) {
    let payload: ApiErrorPayload | undefined;
    try {
      payload = (await response.json()) as ApiErrorPayload;
    } catch {
      payload = undefined;
    }
    throw new ApiError(
      normalizeMessage(payload, "Streaming request failed."),
      response.status,
      payload,
    );
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
        const parsed = JSON.parse(clean) as StreamMessage;
        if (parsed.type === "error") {
          throw new ApiError(
            (parsed.message as string) ?? "Stream interrupted.",
            500,
          );
        }
        if (params.onMessage) params.onMessage(parsed);
        if (parsed.type === "token" && typeof parsed.content === "string") {
          params.onDelta(parsed.content);
        } else if (typeof parsed.token === "string") {
          params.onDelta(parsed.token);
        }
      } catch (error) {
        if (error instanceof SyntaxError) {
          // SSE frame was raw text rather than JSON; emit as-is so streaming surfaces still see content.
          params.onDelta(clean);
        } else {
          throw error;
        }
      }
    }
  }
}
