"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ApiError, type ChatMessage, type HealthResponse } from "../../../lib/api";
import { useNumeriquApi } from "../../../lib/useNumeriquApi";
import { cardClass, classNames, EmptyState } from "./ui";

export function RagWorkbench() {
  const { rag, loading } = useNumeriquApi();
  const [input, setInput] = useState("What changed in revenue this month?");
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
        if (sessions.length > 0) {
          const detailed = await rag.session(sessions[0].id);
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

  async function ask() {
    const query = input.trim();
    if (!query || isStreaming) return;

    setError(null);
    setInput("");
    setIsStreaming(true);
    setMessages((current) => [...current, { role: "user", content: query }, { role: "assistant", content: "" }]);

    try {
      await rag.streamQuery({
        query,
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
      const message = caught instanceof ApiError ? caught.message : caught instanceof Error ? caught.message : "Stream failed.";
      setError(message);
      setMessages((current) => {
        const copy = [...current];
        copy[copy.length - 1] = { role: "assistant", content: `Backend error: ${message}` };
        return copy;
      });
    } finally {
      setIsStreaming(false);
    }
  }

  return (
    <div className="space-y-6">
      <section className={cardClass()}>
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-violet-300">AI Workbench</p>
            <h2 className="mt-2 font-display text-2xl font-bold text-white">RAG (Advisor) Layer</h2>
            <p className="mt-2 text-sm text-slate-400">{health?.advisory ?? "Health check pending"}</p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4 text-sm text-slate-300">
            This page only calls <span className="font-mono text-xs text-cyan-200">/rag</span> endpoints.
          </div>
        </div>
      </section>

      {error ? (
        <div className="rounded-2xl border border-rose-400/20 bg-rose-400/10 p-4 text-rose-100">{error}</div>
      ) : null}

      <section className={cardClass("h-full")}>
        <div
          ref={scrollRef}
          className="h-[420px] space-y-3 overflow-y-auto rounded-2xl border border-white/10 bg-slate-950/60 p-4"
        >
          {messages.length === 0 ? (
            <EmptyState title="Ready for questions" detail="Streams from /rag/query with your bearer token." />
          ) : (
            messages.map((message, index) => (
              <div
                key={`${message.role}-${index}`}
                className={classNames(
                  "flex rounded-2xl p-3 text-sm",
                  message.role === "user" ? "ml-8 justify-end" : "mr-8 justify-start",
                )}
              >
                <div
                  className={classNames(
                    "max-w-[90%] rounded-2xl p-3",
                    message.role === "user"
                      ? "bg-blue-500/20 text-blue-50 ring-1 ring-blue-400/20"
                      : "bg-white/[0.04] text-slate-100 ring-1 ring-white/10",
                  )}
                >
                  <div className="prose prose-invert prose-sm max-w-none leading-relaxed prose-headings:text-slate-100 prose-p:text-slate-200 prose-strong:text-white prose-a:text-cyan-300">
                    {message.content ? (
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
                    ) : isStreaming && index === messages.length - 1 ? (
                      <span className="text-slate-500 italic">Thinking…</span>
                    ) : null}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>

        <div className="mt-4 flex gap-3">
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void ask();
            }}
            className="min-h-12 flex-1 rounded-full border border-white/10 bg-slate-900 px-5 text-white outline-none focus:border-violet-400"
            placeholder="Ask a CFO-grade question..."
          />
          <button
            onClick={() => void ask()}
            disabled={isStreaming}
            className="rounded-full bg-violet-500 px-6 py-3 font-semibold text-white hover:bg-violet-400 disabled:opacity-50"
          >
            {isStreaming ? "Streaming" : "Ask"}
          </button>
        </div>
      </section>
    </div>
  );
}
