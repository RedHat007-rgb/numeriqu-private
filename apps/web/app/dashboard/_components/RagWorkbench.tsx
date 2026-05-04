"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ApiError, type ChatMessage, type HealthResponse } from "../../../lib/api";
import { useNumeriquApi } from "../../../lib/useNumeriquApi";
import { Button } from "../../../components/ui/Button";
import { ErrorBanner } from "../../../components/ui/ErrorBanner";
import { EmptyState } from "../../../components/ui/EmptyState";
import { StatusPill } from "../../../components/ui/StatusPill";
import { cn } from "../../../components/ui/cn";

const SAMPLE_PROMPTS = [
  "What changed in revenue this month?",
  "Summarize last week's sync activity.",
  "Which entities had the largest expense swings?",
];

export function RagWorkbench() {
  const { rag, loading } = useNumeriquApi();
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    rag
      .health()
      .then(setHealth)
      .catch(() => setHealth(null));
  }, [rag]);

  useEffect(() => {
    if (loading) return;
    const load = async () => {
      try {
        const sessions = await rag.sessions();
        const first = sessions[0];
        if (first) {
          const detailed = await rag.session(first.id);
          setMessages(detailed.messages ?? []);
          setSessionId(detailed.id);
        }
      } catch {
        /* non-fatal */
      }
    };
    void load();
  }, [rag, loading]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  async function ask(query: string) {
    const trimmed = query.trim();
    if (!trimmed || isStreaming) return;

    setError(null);
    setInput("");
    setIsStreaming(true);
    setMessages((current) => [
      ...current,
      { role: "user", content: trimmed },
      { role: "assistant", content: "" },
    ]);

    try {
      await rag.streamQuery({
        query: trimmed,
        sessionId,
        onDelta: (delta) => {
          setMessages((current) => {
            const copy = [...current];
            const last = copy[copy.length - 1];
            if (last?.role === "assistant")
              copy[copy.length - 1] = { ...last, content: last.content + delta };
            return copy;
          });
        },
        onMessage: (msg) => {
          if (msg.type === "done" && msg.metrics?.sessionId) {
            setSessionId(msg.metrics.sessionId);
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
      setMessages((current) => {
        const copy = [...current];
        copy[copy.length - 1] = {
          role: "assistant",
          content: `_The advisor couldn't finish that response._\n\n${message}`,
        };
        return copy;
      });
    } finally {
      setIsStreaming(false);
    }
  }

  const healthTone = health?.status === "operational" ? "success" : health ? "warning" : "neutral";

  return (
    <div className="space-y-6">
      <section className="surface-card p-6">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-accent-violet">
              AI Workbench
            </p>
            <h2 className="mt-2 font-display text-xl font-bold text-text-primary md:text-2xl">
              RAG advisor
            </h2>
            <p className="mt-2 text-sm text-text-muted">
              Source-cited answers grounded in your synced finance data.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <StatusPill tone={healthTone}>
              {health?.status ? health.status : "checking"}
            </StatusPill>
            <p className="font-mono text-xs text-text-muted">/rag endpoints</p>
          </div>
        </div>
      </section>

      {error ? (
        <ErrorBanner title="Advisor error" tone="danger" onDismiss={() => setError(null)}>
          {error}
        </ErrorBanner>
      ) : null}

      <section className="surface-card p-4 md:p-6">
        <div
          ref={scrollRef}
          className="h-[420px] space-y-3 overflow-y-auto rounded-2xl border border-default bg-bg-elevated/40 p-4"
        >
          {messages.length === 0 ? (
            <EmptyState
              title="Ready to ask"
              detail="Try one of these to get started, or type any CFO-grade question."
              action={
                <div className="flex flex-wrap justify-center gap-2">
                  {SAMPLE_PROMPTS.map((prompt) => (
                    <button
                      key={prompt}
                      type="button"
                      onClick={() => void ask(prompt)}
                      className="rounded-full border border-default px-3 py-1.5 text-xs text-text-secondary hover:border-accent-blue/50 hover:text-text-primary"
                    >
                      {prompt}
                    </button>
                  ))}
                </div>
              }
            />
          ) : (
            messages.map((message, index) => (
              <div
                key={`${message.role}-${index}`}
                className={cn("flex p-1", message.role === "user" ? "justify-end" : "justify-start")}
              >
                <div
                  className={cn(
                    "max-w-[90%] rounded-2xl p-3 ring-1",
                    message.role === "user"
                      ? "bg-accent-blue/15 text-text-primary ring-accent-blue/20"
                      : "bg-surface-card/60 text-text-primary ring-default",
                  )}
                >
                  <div className="prose prose-sm max-w-none leading-relaxed text-text-primary prose-headings:text-text-primary prose-strong:text-text-primary prose-a:text-accent-blue prose-code:text-accent-cyan">
                    {message.content ? (
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
                    ) : isStreaming && index === messages.length - 1 ? (
                      <span className="text-text-muted italic">Thinking…</span>
                    ) : null}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>

        <form
          className="mt-4 flex gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void ask(input);
          }}
        >
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            aria-label="Ask the advisor"
            className="min-h-12 flex-1 rounded-full border border-default bg-surface-card/70 px-5 text-text-primary outline-none focus:border-accent-violet"
            placeholder="Ask a CFO-grade question..."
          />
          <Button type="submit" loading={isStreaming} disabled={!input.trim() || isStreaming}>
            {isStreaming ? "Streaming" : "Ask"}
          </Button>
        </form>
      </section>
    </div>
  );
}
