"use client";

import React, { useEffect, useState } from "react";
import { GlassCard } from "@repo/ui";
import { useNumeriquApi } from "../../../lib/useNumeriquApi";
import { 
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, 
  ResponsiveContainer, PieChart, Pie, Cell 
} from "recharts";
import { motion, AnimatePresence } from "framer-motion";
import { Maximize2, X } from "lucide-react";

interface ChartConfig {
  metric: string;
  grouping: string;
}

interface Chart {
  id: string;
  title: string;
  description?: string | null;
  type: string;
  config: ChartConfig;
  layoutIndex?: number;
}

interface Dashboard {
  id: string;
  title: string;
  description?: string | null;
  charts: Chart[];
}

const COLORS = ["#3b82f6", "#7c3aed", "#06b6d4", "#14b8a6", "#f59e0b"];

export function DashboardPreview({ triggerSync }: { triggerSync: number }) {
  const { agent, loading } = useNumeriquApi();
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [chartData, setChartData] = useState<Record<string, any[]>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [expandedChartId, setExpandedChartId] = useState<string | null>(null);

  useEffect(() => {
    if (loading) return;
    
    const fetchDashboard = async () => {
      setIsLoading(true);
      try {
        const latest = await agent.latestDashboard();
        if (latest) {
          setDashboard(latest);
          const dataMap: Record<string, any[]> = {};
          await Promise.all(
            latest.charts.map(async (c: Chart) => {
              const res = await agent.getMetrics(c.config.metric, c.config.grouping);
              dataMap[c.id] = res.data;
            })
          );
          setChartData(dataMap);
        }
      } catch (err) {
        console.error("Dashboard sync failed", err);
      } finally {
        setIsLoading(false);
      }
    };

    fetchDashboard();
  }, [agent, loading, triggerSync]);

  const renderChart = (chart: Chart, isExpanded = false) => {
    const data = chartData[chart.id] || [];
    const chartPx = isExpanded ? 520 : 220;
    return (
      <div className="w-full min-w-0" style={{ height: chartPx }}>
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
        {chart.type === "bar" ? (
          <BarChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke="#ffffff10" />
            <XAxis dataKey="name" stroke="#64748b" fontSize={isExpanded ? 12 : 10} />
            <YAxis stroke="#64748b" fontSize={isExpanded ? 12 : 10} />
            <Tooltip 
              contentStyle={{ backgroundColor: "#0f172a", border: "1px solid #ffffff10", borderRadius: "8px" }}
              itemStyle={{ color: "#f1f5f9" }}
            />
            <Bar dataKey="value" fill="#7c3aed" radius={[4, 4, 0, 0]} />
          </BarChart>
        ) : chart.type === "pie" ? (
          <PieChart>
            <Pie
              data={data}
              cx="50%"
              cy="50%"
              innerRadius={isExpanded ? 80 : 40}
              outerRadius={isExpanded ? 140 : 70}
              paddingAngle={5}
              dataKey="value"
            >
              {data.map((_, index) => (
                <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} stroke="none" />
              ))}
            </Pie>
            <Tooltip />
          </PieChart>
        ) : (
          <LineChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke="#ffffff10" />
            <XAxis dataKey="name" stroke="#64748b" fontSize={isExpanded ? 12 : 10} />
            <YAxis stroke="#64748b" fontSize={isExpanded ? 12 : 10} />
            <Tooltip 
              contentStyle={{ backgroundColor: "#0f172a", border: "1px solid #ffffff10", borderRadius: "8px" }}
            />
            <Line type="monotone" dataKey="value" stroke="#3b82f6" strokeWidth={isExpanded ? 3 : 2} dot={isExpanded} />
          </LineChart>
        )}
        </ResponsiveContainer>
      </div>
    );
  };

  if (!dashboard) {
    return (
      <div className="h-full flex items-center justify-center text-slate-500 italic text-sm border-2 border-dashed border-white/5 rounded-2xl p-20">
        No active mission intelligence. Deploy a command to synthesize.
      </div>
    );
  }

  const expandedChart = dashboard.charts.find(c => c.id === expandedChartId);

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center bg-emerald-500/10 p-4 rounded-xl border border-emerald-500/20">
        <div>
          <h2 className="text-xl font-bold text-emerald-100">{dashboard.title}</h2>
          <p className="text-xs text-emerald-300/80">{dashboard.description || "Synthesized analytical view"}</p>
        </div>
        <div className="flex items-center gap-2">
           <div className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse"></div>
           <span className="text-[10px] font-bold text-emerald-400 uppercase tracking-widest">Live Sync Intelligence</span>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pb-12">
        {dashboard.charts.map((chart) => (
          <div
            key={chart.id}
            className="cursor-pointer"
            onClick={() => setExpandedChartId(chart.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setExpandedChartId(chart.id);
              }
            }}
            role="button"
            tabIndex={0}
          >
            <GlassCard className="p-4 flex flex-col h-[320px] hover:border-emerald-500/40 transition-all relative group">
              <div className="absolute top-4 right-4 opacity-0 group-hover:opacity-100 transition-opacity">
                <Maximize2 size={14} className="text-emerald-400" />
              </div>
              <div className="mb-4">
                <h3 className="text-sm font-semibold text-slate-200">{chart.title}</h3>
                <p className="text-[10px] text-slate-500 uppercase tracking-wider">{chart.type} · {chart.config.metric}</p>
              </div>

              <div className="flex-1 w-full min-h-0 pointer-events-none">
                {renderChart(chart)}
              </div>
            </GlassCard>
          </div>
        ))}
      </div>

      <AnimatePresence>
        {expandedChart && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }} 
              animate={{ opacity: 1 }} 
              exit={{ opacity: 0 }}
              className="absolute inset-0 bg-black/80 backdrop-blur-xl"
              onClick={() => setExpandedChartId(null)}
            />
            <motion.div
              layoutId={expandedChart.id}
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="relative w-full max-w-5xl h-[80vh] bg-[#020617] border border-white/10 rounded-3xl p-8 shadow-2xl flex flex-col"
            >
              <button 
                onClick={() => setExpandedChartId(null)}
                className="absolute top-6 right-6 p-2 rounded-full bg-white/5 hover:bg-white/10 text-slate-400 hover:text-white transition-colors"
                title="Close Deep Dive"
              >
                <X size={20} />
              </button>
              
              <div className="mb-8">
                <h2 className="text-2xl font-bold text-white mb-2">{expandedChart.title}</h2>
                <p className="text-slate-400 text-sm">{expandedChart.description || `Tactical analysis of ${expandedChart.config.metric} grouped by ${expandedChart.config.grouping}.`}</p>
              </div>

              <div className="flex-1 w-full min-h-0 bg-white/[0.02] rounded-2xl p-6 border border-white/5">
                {renderChart(expandedChart, true)}
              </div>
              
              <div className="mt-8 flex justify-between items-center text-[10px] uppercase tracking-[0.2em] text-slate-500 font-bold">
                <span>Mission Intelligence Unit</span>
                <span>NumeriQu Strategic Layer v2</span>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
