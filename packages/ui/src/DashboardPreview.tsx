"use client";

import React from "react";
import { GlassCard } from "./GlassCard";

const AreaChart: React.FC<{
  data: number[];
  color: "blue" | "violet" | "cyan";
  height?: number;
}> = ({ data, color, height = 120 }) => {
  const colorMap = {
    blue: { stroke: "#3b82f6", fill: "rgba(59, 130, 246, 0.2)" },
    violet: { stroke: "#7c3aed", fill: "rgba(124, 58, 237, 0.2)" },
    cyan: { stroke: "#06b6d4", fill: "rgba(6, 182, 212, 0.2)" },
  };

  const width = 280;
  const minVal = Math.min(...data);
  const maxVal = Math.max(...data);
  const range = maxVal - minVal || 1;

  const points = data.map((v, i) => ({
    x: (i / (data.length - 1)) * width,
    y: height - ((v - minVal) / range) * height,
  }));

  const pathData = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
  const fillPath = `${pathData} L ${width} ${height} L 0 ${height} Z`;

  return (
    <svg width={width} height={height + 20} viewBox={`0 0 ${width} ${height + 20}`}>
      <path d={fillPath} fill={colorMap[color].fill} />
      <path d={pathData} stroke={colorMap[color].stroke} strokeWidth="2" fill="none" />
    </svg>
  );
};

const DonutChart: React.FC = () => {
  const radius = 45;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference * 0.22;

  return (
    <svg width="120" height="120" viewBox="0 0 120 120" aria-hidden>
      <circle cx="60" cy="60" r={radius} fill="none" stroke="rgb(var(--color-bg-elevated))" strokeWidth="8" />
      <circle
        cx="60"
        cy="60"
        r={radius}
        fill="none"
        stroke="#3b82f6"
        strokeWidth="8"
        strokeDasharray={circumference}
        strokeDashoffset={strokeDashoffset}
        strokeLinecap="round"
        transform="rotate(-90 60 60)"
      />
      <text x="60" y="65" textAnchor="middle" fill="#3b82f6" fontSize="18" fontWeight="bold">
        78%
      </text>
    </svg>
  );
};

const CandleChart: React.FC = () => {
  const bars = [
    { x: 20, h: 60, open: 30, close: 50 },
    { x: 50, h: 80, open: 20, close: 70 },
    { x: 80, h: 50, open: 45, close: 25 },
    { x: 110, h: 90, open: 40, close: 80 },
    { x: 140, h: 70, open: 35, close: 60 },
  ];

  return (
    <svg width="170" height="120" viewBox="0 0 170 120" aria-hidden>
      {bars.map((bar, i) => (
        <g key={i}>
          <line x1={bar.x + 5} y1={120 - bar.h} x2={bar.x + 5} y2={120} stroke="#06b6d4" strokeWidth="1" />
          <rect
            x={bar.x}
            y={120 - Math.max(bar.open, bar.close)}
            width="10"
            height={Math.abs(bar.close - bar.open)}
            fill={bar.close > bar.open ? "#14b8a6" : "#ef4444"}
            stroke={bar.close > bar.open ? "#06b6d4" : "#f87171"}
            strokeWidth="1"
          />
        </g>
      ))}
    </svg>
  );
};

