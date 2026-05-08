"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { motion, AnimatePresence } from "framer-motion";
import { ApiError } from "../../../lib/api";
import { useNumeriquApi } from "../../../lib/useNumeriquApi";
import { cn } from "../../../components/ui/cn";
import type { ChatSessionSummary } from "../../../lib/api/types";
import {
  Sparkles,
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
            {sessions.map((session, i) => (
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
        <h2 className="font-display text-lg font-bold text-text-primary">RAG Advisor</h2>
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

// ─── RagWorkbench ─────────────────────────────────────────────────────────────

export function RagWorkbench() {
  const { rag, loading } = useNumeriquApi();

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
        },
      });
    } catch (caught) {
      const message =
        caught instanceof ApiError
          ? caught.toUserMessage("The advisor stream was interrupted. Please retry.")
          : caught instanceof Error
            ? caught.message
            : "The advisor stream was interrupted. Please retry.";
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
    <div className="flex h-[calc(100vh-9.5rem)] overflow-hidden rounded-2xl border border-default bg-bg-elevated/10">
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
            <span className="text-xs font-bold text-text-primary">RAG Advisor</span>
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
              {isStreaming ? (
                <Loader2 size={15} className="animate-spin" />
              ) : (
                <Send size={15} />
              )}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
