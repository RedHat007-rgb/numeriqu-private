"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "sonner";
import { ApiError } from "../../../lib/api";
import { useNumeriquApi } from "../../../lib/useNumeriquApi";
import { cn } from "../../../components/ui/cn";
import { DashboardPreview } from "./DashboardPreview";
import type { ChatSessionSummary } from "../../../lib/api/types";
import {
  Brain,
  Database,
  BarChart3,
  Sparkles,
  CheckCircle2,
  Loader2,
  ChevronRight,
  LayoutDashboard,
  TrendingUp,
  Users,
  FileText,
  Flame,
  Search,
  Plus,
  Edit3,
  PenLine,
  Send,
  Activity,
  History,
  ChevronLeft,
  Wand2,
  Clock,
  MessageSquare,
} from "lucide-react";

// ─── Types ─────────────────────────────────────────────────────────────────────

type ChartTurnMetadata = {
  kind?: string;
  mode?: "create" | "edit";
  versionNumber?: number;
  previousVersionNumber?: number | null;
  dashboardId?: string | null;
  dashboardTitle?: string;
  widgetCount?: number;
  prompt?: string;
  summary?: string;
  widgetSnapshots?: Array<{
    title?: string;
    chartType?: string;
    displayOrder?: number;
  }>;
  intent?: "CREATE_DASHBOARD" | "EDIT_DASHBOARD" | null;
};

type Message = {
  role: "user" | "assistant" | "system";
  content: string;
  metadata?: ChartTurnMetadata | null;
};
type Phase = { id: string; label: string; status: "pending" | "running" | "done" };
type ToolCall = { tool: string; label: string; status: "running" | "done"; rowCount?: number };
type QueryIntent = "CREATE_DASHBOARD" | "EDIT_DASHBOARD" | null;
type ClarificationPrompt = {
  question: string;
  options: Array<{ label: string; value: string }>;
  reason?: string;
};

// ─── Config ────────────────────────────────────────────────────────────────────

const SAMPLE_PROMPTS = [
  {
    label: "CFO Board Pack",
    icon: BarChart3,
    prompt: "Build a full CFO board pack with spend trend, vendor concentration, burn analysis, and an investor-ready summary.",
    color: "text-accent-violet",
    bg: "bg-accent-violet/8",
  },
  {
    label: "Cash Runway Model",
    icon: Flame,
    prompt: "Model my cash runway. What is my current burn rate and when do I need to raise?",
    color: "text-feedback-danger",
    bg: "bg-feedback-danger/8",
  },
  {
    label: "Overdue Risk Audit",
    icon: TrendingUp,
    prompt: "Deep-dive into overdue receivables. Quantify the concentration risk and flag the highest exposure entities.",
    color: "text-feedback-warning",
    bg: "bg-feedback-warning/8",
  },
  {
    label: "Entity Comparison",
    icon: Users,
    prompt: "Compare spend concentration across all my connected entities. Which vendors or entities drive the most cost and why?",
    color: "text-accent-cyan",
    bg: "bg-accent-cyan/8",
  },
  {
    label: "Quarterly Review",
    icon: Search,
    prompt: "Give me a full quarterly spend analysis with quarter-over-quarter comparisons and vendor signals.",
    color: "text-accent-blue",
    bg: "bg-accent-blue/8",
  },
];

const EDIT_CHIPS = [
  "Add quarterly comparison",
  "Show vendor breakdown",
  "Add cash runway",
  "Switch to bar charts",
];

const PHASE_ICONS: Record<string, React.ElementType> = {
  planning: Brain,
  execution: Database,
  dashboard: LayoutDashboard,
  synthesis: Sparkles,
};

const TOOL_ICONS: Record<string, React.ElementType> = {
  revenue_trend: TrendingUp,
  entity_comparison: Users,
  invoice_breakdown: FileText,
  venture_metrics: Flame,
  financial_summary: Search,
};

// ─── Helpers ───────────────────────────────────────────────────────────────────

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
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(dateStr));
}

function isChartTurnMetadata(metadata: unknown): metadata is ChartTurnMetadata {
  return !!metadata && typeof metadata === "object" && (metadata as ChartTurnMetadata).kind === "chart_turn";
}