export const DashboardPreview: React.FC = () => {
  return (
    <section className="mx-auto max-w-7xl px-6 py-24">
      <div className="mb-4 font-mono text-xs uppercase tracking-[0.28em] text-accent-blue">
        PLATFORM PREVIEW
      </div>
      <h2 className="mb-12 text-text-primary">Everything in one command center</h2>

      <div className="relative">
        <div className="flex items-center gap-2 rounded-t-lg border border-default bg-bg-card/80 p-4">
          <div className="flex gap-2" aria-hidden>
            <div className="h-3 w-3 rounded-full bg-feedback-danger" />
            <div className="h-3 w-3 rounded-full bg-feedback-warning" />
            <div className="h-3 w-3 rounded-full bg-feedback-success" />
          </div>
          <div className="flex-1 text-center font-mono text-xs text-text-muted">
            app.numeriqu.com / dashboard
          </div>
        </div>

        <GlassCard className="relative rounded-t-none border-t-0 p-8">
          <div
            className="pointer-events-none absolute -top-32 right-0 h-96 w-96 bg-accent-blue opacity-20 blur-3xl"
            aria-hidden
          />

          <div className="relative z-10 grid grid-cols-12 gap-6">
            <div className="col-span-12 md:col-span-3">
              <GlassCard glowColor="blue" className="h-full p-4">
                <div className="mb-4 flex items-center justify-between">
                  <h3 className="font-mono text-sm font-bold text-text-primary">RAG ADVISOR</h3>
                  <span className="text-xs text-text-muted" aria-hidden>×</span>
                </div>

                <div className="mb-4 space-y-3">
                  {[
                    { role: "user", msg: "Q3 revenue analysis?" },
                    { role: "ai", msg: "Revenue grew 24% YoY..." },
                  ].map((chat, i) => (
                    <div
                      key={i}
                      className={`rounded p-2 text-xs ${
                        chat.role === "user"
                          ? "ml-4 bg-accent-blue/20 text-accent-blue"
                          : "mr-4 bg-accent-violet/20 text-accent-violet"
                      }`}
                    >
                      {chat.msg}
                    </div>
                  ))}
                </div>

                <div className="rounded border border-default bg-bg-elevated/40 p-2 text-xs text-text-muted">
                  Type your query...
                </div>
              </GlassCard>
            </div>

            <div className="col-span-12 space-y-4 md:col-span-6">
              <GlassCard glowColor="blue" className="p-4">
                <div className="mb-3 flex items-center justify-between">
                  <div>
                    <h3 className="font-mono text-sm font-bold text-text-primary">REVENUE TREND</h3>
                    <div className="mt-2 flex gap-2">
                      {["YTD", "MoM", "QoQ"].map((tag) => (
                        <span
                          key={tag}
                          className="rounded bg-accent-blue/20 px-2 py-1 text-xs text-accent-blue"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  </div>
                  <span className="text-xs text-feedback-success" aria-hidden>↗</span>
                </div>
                <AreaChart data={[10, 25, 20, 35, 40, 30, 45]} color="blue" />
              </GlassCard>

              <GlassCard className="p-4">
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="font-mono text-sm font-bold text-text-primary">REVENUE BREAKDOWN</h3>
                  <span className="text-xs text-text-muted" aria-hidden>↓</span>
                </div>
                <div className="flex items-center justify-around">
                  <AreaChart data={[15, 30, 25, 40]} color="cyan" height={80} />
                  <DonutChart />
                </div>
              </GlassCard>

              <GlassCard glowColor="violet" className="p-4">
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="font-mono text-sm font-bold text-text-primary">DOCUMENT SEARCH</h3>
                  <span className="text-xs text-text-muted" aria-hidden>×</span>
                </div>
                <AreaChart data={[8, 20, 15, 32, 25, 40]} color="violet" height={80} />
              </GlassCard>
            </div>

            <div className="col-span-12 space-y-4 md:col-span-3">
              <div className="grid grid-cols-3 gap-2">
                {["+24%", "-8%", "+12%"].map((metric) => (
                  <div
                    key={metric}
                    className="rounded border border-accent-blue/30 bg-accent-blue/10 p-2 text-center font-mono text-xs text-accent-blue"
                  >
                    {metric}
                  </div>
                ))}
              </div>

              <GlassCard className="p-4">
                <h3 className="mb-4 font-mono text-sm font-bold text-text-primary">KEY METRICS</h3>
                <div className="space-y-3">
                  {[
                    { label: "Profitability", value: "+$2.4M" },
                    { label: "Cost reduction", value: "18%" },
                    { label: "Efficiency gain", value: "+34%" },
                  ].map((m) => (
                    <div key={m.label} className="flex justify-between text-xs">
                      <span className="text-text-muted">{m.label}</span>
                      <span className="font-mono text-accent-cyan">{m.value}</span>
                    </div>
                  ))}
                </div>
              </GlassCard>

              <GlassCard className="p-4">
                <h3 className="mb-3 font-mono text-xs font-bold text-text-primary">LIVE ANALYTICS</h3>
                <CandleChart />
              </GlassCard>
            </div>
          </div>
        </GlassCard>
      </div>
    </section>
  );
};
