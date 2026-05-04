"use client";

import React from "react";
import { GlassCard } from "./GlassCard";
import { SparklineChart } from "./SparklineChart";

export const FeaturesGrid: React.FC = () => {
  return (
    <section id="features" className="mx-auto max-w-7xl px-6 py-24">
      <div className="mb-12 text-center">
        <p className="font-mono text-xs uppercase tracking-[0.28em] text-accent-blue">
          Platform
        </p>
        <h2 className="mt-3 text-text-primary">A calm command center for finance</h2>
        <p className="mx-auto mt-4 max-w-2xl text-lg text-text-secondary">
          Replace ad-hoc spreadsheets with a unified view of revenue, runway,
          and exceptions — explained in plain English.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-12">
        <GlassCard
          glowColor="blue"
          className="cursor-pointer p-8 transition-transform hover:-translate-y-1 md:col-span-6"
        >
          <h3 className="mb-6 flex items-center gap-2 text-xl font-bold text-text-primary">
            <span aria-hidden className="text-accent-blue">📊</span> Live financial overview
          </h3>

          <div className="space-y-3">
            {[
              { ticker: "Revenue", price: "$1.84M", change: "+12.4%" },
              { ticker: "Runway", price: "14.2 mo", change: "+0.6 mo" },
              { ticker: "Burn", price: "$128K", change: "-3.1%" },
            ].map((item) => (
              <div
                key={item.ticker}
                className="flex items-center justify-between rounded-xl border border-default bg-bg-elevated/40 p-3"
              >
                <div className="flex-1">
                  <p className="text-sm font-semibold text-text-primary">{item.ticker}</p>
                  <SparklineChart data={[10, 15, 13, 20, 18, 25, 22]} color="cyan" width={100} height={20} />
                </div>
                <div className="text-right">
                  <p className="text-sm font-mono text-text-primary">{item.price}</p>
                  <p
                    className={`text-xs font-mono ${
                      item.change.startsWith("-") ? "text-feedback-danger" : "text-feedback-success"
                    }`}
                  >
                    {item.change}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </GlassCard>

        <GlassCard
          glowColor="violet"
          className="cursor-pointer p-6 transition-transform hover:-translate-y-1 md:col-span-3"
        >
          <h3 className="mb-4 flex items-center gap-2 text-lg font-bold text-text-primary">
            <span aria-hidden>🔍</span> RAG advisor
          </h3>
          <p className="mb-4 text-sm text-text-muted">
            Source-cited answers grounded in your finance data, not the public web.
          </p>
          <div className="space-y-2">
            {["Revenue drivers Q3", "Margin variance review", "Cash runway sensitivity"].map((doc) => (
              <div
                key={doc}
                className="rounded-md border border-default bg-bg-elevated/40 p-2 text-xs text-text-secondary"
              >
                {doc}
              </div>
            ))}
          </div>
        </GlassCard>

        <GlassCard className="cursor-pointer p-6 transition-transform hover:-translate-y-1 md:col-span-3">
          <h3 className="mb-4 flex items-center gap-2 text-lg font-bold text-text-primary">
            <span aria-hidden>💰</span> Margin tracker
          </h3>
          <div className="text-center">
            <p className="mb-2 text-3xl font-bold text-accent-cyan">78%</p>
            <p className="text-sm text-text-muted">Goal achieved this quarter</p>
            <SparklineChart data={[20, 35, 28, 50, 45, 65, 78]} color="teal" width={120} height={40} />
          </div>
        </GlassCard>

        <GlassCard className="cursor-pointer p-6 transition-transform hover:-translate-y-1 md:col-span-3">
          <h3 className="mb-4 flex items-center gap-2 text-lg font-bold text-text-primary">
            <span aria-hidden>📈</span> Key health metrics
          </h3>
          <div className="space-y-3">
            {[
              { metric: "Profitability", value: "+$2.4M", positive: true },
              { metric: "Cost discipline", value: "-18%", positive: true },
              { metric: "Operational efficiency", value: "+34%", positive: true },
            ].map((item) => (
              <div key={item.metric} className="flex items-center justify-between">
                <span className="text-xs text-text-muted">{item.metric}</span>
                <span
                  className={`text-sm font-mono font-bold ${
                    item.positive ? "text-feedback-success" : "text-feedback-danger"
                  }`}
                >
                  {item.value}
                </span>
              </div>
            ))}
          </div>
        </GlassCard>

        <GlassCard
          glowColor="blue"
          className="cursor-pointer p-6 transition-transform hover:-translate-y-1 md:col-span-3"
        >
          <h3 className="mb-4 flex items-center gap-2 text-lg font-bold text-text-primary">
            <span aria-hidden>📅</span> Scheduled reports
          </h3>
          <div className="space-y-2">
            {["Weekly board pack", "Monthly close summary", "Quarterly variance report"].map((report) => (
              <div
                key={report}
                className="rounded-md border border-accent-blue/30 bg-accent-blue/10 p-2 text-xs text-accent-blue"
              >
                ⏰ {report}
              </div>
            ))}
          </div>
        </GlassCard>
      </div>
    </section>
  );
};
