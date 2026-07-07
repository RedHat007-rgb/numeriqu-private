"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { motion, AnimatePresence } from "framer-motion";
import { ApiError } from "../../../lib/api";
import { useNumeriquApi } from "../../../lib/useNumeriquApi";
import { cn } from "../../../components/ui/cn";
import { StatusPill } from "../../../components/ui/StatusPill";
import type { ChatSessionSummary } from "../../../lib/api/types";
import {
  ArrowLeft,
  LayoutDashboard,
  Send,
  Loader2,
  Plus,
  ChevronRight,
  ChevronLeft,
  History,
  Clock,
  MessageSquare,
  BookOpen,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

type Message = { role: "user" | "assistant" | "system"; content: string };
type ClarificationPrompt = {
  question: string;
  options: Array<{ label: string; value: string }>;
  reason?: string;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function timeAgo(dateStr?: string): string {
  if (!dateStr) return "";
  const diff = Date.now() - new Date(dateStr).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(
    new Date(dateStr),
  );
}

// ─── Session Sidebar ──────────────────────────────────────────────────────────

function SessionSidebar({
  sessions,
  activeSessionId,
  onSelectSession,
  onNewSession,
  isLoading,
  collapsed,
  onToggleCollapse,
}: {
  sessions: ChatSessionSummary[];
  activeSessionId: string | null;
  onSelectSession: (id: string) => void;
  onNewSession: () => void;
  isLoading: boolean;
  collapsed: boolean;
  onToggleCollapse: () => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const visibleSessions = showAll ? sessions : sessions.slice(0, 14);

  return (
    <motion.div
      animate={{ width: collapsed ? 52 : 220 }}
      transition={{ type: "spring", stiffness: 320, damping: 32 }}
      className="relative flex h-full shrink-0 flex-col overflow-hidden border-r border-default bg-bg-elevated/20"
    >
      {/* Top bar */}
      <div
        className={cn(
          "flex items-center gap-2 border-b border-default p-3",
          collapsed && "justify-center",
        )}
      >
        {!collapsed && (
          <button
            onClick={onNewSession}
            className="flex flex-1 items-center gap-2 rounded-xl border border-default bg-bg-surface px-3 py-2 text-xs font-semibold text-text-secondary transition-all hover:border-accent-blue/40 hover:bg-accent-blue/5 hover:text-text-primary"
          >
            <Plus size={12} />
            New Chat
          </button>
        )}
        {collapsed && (
          <button
            onClick={onNewSession}
            title="New Chat"
            className="flex h-8 w-8 items-center justify-center rounded-xl border border-default text-text-muted hover:border-accent-blue/40 hover:text-accent-blue"
          >
            <Plus size={12} />
          </button>
        )}
        <button
          onClick={onToggleCollapse}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-default text-text-muted transition-colors hover:text-text-primary"
          title={collapsed ? "Expand" : "Collapse"}
        >
          {collapsed ? <ChevronRight size={12} /> : <ChevronLeft size={12} />}
        </button>
      </div>

      {/* Session list */}
      {!collapsed && (
        <div className="flex-1 overflow-y-auto p-2">
          {isLoading && (
            <div className="space-y-2 p-2">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-12 animate-pulse rounded-xl bg-bg-elevated" />
              ))}
            </div>
          )}

          {!isLoading && sessions.length === 0 && (
            <div className="flex flex-col items-center justify-center px-3 py-10 text-center">
              <History size={18} className="mb-2 text-text-muted opacity-40" />
              <p className="text-[10px] text-text-muted">No conversations yet</p>
            </div>
          )}

          <AnimatePresence initial={false}>
            {visibleSessions.map((session, i) => (
              <motion.button
                key={session.id}
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: i * 0.04 }}
                onClick={() => onSelectSession(session.id)}
                className={cn(
                  "mb-1 w-full rounded-xl border px-3 py-2.5 text-left transition-all",
                  session.id === activeSessionId
                    ? "border-accent-blue/30 bg-accent-blue/8 text-text-primary"
                    : "border-transparent text-text-secondary hover:border-default hover:bg-bg-elevated/60 hover:text-text-primary",
                )}
              >
                <p className="truncate text-xs font-medium leading-snug">
                  {session.title ?? "Conversation"}
                </p>
                <div className="mt-0.5 flex items-center gap-1.5">
                  {session.messageCount != null && (
                    <span className="flex items-center gap-0.5 text-[10px] text-text-muted">
                      <MessageSquare size={8} />
                      {session.messageCount}
                    </span>
                  )}
                  {session.updatedAt && (
                    <span className="flex items-center gap-0.5 text-[10px] text-text-muted">
                      <Clock size={8} />
                      {timeAgo(session.updatedAt)}
                    </span>
                  )}
                </div>
              </motion.button>
            ))}
          </AnimatePresence>

          {!isLoading && sessions.length > 14 ? (
            <div className="sticky bottom-0 -mx-2 mt-2 border-t border-default bg-bg-surface/80 p-2 backdrop-blur">
              <button
                type="button"
                onClick={() => setShowAll((v) => !v)}
                className="w-full rounded-xl border border-default bg-bg-elevated/40 px-3 py-2 text-[11px] font-semibold text-text-secondary hover:bg-bg-elevated/60 hover:text-text-primary"
              >
                {showAll ? "Show fewer" : `Show all conversations (${sessions.length})`}
              </button>
            </div>
          ) : null}
        </div>
      )}
    </motion.div>
  );
}