// ─── Session Sidebar ───────────────────────────────────────────────────────────

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
      <div className={cn("flex items-center gap-2 border-b border-default p-3", collapsed && "justify-center")}>
        {!collapsed && (
          <button
            onClick={onNewSession}
            className="flex flex-1 items-center gap-2 rounded-xl border border-default bg-bg-surface px-3 py-2 text-xs font-semibold text-text-secondary transition-all hover:border-accent-violet/40 hover:bg-accent-violet/5 hover:text-text-primary"
          >
            <Plus size={12} />
            New Chat
          </button>
        )}
        {collapsed && (
          <button
            onClick={onNewSession}
            title="New Chat"
            className="flex h-8 w-8 items-center justify-center rounded-xl border border-default text-text-muted hover:border-accent-violet/40 hover:text-accent-violet"
          >
            <Plus size={12} />
          </button>
        )}
        <button
          onClick={onToggleCollapse}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-default text-text-muted transition-colors hover:border-default hover:text-text-primary"
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
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
                    ? "border-accent-violet/30 bg-accent-violet/8 text-text-primary"
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

// ─── Agent Thinking Panel ──────────────────────────────────────────────────────

function AgentThinkingPanel({
  phases,
  toolCalls,
  dashboardInfo,
  intent,
}: {
  phases: Phase[];
  toolCalls: ToolCall[];
  dashboardInfo: { title?: string; widgetCount?: number; summary?: string; isEdit?: boolean } | null;
  intent: QueryIntent;
}) {
  if (phases.length === 0) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      className="rounded-2xl border border-default bg-bg-elevated/50 p-4 space-y-3"
    >
      <div className="flex items-center gap-2">
        <motion.div
          animate={{ rotate: [0, 15, -15, 0] }}
          transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
        >
          <Sparkles size={11} className="text-accent-violet" />
        </motion.div>
        <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-accent-violet">
          Agent Execution
        </p>
        {intent && (
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider",
              intent === "EDIT_DASHBOARD"
                ? "bg-accent-cyan/12 text-accent-cyan"
                : "bg-accent-violet/12 text-accent-violet",
            )}
          >
            {intent === "EDIT_DASHBOARD" ? "refining" : "creating"}
          </span>
        )}
      </div>

      <div className="space-y-2">
        {phases.map((phase, i) => {
          const Icon = PHASE_ICONS[phase.id] ?? Brain;
          return (
            <motion.div
              key={phase.id}
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: i * 0.08 }}
              className="flex items-center gap-2.5"
            >
              <div
                className={cn(
                  "flex h-6 w-6 shrink-0 items-center justify-center rounded-full",
                  phase.status === "done"
                    ? "bg-feedback-success/15 text-feedback-success"
                    : phase.status === "running"
                      ? "bg-accent-violet/15 text-accent-violet"
                      : "bg-bg-elevated text-text-muted",
                )}
              >
                {phase.status === "done" ? (
                  <CheckCircle2 size={12} />
                ) : phase.status === "running" ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <Icon size={12} />
                )}
              </div>
              <span
                className={cn(
                  "text-xs",
                  phase.status === "done"
                    ? "font-semibold text-text-primary"
                    : phase.status === "running"
                      ? "font-semibold text-accent-violet"
                      : "text-text-muted",
                )}
              >
                {phase.label}
              </span>
            </motion.div>
          );
        })}
      </div>

      {toolCalls.length > 0 && (
        <div className="space-y-1.5 border-t border-default pt-3">
          <p className="text-[9px] font-bold uppercase tracking-[0.2em] text-text-muted">Data tools</p>
          {toolCalls.map((tc, i) => {
            const Icon = TOOL_ICONS[tc.tool] ?? Database;
            return (
              <motion.div
                key={i}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: i * 0.05 }}
                className="flex items-center gap-2"
              >
                <ChevronRight size={9} className="shrink-0 text-text-muted" />
                <Icon
                  size={9}
                  className={tc.status === "done" ? "text-feedback-success" : "text-accent-cyan"}
                />
                <span className="flex-1 text-[11px] font-medium text-text-secondary">{tc.label}</span>
                {tc.status === "running" ? (
                  <Loader2 size={9} className="animate-spin text-accent-violet" />
                ) : tc.rowCount !== undefined ? (
                  <span className="text-[9px] text-text-muted">{tc.rowCount} rows</span>
                ) : null}
              </motion.div>
            );
          })}
        </div>
      )}

      {dashboardInfo && (
        <motion.div
          initial={{ opacity: 0, scale: 0.97 }}
          animate={{ opacity: 1, scale: 1 }}
          className={cn(
            "flex items-center gap-2.5 rounded-xl border p-2.5",
            dashboardInfo.isEdit
              ? "border-accent-cyan/20 bg-accent-cyan/8"
              : "border-feedback-success/20 bg-feedback-success/8",
          )}
        >
          {dashboardInfo.isEdit ? (
            <Edit3 size={13} className="shrink-0 text-accent-cyan" />
          ) : (
            <BarChart3 size={13} className="shrink-0 text-feedback-success" />
          )}
          <div className="min-w-0 flex-1">
            <p
              className={cn(
                "truncate text-xs font-semibold",
                dashboardInfo.isEdit ? "text-accent-cyan" : "text-feedback-success",
              )}
            >
              {dashboardInfo.isEdit ? "Dashboard Updated" : "Dashboard Generated"}
            </p>
            <p className="truncate text-[10px] text-text-muted">
              {dashboardInfo.summary ?? dashboardInfo.title}
            </p>
          </div>
          <CheckCircle2
            size={12}
            className={cn("shrink-0", dashboardInfo.isEdit ? "text-accent-cyan" : "text-feedback-success")}
          />
        </motion.div>
      )}
    </motion.div>
  );
}

