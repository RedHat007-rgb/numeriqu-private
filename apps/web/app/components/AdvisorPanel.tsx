"use client";

import React, { useState, useRef, useEffect } from 'react';
import { apiFetch } from '../lib/supabase';
import MarkdownRenderer from './MarkdownRenderer';
import { motion, AnimatePresence } from 'framer-motion';
import { Send, StopCircle, Sparkles, User, Bot, Clock, Zap } from 'lucide-react';

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

const SUGGESTED_QUERIES = [
  "What is my current profitability across all providers?",
  "Compare revenue between my organizations",
  "What's my overdue invoice risk exposure?",
  "Analyze my monthly revenue trend",
  "Which organization generates the most revenue?",
  "How healthy is my cash flow right now?",
];

export default function AdvisorPanel() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isQuerying, setIsQuerying] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [streamingStatus, setStreamingStatus] = useState('');
  const chatEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

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

      const response = await apiFetch('/rag/query', {
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
        fullContent = fullContent || 'Dialogue cancelled by user.';
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
    <div className="advisor-panel">
      {/* Chat Messages */}
      <div className="advisor-messages">
        {messages.length === 0 && !isQuerying && (
          <motion.div
            className="advisor-empty"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.5 }}
          >
            <div className="advisor-empty-icon">
              <Sparkles size={32} />
            </div>
            <h2>Financial Advisor</h2>
            <p>Ask me anything about your revenue, expenses, profitability, or connected organizations. Every answer is grounded in your live accounting data.</p>

            <div className="suggested-queries">
              {SUGGESTED_QUERIES.map((q, i) => (
                <motion.button
                  key={i}
                  className="suggested-btn"
                  onClick={() => handleQuery(q)}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.1 + i * 0.05 }}
                  whileHover={{ scale: 1.02, y: -2 }}
                  whileTap={{ scale: 0.98 }}
                >
                  <Sparkles size={12} />
                  {q}
                </motion.button>
              ))}
            </div>
          </motion.div>
        )}

        <AnimatePresence>
          {messages.map((msg) => (
            <motion.div
              key={msg.id}
              className={`chat-msg ${msg.role}`}
              initial={{ opacity: 0, y: 15, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ duration: 0.3 }}
            >
              <div className="chat-msg-avatar">
                {msg.role === 'user' ? <User size={16} /> : <Bot size={16} />}
              </div>
              <div className="chat-msg-body">
                <div className="chat-msg-header">
                  <span className="chat-msg-role">{msg.role === 'user' ? 'You' : 'Numeriqu Advisor'}</span>
                  <span className="chat-msg-time">{new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                </div>
                <div className="chat-msg-content">
                  {msg.role === 'assistant' ? (
                    <MarkdownRenderer content={msg.content} />
                  ) : (
                    msg.content
                  )}
                </div>
                {msg.metrics && (
                  <div className="chat-msg-metrics">
                    <Clock size={11} />
                    <span>{((msg.metrics.totalMs || 0) / 1000).toFixed(1)}s</span>
                    <Zap size={11} />
                    <span>{msg.metrics.mode}</span>
                  </div>
                )}
              </div>
            </motion.div>
          ))}
        </AnimatePresence>

        {/* Streaming message */}
        {isQuerying && (
          <motion.div
            className="chat-msg assistant"
            initial={{ opacity: 0, y: 15 }}
            animate={{ opacity: 1, y: 0 }}
          >
            <div className="chat-msg-avatar streaming">
              <Bot size={16} />
            </div>
            <div className="chat-msg-body">
              <div className="chat-msg-header">
                <span className="chat-msg-role">Numeriqu Advisor</span>
                {streamingStatus && <span className="streaming-status">{streamingStatus}</span>}
              </div>
              <div className="chat-msg-content">
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
            </div>
          </motion.div>
        )}

        <div ref={chatEndRef} />
      </div>

      {/* Input Area */}
      <div className="advisor-input-area">
        <div className="advisor-input-wrap">
          <input
            ref={inputRef}
            className="advisor-input"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about your revenue, expenses, margins..."
            disabled={isQuerying}
          />
          {isQuerying ? (
            <button className="advisor-btn cancel" onClick={cancelQuery} title="Cancel query">
              <StopCircle size={18} />
            </button>
          ) : (
            <button
              className="advisor-btn send"
              onClick={() => handleQuery()}
              disabled={!input.trim()}
              title="Send query"
            >
              <Send size={18} />
            </button>
          )}
        </div>
        <p className="advisor-disclaimer">Responses are grounded in your live ClickHouse data. No hallucinations.</p>
      </div>
    </div>
  );
}
