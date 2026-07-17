import { createRequester, type TokenProvider } from "./base";
import type {
  SignalBoardPackSummary,
  SignalDetail,
  SignalMetricsOverview,
  SignalSummary,
  SignalWatchlistSummary,
} from "./types";

type SignalIndexResponse = {
  overview: SignalMetricsOverview;
  signals: SignalSummary[];
  watchlists: SignalWatchlistSummary[];
  computedAt: string;
};

export class SignalIntelligenceApi {
  private readonly request: ReturnType<typeof createRequester>;

  constructor(getToken: TokenProvider) {
    this.request = createRequester(getToken);
  }

  list() {
    return this.request<SignalIndexResponse>("/signal-intelligence/signals");
  }

  get(signalId: string) {
    return this.request<SignalDetail>(`/signal-intelligence/signals/${signalId}`);
  }

  acknowledge(signalId: string, note?: string) {
    return this.request<{ success: true }>(`/signal-intelligence/signals/${signalId}/acknowledge`, {
      method: "POST",
      body: JSON.stringify({ note }),
    });
  }

  dismiss(signalId: string, reason: string) {
    return this.request<{ success: true }>(`/signal-intelligence/signals/${signalId}/dismiss`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    });
  }

  assign(signalId: string, assignedToUserId: string | null) {
    return this.request<{ success: true }>(`/signal-intelligence/signals/${signalId}/assign`, {
      method: "POST",
      body: JSON.stringify({ assignedToUserId }),
    });
  }

  comment(signalId: string, content: string) {
    return this.request<{ id: string }>(`/signal-intelligence/signals/${signalId}/comments`, {
      method: "POST",
      body: JSON.stringify({ content }),
    });
  }

  createBoardPack(signalId: string, params: { title: string; audience: string; exportFormat?: string }) {
    return this.request<SignalBoardPackSummary>(`/signal-intelligence/signals/${signalId}/board-packs`, {
      method: "POST",
      body: JSON.stringify(params),
    });
  }

  listBoardPacks() {
    return this.request<SignalBoardPackSummary[]>("/signal-intelligence/board-packs");
  }

  listWatchlists() {
    return this.request<SignalWatchlistSummary[]>("/signal-intelligence/watchlists");
  }

  createWatchlist(params: { name: string; description?: string | null }) {
    return this.request<SignalWatchlistSummary>("/signal-intelligence/watchlists", {
      method: "POST",
      body: JSON.stringify(params),
    });
  }

  deleteWatchlist(watchlistId: string) {
    return this.request<{ success: true }>(`/signal-intelligence/watchlists/${watchlistId}`, {
      method: "DELETE",
    });
  }

  recompute() {
    return this.request<{ success: true }>("/signal-intelligence/recompute", {
      method: "PATCH",
    });
  }
}
