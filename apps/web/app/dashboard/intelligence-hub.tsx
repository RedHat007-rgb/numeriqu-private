"use client";

import React, { useState, useEffect, useRef } from "react";
import { GlassCard, GlowButton } from "@repo/ui";
import { useAuth } from "../providers";
import { useNumeriquApi } from "../../lib/useNumeriquApi";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";
import { DashboardPreview } from "./_components/DashboardPreview";

interface Message {
  role: "user" | "assistant" | "system";
  content: string;
}

export default function IntelligenceHub() {
  const { user } = useAuth();
  const { rag, agent, loading } = useNumeriquApi();
  
  const [query, setQuery] = useState("");
  const [ragMessages, setRagMessages] = useState<Message[]>([]);
  const [agentMessages, setAgentMessages] = useState<Message[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [syncTrigger, setSyncTrigger] = useState(0);
  
  const [ragSid, setRagSid] = useState<string | null>(null);
  const [agentSid, setAgentSid] = useState<string | null>(null);

  const ragScrollRef = useRef<HTMLDivElement>(null);
  const agentScrollRef = useRef<HTMLDivElement>(null);

  // Load initial history independently on mount
  useEffect(() => {
    if (loading) return;

    const loadHistory = async () => {
      try {
        const [ragSessions, agentSessions] = await Promise.all([
          rag.sessions(),
          agent.sessions()
        ]);

        if (ragSessions.length > 0) {
          const detailed = await rag.session(ragSessions[0].id);
          setRagMessages(detailed.messages);
          setRagSid(detailed.id);
        }

        if (agentSessions.length > 0) {
          const detailed = await agent.session(agentSessions[0].id);
          setAgentMessages(detailed.messages);
          setAgentSid(detailed.id);
        }
      } catch (err) {
        console.error("History recovery failed", err);
      }
    };

    loadHistory();
  }, [rag, agent, loading]);

  // Scroll tracking
  useEffect(() => {
    if (ragScrollRef.current) ragScrollRef.current.scrollTop = ragScrollRef.current.scrollHeight;
  }, [ragMessages]);
  
  useEffect(() => {
    if (agentScrollRef.current) agentScrollRef.current.scrollTop = agentScrollRef.current.scrollHeight;
  }, [agentMessages]);

  const handleQuery = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim() || isStreaming) return;

    const q = query;
    setQuery("");
    setIsStreaming(true);

    // Loosely coupled parallel execution
    setRagMessages(prev => [...prev, { role: "user", content: q }]);
    setAgentMessages(prev => [...prev, { role: "user", content: q }]);

    const runRag = async () => {
      setRagMessages(prev => [...prev, { role: "assistant", content: "" }]);
      await rag.streamQuery({
        query: q,
        sessionId: ragSid,
        onDelta: (d) => setRagMessages(prev => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last) last.content += d;
          return next;
        }),
        onMessage: (msg) => {
          if (msg.type === 'done' && msg.metrics?.sessionId) {
            setRagSid(msg.metrics.sessionId);
          }
        }
      });
    };

    const runAgent = async () => {
      setAgentMessages(prev => [...prev, { role: "assistant", content: "" }]);
      await agent.streamQuery({
        query: q,
        sessionId: agentSid,
        onDelta: (d) => {
          setAgentMessages(prev => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last) last.content += d;
            return next;
          });
        },
        onMessage: (msg) => {
          if (msg.type === 'system' && msg.action === 'DASHBOARD_REFRESH') {
            setSyncTrigger(prev => prev + 1);
            toast.success("Strategic Sync Successful", {
              description: "Dashboard view updated with live insights."
            });
          }
          if (msg.type === 'done' && msg.metrics?.sessionId) {
            setAgentSid(msg.metrics.sessionId);
          }
        }
      });
    };

    Promise.all([runRag(), runAgent()]).finally(() => setIsStreaming(false));
  };

  return (
    <div className="flex flex-col h-[calc(100vh-10rem)] space-y-6">
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-[1fr_1fr_1.5fr] gap-6 overflow-hidden">
        
        {/* Panel 1: RAG Advisor */}
        <section className="flex flex-col h-full overflow-hidden">
          <div className="mb-2 flex items-center gap-2 px-1">
            <div className="h-1.5 w-1.5 rounded-full bg-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.5)]"></div>
            <span className="text-[10px] font-bold uppercase tracking-[0.25em] text-blue-400">Personal Advisor (RAG)</span>
          </div>
          <GlassCard className="flex-1 flex flex-col overflow-hidden border-blue-500/10">
            <div className="flex-1 overflow-y-auto p-4 space-y-4 scrollbar-thin" ref={ragScrollRef}>
              {ragMessages.map((m, i) => (
                <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                  <div className={`max-w-[90%] p-3 rounded-lg text-sm ${m.role === "user" ? "bg-blue-600/10 border border-blue-500/20 text-blue-100" : "bg-white/[0.03] border border-white/5"}`}>
                    <div className="prose prose-invert prose-sm max-w-none leading-relaxed prose-headings:text-slate-100 prose-p:text-slate-200 prose-strong:text-white prose-a:text-cyan-300">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {m.content}
                      </ReactMarkdown>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </GlassCard>
        </section>

        {/* Panel 2: Agent Orchestrator */}
        <section className="flex flex-col h-full overflow-hidden">
          <div className="mb-2 flex items-center gap-2 px-1">
            <div className="h-1.5 w-1.5 rounded-full bg-violet-500 shadow-[0_0_8px_rgba(124,58,237,0.5)]"></div>
            <span className="text-[10px] font-bold uppercase tracking-[0.25em] text-violet-400">Mission Agent (CFO)</span>
          </div>
          <GlassCard className="flex-1 flex flex-col overflow-hidden border-violet-500/10">
            <div className="flex-1 overflow-y-auto p-4 space-y-4 scrollbar-thin" ref={agentScrollRef}>
              {agentMessages.map((m, i) => (
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
          </GlassCard>
        </section>

        {/* Panel 3: Live Strategic View */}
        <section className="flex flex-col h-full overflow-hidden">
          <div className="mb-2 flex items-center gap-2 px-1">
            <div className="h-1.5 w-1.5 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]"></div>
            <span className="text-[10px] font-bold uppercase tracking-[0.25em] text-emerald-400">Strategic Performance Sync</span>
          </div>
          <div className="flex-1 overflow-y-auto pr-1 scrollbar-thin">
            <DashboardPreview triggerSync={syncTrigger} />
          </div>
        </section>

      </div>

      {/* Control Area */}
      <GlassCard className="p-4 border-white/10 group focus-within:border-blue-500/30 transition-all">
        <form onSubmit={handleQuery} className="flex gap-4">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            disabled={isStreaming}
            placeholder="Deploy analytical mission..."
            className="flex-1 bg-transparent border-none outline-none text-white placeholder:text-slate-600 text-lg font-medium"
          />
          <GlowButton disabled={isStreaming} className="min-w-[160px]">
            {isStreaming ? "Synthesizing..." : "Execute"}
          </GlowButton>
        </form>
      </GlassCard>
    </div>
  );
}
