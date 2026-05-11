"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ApiError } from "../../lib/api";
import { useNumeriquApi } from "../../lib/useNumeriquApi";
import { Button } from "../../components/ui/Button";
import { ErrorBanner } from "../../components/ui/ErrorBanner";
import { EmptyState } from "../../components/ui/EmptyState";
import { StatusPill } from "../../components/ui/StatusPill";
import { cn } from "../../components/ui/cn";
import { DashboardPreview } from "./_components/DashboardPreview";

type Message = { role: "user" | "assistant" | "system"; content: string };

const SUGGESTED_PROMPTS = [
  "What changed since last month? Top 5 drivers and why.",
  "Where are we off-plan this quarter? Call out the 3 biggest gaps.",
  "Build a board-ready dashboard for the last close.",
];

export default function IntelligenceHub() {
  const { rag, agent, loading } = useNumeriquApi();

  const [query, setQuery] = useState("");
  const [ragMessages, setRagMessages] = useState<Message[]>([]);
  const [agentMessages, setAgentMessages] = useState<Message[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [syncTrigger, setSyncTrigger] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const [ragSid, setRagSid] = useState<string | null>(null);
  const [agentSid, setAgentSid] = useState<string | null>(null);

  const ragScrollRef = useRef<HTMLDivElement>(null);
  const agentScrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (loading) return;
    const loadHistory = async () => {
      try {
        const [ragSessions, agentSessions] = await Promise.all([rag.sessions(), agent.sessions()]);
        const firstRag = ragSessions[0];
        if (firstRag) {
          const detailed = await rag.session(firstRag.id);
          setRagMessages((detailed.messages as Message[]) ?? []);
          setRagSid(detailed.id);
        }
        const firstAgent = agentSessions[0];
        if (firstAgent) {
          const detailed = await agent.session(firstAgent.id);
          setAgentMessages((detailed.messages as Message[]) ?? []);
          setAgentSid(detailed.id);
        }
      } catch {
        /* non-fatal */
      }
    };
    void loadHistory();
  }, [rag, agent, loading]);

  useEffect(() => {
    if (ragScrollRef.current) ragScrollRef.current.scrollTop = ragScrollRef.current.scrollHeight;
  }, [ragMessages]);

  useEffect(() => {
    if (agentScrollRef.current) agentScrollRef.current.scrollTop = agentScrollRef.current.scrollHeight;
  }, [agentMessages]);

  async function handleQuery(prompt: string) {
    const trimmed = prompt.trim();
    if (!trimmed || isStreaming) return;

    setQuery("");
    setError(null);
    setIsStreaming(true);

    setRagMessages((prev) => [...prev, { role: "user", content: trimmed }, { role: "assistant", content: "" }]);
    setAgentMessages((prev) => [...prev, { role: "user", content: trimmed }, { role: "assistant", content: "" }]);

    const errors: string[] = [];

    const runRag = async () => {
      try {
        await rag.streamQuery({
          query: trimmed,
          sessionId: ragSid,
          onDelta: (delta) =>
            setRagMessages((prev) => {
              const next = [...prev];
              const last = next[next.length - 1];
              if (last) last.content += delta;
              return next;
            }),
          onMessage: (msg) => {
            if (msg.type === "done" && msg.metrics?.sessionId) setRagSid(msg.metrics.sessionId);
          },
        });
      } catch (caught) {
        const message =
          caught instanceof ApiError
            ? caught.toUserMessage("Prism stream interrupted.")
            : caught instanceof Error
              ? caught.message
              : "Prism stream interrupted.";
        errors.push(`Prism: ${message}`);
        setRagMessages((prev) => {
          const copy = [...prev];
          copy[copy.length - 1] = { role: "assistant", content: `_${message}_` };
          return copy;
        });
      }
    };

    const runAgent = async () => {
      try {
        await agent.streamQuery({
          query: trimmed,
          sessionId: agentSid,
          onDelta: (delta) =>
            setAgentMessages((prev) => {
              const next = [...prev];
              const last = next[next.length - 1];
              if (last) last.content += delta;
              return next;
            }),
          onMessage: (msg) => {
            if (msg.type === "system" && msg.action === "DASHBOARD_REFRESH") {
              setSyncTrigger((prev) => prev + 1);
              toast.success("Dashboard refreshed", {
                description: "Live charts have been refreshed from the latest insights.",
              });
            }
            if (msg.type === "done" && msg.metrics?.sessionId) setAgentSid(msg.metrics.sessionId);
          },
        });
      } catch (caught) {
        const message =
          caught instanceof ApiError
            ? caught.toUserMessage("Astra stream interrupted.")
            : caught instanceof Error
              ? caught.message
              : "Astra stream interrupted.";
        errors.push(`Astra: ${message}`);
        setAgentMessages((prev) => {
          const copy = [...prev];
          copy[copy.length - 1] = { role: "assistant", content: `_${message}_` };
          return copy;
        });
      }
    };

    await Promise.allSettled([runRag(), runAgent()]);
    setIsStreaming(false);
    if (errors.length > 0) setError(errors.join(" · "));
  }

  function MessageList({
    title,
    tone,
    messages,
    scrollRef,
  }: {
    title: string;
    tone: "blue" | "violet";
    messages: Message[];
    scrollRef: React.RefObject<HTMLDivElement | null>;
  }) {
    return (
      <section className="flex h-full flex-col overflow-hidden">
        <div className="mb-2 flex items-center gap-2 px-1">
          <span
            aria-hidden
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              tone === "blue"
                ? "bg-accent-blue shadow-[0_0_8px_rgba(59,130,246,0.5)]"
                : "bg-accent-violet shadow-[0_0_8px_rgba(124,58,237,0.5)]",
            )}
          />
          <span
            className={cn(
              "text-[10px] font-bold uppercase tracking-[0.25em]",
              tone === "blue" ? "text-accent-blue" : "text-accent-violet",
            )}
          >
            {title}
          </span>
        </div>
        <div className="surface-card flex-1 overflow-hidden p-0">
          <div className="h-full space-y-4 overflow-y-auto p-4" ref={scrollRef}>
            {messages.length === 0 ? (
              <EmptyState
                title="Ready"
                detail="Send a query below to fan out across both surfaces."
              />
            ) : (
              messages.map((message, index) => (
                <div
                  key={index}
                  className={cn("flex", message.role === "user" ? "justify-end" : "justify-start")}
                >
                  <div
                    className={cn(
                      "max-w-[90%] rounded-xl p-3 text-sm ring-1",
                      message.role === "user"
                        ? tone === "blue"
                          ? "bg-accent-blue/12 ring-accent-blue/25"
                          : "bg-accent-violet/12 ring-accent-violet/25"
                        : "bg-surface-card/60 ring-default",
                      "text-text-primary",
                    )}
                  >
                    <div className="prose prose-sm max-w-none leading-relaxed text-text-primary prose-headings:text-text-primary prose-strong:text-text-primary prose-a:text-accent-cyan prose-code:text-accent-cyan">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content || "_…_"}</ReactMarkdown>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </section>
    );
  }

  return (
    <div className="flex h-[calc(100vh-12rem)] flex-col gap-4">
      <header className="surface-card flex items-center justify-between p-5">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-accent-blue">
            Ask
          </p>
          <h2 className="mt-1 font-display text-xl font-bold text-text-primary md:text-2xl">
            One question. Two ways to answer.
          </h2>
          <p className="mt-1 text-sm text-text-muted">
            Prism cites sources. Astra turns answers into dashboards.
          </p>
        </div>
        <StatusPill tone={isStreaming ? "info" : "neutral"}>
          {isStreaming ? "thinking" : "ready"}
        </StatusPill>
      </header>

      {error ? (
        <ErrorBanner title="One or more streams failed" tone="warning" onDismiss={() => setError(null)}>
          {error}
        </ErrorBanner>
      ) : null}

      <div className="grid flex-1 grid-cols-1 gap-4 overflow-hidden lg:grid-cols-[1fr_1fr_1.5fr]">
        <MessageList title="Prism" tone="blue" messages={ragMessages} scrollRef={ragScrollRef} />
        <MessageList title="Astra" tone="violet" messages={agentMessages} scrollRef={agentScrollRef} />

        <section className="flex h-full flex-col overflow-hidden">
          <div className="mb-2 flex items-center gap-2 px-1">
            <span
              aria-hidden
              className="h-1.5 w-1.5 rounded-full bg-feedback-success shadow-[0_0_8px_rgba(16,185,129,0.5)]"
            />
            <span className="text-[10px] font-bold uppercase tracking-[0.25em] text-feedback-success">
              Live dashboard
            </span>
          </div>
          <div className="flex-1 overflow-y-auto pr-1">
            <DashboardPreview triggerSync={syncTrigger} />
          </div>
        </section>
      </div>

      <form
        className="surface-card p-3 transition-all focus-within:border-accent-blue/30"
        onSubmit={(event) => {
          event.preventDefault();
          void handleQuery(query);
        }}
      >
        <div className="flex flex-col gap-2 md:flex-row md:items-center">
          <input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            disabled={isStreaming}
            placeholder="Ask a finance question (runs advisor + agent in parallel)…"
            aria-label="Ask NumeriQ"
            className="flex-1 rounded-full border border-default bg-surface-card/60 px-4 py-2 text-base text-text-primary outline-none placeholder:text-text-muted focus:border-accent-blue/50 disabled:opacity-60"
          />
          <Button type="submit" loading={isStreaming} disabled={!query.trim() || isStreaming}>
            {isStreaming ? "Working…" : "Ask"}
          </Button>
        </div>
        <div className="mt-2 flex flex-wrap gap-2 px-2">
          {SUGGESTED_PROMPTS.map((prompt) => (
            <button
              key={prompt}
              type="button"
              onClick={() => void handleQuery(prompt)}
              className="rounded-full border border-default px-3 py-1 text-xs text-text-secondary hover:border-accent-blue/40 hover:text-text-primary"
            >
              {prompt}
            </button>
          ))}
        </div>
      </form>
    </div>
  );
}