// ─── Welcome Screen ───────────────────────────────────────────────────────────

function WelcomeScreen() {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <motion.div
        initial={{ scale: 0.7, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: "spring", stiffness: 220, damping: 18 }}
        className="relative mb-5 flex h-14 w-14 items-center justify-center"
      >
        <motion.div
          animate={{ scale: [1, 1.18, 1] }}
          transition={{ duration: 2.5, repeat: Infinity, ease: "easeInOut" }}
          className="absolute inset-0 rounded-2xl bg-accent-blue/15"
        />
        <div className="relative flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-blue/10 ring-1 ring-accent-blue/25">
          <BookOpen size={24} className="text-accent-blue" />
        </div>
      </motion.div>

      <motion.div
        initial={{ y: 10, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.12 }}
      >
        <h2 className="font-display text-lg font-bold text-text-primary">Prism</h2>
        <p className="mt-1.5 max-w-[260px] text-xs leading-relaxed text-text-muted">
          Ask anything about your finances — revenue, burn rate, overdue invoices, cash flow, or entity comparisons.
        </p>
      </motion.div>
    </div>
  );
}

// ─── Message Bubble ───────────────────────────────────────────────────────────

function MessageBubble({
  message,
  isStreaming,
  isLast,
  statusMsg,
}: {
  message: Message;
  isStreaming: boolean;
  isLast: boolean;
  statusMsg: string | null;
}) {
  const isUser = message.role === "user";

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22 }}
      className={cn("flex gap-2.5", isUser ? "flex-row-reverse" : "flex-row")}
    >
      {!isUser && (
        <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-xl bg-accent-blue/10 ring-1 ring-accent-blue/20">
          <BookOpen size={11} className="text-accent-blue" />
        </div>
      )}

      <div
        className={cn(
          "max-w-[88%] rounded-2xl px-3.5 py-2.5 text-sm",
          isUser
            ? "bg-accent-blue/10 ring-1 ring-accent-blue/20 text-text-primary"
            : "bg-bg-elevated/60 ring-1 ring-default text-text-primary",
        )}
      >
        {message.content ? (
          <div className="prose prose-sm max-w-none leading-relaxed text-text-primary prose-headings:text-text-primary prose-strong:text-text-primary prose-a:text-accent-blue prose-code:text-accent-cyan prose-table:text-xs">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
          </div>
        ) : isStreaming && isLast ? (
          <span className="flex items-center gap-2 text-text-muted">
            <span className="flex gap-0.5">
              {[0, 1, 2].map((i) => (
                <motion.span
                  key={i}
                  animate={{ opacity: [0.25, 1, 0.25] }}
                  transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.18 }}
                  className="inline-block h-1.5 w-1.5 rounded-full bg-accent-blue"
                />
              ))}
            </span>
            <span className="text-xs italic">{statusMsg ?? "Thinking..."}</span>
          </span>
        ) : null}
      </div>
    </motion.div>
  );
}

