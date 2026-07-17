"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  CheckCircle2,
  ListChecks,
  MessageSquare,
  RefreshCw,
  Send,
  Share2,
  ShieldAlert,
  Sparkles,
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
import type { SignalDetail as SignalDetailType } from "../../../lib/api";

function toneForSeverity(value: string) {
  if (value === "CRITICAL") return "danger" as const;
  if (value === "HIGH") return "warning" as const;
  if (value === "MEDIUM") return "info" as const;
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

export function SignalDetailPage({ signalId }: { signalId: string }) {
  const { signals: api, loading, isAuthenticated } = useNumeriquApi();
  const [signal, setSignal] = useState<SignalDetailType | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [boardPackTitle, setBoardPackTitle] = useState("Board pack");
  const [audience, setAudience] = useState("board");
  const [owner, setOwner] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [actioning, setActioning] = useState(false);
  const aiNarrative = signal?.evidence.find((section) => section.evidenceType === "ai_narrative") ?? null;

  const load = async () => {
    setState("loading");
    try {
      const payload = await api.get(signalId);
      setSignal(payload);
      setBoardPackTitle(`${payload.metric.label} review`);
      setAudience(payload.signalType === "CASH_RISK" ? "finance leadership" : "board");
      setError(null);
      setState("ready");
    } catch (caught) {
      setState("error");
      setError(caught instanceof Error ? caught.message : "Could not load this signal.");
    }
  };

  useEffect(() => {
    if (loading || !isAuthenticated) return;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signalId, loading, isAuthenticated]);

  const refreshSignal = async () => {
    setRefreshing(true);
    try {
      await api.recompute();
      await load();
      toast.success("Signal refreshed");
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Could not refresh signal.");
    } finally {
      setRefreshing(false);
    }
  };

  const withAction = async (fn: () => Promise<unknown>, successMessage: string) => {
    setActioning(true);
    try {
      await fn();
      await load();
      toast.success(successMessage);
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Action failed.");
    } finally {
      setActioning(false);
    }
  };

  if (state === "error") {
    return (
      <ErrorBanner title="Signal unavailable">
        {error ?? "We could not load the signal."}
      </ErrorBanner>
    );
  }

  if (state === "loading" && !signal) {
    return <Skeleton height={420} rounded="xl" />;
  }

  if (!signal) {
    return (
      <EmptyState
        title="No signal selected"
        detail="Pick a signal from the inbox to start an investigation."
        icon={<ShieldAlert className="size-5" />}
        action={
          <Link href="/dashboard/signals">
            <Button variant="secondary">
              <ArrowLeft className="size-4" />
              Back to signals
            </Button>
          </Link>
        }
      />
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Link href="/dashboard/signals">
            <Button variant="ghost" size="sm">
              <ArrowLeft className="size-4" />
              Back
            </Button>
          </Link>
          <StatusPill tone={toneForSeverity(signal.severity)}>{signal.severity}</StatusPill>
          <StatusPill tone={signal.status === "DISMISSED" ? "neutral" : signal.status === "NEW" ? "warning" : "info"}>
            {signal.status}
          </StatusPill>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={refreshSignal} loading={refreshing}>
            <RefreshCw className="size-4" />
            Recompute
          </Button>
          <Button
            variant="secondary"
            onClick={() =>
              withAction(
                () => api.acknowledge(signal.id, "Reviewed in workspace"),
                "Signal acknowledged",
              )
            }
            loading={actioning}
          >
            <CheckCircle2 className="size-4" />
            Acknowledge
          </Button>
        </div>
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <main className="space-y-5">
          <Surface tone="card" className="border-default">
            <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-text-muted">Investigation</p>
            <h1 className="mt-2 font-display text-3xl font-bold tracking-tight text-text-primary">{signal.title}</h1>
            <p className="mt-3 max-w-3xl text-sm leading-7 text-text-muted">{signal.summary}</p>

            <div className="mt-5 grid gap-3 md:grid-cols-4">
              <Metric label="Impact" value={formatCurrency(signal.impactAmount)} />
              <Metric label="Confidence" value={`${(signal.confidenceScore * 100).toFixed(0)}%`} />
              <Metric label="Metric" value={signal.metric.label} />
              <Metric label="Updated" value={formatTime(signal.lastRefreshedAt ?? signal.updatedAt)} />
            </div>
          </Surface>

          <div className="grid gap-5 lg:grid-cols-2">
            {signal.evidence.filter((section) => section.evidenceType !== "ai_narrative").map((section) => (
              <Surface key={section.id} tone="card" className="border-default">
                <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-text-muted">{section.evidenceType}</p>
                <h2 className="mt-2 font-display text-xl font-semibold text-text-primary">{section.title}</h2>
                <div className="mt-4 space-y-3 text-sm leading-6 text-text-muted">
                  {Object.entries(section.payload).map(([key, value]) => (
                    <div key={key} className="flex items-start justify-between gap-3 rounded-xl border border-default bg-bg-elevated/40 p-3">
                      <span className="font-medium text-text-primary">{prettyKey(key)}</span>
                      <span className="text-right">{renderValue(value)}</span>
                    </div>
                  ))}
                </div>
              </Surface>
            ))}
          </div>

          {aiNarrative ? (
            <Surface tone="card" className="border-default">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-text-muted">Next steps</p>
                  <h2 className="mt-1 font-display text-xl font-semibold text-text-primary">What to do now</h2>
                </div>
                <ListChecks className="size-5 text-accent-blue" />
              </div>

              <div className="mt-4 grid gap-4 lg:grid-cols-2">
                <div className="space-y-3 rounded-xl border border-default bg-bg-elevated/40 p-4">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-text-muted">Executive angle</p>
                  <p className="text-sm leading-6 text-text-primary">{String(aiNarrative.payload.executiveAngle ?? aiNarrative.title ?? signal.summary)}</p>
                </div>
                <div className="space-y-3 rounded-xl border border-default bg-bg-elevated/40 p-4">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-text-muted">Likely driver</p>
                  <p className="text-sm leading-6 text-text-primary">{String(aiNarrative.payload.likelyDriver ?? "Review the supporting evidence.")}</p>
                </div>
              </div>

              <div className="mt-4 grid gap-4 lg:grid-cols-2">
                <div className="space-y-3 rounded-xl border border-default bg-bg-elevated/40 p-4">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-text-muted">Recommended action</p>
                  <p className="text-sm leading-6 text-text-primary">{String(aiNarrative.payload.recommendedAction ?? "Review this with the owner and decide the response path.")}</p>
                </div>
                <div className="space-y-3 rounded-xl border border-default bg-bg-elevated/40 p-4">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-text-muted">Watchlist note</p>
                  <p className="text-sm leading-6 text-text-primary">{String(aiNarrative.payload.watchlistNote ?? "Keep this on a watchlist until the trend stabilizes.")}</p>
                </div>
              </div>

              <div className="mt-4 space-y-3">
                <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-text-muted">Action checklist</p>
                <div className="grid gap-3 md:grid-cols-3">
                  {Array.isArray(aiNarrative.payload.actionSteps)
                    ? (aiNarrative.payload.actionSteps as Array<{ label?: string; description?: string }>).map((step, index) => (
                        <div key={`${step.label ?? "step"}-${index}`} className="rounded-xl border border-default bg-bg-elevated/40 p-4">
                          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-text-muted">{step.label ?? `Step ${index + 1}`}</p>
                          <p className="mt-2 text-sm leading-6 text-text-primary">{step.description ?? "Follow up with the relevant owner."}</p>
                        </div>
                      ))
                    : null}
                </div>
              </div>
            </Surface>
          ) : null}

          <Surface tone="card" className="border-default">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-text-muted">Comments</p>
                <h2 className="mt-1 font-display text-xl font-semibold text-text-primary">{signal.comments.length} notes</h2>
              </div>
              <MessageSquare className="size-5 text-accent-blue" />
            </div>

            <div className="mt-4 space-y-3">
              {signal.comments.length === 0 ? (
                <p className="text-sm text-text-muted">No comments yet. Add a note to record the investigation trail.</p>
              ) : (
                signal.comments.map((item) => (
                  <div key={item.id} className="rounded-xl border border-default bg-bg-elevated/40 p-3">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm font-semibold text-text-primary">{item.authorEmail ?? item.authorId}</p>
                      <span className="text-xs text-text-muted">{formatTime(item.createdAt)}</span>
                    </div>
                    <p className="mt-2 text-sm leading-6 text-text-muted">{item.content}</p>
                  </div>
                ))
              )}
            </div>

            <div className="mt-4 flex flex-col gap-3 md:flex-row">
              <textarea
                value={comment}
                onChange={(event) => setComment(event.target.value)}
                rows={3}
                placeholder="Add an investigation note"
                className="min-h-[84px] flex-1 rounded-xl border border-default bg-bg-surface px-3 py-2 text-sm text-text-primary outline-none transition focus:border-accent-blue"
              />
              <Button
                onClick={() => withAction(() => api.comment(signal.id, comment), "Comment added")}
                disabled={comment.trim().length < 2}
              >
                <Send className="size-4" />
                Add note
              </Button>
            </div>
          </Surface>
        </main>

        <aside className="space-y-5">
          <Surface tone="card" className="border-default">
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-text-muted">Actions</p>
            <div className="mt-4 space-y-3">
              <label className="block">
                <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.2em] text-text-muted">Assign to user id</span>
                <input
                  value={owner}
                  onChange={(event) => setOwner(event.target.value)}
                  placeholder="Paste user id"
                  className="h-11 w-full rounded-xl border border-default bg-bg-surface px-3 text-sm text-text-primary outline-none transition focus:border-accent-blue"
                />
              </label>
              <Button
                variant="secondary"
                onClick={() => withAction(() => api.assign(signal.id, owner.trim() ? owner.trim() : null), "Assignment updated")}
              >
                <Share2 className="size-4" />
                Update assignee
              </Button>
              <Button
                variant="danger"
                onClick={() =>
                  withAction(
                    () => api.dismiss(signal.id, "Reviewed and dismissed in workspace"),
                    "Signal dismissed",
                  )
                }
              >
                <ShieldAlert className="size-4" />
                Dismiss
              </Button>
            </div>
          </Surface>

          <Surface tone="card" className="border-default">
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-text-muted">Board pack</p>
            <h2 className="mt-1 font-display text-xl font-semibold text-text-primary">Export this investigation</h2>
            <div className="mt-4 space-y-3">
              <label className="block">
                <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.2em] text-text-muted">Title</span>
                <input
                  value={boardPackTitle}
                  onChange={(event) => setBoardPackTitle(event.target.value)}
                  className="h-11 w-full rounded-xl border border-default bg-bg-surface px-3 text-sm text-text-primary outline-none transition focus:border-accent-blue"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.2em] text-text-muted">Audience</span>
                <input
                  value={audience}
                  onChange={(event) => setAudience(event.target.value)}
                  className="h-11 w-full rounded-xl border border-default bg-bg-surface px-3 text-sm text-text-primary outline-none transition focus:border-accent-blue"
                />
              </label>
              <Button
                onClick={() =>
                  withAction(
                    async () => {
                      await api.createBoardPack(signal.id, {
                        title: boardPackTitle,
                        audience,
                        exportFormat: "json",
                      });
                    },
                    "Board pack exported",
                  )
                }
              >
                <Sparkles className="size-4" />
                Create board pack
              </Button>
            </div>
          </Surface>

          <Surface tone="card" className="border-default">
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-text-muted">Board pack history</p>
            <div className="mt-4 space-y-3">
              {signal.boardPacks.length === 0 ? (
                <p className="text-sm text-text-muted">No board pack exports yet.</p>
              ) : (
                signal.boardPacks.map((pack) => (
                  <div key={pack.id} className="rounded-xl border border-default bg-bg-elevated/40 p-3">
                    <div className="flex items-center justify-between gap-3">
                      <p className="font-semibold text-text-primary">{pack.title}</p>
                      <StatusPill tone="info">{pack.exportFormat}</StatusPill>
                    </div>
                    <p className="mt-2 text-sm text-text-muted">{pack.audience}</p>
                    <p className="mt-2 text-xs text-text-muted">{formatTime(pack.createdAt)}</p>
                  </div>
                ))
              )}
            </div>
          </Surface>
        </aside>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-default bg-bg-elevated/40 p-3">
      <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-text-muted">{label}</p>
      <p className="mt-2 text-sm font-semibold text-text-primary">{value}</p>
    </div>
  );
}

function prettyKey(value: string) {
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function renderValue(value: unknown) {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number") return Number.isFinite(value) ? value.toLocaleString() : "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"}`;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