// ─── Welcome Screen ────────────────────────────────────────────────────────────

function WelcomeScreen({ onPrompt }: { onPrompt: (p: string) => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-4 py-8">
      <motion.div
        initial={{ scale: 0.7, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: "spring", stiffness: 220, damping: 18 }}
        className="relative mb-5 flex h-14 w-14 items-center justify-center"
      >
        <motion.div
          animate={{ scale: [1, 1.18, 1] }}
          transition={{ duration: 2.5, repeat: Infinity, ease: "easeInOut" }}
          className="absolute inset-0 rounded-2xl bg-accent-violet/15"
        />
        <div className="relative flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-violet/10 ring-1 ring-accent-violet/25">
          <Sparkles size={26} className="text-accent-violet" />
        </div>
      </motion.div>

      <motion.div
        initial={{ y: 10, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.12 }}
        className="mb-1 text-center"
      >
        <h2 className="font-display text-lg font-bold text-text-primary">
          Good to see you.
        </h2>
        <p className="mt-1.5 max-w-[240px] text-xs leading-relaxed text-text-muted">
          Tell me what you need — I&apos;ll build the analysis and dashboard, instantly.
        </p>
      </motion.div>

      <motion.div
        initial={{ y: 14, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.2 }}
        className="mt-6 w-full space-y-2"
      >
        {SAMPLE_PROMPTS.map((sp, i) => (
          <motion.button
            key={sp.label}
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.24 + i * 0.06 }}
            onClick={() => onPrompt(sp.prompt)}
            className="group flex w-full items-center gap-3 rounded-xl border border-default bg-bg-elevated/30 px-3 py-2.5 text-left transition-all hover:border-accent-violet/30 hover:bg-accent-violet/5"
          >
            <div className={cn("flex h-6 w-6 shrink-0 items-center justify-center rounded-lg", sp.bg)}>
              <sp.icon size={12} className={sp.color} />
            </div>
            <span className="flex-1 text-xs font-medium text-text-secondary transition-colors group-hover:text-text-primary">
              {sp.label}
            </span>
            <ChevronRight
              size={11}
              className="shrink-0 text-text-muted opacity-0 transition-opacity group-hover:opacity-100"
            />
          </motion.button>
        ))}
      </motion.div>
    </div>
  );
}

// ─── Message Bubble ────────────────────────────────────────────────────────────

