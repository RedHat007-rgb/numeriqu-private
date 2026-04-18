"use client";

import React, { useState, useRef, useEffect } from 'react';
import { apiFetch } from '../lib/supabase';
import MarkdownRenderer from './MarkdownRenderer';
import FinancialInsights from './FinancialInsights';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Send, StopCircle, Zap, User, Bot, Clock, Terminal,
  ChevronRight, BarChart3, CheckCircle2, AlertCircle,
} from 'lucide-react';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  metrics?: {
    totalMs: number;
    tokens: number;
    mode: string;
  };
}

const AGENT_SUGGESTIONS = [
  "Analyze revenue concentration risk across all entities",
  "Design a dashboard showing my invoice aging breakdown",
  "Show me a pictorial representation of monthly revenue",
  "Create a profitability comparison between my organizations",
  "Audit my overdue invoices and assess collection risk",
  "Build a spend analysis dashboard for the last quarter",
];

export default function AgentPanel() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isQuerying, setIsQuerying] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [streamingStatus, setStreamingStatus] = useState('');
  const [activeTab, setActiveTab] = useState<'missions' | 'dashboards'>('missions');
  const chatEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const saved = localStorage.getItem('numeriqu_agent_history');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        setMessages(parsed.map((m: any) => ({ ...m, timestamp: new Date(m.timestamp) })));
      } catch { }
    }
  }, []);

  useEffect(() => {
    if (messages.length > 0) {
      localStorage.setItem('numeriqu_agent_history', JSON.stringify(messages));
    }
  }, [messages]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingContent]);

  const cancelQuery = () => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  };

  const handleQuery = async (queryOverride?: string) => {
    const query = queryOverride || input.trim();
    if (!query || isQuerying) return;

    const controller = new AbortController();
    abortRef.current = controller;

    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: query,
      timestamp: new Date(),
    };

    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setIsQuerying(true);
    setStreamingContent('');
    setStreamingStatus('');

    let fullContent = '';
    let metrics: ChatMessage['metrics'] = undefined;

    try {
      const history = messages.slice(-10).map(m => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content,
      }));

      const response = await apiFetch('/agent/query', {
        method: 'POST',
        body: JSON.stringify({ query, history }),
        signal: controller.signal,
      });

      if (!response.ok) throw new Error(`API error: ${response.status}`);

      const reader = response.body?.getReader();
      if (!reader) throw new Error('No response stream');

      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const text = decoder.decode(value, { stream: true });
        const lines = text.split('\n').filter(Boolean);

        for (const line of lines) {
          const cleanLine = line.startsWith('data: ') ? line.slice(6) : line;
          try {
            const parsed = JSON.parse(cleanLine);
            switch (parsed.type) {
              case 'status':
                setStreamingStatus(parsed.message);
                break;
              case 'token':
                setStreamingStatus('');
                fullContent += parsed.content;
                setStreamingContent(fullContent);
                break;
              case 'done':
                metrics = parsed.metrics;
                break;
              case 'system':
                if (parsed.action === 'DASHBOARD_REFRESH') {
                  window.dispatchEvent(new CustomEvent('numeriqu:refresh_insights'));
                  // Silently execute UI sweep without dumping text into the LLM chat history
                }
                break;
              case 'error':
                fullContent += `\n\n⚠️ ${parsed.message}`;
                setStreamingContent(fullContent);
                break;
            }
          } catch { /* skip non-JSON */ }
        }
      }
    } catch (error: any) {
      if (error.name === 'AbortError') {
        fullContent = fullContent || 'Mission cancelled by user.';
      } else {
        fullContent = fullContent || '⚠️ Data sync interrupted. We are unable to establish a secure connection to the reasoning engine right now. Please verify your internet connection or try again momentarily.';
      }
    }

    const assistantMsg: ChatMessage = {
      id: `assistant-${Date.now()}`,
      role: 'assistant',
      content: fullContent || 'No response generated.',
      timestamp: new Date(),
      metrics,
    };

    setMessages(prev => [...prev, assistantMsg]);
    setStreamingContent('');
    setStreamingStatus('');
    setIsQuerying(false);
    abortRef.current = null;
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleQuery();
    }
    if (e.key === 'Escape' && isQuerying) {
      cancelQuery();
    }
  };

  return (
    <div className="agent-panel">
      {/* ─── Command Input ──────────────────────────────── */}
      <motion.div
        className="agent-command-bar"
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
      >
        <div className="agent-command-header">
          <div className="agent-status-badge">
            <div className="status-orb" style={{ background: '#00F5D4', width: 8, height: 8 }} />
            <span>AGENT ACTIVE</span>
          </div>
          <span className="agent-mission-count">{messages.filter(m => m.role === 'user').length} missions completed</span>
        </div>
        <div className="agent-command-input-wrap">
          <Terminal size={16} style={{ opacity: 0.4, flexShrink: 0 }} />
          <input
            ref={inputRef}
            className="agent-command-input"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Delegate a mission… e.g. 'Analyze revenue concentration by entity'"
            disabled={isQuerying}
          />
          {isQuerying ? (
            <button className="agent-btn cancel" onClick={cancelQuery}>
              <StopCircle size={16} />
              <span>Abort</span>
            </button>
          ) : (
            <button
              className="agent-btn execute"
              onClick={() => handleQuery()}
              disabled={!input.trim()}
            >
              <Zap size={16} />
              <span>Execute</span>
            </button>
          )}
        </div>
      </motion.div>

      {/* ─── Tab Switcher ──────────────────────────────── */}
      <div className="agent-tabs">
        <button
          className={`agent-tab ${activeTab === 'missions' ? 'active' : ''}`}
          onClick={() => setActiveTab('missions')}
        >
          <Terminal size={14} />
          Mission Reports
          {messages.length > 0 && <span className="tab-count">{messages.filter(m => m.role === 'assistant').length}</span>}
        </button>
        <button
          className={`agent-tab ${activeTab === 'dashboards' ? 'active' : ''}`}
          onClick={() => setActiveTab('dashboards')}
        >
          <BarChart3 size={14} />
          Generated Dashboards
        </button>
      </div>

      {/* ─── Mission Reports Tab ──────────────────────── */}
      {activeTab === 'missions' && (
        <div className="agent-missions">
          {messages.length === 0 && !isQuerying && (
            <motion.div
              className="agent-empty"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
            >
              <div className="agent-empty-icon">
                <Zap size={32} />
              </div>
              <h2>Strategic Intelligence Agent</h2>
              <p>I'm your autonomous CFO. I can analyze your data, generate charts, create dashboards, and provide strategic recommendations — all grounded in your live financial data.</p>

              <div className="suggested-queries agent-suggestions">
                {AGENT_SUGGESTIONS.map((q, i) => (
                  <motion.button
                    key={i}
                    className="suggested-btn agent-suggest-btn"
                    onClick={() => handleQuery(q)}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.1 + i * 0.05 }}
                    whileHover={{ scale: 1.02, y: -2 }}
                    whileTap={{ scale: 0.98 }}
                  >
                    <ChevronRight size={12} />
                    {q}
                  </motion.button>
                ))}
              </div>
            </motion.div>
          )}

          <AnimatePresence>
            {messages.slice().reverse().map((msg) => (
              <motion.div
                key={msg.id}
                className={`agent-mission-card ${msg.role}`}
                initial={{ opacity: 0, y: 15, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                transition={{ duration: 0.3 }}
              >
                <div className="mission-card-header">
                  <div className="mission-card-label">
                    {msg.role === 'user' ? (
                      <>
                        <User size={12} />
                        <span>MISSION BRIEF</span>
                      </>
                    ) : (
                      <>
                        <CheckCircle2 size={12} />
                        <span>EXECUTION REPORT</span>
                      </>
                    )}
                  </div>
                  <div className="mission-card-meta">
                    <Clock size={11} />
                    <span>{new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                    {msg.metrics && (
                      <>
                        <span>·</span>
                        <span>{((msg.metrics.totalMs || 0) / 1000).toFixed(1)}s</span>
                      </>
                    )}
                  </div>
                </div>
                <div className="mission-card-body">
                  {msg.role === 'assistant' ? (
                    <MarkdownRenderer content={msg.content} />
                  ) : (
                    <p>{msg.content}</p>
                  )}
                </div>
              </motion.div>
            ))}
          </AnimatePresence>

          {/* Streaming */}
          {isQuerying && (
            <motion.div
              className="agent-mission-card assistant streaming-card"
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
            >
              <div className="mission-card-header">
                <div className="mission-card-label streaming-label">
                  <div className="mini-spinner" />
                  <span>MISSION IN PROGRESS</span>
                </div>
                {streamingStatus && <span className="streaming-status">{streamingStatus}</span>}
              </div>
              <div className="mission-card-body">
                {streamingContent ? (
                  <>
                    <MarkdownRenderer content={streamingContent} />
                    <span className="cursor-blink">▊</span>
                  </>
                ) : (
                  <div className="thinking-dots">
                    <div className="thinking-dot" />
                    <div className="thinking-dot" />
                    <div className="thinking-dot" />
                  </div>
                )}
              </div>
            </motion.div>
          )}

          <div ref={chatEndRef} />
        </div>
      )}

      {/* ─── Generated Dashboards Tab ──────────────────── */}
      {activeTab === 'dashboards' && (
        <div className="agent-dashboards">
          <FinancialInsights />
        </div>
      )}
    </div>
  );
}
