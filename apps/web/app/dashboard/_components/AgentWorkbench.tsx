"use client";

import React, { useEffect, useState, useRef } from "react";
import { GlassCard, GlowButton } from "@repo/ui";
import { useNumeriquApi } from "../../../lib/useNumeriquApi";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";
import { DashboardPreview } from "./DashboardPreview";

interface Message {
  role: "user" | "assistant" | "system";
  content: string;
}

export function AgentWorkbench() {
  const { agent, loading } = useNumeriquApi();
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [syncTrigger, setSyncTrigger] = useState(0);
  
  const scrollRef = useRef<HTMLDivElement>(null);

  // Load mission history on mount
  useEffect(() => {
    if (loading) return;
    
    const fetchHistory = async () => {
      try {
        const sessions = await agent.sessions();
        if (sessions.length > 0) {
          const detailed = await agent.session(sessions[0].id);
          setMessages(detailed.messages);
          setSessionId(detailed.id);
        }
      } catch (err) {
        console.error("Agent history recovery failed", err);
      }
    };

    fetchHistory();
  }, [agent, loading]);

  // Auto-scroll
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  async function execute() {
    const q = input.trim();
    if (!q || isStreaming) return;

    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: q }, { role: "assistant", content: "" }]);
    setIsStreaming(true);

    let fullResponse = "";
    try {
      await agent.streamQuery({
        query: q,
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
        },
      });

      // Synchronize dashboard if orchestration command emitted
      if (fullResponse.includes("[COMMAND: GENERATE_DASHBOARD")) {
        setSyncTrigger((prev) => prev + 1);
        toast.success("Strategic Dashboard Updated", {
          description: "Live charts have been refreshed from your latest mission instructions."
        });
      }
    } catch (err: any) {
      toast.error("Orchestration faulty", { description: err.message });
    } finally {
      setIsStreaming(false);
    }
  }

  return (
    <div className="flex flex-col h-[calc(100vh-10rem)] space-y-6">
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-[400px_1fr] gap-6 overflow-hidden">
        
        {/* Left: Strategic Mission Chat */}
        <section className="flex flex-col h-full overflow-hidden">
          <div className="mb-2 flex items-center justify-between px-1">
            <div className="flex items-center gap-2">
              <div className="h-1.5 w-1.5 rounded-full bg-violet-500 shadow-[0_0_8px_rgba(124,58,237,0.5)]"></div>
              <span className="text-[10px] font-bold uppercase tracking-[0.25em] text-violet-400">Mission History</span>
            </div>
          </div>
          
          <GlassCard className="flex-1 flex flex-col overflow-hidden border-violet-500/10">
            <div className="flex-1 overflow-y-auto p-4 space-y-4 scrollbar-thin" ref={scrollRef}>
              {messages.length === 0 && (
                <div className="h-full flex items-center justify-center text-slate-500 italic text-sm text-center px-4">
                  Deploy a mission to begin strategic analysis.
                </div>
              )}
              {messages.map((m, i) => (
                <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                  <div className={`max-w-[90%] p-3 rounded-lg text-sm ${m.role === "user" ? "bg-violet-600/10 border border-violet-500/20 text-violet-100" : "bg-white/[0.03] border border-white/5"}`}>
                    <div className="prose prose-invert prose-sm max-w-none leading-relaxed prose-headings:text-slate-100 prose-p:text-slate-200 prose-strong:text-white prose-a:text-violet-300">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {m.content}
                      </ReactMarkdown>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div className="p-4 border-t border-white/5">
              <div className="flex gap-2">
                <input
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && execute()}
                  disabled={isStreaming}
                  placeholder="Deploy command..."
                  className="flex-1 bg-slate-900/50 border border-white/10 rounded-full px-4 py-2 text-sm text-white outline-none focus:border-violet-500/50"
                />
                <button
                  onClick={execute}
                  disabled={isStreaming}
                  className="rounded-full bg-violet-500 p-2 text-white hover:bg-violet-400 disabled:opacity-50"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 5l7 7-7 7M5 5l7 7-7 7" />
                  </svg>
                </button>
              </div>
            </div>
          </GlassCard>
        </section>

        {/* Right: Live Dynamic Insight View */}
        <section className="flex flex-col h-full overflow-hidden">
          <div className="mb-2 flex items-center justify-between px-1">
            <div className="flex items-center gap-2">
              <div className="h-1.5 w-1.5 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]"></div>
              <span className="text-[10px] font-bold uppercase tracking-[0.25em] text-emerald-400">Strategic Dashboard Sync</span>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto pr-2 scrollbar-thin">
            <DashboardPreview triggerSync={syncTrigger} />
          </div>
        </section>

      </div>
    </div>
  );
}
