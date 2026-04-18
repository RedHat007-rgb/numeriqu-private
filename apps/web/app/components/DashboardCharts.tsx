"use client";

import React, { useEffect, useState, useCallback } from 'react';
import { apiFetch } from '../lib/supabase';
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import { motion, AnimatePresence } from 'framer-motion';
import {
  TrendingUp, TrendingDown, DollarSign, Activity, FileText,
  AlertTriangle, Building2, Zap, ArrowUpRight, ArrowDownRight,
  Wallet, Clock, BarChart3, PieChart as PieIcon, RefreshCcw,
} from 'lucide-react';

const CHART_COLORS = ['#00F5D4', '#9B5DE5', '#3B82F6', '#F59E0B', '#EF4444', '#10B981', '#F472B6', '#6366F1'];

interface DashboardData {
  kpis: {
    totalRevenue: number;
    totalExpenses: number;
    netProfit: number;
    profitMargin: number;
    totalInvoices: number;
    avgInvoiceValue: number;
    overdueAmount: number;
    overdueCount: number;
    orgCount: number;
    providerCount: number;
  };
  venture: {
    burnRate: number;
    runwayMonths: number;
    cashOnHand: number;
    efficiencyMultiplier: number;
  };
  charts: {
    monthlyTrend: any[];
    orgBreakdown: any[];
    invoiceStatus: any[];
    cashflowWaterfall: any[];
  };
  connectedOrgs: any[];
  meta: {
    computedAt: string;
    latencyMs: number;
    error?: string;
  };
}

const emptyDashboard: DashboardData = {
  kpis: { totalRevenue: 0, totalExpenses: 0, netProfit: 0, profitMargin: 0, totalInvoices: 0, avgInvoiceValue: 0, overdueAmount: 0, overdueCount: 0, orgCount: 0, providerCount: 0 },
  venture: { burnRate: 0, runwayMonths: 0, cashOnHand: 0, efficiencyMultiplier: 0 },
  charts: { monthlyTrend: [], orgBreakdown: [], invoiceStatus: [], cashflowWaterfall: [] },
  connectedOrgs: [],
  meta: { computedAt: new Date().toISOString(), latencyMs: 0 },
};

const fmtCurrency = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);

const fmtCompact = (n: number) => {
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return fmtCurrency(n);
};