function MessageBubble({
  message,
  isStreaming,
  isLast,
}: {
  message: Message;
  isStreaming: boolean;
  isLast: boolean;
}) {
  const isUser = message.role === "user";
  const chartTurn = isChartTurnMetadata(message.metadata) ? message.metadata : null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22 }}
      className={cn("flex gap-2.5", isUser ? "flex-row-reverse" : "flex-row")}
    >
      {!isUser && (
        <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-xl bg-accent-violet/10 ring-1 ring-accent-violet/20">
          <Sparkles size={11} className="text-accent-violet" />
        </div>
      )}

      <div
        className={cn(
          "max-w-[88%] rounded-2xl px-3.5 py-2.5 text-sm",
          isUser
            ? "bg-accent-violet/12 ring-1 ring-accent-violet/25 text-text-primary"
            : "bg-bg-elevated/60 ring-1 ring-default text-text-primary",
        )}
      >
        {chartTurn && !isUser && (
          <div className="mb-3 rounded-2xl border border-accent-cyan/20 bg-accent-cyan/5 p-3 shadow-sm">
            <div className="mb-2 flex items-center gap-2">
              <span className="rounded-full bg-accent-cyan/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-accent-cyan">
                Chart v{chartTurn.versionNumber ?? "?"}
              </span>
              <span className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">
                {chartTurn.mode === "edit" ? "updated chart" : "new chart"}
              </span>
              {typeof chartTurn.previousVersionNumber === "number" && (
                <span className="rounded-full bg-bg-elevated px-2 py-0.5 text-[10px] font-semibold text-text-muted">
                  preserves v{chartTurn.previousVersionNumber}
                </span>
              )}
            </div>
            <p className="text-sm font-semibold text-text-primary">
              {chartTurn.dashboardTitle ?? "Dashboard"}
            </p>
            <p className="mt-1 text-xs text-text-muted">
              {chartTurn.summary ?? "Chart generated from the current conversation."}
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <span className="rounded-full bg-bg-elevated px-2 py-0.5 text-[10px] font-semibold text-text-muted">
                {chartTurn.widgetCount ?? 0} widgets
              </span>
              {chartTurn.intent && (
                <span className="rounded-full bg-bg-elevated px-2 py-0.5 text-[10px] font-semibold text-text-muted">
                  {chartTurn.intent === "EDIT_DASHBOARD" ? "edit" : "create"}
                </span>
              )}
              {chartTurn.widgetSnapshots?.slice(0, 3).map((widget) => (
                <span
                  key={`${widget.title ?? "widget"}-${widget.displayOrder ?? 0}`}
                  className="rounded-full bg-bg-elevated px-2 py-0.5 text-[10px] font-semibold text-text-muted"
                >
                  {widget.title ?? "Chart"}
                </span>
              ))}
            </div>
          </div>
        )}

        {message.content ? (
          <div className="prose prose-sm max-w-none leading-relaxed text-text-primary prose-headings:text-text-primary prose-strong:text-text-primary prose-a:text-accent-violet prose-code:text-accent-cyan prose-table:text-xs">
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
                  className="inline-block h-1.5 w-1.5 rounded-full bg-accent-violet"
                />
              ))}
            </span>
            <span className="text-xs italic">Synthesizing intelligence...</span>
          </span>
        ) : null}
      </div>
    </motion.div>
  );
}

// ─── Edit Mode Bar ─────────────────────────────────────────────────────────────

function EditModeBar({
  dashboardTitle,
  onChip,
}: {
  dashboardTitle: string;
  onChip: (s: string) => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-xl border border-accent-cyan/20 bg-accent-cyan/5 p-3"
    >
      <div className="mb-2 flex items-center gap-1.5">
        <Wand2 size={10} className="text-accent-cyan" />
        <span className="text-[10px] font-bold uppercase tracking-wider text-accent-cyan">
          Editing mode
        </span>
        <span className="ml-auto max-w-[150px] truncate text-[10px] text-text-muted">
          {dashboardTitle}
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {EDIT_CHIPS.map((chip) => (
          <button
            key={chip}
            onClick={() => onChip(chip)}
            className="rounded-full border border-accent-cyan/20 px-2.5 py-1 text-[10px] font-medium text-accent-cyan/80 transition-all hover:border-accent-cyan/40 hover:bg-accent-cyan/8 hover:text-accent-cyan"
          >
            {chip}
          </button>
        ))}
      </div>
    </motion.div>
  );
}

// ─── Dashboard Generating Overlay ──────────────────────────────────────────────

