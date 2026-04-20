"use client";

import React from "react";
import { GlassCard } from "./GlassCard";
import { SparklineChart } from "./SparklineChart";

export const FeaturesGrid: React.FC = () => {
  return (
    <section id="features" className="py-24 px-6 max-w-7xl mx-auto">
      <h2 className="text-4xl md:text-5xl font-bold mb-16 text-white">
        Powerful Features Built for Modern Finance
      </h2>

      {/* Bento Grid */}
      <div className="grid grid-cols-1 md:grid-cols-12 gap-6">
        {/* Card A: Market Overview - 2 cols */}
        <GlassCard
          glowColor="blue"
          className="md:col-span-6 p-8 hover:translate-y-[-4px] transition-transform cursor-pointer"
        >
          <h3 className="text-xl font-bold mb-6 flex items-center gap-2">
            <span className="text-blue-400">📊</span> Market Overview
          </h3>

          {/* Ticker Simulation */}
          <div className="space-y-3">
            {[
              { ticker: "NASDAQ:MSFT", price: "$425.30", change: "+2.3%" },
              { ticker: "S&P:SPX", price: "$5,280.15", change: "+1.8%" },
              { ticker: "NYSE:AAPL", price: "$189.45", change: "-0.5%" },
            ].map((item) => (
              <div
                key={item.ticker}
                className="flex justify-between items-center p-3 bg-slate-800/30 rounded border border-white/5"
              >
                <div className="flex-1">
                  <p className="text-sm font-mono font-bold text-blue-300">
                    {item.ticker}
                  </p>
                  <SparklineChart
                    data={[10, 15, 13, 20, 18, 25, 22]}
                    color="cyan"
                    width={100}
                    height={20}
                  />
                </div>
                <div className="text-right">
                  <p className="text-sm font-mono text-white">{item.price}</p>
                  <p
                    className={`text-xs font-mono ${
                      item.change.includes("-")
                        ? "text-red-400"
                        : "text-green-400"
                    }`}
                  >
                    {item.change}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </GlassCard>

        {/* Card B: RAG Search - 1 col */}
        <GlassCard
          glowColor="violet"
          className="md:col-span-3 p-6 hover:translate-y-[-4px] transition-transform cursor-pointer"
        >
          <h3 className="text-lg font-bold mb-4 flex items-center gap-2">
            <span>🔍</span> RAG Search
          </h3>
          <div className="space-y-3">
            <input
              type="text"
              placeholder="Search documents..."
              className="w-full bg-slate-800/50 border border-white/10 rounded px-3 py-2 text-sm text-text-primary"
            />
            <div className="space-y-2">
              {["Q3 Report", "Budget Plan", "Market Trends"].map((doc) => (
                <div
                  key={doc}
                  className="text-xs p-2 bg-slate-800/30 rounded border border-white/5 text-text-muted"
                >
                  📄 {doc}
                </div>
              ))}
            </div>
          </div>
        </GlassCard>

        {/* Card C: Revenue Analytics - 1 col */}
        <GlassCard className="md:col-span-3 p-6 hover:translate-y-[-4px] transition-transform cursor-pointer">
          <h3 className="text-lg font-bold mb-4 flex items-center gap-2">
            <span>💰</span> Revenue Analytics
          </h3>
          <div className="text-center">
            <p className="text-3xl font-bold text-cyan-400 mb-2">78%</p>
            <p className="text-sm text-text-muted">Goal Achieved</p>
            <SparklineChart
              data={[20, 35, 28, 50, 45, 65, 78]}
              color="teal"
              width={120}
              height={40}
            />
          </div>
        </GlassCard>

        {/* Card D: KPI Monitoring - 1 col */}
        <GlassCard className="md:col-span-3 p-6 hover:translate-y-[-4px] transition-transform cursor-pointer">
          <h3 className="text-lg font-bold mb-4 flex items-center gap-2">
            <span>📈</span> Key Metrics
          </h3>
          <div className="space-y-3">
            {[
              { metric: "Profitability", value: "+$2.4M", trend: "↑" },
              { metric: "Cost Savings", value: "18%", trend: "↑" },
              { metric: "Efficiency", value: "+34%", trend: "↑" },
            ].map((item) => (
              <div
                key={item.metric}
                className="flex justify-between items-center"
              >
                <span className="text-xs text-text-muted">{item.metric}</span>
                <span
                  className={`text-sm font-mono font-bold ${
                    item.trend === "↑" ? "text-green-400" : "text-red-400"
                  }`}
                >
                  {item.value}
                </span>
              </div>
            ))}
          </div>
        </GlassCard>

        {/* Card E: Reports - 1 col */}
        <GlassCard
          glowColor="blue"
          className="md:col-span-3 p-6 hover:translate-y-[-4px] transition-transform cursor-pointer"
        >
          <h3 className="text-lg font-bold mb-4 flex items-center gap-2">
            <span>📅</span> Scheduled Reports
          </h3>
          <div className="space-y-2">
            {["Weekly Report", "Monthly Summary", "Quarterly Analysis"].map(
              (report) => (
                <div
                  key={report}
                  className="text-xs p-2 bg-blue-500/10 border border-blue-400/30 rounded text-blue-300"
                >
                  ⏰ {report}
                </div>
              ),
            )}
          </div>
        </GlassCard>
      </div>
    </section>
  );
};