export default function DashboardCharts() {
  const [data, setData] = useState<DashboardData>(emptyDashboard);
  const [isLoading, setIsLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());

  const loadDashboard = useCallback(async () => {
    try {
      const res = await apiFetch('/analytics/dashboard');
      if (res.ok) {
        const payload = await res.json();
        setData(payload);
        setLastRefresh(new Date());
      }
    } catch (err) {
      console.warn('[Dashboard] Load failed, using cached data');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDashboard();
    const interval = setInterval(loadDashboard, 60_000); // Refresh every 60s
    return () => clearInterval(interval);
  }, [loadDashboard]);

  // Listen for agent insight creation
  useEffect(() => {
    const handler = () => loadDashboard();
    window.addEventListener('numeriqu:refresh_insights', handler);
    return () => window.removeEventListener('numeriqu:refresh_insights', handler);
  }, [loadDashboard]);

  const { kpis, venture, charts } = data;
  const hasData = kpis.totalRevenue > 0 || kpis.totalInvoices > 0;

  if (isLoading) {
    return (
      <div className="dashboard-loading">
        <div className="pulse-ring" />
        <p style={{ color: 'var(--muted)', marginTop: 24, fontSize: '0.9rem' }}>Loading financial intelligence...</p>
      </div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.6 }}
    >
      {/* ─── TOP KPI CARDS ──────────────────────────────────────────────── */}
      <div className="kpi-grid">
        <KPICard
          icon={<DollarSign size={20} />}
          label="Total Revenue"
          value={fmtCompact(kpis.totalRevenue)}
          subtitle={`${kpis.totalInvoices} invoices processed`}
          trend={kpis.totalRevenue > 0 ? 'up' : 'neutral'}
          color="#00F5D4"
          delay={0}
        />
        <KPICard
          icon={<Activity size={20} />}
          label="Total Expenses"
          value={fmtCompact(kpis.totalExpenses)}
          subtitle={`${kpis.overdueCount} overdue (${fmtCompact(kpis.overdueAmount)})`}
          trend={kpis.overdueCount > 0 ? 'down' : 'neutral'}
          color="#FF6B6B"
          delay={0.05}
        />
        <KPICard
          icon={<TrendingUp size={20} />}
          label="Net Profit"
          value={fmtCompact(kpis.netProfit)}
          subtitle={`${kpis.profitMargin}% margin`}
          trend={kpis.netProfit >= 0 ? 'up' : 'down'}
          color={kpis.netProfit >= 0 ? '#00F5D4' : '#FF6B6B'}
          delay={0.1}
        />
        <KPICard
          icon={<Wallet size={20} />}
          label="Avg Invoice"
          value={fmtCompact(kpis.avgInvoiceValue)}
          subtitle={`${kpis.orgCount} orgs · ${kpis.providerCount} providers`}
          trend="neutral"
          color="#9B5DE5"
          delay={0.15}
        />
      </div>

      {/* ─── VENTURE METRICS (Puzzle-style) ──────────────────────────────── */}
      {(venture.burnRate > 0 || venture.cashOnHand > 0) && (
        <motion.div
          className="venture-strip"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
        >
          <div className="venture-item">
            <Clock size={14} style={{ opacity: 0.5 }} />
            <span className="venture-label">Burn Rate</span>
            <span className="venture-value" style={{ color: '#FF6B6B' }}>{fmtCompact(venture.burnRate)}/mo</span>
          </div>
          <div className="venture-divider" />
          <div className="venture-item">
            <Wallet size={14} style={{ opacity: 0.5 }} />
            <span className="venture-label">Cash on Hand</span>
            <span className="venture-value" style={{ color: '#00F5D4' }}>{fmtCompact(venture.cashOnHand)}</span>
          </div>
          <div className="venture-divider" />
          <div className="venture-item">
            <Zap size={14} style={{ opacity: 0.5 }} />
            <span className="venture-label">Runway</span>
            <span className="venture-value" style={{ color: '#F59E0B' }}>{venture.runwayMonths} months</span>
          </div>
          <div className="venture-divider" />
          <div className="venture-item">
            <Activity size={14} style={{ opacity: 0.5 }} />
            <span className="venture-label">Efficiency</span>
            <span className="venture-value" style={{ color: '#9B5DE5' }}>{venture.efficiencyMultiplier}x</span>
          </div>
        </motion.div>
      )}

      {/* ─── CHARTS ROW ─────────────────────────────────────────── */}
      <div className="charts-grid">
        {/* Revenue Trend */}
        <motion.div
          className="chart-card chart-wide"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.25 }}
        >
          <div className="chart-header">
            <div>
              <h3 className="chart-title">Revenue Trend</h3>
              <p className="chart-subtitle">Monthly revenue across all connected organizations</p>
            </div>
            <div className="chart-badge">
              <BarChart3 size={12} />
              <span>{charts.monthlyTrend.length} months</span>
            </div>
          </div>
          <div className="chart-body">
            {charts.monthlyTrend.length > 0 ? (
              <ResponsiveContainer width="100%" height={280}>
                <AreaChart data={charts.monthlyTrend} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
                  <defs>
                    <linearGradient id="gradRevenue" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#00F5D4" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#00F5D4" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" vertical={false} />
                  <XAxis dataKey="name" stroke="rgba(255,255,255,0.3)" fontSize={11} tickLine={false} axisLine={false} dy={10} />
                  <YAxis stroke="rgba(255,255,255,0.3)" fontSize={11} tickLine={false} axisLine={false} tickFormatter={(v) => `$${v >= 1000 ? (v/1000).toFixed(0)+'k' : v}`} dx={-5} />
                  <Tooltip
                    contentStyle={{ background: 'rgba(10,10,14,0.95)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 16, backdropFilter: 'blur(20px)', boxShadow: '0 20px 40px rgba(0,0,0,0.5)' }}
                    labelStyle={{ color: 'rgba(255,255,255,0.5)', fontSize: 11, marginBottom: 4 }}
                    itemStyle={{ color: '#00F5D4', fontWeight: 600 }}
                    formatter={(value: number) => [fmtCurrency(value), 'Revenue']}
                  />
                  <Area type="monotone" dataKey="revenue" stroke="#00F5D4" strokeWidth={3} fillOpacity={1} fill="url(#gradRevenue)" animationDuration={1500} dot={false} activeDot={{ r: 6, fill: '#00F5D4', stroke: '#000', strokeWidth: 2 }} />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <EmptyChart message="Revenue data will appear after your first sync" />
            )}
          </div>
        </motion.div>

        {/* Revenue by Org - Donut */}
        <motion.div
          className="chart-card"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
        >
          <div className="chart-header">
            <div>
              <h3 className="chart-title">Revenue by Organization</h3>
              <p className="chart-subtitle">Distribution across entities</p>
            </div>
            <div className="chart-badge">
              <PieIcon size={12} />
              <span>{charts.orgBreakdown.length} orgs</span>
            </div>
          </div>
          <div className="chart-body">
            {charts.orgBreakdown.length > 0 ? (
              <ResponsiveContainer width="100%" height={280}>
                <PieChart>
                  <Pie
                    data={charts.orgBreakdown}
                    cx="50%"
                    cy="50%"
                    innerRadius={70}
                    outerRadius={100}
                    paddingAngle={4}
                    dataKey="value"
                    animationDuration={1200}
                  >
                    {charts.orgBreakdown.map((_: any, i: number) => (
                      <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} stroke="rgba(0,0,0,0.3)" strokeWidth={2} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{ background: 'rgba(10,10,14,0.95)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 16, backdropFilter: 'blur(20px)' }}
                    formatter={(value: number, name: string) => [fmtCurrency(value), name]}
                  />
                  <Legend
                    layout="vertical"
                    align="right"
                    verticalAlign="middle"
                    iconType="circle"
                    iconSize={8}
                    wrapperStyle={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', lineHeight: '24px' }}
                  />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <EmptyChart message="Connect an organization to see the breakdown" icon={<Building2 size={32} />} />
            )}
          </div>
        </motion.div>
      </div>

      {/* ─── SECOND ROW: Invoice Status + Cash Flow ──────────────────── */}
      <div className="charts-grid">
        {/* Invoice Status Distribution */}
        <motion.div
          className="chart-card"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.35 }}
        >
          <div className="chart-header">
            <div>
              <h3 className="chart-title">Invoice Status</h3>
              <p className="chart-subtitle">Distribution by payment status</p>
            </div>
            <div className="chart-badge">
              <FileText size={12} />
              <span>{kpis.totalInvoices} total</span>
            </div>
          </div>
          <div className="chart-body">
            {charts.invoiceStatus.length > 0 ? (
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={charts.invoiceStatus} layout="vertical" margin={{ top: 0, right: 20, left: 10, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" horizontal={false} />
                  <XAxis type="number" stroke="rgba(255,255,255,0.3)" fontSize={11} tickLine={false} axisLine={false} tickFormatter={(v) => `${v}`} />
                  <YAxis type="category" dataKey="name" stroke="rgba(255,255,255,0.4)" fontSize={11} tickLine={false} axisLine={false} width={100} />
                  <Tooltip
                    contentStyle={{ background: 'rgba(10,10,14,0.95)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 16, backdropFilter: 'blur(20px)' }}
                    formatter={(value: number, name: string) => [value, name === 'count' ? 'Invoices' : 'Amount']}
                  />
                  <Bar dataKey="count" fill="#00F5D4" radius={[0, 6, 6, 0]} animationDuration={1200} barSize={20}>
                    {charts.invoiceStatus.map((_: any, i: number) => (
                      <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <EmptyChart message="Invoice data loads after the first sync" icon={<FileText size={32} />} />
            )}
          </div>
        </motion.div>

        {/* Cash Flow Waterfall */}
        <motion.div
          className="chart-card"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.4 }}
        >
          <div className="chart-header">
            <div>
              <h3 className="chart-title">Cash Flow Summary</h3>
              <p className="chart-subtitle">Revenue → Expenses → Net Profit</p>
            </div>
          </div>
          <div className="chart-body">
            {hasData ? (
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={charts.cashflowWaterfall} margin={{ top: 20, right: 20, left: -10, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" vertical={false} />
                  <XAxis dataKey="name" stroke="rgba(255,255,255,0.4)" fontSize={12} tickLine={false} axisLine={false} />
                  <YAxis stroke="rgba(255,255,255,0.3)" fontSize={11} tickLine={false} axisLine={false} tickFormatter={(v) => fmtCompact(Math.abs(v))} dx={-5} />
                  <Tooltip
                    contentStyle={{ background: 'rgba(10,10,14,0.95)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 16, backdropFilter: 'blur(20px)' }}
                    formatter={(value: number) => [fmtCurrency(Math.abs(value)), '']}
                  />
                  <Bar dataKey="value" radius={[8, 8, 0, 0]} animationDuration={1200} barSize={60}>
                    {charts.cashflowWaterfall.map((entry: any, i: number) => (
                      <Cell key={i} fill={entry.fill} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <EmptyChart message="Cash flow data will appear after syncing" icon={<DollarSign size={32} />} />
            )}
          </div>
        </motion.div>
      </div>

      {/* ─── CONNECTED ORGS TABLE ──────────────────────────────── */}
      {data.connectedOrgs.length > 0 && (
        <motion.div
          className="chart-card chart-full"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.45 }}
        >
          <div className="chart-header">
            <div>
              <h3 className="chart-title">Connected Organizations</h3>
              <p className="chart-subtitle">Per-entity revenue breakdown from {kpis.providerCount} provider{kpis.providerCount !== 1 ? 's' : ''}</p>
            </div>
            <button className="refresh-btn" onClick={loadDashboard} title="Refresh data">
              <RefreshCcw size={14} />
            </button>
          </div>
          <div style={{ overflowX: 'auto', marginTop: 16 }}>
            <table className="org-table">
              <thead>
                <tr>
                  <th>Organization</th>
                  <th>Provider</th>
                  <th>Revenue</th>
                  <th>Invoices</th>
                  <th>Share</th>
                </tr>
              </thead>
              <tbody>
                {data.connectedOrgs.map((org, i) => {
                  const share = kpis.totalRevenue > 0 ? ((org.totalRevenue / kpis.totalRevenue) * 100) : 0;
                  return (
                    <tr key={org.orgId || i}>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <div style={{ width: 8, height: 8, borderRadius: 4, background: CHART_COLORS[i % CHART_COLORS.length] }} />
                          <span style={{ fontWeight: 600 }}>{org.orgName}</span>
                        </div>
                      </td>
                      <td>
                        <span className="provider-badge">{org.provider.toUpperCase()}</span>
                      </td>
                      <td style={{ fontWeight: 600, color: '#00F5D4' }}>{fmtCurrency(org.totalRevenue)}</td>
                      <td>{org.invoiceCount}</td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <div className="share-bar">
                            <div className="share-fill" style={{ width: `${share}%`, background: CHART_COLORS[i % CHART_COLORS.length] }} />
                          </div>
                          <span style={{ fontSize: '0.8rem', opacity: 0.6, minWidth: 40 }}>{share.toFixed(1)}%</span>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </motion.div>
      )}

      {/* ─── DATA FRESHNESS INDICATOR ───────────────────────────── */}
      <motion.div
        className="freshness-bar"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.5 }}
      >
        <div className="freshness-dot" />
        <span>Data computed {data.meta.computedAt ? new Date(data.meta.computedAt).toLocaleTimeString() : 'N/A'}</span>
        <span>·</span>
        <span>{data.meta.latencyMs}ms</span>
        {data.meta.error && (
          <>
            <span>·</span>
            <span style={{ color: '#F59E0B' }}>{data.meta.error}</span>
          </>
        )}
      </motion.div>
    </motion.div>
  );
}

// ─── Subcomponents ──────────────────────────────────────────────────────────

function KPICard({ icon, label, value, subtitle, trend, color, delay }: {
  icon: React.ReactNode;
  label: string;
  value: string;
  subtitle: string;
  trend: 'up' | 'down' | 'neutral';
  color: string;
  delay: number;
}) {
  return (
    <motion.div
      className="kpi-card"
      initial={{ opacity: 0, y: 15, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ delay, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
      whileHover={{ y: -3, transition: { duration: 0.2 } }}
    >
      <div className="kpi-icon" style={{ color, background: `${color}15` }}>
        {icon}
      </div>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      <div className="kpi-subtitle">
        {trend === 'up' && <ArrowUpRight size={13} style={{ color: '#00F5D4' }} />}
        {trend === 'down' && <ArrowDownRight size={13} style={{ color: '#FF6B6B' }} />}
        <span>{subtitle}</span>
      </div>
    </motion.div>
  );
}

function EmptyChart({ message, icon }: { message: string; icon?: React.ReactNode }) {
  return (
    <div className="empty-chart">
      {icon || <BarChart3 size={32} style={{ opacity: 0.15 }} />}
      <p>{message}</p>
    </div>
  );
}
