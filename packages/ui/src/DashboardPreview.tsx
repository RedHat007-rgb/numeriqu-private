"use client";

import React from "react";
import { GlassCard } from "./GlassCard";
import { SparklineChart } from "./SparklineChart";

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

  const pathData = points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`)
    .join(" ");
  const fillPath = `${pathData} L ${width} ${height} L 0 ${height} Z`;

  return (
    <svg
      width={width}
      height={height + 20}
      viewBox={`0 0 ${width} ${height + 20}`}
    >
      <path d={fillPath} fill={colorMap[color].fill} />
      <path
        d={pathData}
        stroke={colorMap[color].stroke}
        strokeWidth="2"
        fill="none"
      />
    </svg>
  );
};

const DonutChart: React.FC = () => {
  const radius = 45;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference * 0.22; // 78% filled

  return (
    <svg width="120" height="120" viewBox="0 0 120 120">
      <circle
        cx="60"
        cy="60"
        r={radius}
        fill="none"
        stroke="#1e293b"
        strokeWidth="8"
      />
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
      <text
        x="60"
        y="65"
        textAnchor="middle"
        fill="#3b82f6"
        fontSize="18"
        fontWeight="bold"
      >
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
    <svg width="170" height="120" viewBox="0 0 170 120">
      {bars.map((bar, i) => (
        <g key={i}>
          {/* Wick */}
          <line
            x1={bar.x + 5}
            y1={120 - bar.h}
            x2={bar.x + 5}
            y2={120}
            stroke="#06b6d4"
            strokeWidth="1"
          />
          {/* Candle Body */}
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
    <section className="py-24 px-6 max-w-7xl mx-auto">
      {/* Section Label */}
      <div className="mb-4 font-mono text-xs text-text-muted tracking-widest">
        PLATFORM PREVIEW
      </div>

      {/* Headline */}
      <h2 className="text-4xl md:text-5xl font-bold mb-12 text-white">
        Everything in one command center
      </h2>

      {/* Mock Browser Window */}
      <div className="relative">
        {/* Browser Chrome */}
        <div className="bg-slate-900 rounded-t-lg border border-white/10 p-4 flex items-center gap-2">
          <div className="flex gap-2">
            <div className="w-3 h-3 rounded-full bg-red-500" />
            <div className="w-3 h-3 rounded-full bg-yellow-500" />
            <div className="w-3 h-3 rounded-full bg-green-500" />
          </div>
          <div className="flex-1 text-center text-xs text-text-muted font-mono">
            app.numeriqu.ai/dashboard
          </div>
        </div>

        {/* Dashboard Content */}
        <GlassCard className="rounded-t-none border-t-0 p-8 relative">
          {/* Glow Effect Behind */}
          <div className="absolute -top-32 right-0 w-96 h-96 bg-blue-500 opacity-20 blur-3xl pointer-events-none" />

          {/* 3-Column Grid */}
          <div className="grid grid-cols-12 gap-6 relative z-10">
            {/* LEFT COLUMN */}
            <div className="col-span-12 md:col-span-3">
              <GlassCard glowColor="blue" className="p-4 h-full">
                <div className="flex justify-between items-center mb-4">
                  <h3 className="text-sm font-mono font-bold">
                    INSIGHTS CHATBOT
                  </h3>
                  <span className="text-xs">×</span>
                </div>

                {/* Chat Messages */}
                <div className="space-y-3 mb-4">
                  {[
                    { role: "user", msg: "Q3 revenue analysis?" },
                    { role: "ai", msg: "Revenue grew 24% YoY..." },
                  ].map((chat, i) => (
                    <div
                      key={i}
                      className={`text-xs p-2 rounded ${
                        chat.role === "user"
                          ? "bg-blue-500/20 text-blue-200 ml-4"
                          : "bg-violet-500/20 text-violet-200 mr-4"
                      }`}
                    >
                      {chat.msg}
                    </div>
                  ))}
                </div>

                {/* Search Bar */}
                <div className="bg-slate-800/50 rounded p-2 text-xs text-text-muted border border-white/10">
                  Type your query...
                </div>
              </GlassCard>
            </div>

            {/* CENTER COLUMN */}
            <div className="col-span-12 md:col-span-6 space-y-4">
              {/* Market Overview */}
              <GlassCard glowColor="blue" className="p-4">
                <div className="flex justify-between items-center mb-3">
                  <div>
                    <h3 className="text-sm font-mono font-bold">
                      MARKET OVERVIEW
                    </h3>
                    <div className="flex gap-2 mt-2">
                      {["NASDAQ", "TECH", "FINANCE"].map((tag) => (
                        <span
                          key={tag}
                          className="text-xs px-2 py-1 bg-blue-500/20 text-blue-300 rounded"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  </div>
                  <span className="text-xs">↗</span>
                </div>
                <AreaChart data={[10, 25, 20, 35, 40, 30, 45]} color="blue" />
              </GlassCard>

              {/* Revenue Breakdown */}
              <GlassCard className="p-4">
                <div className="flex justify-between items-center mb-3">
                  <h3 className="text-sm font-mono font-bold">
                    REVENUE BREAKDOWN
                  </h3>
                  <span className="text-xs">↓</span>
                </div>
                <div className="flex justify-around items-center">
                  <AreaChart data={[15, 30, 25, 40]} color="cyan" height={80} />
                  <DonutChart />
                </div>
              </GlassCard>

              {/* Document Search */}
              <GlassCard glowColor="violet" className="p-4">
                <div className="flex justify-between items-center mb-3">
                  <h3 className="text-sm font-mono font-bold">
                    DOCUMENT SEARCH
                  </h3>
                  <span className="text-xs">×</span>
                </div>
                <AreaChart
                  data={[8, 20, 15, 32, 25, 40]}
                  color="violet"
                  height={80}
                />
              </GlassCard>
            </div>

            {/* RIGHT COLUMN */}
            <div className="col-span-12 md:col-span-3 space-y-4">
              {/* Metrics Chips */}
              <div className="grid grid-cols-3 gap-2">
                {["↑ 24%", "↓ 8%", "→ 12%"].map((metric) => (
                  <div
                    key={metric}
                    className="bg-blue-500/10 border border-blue-400/30 rounded p-2 text-center text-xs font-mono text-blue-300"
                  >
                    {metric}
                  </div>
                ))}
              </div>

              {/* Key Metrics */}
              <GlassCard className="p-4">
                <h3 className="text-sm font-mono font-bold mb-4">
                  KEY METRICS
                </h3>
                <div className="space-y-3">
                  {[
                    { label: "Profitability", value: "+$2.4M" },
                    { label: "Cost Reduction", value: "18%" },
                    { label: "Efficiency Gain", value: "+34%" },
                  ].map((m) => (
                    <div key={m.label} className="flex justify-between text-xs">
                      <span className="text-text-muted">{m.label}</span>
                      <span className="text-cyan-400 font-mono">{m.value}</span>
                    </div>
                  ))}
                </div>
              </GlassCard>

              {/* Live Chart */}
              <GlassCard className="p-4">
                <h3 className="text-xs font-mono font-bold mb-3">
                  LIVE ANALYTICS
                </h3>
                <CandleChart />
              </GlassCard>
            </div>
          </div>
        </GlassCard>
      </div>
    </section>
  );
};