function PrismComingSoonOverlay({
  onGoBack,
  onGoHome,
}: {
  onGoBack: () => void;
  onGoHome: () => void;
}) {
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center px-4 py-6 sm:px-6">
      <div className="absolute inset-0 bg-slate-950/50 backdrop-blur-2xl" />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(70,126,255,0.18),transparent_42%),radial-gradient(circle_at_bottom_right,rgba(43,124,255,0.12),transparent_26%)]" />
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.22, ease: "easeOut" }}
        className="relative w-full max-w-4xl overflow-hidden rounded-[28px] border border-white/10 bg-bg-card/92 shadow-2xl shadow-black/45 ring-1 ring-white/5"
      >
        <div className="absolute inset-x-0 top-0 h-1 bg-[linear-gradient(90deg,#2b7cff_0%,#79a9ff_50%,#2b7cff_100%)]" />
        <div className="grid gap-0 lg:grid-cols-[1.2fr_0.8fr]">
          <div className="border-b border-white/8 p-6 sm:p-8 lg:border-b-0 lg:border-r lg:border-white/8">
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex size-12 items-center justify-center rounded-2xl bg-accent-blue/10 ring-1 ring-accent-blue/20">
                <BookOpen size={22} className="text-accent-blue" />
              </div>
              <StatusPill tone="neutral" withDot={false} className="px-2.5 py-1 text-[10px] uppercase tracking-[0.18em]">
                Coming soon
              </StatusPill>
            </div>

            <h2 className="mt-5 max-w-lg font-display text-3xl font-bold tracking-tight text-text-primary sm:text-4xl">
              Prism is almost here.
            </h2>
            <p className="mt-4 max-w-xl text-sm leading-7 text-text-muted sm:text-base">
              We’re shaping Prism into a focused evidence workspace for finance. For now, the product is still under construction, so this area stays locked while we finish it.
            </p>

            <div className="mt-6 grid gap-3 sm:grid-cols-2">
              {[
                "Cited answers from live data",
                "Fast navigation back to workspace",
                "A cleaner, guided launch screen",
                "Prism first, clutter later",
              ].map((item) => (
                <div
                  key={item}
                  className="rounded-2xl border border-white/8 bg-white/[0.03] px-4 py-3 text-sm font-medium text-text-primary ring-1 ring-white/5"
                >
                  {item}
                </div>
              ))}
            </div>
          </div>

          <div className="flex flex-col justify-between gap-6 bg-white/[0.03] p-6 sm:p-8">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-text-muted">
                Launch status
              </p>
              <div className="mt-4 rounded-3xl border border-white/8 bg-bg-surface/55 p-4 ring-1 ring-white/5">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-semibold text-text-primary">Prism</span>
                  <span className="rounded-full bg-accent-blue/12 px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.2em] text-accent-blue">
                    Building
                  </span>
                </div>
                <div className="mt-4 space-y-3">
                  <div className="h-3 rounded-full bg-white/8">
                    <div className="h-3 w-[38%] rounded-full bg-[linear-gradient(90deg,#2b7cff,#79a9ff)]" />
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <div className="h-16 rounded-2xl border border-white/8 bg-white/[0.03]" />
                    <div className="h-16 rounded-2xl border border-white/8 bg-white/[0.03]" />
                    <div className="h-16 rounded-2xl border border-white/8 bg-white/[0.03]" />
                  </div>
                </div>
              </div>
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              <button
                type="button"
                onClick={onGoBack}
                className="inline-flex items-center justify-center gap-2 rounded-2xl border border-default bg-bg-surface px-4 py-3 text-sm font-semibold text-text-primary transition-colors hover:bg-bg-elevated/70"
              >
                <ArrowLeft size={16} />
                Go back
              </button>
              <button
                type="button"
                onClick={onGoHome}
                className="inline-flex items-center justify-center gap-2 rounded-2xl bg-accent-blue px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-accent-blue/90"
              >
                <LayoutDashboard size={16} />
                Back to dashboard
              </button>
            </div>
          </div>
        </div>
      </motion.div>
    </div>
  );
}

