"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";
import { ApiError } from "../../../lib/api";
import { useNumeriquApi } from "../../../lib/useNumeriquApi";
import { Button } from "../../../components/ui/Button";
import { ErrorBanner } from "../../../components/ui/ErrorBanner";
import { EmptyState } from "../../../components/ui/EmptyState";
import { StatusPill } from "../../../components/ui/StatusPill";
import { cn } from "../../../components/ui/cn";
import { DashboardPreview } from "./DashboardPreview";

type Message = {
  role: "user" | "assistant" | "system";
  content: string;
};

const SAMPLE_PROMPTS = [
  "Build a full CFO board pack with revenue trend, entity breakdown, and burn analysis.",
  "Run a forensic expense audit — find anomalies, concentrations, and unusual patterns.",
  "Model three cash runway scenarios: base case, upside, and risk case.",
  "Generate an investor-ready P&L summary with entity-by-entity margin comparison.",
  "Identify our top revenue risks and create an action dashboard.",
];

export function AgentWorkbench() {
  const { agent, loading } = useNumeriquApi();
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [syncTrigger, setSyncTrigger] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (loading) return;
    const fetchHistory = async () => {
      try {
        const sessions = await agent.sessions();
        const first = sessions[0];
        if (first) {
          const detailed = await agent.session(first.id);
          setMessages((detailed.messages as Message[]) ?? []);
          setSessionId(detailed.id);
        }
      } catch {
        /* non-fatal */
      }
    };
    void fetchHistory();
  }, [agent, loading]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  async function execute(prompt: string) {
    const query = prompt.trim();
    if (!query || isStreaming) return;

    setError(null);
    setInput("");
    setMessages((prev) => [
      ...prev,
      { role: "user", content: query },
      { role: "assistant", content: "" },
    ]);
    setIsStreaming(true);

    let fullResponse = "";
    try {
      await agent.streamQuery({
        query,
        sessionId,
        onDelta: (delta) => {
          fullResponse += delta;
          setMessages((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last) last.content += delta;
            return next;
          });
        },
        onMessage: (msg) => {
          if (msg.type === "done" && msg.metrics?.sessionId) {
            setSessionId(msg.metrics.sessionId);
          }
          if (msg.type === "system" && msg.action === "DASHBOARD_REFRESH") {
            setSyncTrigger((prev) => prev + 1);
            toast.success("Dashboard refreshed", {
              description: "Live charts have been refreshed from the latest mission output.",
            });
          }
        },
      });

      if (fullResponse.includes("[COMMAND: GENERATE_DASHBOARD")) {
        setSyncTrigger((prev) => prev + 1);
      }
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
        copy[copy.length - 1] = {
          role: "assistant",
          content: `_The agent couldn't finish this mission._\n\n${message}`,
        };
        return copy;
      });
    } finally {
      setIsStreaming(false);
    }
  }

  return (
    <div className="flex h-[calc(100vh-12rem)] flex-col space-y-4">
      <header className="surface-card flex items-center justify-between p-5">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-accent-violet">
            Agent workbench
          </p>
          <h2 className="mt-1 font-display text-xl font-bold text-text-primary md:text-2xl">
            Autonomous CFO Intelligence
          </h2>
        </div>
        <StatusPill tone={isStreaming ? "info" : "neutral"}>
          {isStreaming ? "running" : "ready"}
        </StatusPill>
      </header>

      {error ? (
        <ErrorBanner title="Mission interrupted" tone="danger" onDismiss={() => setError(null)}>
          {error}
        </ErrorBanner>
      ) : null}

      <div className="grid flex-1 grid-cols-1 gap-4 overflow-hidden lg:grid-cols-[420px_1fr]">
        <section className="surface-card flex h-full flex-col overflow-hidden p-4">
          <p className="px-1 pb-3 text-[10px] font-bold uppercase tracking-[0.25em] text-accent-violet">
            Mission History
          </p>

          <div className="flex-1 space-y-3 overflow-y-auto rounded-xl border border-default bg-bg-elevated/40 p-3" ref={scrollRef}>
            {messages.length === 0 ? (
              <EmptyState
                title="Ready for a mission"
                detail="Deploy the agent on any financial objective — board packs, anomaly detection, scenario modeling, or deep entity analysis."
                action={
                  <div className="flex flex-wrap justify-center gap-2">
                    {SAMPLE_PROMPTS.map((prompt) => (
                      <button
                        key={prompt}
                        type="button"
                        onClick={() => void execute(prompt)}
                        className="rounded-full border border-default px-3 py-1.5 text-xs text-text-secondary hover:border-accent-violet/50 hover:text-text-primary"
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
                  key={index}
                  className={cn("flex", message.role === "user" ? "justify-end" : "justify-start")}
                >
                  <div
                    className={cn(
                      "max-w-[92%] rounded-2xl p-3 text-sm ring-1",
                      message.role === "user"
                        ? "bg-accent-violet/15 text-text-primary ring-accent-violet/25"
                        : "bg-surface-card/60 text-text-primary ring-default",
                    )}
                  >
                    <div className="prose prose-sm max-w-none leading-relaxed text-text-primary prose-headings:text-text-primary prose-strong:text-text-primary prose-a:text-accent-violet prose-code:text-accent-cyan">
                      {message.content ? (
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
                      ) : isStreaming && index === messages.length - 1 ? (
                        <span className="text-text-muted italic">Planning…</span>
                      ) : null}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>

          <form
            className="mt-3 flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void execute(input);
            }}
          >
            <input
              type="text"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              disabled={isStreaming}
              placeholder="Deploy a mission..."
              aria-label="Mission prompt"
              className="flex-1 rounded-full border border-default bg-surface-card/70 px-4 py-2 text-sm text-text-primary outline-none focus:border-accent-violet/50 disabled:opacity-60"
            />
            <Button type="submit" loading={isStreaming} disabled={!input.trim() || isStreaming}>
              Send
            </Button>
          </form>
        </section>

        <section className="flex h-full flex-col overflow-hidden">
          <p className="px-1 pb-3 text-[10px] font-bold uppercase tracking-[0.25em] text-feedback-success">
            Strategic dashboard sync
          </p>
          <div className="flex-1 overflow-y-auto pr-1">
            <DashboardPreview triggerSync={syncTrigger} />
          </div>
        </section>
      </div>
    </div>
  );
}
