"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowRight,
  Brain,
  CircleAlert,
  Clock3,
  RefreshCw,
  Search,
  TrendingDown,
  WalletCards,
  Plus,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "../../../components/ui/Button";
import { EmptyState } from "../../../components/ui/EmptyState";
import { ErrorBanner } from "../../../components/ui/ErrorBanner";
import { Skeleton } from "../../../components/ui/Skeleton";
import { StatusPill } from "../../../components/ui/StatusPill";
import { Surface } from "../../../components/ui/Surface";
import { cn } from "../../../components/ui/cn";
import { useNumeriquApi } from "../../../lib/useNumeriquApi";
import type {
  SignalMetricsOverview,
  SignalSeverity,
  SignalStatus,
  SignalSummary,
  SignalWatchlistSummary,
} from "../../../lib/api";

type FilterState = {
  severity: SignalSeverity | "ALL";
  status: SignalStatus | "ALL";
  q: string;
};

const EMPTY_OVERVIEW: SignalMetricsOverview = {
  signalCount: 0,
  newCount: 0,
  investigatingCount: 0,
  dismissedCount: 0,
  criticalCount: 0,
  averageConfidence: 0,
  totalImpact: 0,
};

function toneForSeverity(severity: SignalSeverity) {
  if (severity === "CRITICAL") return "danger" as const;
  if (severity === "HIGH") return "warning" as const;
  if (severity === "MEDIUM") return "info" as const;
  return "neutral" as const;
}