function DashboardGeneratingOverlay() {
  return (
    <div className="flex flex-col items-center justify-center gap-5 py-12">
      <div className="relative flex h-16 w-16 items-center justify-center">
        <motion.div
          animate={{ scale: [1, 1.4, 1], opacity: [0.4, 0.15, 0.4] }}
          transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
          className="absolute inset-0 rounded-2xl bg-accent-violet"
        />
        <div className="relative flex h-16 w-16 items-center justify-center rounded-2xl bg-accent-violet/15 ring-1 ring-accent-violet/30">
          <Sparkles size={28} className="text-accent-violet" />
        </div>
      </div>
      <div className="text-center">
        <p className="text-sm font-semibold text-text-primary">Building your dashboard...</p>
        <p className="mt-1 text-xs text-text-muted">
          Executing data tools · Designing charts · Writing analysis
        </p>
      </div>
      <div className="w-full space-y-3 px-2">
        {[200, 160, 220, 180].map((h, i) => (
          <motion.div
            key={i}
            animate={{ opacity: [0.3, 0.65, 0.3] }}
            transition={{ duration: 1.6, repeat: Infinity, delay: i * 0.22 }}
            className="w-full rounded-2xl bg-bg-elevated"
            style={{ height: h }}
          />
        ))}
      </div>
    </div>
  );
}

// ─── AgentWorkbench ────────────────────────────────────────────────────────────