// ─── RagWorkbench ─────────────────────────────────────────────────────────────

export function RagWorkbench() {
  const router = useRouter();
  const { rag, loading } = useNumeriquApi();
  const searchParams = useSearchParams();
  const autoAskRef = useRef(false);
  const showComingSoon = true;

  // Sidebar
  const [sessions, setSessions] = useState<ChatSessionSummary[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  // Conversation
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingClarification, setPendingClarification] = useState<ClarificationPrompt | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // ── Load sessions ────────────────────────────────────────────────────────────

  const loadSessions = useCallback(async () => {
    if (loading) return;
    setSessionsLoading(true);
    try {
      const list = await rag.sessions();
      setSessions(list);
    } catch {
      /* non-fatal */
    } finally {
      setSessionsLoading(false);
    }
  }, [rag, loading]);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  // ── Auto-ask from ?q=... (Command Palette) ──────────────────────────────────

  useEffect(() => {
    if (loading) return;
    if (autoAskRef.current) return;
    const q = searchParams.get("q");
    if (!q) return;
    autoAskRef.current = true;
    handleNewSession();
    setTimeout(() => void ask(q), 50);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  // ── Auto-scroll ──────────────────────────────────────────────────────────────

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  // ── Session actions ──────────────────────────────────────────────────────────

  async function handleSelectSession(id: string) {
    if (id === sessionId) return;
    setError(null);
    setMessages([]);
    setSessionId(id);
    try {
      const detail = await rag.session(id);
      setMessages((detail.messages as Message[]) ?? []);
    } catch {
      /* non-fatal */
    }
  }

  function handleNewSession() {
    setMessages([]);
    setSessionId(null);
    setError(null);
    setTimeout(() => inputRef.current?.focus(), 50);
  }

  // ── Ask ──────────────────────────────────────────────────────────────────────

  async function ask(query: string) {
    const trimmed = query.trim();
    if (!trimmed || isStreaming) return;

    setError(null);
    setInput("");
    setStatusMsg(null);
    setPendingClarification(null);
    setIsStreaming(true);
    setMessages((prev) => [
      ...prev,
      { role: "user", content: trimmed },
      { role: "assistant", content: "" },
    ]);

    try {
      await rag.streamQuery({
        query: trimmed,
        sessionId,
        onDelta: (delta) => {
          setMessages((prev) => {
            const copy = [...prev];
            const last = copy[copy.length - 1];
            if (last?.role === "assistant") {
              copy[copy.length - 1] = { ...last, content: last.content + delta };
            }
            return copy;
          });
        },
        onMessage: (msg: any) => {
          if (msg.type === "done" && msg.metrics?.sessionId) {
            setSessionId(msg.metrics.sessionId as string);
            setStatusMsg(null);
            void loadSessions();
          }
          if (msg.type === "status") {
            setStatusMsg(msg.message as string);
          }
          if (msg.type === "clarify") {
            setPendingClarification({
              question: String(msg.question ?? "Clarify"),
              reason: msg.reason ? String(msg.reason) : undefined,
              options: Array.isArray(msg.options)
                ? msg.options.map((o: any) => ({ label: String(o.label ?? ""), value: String(o.value ?? "") }))
                : [],
            });
          }
        },
      });
    } catch (caught) {
      const message =
        caught instanceof ApiError
          ? caught.toUserMessage("The advisor stream was interrupted. Please retry.")
          : caught instanceof Error
            ? caught.message
            : "Prism stream was interrupted. Please retry.";
      setError(message);
      setMessages((prev) => {
        const copy = [...prev];
        if (copy[copy.length - 1]?.role === "assistant" && !copy[copy.length - 1]?.content) {
          copy.pop();
        }
        return copy;
      });
    } finally {
      setIsStreaming(false);
      setStatusMsg(null);
    }
  }

  const hasConversation = messages.filter((m) => m.role !== "system").length > 0;
  const visibleMessages = messages.filter((m) => m.role !== "system");

  return (
    <div className="relative surface-card flex h-full overflow-hidden p-0">
      <div className={cn("flex h-full w-full overflow-hidden", showComingSoon && "blur-[2px] saturate-75")}>
        {/* ── Col 1: History Sidebar ── */}
        <SessionSidebar
          sessions={sessions}
          activeSessionId={sessionId}
          onSelectSession={(id) => void handleSelectSession(id)}
          onNewSession={handleNewSession}
          isLoading={sessionsLoading}
          collapsed={sidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed((c) => !c)}
        />

        {/* ── Col 2: Chat ── */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-default px-4 py-3">
            <div className="flex items-center gap-2">
              <BookOpen size={13} className="text-accent-blue" />
              <span className="text-xs font-bold text-text-primary">Prism</span>
              <StatusPill tone="neutral" withDot={false} className="px-2 py-0.5 text-[10px] uppercase tracking-[0.18em]">
                Coming soon
              </StatusPill>
            </div>
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider",
                isStreaming ? "bg-accent-blue/12 text-accent-blue" : "bg-bg-elevated text-text-muted",
              )}
            >
              {isStreaming ? "thinking" : "ready"}
            </span>
          </div>

          {/* Messages */}
          <div ref={scrollRef} className="flex-1 overflow-y-auto p-4">
            {!hasConversation ? (
              <WelcomeScreen />
            ) : (
              <div className="space-y-4">
                <AnimatePresence initial={false}>
                  {visibleMessages.map((message, index) => (
                    <MessageBubble
                      key={index}
                      message={message}
                      isStreaming={isStreaming}
                      isLast={index === visibleMessages.length - 1}
                      statusMsg={statusMsg}
                    />
                  ))}
                </AnimatePresence>
              </div>
            )}
          </div>

          {/* Error */}
          <AnimatePresence>
            {error && (
              <motion.div
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 4 }}
                className="mx-3 mb-2 flex items-start justify-between gap-2 rounded-xl border border-feedback-danger/25 bg-feedback-danger/8 px-3 py-2 text-xs text-feedback-danger"
              >
                <span className="flex-1">{error}</span>
                <button
                  onClick={() => setError(null)}
                  className="shrink-0 text-feedback-danger/60 hover:text-feedback-danger"
                >
                  ✕
                </button>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Input */}
          <div className="border-t border-default p-3">
            <AnimatePresence>
              {pendingClarification && !isStreaming ? (
                <motion.div
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 6 }}
                  className="mb-2 rounded-xl border border-accent-blue/20 bg-accent-blue/6 p-3"
                >
                  <p className="text-xs font-semibold text-text-primary">{pendingClarification.question}</p>
                  {pendingClarification.reason ? (
                    <p className="mt-1 text-[11px] text-text-muted">{pendingClarification.reason}</p>
                  ) : null}
                  {pendingClarification.options.length > 0 ? (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {pendingClarification.options.map((opt) => (
                        <button
                          key={opt.label}
                          type="button"
                          onClick={() => void ask(opt.value)}
                          className="rounded-full bg-bg-elevated px-3 py-1 text-[11px] font-semibold text-text-secondary ring-1 ring-default transition-colors hover:bg-bg-elevated/70 hover:text-text-primary"
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  <p className="mt-2 text-[10px] text-text-muted">You can also type your answer and press send.</p>
                </motion.div>
              ) : null}
            </AnimatePresence>
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void ask(input);
              }}
            >
              <input
                ref={inputRef}
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                disabled={isStreaming}
                placeholder="Ask about revenue, burn rate, overdue invoices, cash flow..."
                className="flex-1 rounded-xl border border-default bg-bg-surface/70 px-4 py-2.5 text-sm text-text-primary outline-none transition-colors focus:border-accent-blue/50 disabled:opacity-50"
              />
              <button
                type="submit"
                disabled={!input.trim() || isStreaming}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-blue text-white shadow-md transition-all hover:bg-accent-blue/90 disabled:cursor-not-allowed disabled:opacity-35"
              >
                {isStreaming ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
              </button>
            </form>
          </div>
        </div>
      </div>
      {showComingSoon ? (
        <PrismComingSoonOverlay
          onGoBack={() => router.back()}
          onGoHome={() => router.push("/dashboard")}
        />
      ) : null}
    </div>
  );
}