function formatCurrency(value: number) {
  if (!Number.isFinite(value)) return "$0";
  if (Math.abs(value) >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (Math.abs(value) >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(0)}`;
}

function formatTime(value: string | null | undefined) {
  if (!value) return "just now";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "just now";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function CardStat({
  label,
  value,
  icon,
  tone = "neutral",
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
  tone?: "neutral" | "warning" | "danger" | "info" | "success";
}) {
  return (
    <Surface tone="card" className="border-default">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-text-muted">{label}</p>
          <p className="mt-2 font-display text-2xl font-bold text-text-primary">{value}</p>
        </div>
        <div
          className={cn(
            "flex size-10 items-center justify-center rounded-full ring-1",
            tone === "danger" && "bg-feedback-danger/10 text-feedback-danger ring-feedback-danger/20",
            tone === "warning" && "bg-feedback-warning/10 text-feedback-warning ring-feedback-warning/20",
            tone === "info" && "bg-feedback-info/10 text-feedback-info ring-feedback-info/20",
            tone === "success" && "bg-feedback-success/10 text-feedback-success ring-feedback-success/20",
            tone === "neutral" && "bg-text-muted/10 text-text-secondary ring-text-muted/15",
          )}
        >
          {icon}
        </div>
      </div>
    </Surface>
  );
}

function SignalCard({ signal }: { signal: SignalSummary }) {
  const router = useRouter();
  return (
    <button
      type="button"
      onClick={() => router.push(`/dashboard/signals/${signal.id}`)}
      className="group w-full text-left"
    >
      <Surface
        tone="card"
        className="h-full border-default transition hover:-translate-y-0.5 hover:border-accent-blue/40 hover:shadow-lg"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <StatusPill tone={toneForSeverity(signal.severity)}>{signal.severity}</StatusPill>
              <StatusPill tone={signal.status === "NEW" ? "warning" : signal.status === "DISMISSED" ? "neutral" : "info"}>
                {signal.status}
              </StatusPill>
            </div>
            <h3 className="mt-3 line-clamp-2 font-display text-lg font-semibold text-text-primary">{signal.title}</h3>
            <p className="mt-2 line-clamp-2 text-sm leading-6 text-text-muted">{signal.summary}</p>
          </div>
          <ArrowRight className="mt-1 size-4 shrink-0 text-text-muted transition group-hover:translate-x-0.5 group-hover:text-text-primary" />
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-text-muted">Impact</p>
            <p className="mt-1 text-base font-semibold text-text-primary">{formatCurrency(signal.impactAmount)}</p>
          </div>
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-text-muted">Confidence</p>
            <p className="mt-1 text-base font-semibold text-text-primary">{(signal.confidenceScore * 100).toFixed(0)}%</p>
          </div>
          <div className="sm:col-span-2">
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-text-muted">Scope</p>
            <p className="mt-1 text-sm text-text-primary">
              {signal.entityScope.entityName ?? "Organization"} · {signal.metric.label}
            </p>
          </div>
        </div>

        <div className="mt-4 flex items-center justify-between border-t border-default pt-3 text-xs text-text-muted">
          <span>{formatTime(signal.lastRefreshedAt ?? signal.updatedAt)}</span>
          <span>{signal.commentCount ?? 0} comments</span>
        </div>
      </Surface>
    </button>
  );
}

export function SignalsPage() {
  const { signals: api, loading, isAuthenticated } = useNumeriquApi();
  const [state, setState] = useState<{
    overview: SignalMetricsOverview;
    signals: SignalSummary[];
    watchlists: SignalWatchlistSummary[];
    computedAt: string | null;
  }>({ overview: EMPTY_OVERVIEW, signals: [], watchlists: [], computedAt: null });
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<FilterState>({ severity: "ALL", status: "ALL", q: "" });
  const [refreshing, setRefreshing] = useState(false);
  const [watchlistName, setWatchlistName] = useState("");
  const [watchlistDescription, setWatchlistDescription] = useState("");
  const [watchlistSaving, setWatchlistSaving] = useState(false);
  const [watchlistDeletingId, setWatchlistDeletingId] = useState<string | null>(null);

  useEffect(() => {
    if (loading || !isAuthenticated) return;
    let cancelled = false;
    const load = async () => {
      setStatus("loading");
      try {
        const payload = await api.list();
        if (cancelled) return;
        setState({
          overview: payload.overview,
          signals: payload.signals,
          watchlists: payload.watchlists,
          computedAt: payload.computedAt,
        });
        setError(null);
        setStatus("ready");
      } catch (caught) {
        if (cancelled) return;
        setStatus("error");
        setError(caught instanceof Error ? caught.message : "Could not load signals.");
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [api, isAuthenticated, loading]);

  const filteredSignals = useMemo(() => {
    return state.signals.filter((signal) => {
      if (filters.severity !== "ALL" && signal.severity !== filters.severity) return false;
      if (filters.status !== "ALL" && signal.status !== filters.status) return false;
      if (!filters.q.trim()) return true;
      const haystack = `${signal.title} ${signal.summary} ${signal.metric.label} ${signal.entityScope.entityName ?? ""}`.toLowerCase();
      return haystack.includes(filters.q.trim().toLowerCase());
    });
  }, [filters.q, filters.severity, filters.status, state.signals]);

  const doRefresh = async () => {
    setRefreshing(true);
    try {
      await api.recompute();
      const payload = await api.list();
      setState({
        overview: payload.overview,
        signals: payload.signals,
        watchlists: payload.watchlists,
        computedAt: payload.computedAt,
      });
      toast.success("Signals refreshed");
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Could not refresh signals.");
    } finally {
      setRefreshing(false);
    }
  };

  const refreshState = async () => {
    const payload = await api.list();
    setState({
      overview: payload.overview,
      signals: payload.signals,
      watchlists: payload.watchlists,
      computedAt: payload.computedAt,
    });
    return payload;
  };

  const createWatchlist = async () => {
    if (watchlistName.trim().length < 2) return;
    setWatchlistSaving(true);
    try {
      await api.createWatchlist({
        name: watchlistName.trim(),
        description: watchlistDescription.trim() || null,
      });
      await refreshState();
      setWatchlistName("");
      setWatchlistDescription("");
      toast.success("Watchlist created");
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Could not create watchlist.");
    } finally {
      setWatchlistSaving(false);
    }
  };

  const deleteWatchlist = async (watchlistId: string) => {
    setWatchlistDeletingId(watchlistId);
    try {
      await api.deleteWatchlist(watchlistId);
      await refreshState();
      toast.success("Watchlist removed");
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Could not delete watchlist.");
    } finally {
      setWatchlistDeletingId(null);
    }
  };

  if (status === "error") {
    return (
      <ErrorBanner title="Signals unavailable">
        {error ?? "We could not load the signal inbox."}
      </ErrorBanner>
    );
  }

  if (status === "loading" && state.signals.length === 0) {
    return (
      <div className="space-y-5">
        <Skeleton height={72} rounded="xl" />
        <div className="grid gap-4 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} height={120} rounded="xl" />
          ))}
        </div>
        <Skeleton height={420} rounded="xl" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div className="max-w-3xl">
          <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-text-muted">Signal intelligence</p>
          <h1 className="mt-2 font-display text-4xl font-bold tracking-tight text-text-primary sm:text-5xl">
            Finance changes that deserve attention
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-text-muted">
            Investigate variance, cash pressure, collections risk, and utilization issues in one workspace with evidence and permissions intact.
          </p>
        </div>

        <div className="flex flex-wrap gap-3">
          <Button variant="secondary" onClick={doRefresh} loading={refreshing}>
            <RefreshCw className="size-4" />
            Refresh signals
          </Button>
          <Link href="#watchlists">
            <Button variant="ghost">
              <WalletCards className="size-4" />
              Watchlists
            </Button>
          </Link>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-6">
        <CardStat label="Open signals" value={state.overview.signalCount.toString()} icon={<AlertTriangle className="size-4" />} tone="warning" />
        <CardStat label="Critical" value={state.overview.criticalCount.toString()} icon={<CircleAlert className="size-4" />} tone="danger" />
        <CardStat label="Needs attention" value={state.overview.newCount.toString()} icon={<Clock3 className="size-4" />} tone="info" />
        <CardStat label="Investigating" value={state.overview.investigatingCount.toString()} icon={<Brain className="size-4" />} tone="neutral" />
        <CardStat label="Avg confidence" value={`${state.overview.averageConfidence.toFixed(2)}`} icon={<Search className="size-4" />} tone="success" />
        <CardStat label="Impact at risk" value={formatCurrency(state.overview.totalImpact)} icon={<TrendingDown className="size-4" />} tone="warning" />
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <section className="space-y-4">
          <Surface tone="card" className="border-default">
            <div className="grid gap-3 md:grid-cols-[1.2fr_0.8fr_0.8fr]">
              <label className="block">
                <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.2em] text-text-muted">Search</span>
                <input
                  value={filters.q}
                  onChange={(event) => setFilters((prev) => ({ ...prev, q: event.target.value }))}
                  placeholder="Search a signal, entity, or metric"
                  className="h-11 w-full rounded-xl border border-default bg-bg-surface px-3 text-sm text-text-primary outline-none transition focus:border-accent-blue"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.2em] text-text-muted">Severity</span>
                <select
                  value={filters.severity}
                  onChange={(event) => setFilters((prev) => ({ ...prev, severity: event.target.value as FilterState["severity"] }))}
                  className="h-11 w-full rounded-xl border border-default bg-bg-surface px-3 text-sm text-text-primary outline-none transition focus:border-accent-blue"
                >
                  {["ALL", "CRITICAL", "HIGH", "MEDIUM", "LOW"].map((value) => (
                    <option key={value} value={value}>{value}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.2em] text-text-muted">Status</span>
                <select
                  value={filters.status}
                  onChange={(event) => setFilters((prev) => ({ ...prev, status: event.target.value as FilterState["status"] }))}
                  className="h-11 w-full rounded-xl border border-default bg-bg-surface px-3 text-sm text-text-primary outline-none transition focus:border-accent-blue"
                >
                  {["ALL", "NEW", "ACKNOWLEDGED", "INVESTIGATING", "RESOLVED", "DISMISSED"].map((value) => (
                    <option key={value} value={value}>{value}</option>
                  ))}
                </select>
              </label>
            </div>
          </Surface>

          {filteredSignals.length === 0 ? (
            <EmptyState
              title="No signals in this scope"
              detail="Try widening the time window or lowering your thresholds. The detector only shows material issues."
              icon={<Search className="size-5" />}
            />
          ) : (
            <div className="grid gap-4 xl:grid-cols-2">
              {filteredSignals.map((signal) => (
                <SignalCard key={signal.id} signal={signal} />
              ))}
            </div>
          )}
        </section>

        <aside className="space-y-5" id="watchlists">
          <Surface tone="card" className="border-default">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-text-muted">Watchlists</p>
                <h2 className="mt-1 font-display text-xl font-semibold text-text-primary">Recurring triggers</h2>
              </div>
              <WalletCards className="size-5 text-accent-blue" />
            </div>
            <div className="mt-4 space-y-3">
              {state.watchlists.length === 0 ? (
                <p className="text-sm text-text-muted">No watchlists yet. The platform will seed a default watchlist on first use.</p>
              ) : (
                state.watchlists.map((watchlist) => (
                  <div key={watchlist.id} className="rounded-xl border border-default bg-bg-elevated/40 p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="font-semibold text-text-primary">{watchlist.name}</p>
                        <p className="mt-1 text-xs text-text-muted">{watchlist.items.length} items</p>
                      </div>
                      <div className="flex items-center gap-2">
                        {watchlist.isDefault ? <StatusPill tone="info">Default</StatusPill> : null}
                        {!watchlist.isDefault ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => deleteWatchlist(watchlist.id)}
                            loading={watchlistDeletingId === watchlist.id}
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        ) : null}
                      </div>
                    </div>
                    {watchlist.description ? <p className="mt-2 text-sm text-text-muted">{watchlist.description}</p> : null}
                  </div>
                ))
              )}
            </div>
          </Surface>

          <Surface tone="card" className="border-default">
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-text-muted">New watchlist</p>
            <div className="mt-4 space-y-3">
              <label className="block">
                <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.2em] text-text-muted">Name</span>
                <input
                  value={watchlistName}
                  onChange={(event) => setWatchlistName(event.target.value)}
                  placeholder="Collections Escalations"
                  className="h-11 w-full rounded-xl border border-default bg-bg-surface px-3 text-sm text-text-primary outline-none transition focus:border-accent-blue"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.2em] text-text-muted">Description</span>
                <textarea
                  value={watchlistDescription}
                  onChange={(event) => setWatchlistDescription(event.target.value)}
                  rows={3}
                  placeholder="Escalate overdue invoices above 10% of revenue."
                  className="min-h-[84px] w-full rounded-xl border border-default bg-bg-surface px-3 py-2 text-sm text-text-primary outline-none transition focus:border-accent-blue"
                />
              </label>
              <Button
                onClick={createWatchlist}
                loading={watchlistSaving}
                disabled={watchlistName.trim().length < 2}
              >
                <Plus className="size-4" />
                Create watchlist
              </Button>
            </div>
          </Surface>

          <Surface tone="card" className="border-default">
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-text-muted">Freshness</p>
            <p className="mt-2 font-display text-xl font-semibold text-text-primary">Current as of</p>
            <p className="mt-1 text-sm text-text-muted">{state.computedAt ? formatTime(state.computedAt) : "not computed yet"}</p>
          </Surface>
        </aside>
      </div>
    </div>
  );
}