export function AgentWorkbench() {
  const { agent, loading } = useNumeriquApi();
  const searchParams = useSearchParams();
  const autoRunRef = useRef(false);

  // Sidebar state
  const [sessions, setSessions] = useState<ChatSessionSummary[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  // Conversation state
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingClarification, setPendingClarification] = useState<ClarificationPrompt | null>(null);

  // Dashboard state
  const [syncTrigger, setSyncTrigger] = useState(0);
  const [isDashboardGenerating, setIsDashboardGenerating] = useState(false);
  const [activeDashboardTitle, setActiveDashboardTitle] = useState<string | null>(null);
  // True when the user clicked an old session from the sidebar (not a live/new chat)
  const [isHistoricalSession, setIsHistoricalSession] = useState(false);

  // Agent thinking state
  const [phases, setPhases] = useState<Phase[]>([]);
  const [toolCalls, setToolCalls] = useState<ToolCall[]>([]);
  const [dashboardInfo, setDashboardInfo] = useState<{
    title?: string;
    widgetCount?: number;
    summary?: string;
    isEdit?: boolean;
  } | null>(null);
  const [currentIntent, setCurrentIntent] = useState<QueryIntent>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // ── Load sessions ──────────────────────────────────────────────────────────

  const loadSessions = useCallback(async () => {
    if (loading) return;
    setSessionsLoading(true);
    try {
      const list = await agent.sessions();
      setSessions(list);
    } catch {
      /* non-fatal */
    } finally {
      setSessionsLoading(false);
    }
  }, [agent, loading]);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  // ── Load session from URL param (?sessionId=...) ───────────────────────────

  useEffect(() => {
    const urlSessionId = searchParams.get("sessionId");
    if (urlSessionId && !loading) {
      void handleSelectSession(urlSessionId);
    }
    // Only run once on mount / when auth resolves
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  // ── Auto-run from ?q=... (Command Palette) ─────────────────────────────────

  useEffect(() => {
    if (loading) return;
    if (autoRunRef.current) return;
    const q = searchParams.get("q");
    if (!q) return;
    autoRunRef.current = true;
    handleNewSession();
    setTimeout(() => void execute(q), 50);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  // ── Auto-scroll ────────────────────────────────────────────────────────────

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, phases, toolCalls]);

  // ── Helpers ────────────────────────────────────────────────────────────────

  function resetThinking() {
    setPhases([]);
    setToolCalls([]);
    setDashboardInfo(null);
    setCurrentIntent(null);
  }

  function updatePhase(phaseId: string, status: Phase["status"], label?: string) {
    setPhases((prev) => {
      const existing = prev.find((p) => p.id === phaseId);
      if (existing) {
        return prev.map((p) =>
          p.id === phaseId ? { ...p, status, ...(label ? { label } : {}) } : p,
        );
      }
      return [...prev, { id: phaseId, label: label ?? phaseId, status }];
    });
  }

  function attachAssistantMetadata(metadata: ChartTurnMetadata | null) {
    if (!metadata) return;
    setMessages((prev) => {
      const copy = [...prev];
      const last = copy[copy.length - 1];
      if (last?.role === "assistant") {
        copy[copy.length - 1] = { ...last, metadata };
      }
      return copy;
    });
  }

  async function handleSelectSession(id: string) {
    if (id === sessionId) return;
    resetThinking();
    setError(null);
    setPendingClarification(null);
    setMessages([]);
    setSessionId(id);
    setActiveDashboardTitle(null);
    setIsHistoricalSession(true); // loaded from sidebar — not a live session
    try {
      const detail = await agent.session(id);
      setMessages((detail.messages as Message[]) ?? []);
    } catch {
      /* non-fatal */
    }
  }

  function handleNewSession() {
    setMessages([]);
    setSessionId(null);
    setActiveDashboardTitle(null);
    setIsHistoricalSession(false);
    resetThinking();
    setError(null);
    setPendingClarification(null);
    setTimeout(() => inputRef.current?.focus(), 50);
  }

  // ── Execute ────────────────────────────────────────────────────────────────

  async function execute(prompt: string) {
    const query = prompt.trim();
    if (!query || isStreaming) return;

    setError(null);
    setInput("");
    resetThinking();
    setPendingClarification(null);
    setIsDashboardGenerating(true);

    setMessages((prev) => [
      ...prev,
      { role: "user", content: query },
      { role: "assistant", content: "" },
    ]);
    setIsStreaming(true);

    try {
      await agent.streamQuery({
        query,
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
            const newId = msg.metrics.sessionId as string;
            setSessionId(newId);
            void loadSessions();
          }

          if (msg.type === "intent") {
            setCurrentIntent(msg.intent as QueryIntent);
            if (msg.activeDashboardTitle) {
              setActiveDashboardTitle(msg.activeDashboardTitle as string);
            }
          }

          if (msg.type === "clarify") {
            const question = String(msg.question ?? "Quick clarification:");
            const options = Array.isArray(msg.options) ? (msg.options as any[]) : [];

            setPendingClarification({
              question,
              options: options
                .map((o) => ({
                  label: String(o?.label ?? "").trim(),
                  value: String(o?.value ?? "").trim(),
                }))
                .filter((o) => o.label && o.value)
                .slice(0, 6),
              reason: typeof msg.reason === "string" ? msg.reason : undefined,
            });

            // Fill the current assistant bubble with the question so it is visible in history.
            setMessages((prev) => {
              const copy = [...prev];
              const last = copy[copy.length - 1];
              if (last?.role === "assistant") {
                const optionLines = options
                  .map((o, i) => `${i + 1}) ${String(o?.label ?? "").trim()}`)
                  .filter(Boolean)
                  .join("\n");
                copy[copy.length - 1] = {
                  ...last,
                  content: [question, optionLines].filter(Boolean).join("\n\n"),
                };
              }
              return copy;
            });

            setIsDashboardGenerating(false);
          }

          if (msg.type === "phase") {
            updatePhase(msg.phase, "running", msg.label);
            setPhases((prev) => {
              const order = ["planning", "execution", "dashboard", "synthesis"];
              const idx = order.indexOf(msg.phase);
              return prev.map((p) => {
                const pi = order.indexOf(p.id);
                return pi < idx ? { ...p, status: "done" } : p;
              });
            });
          }

          if (msg.type === "tool_call") {
            setToolCalls((prev) => [
              ...prev,
              { tool: msg.tool, label: msg.label, status: "running" },
            ]);
          }

          if (msg.type === "tool_result") {
            setToolCalls((prev) =>
              prev.map((tc) =>
                tc.tool === msg.tool
                  ? { ...tc, status: "done", rowCount: msg.rowCount }
                  : tc,
              ),
            );
          }

          if (msg.type === "dashboard_created") {
            setActiveDashboardTitle(msg.title ?? null);
            setIsHistoricalSession(false); // now a live session with its own dashboard
            setDashboardInfo({ title: msg.title, widgetCount: msg.widgetCount, isEdit: false });
            setIsDashboardGenerating(false);
            setSyncTrigger((n) => n + 1);
            if (msg.chartTurn) {
              attachAssistantMetadata(msg.chartTurn as ChartTurnMetadata);
            }
            toast.success("Dashboard generated", {
              description: msg.title ?? "Your strategic dashboard is ready.",
            });
          }

          if (msg.type === "dashboard_updated") {
            setIsHistoricalSession(false); // now live — user continued from old session
            setActiveDashboardTitle((msg.title as string) ?? null);
            setDashboardInfo({
              title: msg.title,
              widgetCount: msg.widgetCount,
              summary: msg.summary,
              isEdit: true,
            });
            setIsDashboardGenerating(false);
            setSyncTrigger((n) => n + 1);
            if (msg.chartTurn) {
              attachAssistantMetadata(msg.chartTurn as ChartTurnMetadata);
            }
            toast.success("Dashboard updated", {
              description: (msg.summary as string) ?? "Your dashboard has been updated.",
            });
          }

          if (msg.type === "dashboard_skipped") {
            setIsDashboardGenerating(false);
          }

          if (msg.type === "system" && msg.action === "DASHBOARD_REFRESH") {
            setSyncTrigger((n) => n + 1);
          }

          if (msg.type === "done") {
            setPhases([]);
            setToolCalls([]);
          }
        },
      });
    } catch (caught) {
      const message =
        caught instanceof ApiError
          ? caught.toUserMessage("The agent stream was interrupted. Please retry.")
          : caught instanceof Error
            ? caught.message
            : "The agent stream was interrupted. Please retry.";
      setError(message);
      setMessages((prev) => {
        const copy = [...prev];
        if (copy[copy.length - 1]?.role === "assistant" && !copy[copy.length - 1]?.content) {
          copy.pop();
        }
        return copy;
      });
      resetThinking();
    } finally {
      setIsStreaming(false);
      setIsDashboardGenerating(false);
    }
  }

  const hasConversation = messages.filter((m) => m.role !== "system").length > 0 || phases.length > 0;

  return (
    <div className="surface-card flex h-full overflow-hidden p-0">
      {/* ── Col 1: Session History ─── */}
      <SessionSidebar
        sessions={sessions}
        activeSessionId={sessionId}
        onSelectSession={(id) => void handleSelectSession(id)}
        onNewSession={handleNewSession}
        isLoading={sessionsLoading}
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed((c) => !c)}
      />

      {/* ── Col 2: Chat Panel ─── */}
        <div className="flex w-[380px] shrink-0 flex-col border-r border-default">
          {/* Chat header */}
          <div className="flex items-center justify-between border-b border-default px-4 py-3">
            <div className="flex items-center gap-2">
              <Brain size={13} className="text-accent-violet" />
              <span className="text-xs font-bold text-text-primary">Astra Console</span>
            </div>
          <div className="flex items-center gap-2">
            {activeDashboardTitle && !isStreaming && (
              <span className="flex items-center gap-1 rounded-full bg-accent-cyan/10 px-2 py-0.5 text-[10px] font-semibold text-accent-cyan ring-1 ring-accent-cyan/20">
                <PenLine size={8} />
                editing
              </span>
            )}
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider",
                isStreaming
                  ? "bg-accent-violet/12 text-accent-violet"
                  : "bg-bg-elevated text-text-muted",
              )}
            >
              {isStreaming
                ? currentIntent === "EDIT_DASHBOARD"
                  ? "refining"
                  : "executing"
                : "ready"}
            </span>
          </div>
        </div>

        {/* Message thread */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto p-4">
          {!hasConversation ? (
            <WelcomeScreen onPrompt={(p) => void execute(p)} />
          ) : (
            <div className="space-y-4">
              <AnimatePresence initial={false}>
                {messages
                  .filter((m) => m.role !== "system")
                  .map((message, index) => (
                    <MessageBubble
                      key={index}
                      message={message}
                      isStreaming={isStreaming}
                      isLast={index === messages.filter((m) => m.role !== "system").length - 1}
                    />
                  ))}
              </AnimatePresence>

              {(isStreaming || phases.length > 0) && (
                <AgentThinkingPanel
                  phases={phases}
                  toolCalls={toolCalls}
                  dashboardInfo={dashboardInfo}
                  intent={currentIntent}
                />
              )}
            </div>
          )}
        </div>

        {/* Edit mode chips */}
        <AnimatePresence>
          {activeDashboardTitle && !isStreaming && hasConversation && (
            <div className="px-3 pb-2">
              <EditModeBar
                dashboardTitle={activeDashboardTitle}
                onChip={(chip) => {
                  setInput(chip);
                  setTimeout(() => inputRef.current?.focus(), 30);
                }}
              />
            </div>
          )}
        </AnimatePresence>

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
            {pendingClarification && !isStreaming && (
              <motion.div
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 6 }}
                className="mb-2 rounded-xl border border-accent-violet/20 bg-accent-violet/6 p-3"
              >
                <p className="text-xs font-semibold text-text-primary">
                  {pendingClarification.question}
                </p>
                {pendingClarification.options.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {pendingClarification.options.map((opt) => (
                      <button
                        key={opt.label}
                        type="button"
                        onClick={() => void execute(opt.value)}
                        className="rounded-full bg-bg-elevated px-3 py-1 text-[11px] font-semibold text-text-secondary ring-1 ring-default transition-colors hover:bg-bg-elevated/70 hover:text-text-primary"
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                )}
                <p className="mt-2 text-[10px] text-text-muted">
                  You can also type your answer and press send.
                </p>
              </motion.div>
            )}
          </AnimatePresence>
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void execute(input);
            }}
          >
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={isStreaming}
              placeholder={
                activeDashboardTitle
                  ? `Refine dashboard... "Add quarterly view"`
                  : "Tell Astra what you want to build…"
              }
              className="flex-1 rounded-xl border border-default bg-bg-surface/70 px-4 py-2.5 text-sm text-text-primary outline-none transition-colors focus:border-accent-violet/50 disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={!input.trim() || isStreaming}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-violet text-white shadow-md transition-all hover:bg-accent-violet/90 disabled:cursor-not-allowed disabled:opacity-35"
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

      {/* ── Col 3: Dashboard Panel ─── */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Dashboard header */}
        <div className="flex items-center justify-between border-b border-default px-4 py-3">
          <div className="flex items-center gap-2">
            <BarChart3 size={13} className="text-feedback-success" />
            <span className="text-xs font-bold text-text-primary">
              {!hasConversation ? "Dashboard" : isHistoricalSession ? "Latest Dashboard" : "Live Intelligence Dashboard"}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <AnimatePresence>
              {isStreaming && (
                <motion.div
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.9 }}
                  className="flex items-center gap-1.5 rounded-full bg-accent-violet/12 px-2.5 py-1 ring-1 ring-accent-violet/20"
                >
                  <motion.span
                    animate={{ opacity: [0.5, 1, 0.5] }}
                    transition={{ duration: 1.2, repeat: Infinity }}
                    className="h-1.5 w-1.5 rounded-full bg-accent-violet"
                  />
                  <span className="text-[10px] font-bold text-accent-violet">
                    {isDashboardGenerating ? "building dashboard" : "analyzing"}
                  </span>
                </motion.div>
              )}
            </AnimatePresence>
            {activeDashboardTitle && !isDashboardGenerating && !isHistoricalSession && !isStreaming && (
              <span className="max-w-[200px] truncate text-[10px] text-text-muted">
                {activeDashboardTitle}
              </span>
            )}
          </div>
        </div>

        {/* Historical session notice — shown only when passively browsing, not while chatting */}
        <AnimatePresence>
          {isHistoricalSession && !isStreaming && !isDashboardGenerating && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="overflow-hidden border-b border-default bg-bg-elevated/40 px-4 py-2.5"
            >
              <p className="text-[11px] text-text-muted">
                <span className="font-semibold text-text-secondary">Viewing a past session.</span>
                {" "}The dashboard below is the one generated for this session (if available).
                Send a message to regenerate or refine it from this conversation.
              </p>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Dashboard content */}
        <div className="flex-1 overflow-y-auto p-4">
          <AnimatePresence mode="wait">
            {isDashboardGenerating && !activeDashboardTitle ? (
              <motion.div
                key="generating"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              >
                <DashboardGeneratingOverlay />
              </motion.div>
            ) : !hasConversation ? (
              <motion.div
                key="empty"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="flex h-full flex-col items-center justify-center py-24 text-center"
              >
                <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-elevated ring-1 ring-default">
                  <BarChart3 size={22} className="text-text-muted opacity-40" />
                </div>
                <p className="text-sm font-medium text-text-secondary">No dashboard yet</p>
                <p className="mt-1.5 max-w-[200px] text-xs text-text-muted">
                  Send a message to generate your first intelligence dashboard.
                </p>
              </motion.div>
            ) : (
              <motion.div
                key="dashboard"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
              >
                <DashboardPreview
                  triggerSync={syncTrigger}
                  isGenerating={isDashboardGenerating}
                  sessionId={sessionId}
                />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
