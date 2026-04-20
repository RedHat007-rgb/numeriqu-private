"use client";

import React from "react";
import { GlassCard } from "./GlassCard";

export const InsightsChatbot: React.FC = () => {
  return (
    <section id="rag" className="py-24 px-6 max-w-7xl mx-auto">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-12 items-center">
        {/* Left: Copy */}
        <div>
          <div className="font-mono text-xs text-blue-400 tracking-widest mb-4">
            INSIGHTS CHATBOT
          </div>
          <h2 className="text-4xl md:text-5xl font-bold mb-6 text-white">
            Ask your data anything. Get answers instantly.
          </h2>
          <p className="text-lg text-text-muted mb-8 leading-relaxed">
            Our RAG-powered search understands your financial documents,
            reports, and market feeds. Every answer is source-cited, combining
            multiple documents for comprehensive insights your team can trust
            and act on immediately.
          </p>

          {/* Feature Chips */}
          <div className="flex flex-wrap gap-3">
            {[
              "Source-cited answers",
              "Multi-doc search",
              "Real-time context",
            ].map((feature) => (
              <div
                key={feature}
                className="px-4 py-2 bg-blue-500/10 border border-blue-400/30 rounded-full text-sm text-blue-300"
              >
                ✓ {feature}
              </div>
            ))}
          </div>
        </div>

        {/* Right: Animated Chat UI */}
        <GlassCard glowColor="blue" className="p-6">
          <div className="space-y-4">
            {/* System Message */}
            <div className="text-sm text-text-muted">
              💬 Assistant:{" "}
              <span className="text-blue-300">
                Ready to analyze your data...
              </span>
            </div>

            {/* User Message */}
            <div className="bg-blue-500/20 rounded p-4 text-right">
              <p className="text-sm text-blue-100">
                "What drove the revenue spike in Q3?"
              </p>
            </div>

            {/* AI Response with Streaming Effect */}
            <div className="bg-violet-500/10 rounded p-4 border border-violet-400/20">
              <p className="text-sm text-violet-200 leading-relaxed">
                Based on analysis of Q3 reports and market data:
                <br />
                <br />
                • New enterprise partnerships contributed 35% growth
                <br />
                • Seasonal market demand surge (+28%)
                <br />• Operational efficiency gains added $1.2M
                <span className="animate-blink">|</span>
              </p>
            </div>

            {/* Citation Chips */}
            <div className="flex flex-wrap gap-2 mt-4">
              {[
                "[Q3_Report.pdf]",
                "[MarketTrends_2026.csv]",
                "[Revenue_Analysis.docx]",
              ].map((source) => (
                <div
                  key={source}
                  className="text-xs px-2 py-1 bg-cyan-500/10 border border-cyan-400/30 rounded text-cyan-300"
                >
                  {source}
                </div>
              ))}
            </div>

            {/* Input Bar */}
            <div className="mt-6 flex gap-2 pt-4 border-t border-white/10">
              <input
                type="text"
                placeholder="Ask another question..."
                className="flex-1 bg-slate-800/50 border border-white/10 rounded px-3 py-2 text-sm text-text-primary placeholder-text-muted outline-none"
              />
              <button className="px-4 py-2 bg-blue-500 text-white rounded text-sm font-medium hover:bg-blue-600">
                ↑
              </button>
            </div>
          </div>
        </GlassCard>
      </div>
    </section>
  );
};
