"use client";

import React, { useEffect, useState, Component, ErrorInfo, ReactNode } from 'react';
import { apiFetch } from '../lib/supabase';
import { 
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend 
} from 'recharts';
import { motion, AnimatePresence } from 'framer-motion';
import { Calendar, RefreshCcw, Info, Trash2, LayoutGrid, AlertTriangle, Activity } from 'lucide-react';

// ─────────────────────────────────────────────────────────────────────────────
// SILICON VALLEY ARCHITECTURE: PRODUCTION ERROR BOUNDARY
// Modern SaaS platforms NEVER let a Single Page Application crash fully.
// If a chart receives malformed JSON or a rendering fault occurs, it is
// sandboxed locally so the rest of the dashboard remains perfectly interactive.
// ─────────────────────────────────────────────────────────────────────────────
interface ErrorBoundaryProps {
  children: ReactNode;
  fallbackTitle: string;
}

interface ErrorBoundaryState {
  hasError: boolean;
  errorMsg: string;
}

class WidgetErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  public state: ErrorBoundaryState = {
    hasError: false,
    errorMsg: ''
  };

  public static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, errorMsg: error.message };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Widget render trapped:", error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div className="glass-card flex-center" style={{ minHeight: '380px', padding: '32px', textAlign: 'center', background: 'rgba(255,10,10,0.02)', border: '1px solid rgba(255,10,10,0.1)' }}>
          <AlertTriangle size={32} color="#EF4444" style={{ marginBottom: '16px', opacity: 0.8 }} />
          <h3 style={{ color: '#fff', fontSize: '1.2rem', marginBottom: '8px' }}>{this.props.fallbackTitle}</h3>
          <p style={{ color: 'var(--muted)', fontSize: '0.85rem' }}>We encountered an issue preparing this visualization. Data is safe, but the render failed. Please refresh the dashboard.</p>
        </div>
      );
    }
    return this.props.children;
  }
}


interface InsightConfig {
  metric: string;
  grouping: string;
}

interface Insight {
  id: string;
  title: string;
  description: string;
  type: 'line' | 'bar' | 'pie' | 'metric' | 'table';
  config: InsightConfig;
  pinned: boolean;
  createdAt: string;
}

export default function FinancialInsights() {
  const [insights, setInsights] = useState<Insight[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [dataCache, setDataCache] = useState<Record<string, any>>({});

  useEffect(() => {
    loadInsights();
    
    // Listen for agent mission updates
    const handleRefresh = () => loadInsights();
    window.addEventListener('numeriqu:refresh_insights', handleRefresh);
    return () => window.removeEventListener('numeriqu:refresh_insights', handleRefresh);
  }, []);

  const loadInsights = async () => {
    setIsLoading(true);
    try {
      const res = await apiFetch('/analytics/insights');
      if (res.ok) {
        const data = await res.json();
        setInsights(data);
        data.forEach((insight: Insight) => fetchInsightData(insight));
      }
    } catch (error) {
      console.error('Failed to load insights', error);
    } finally {
      setIsLoading(false);
    }
  };

  const fetchInsightData = async (insight: Insight, subId?: string) => {
    try {
      if (insight.type === 'dashboard' && insight.config.charts) {
        // Hydrate all child charts recursively
        insight.config.charts.forEach((chart: any, idx: number) => {
          fetchInsightData({ ...insight, id: `${insight.id}-chart-${idx}`, type: chart.type, config: chart.config }, `${insight.id}-chart-${idx}`);
        });
        return;
      }

      const res = await apiFetch(`/agent/metrics?metric=${insight.config.metric}&grouping=${insight.config.grouping}`);
      if (res.ok) {
        const payload = await res.json();
        setDataCache(prev => ({ ...prev, [subId || insight.id]: payload.data }));
      }
    } catch (e) {
      console.error(`Failed to fetch data for ${subId || insight.id}`);
    }
  };

  const deleteInsight = async (id: string) => {
    try {
      const res = await apiFetch(`/analytics/insights/${id}`, { method: 'DELETE' });
      if (res.ok) {
        setInsights(prev => prev.filter(i => i.id !== id));
      }
    } catch (e) {
      alert('Failed to delete insight');
    }
  };

  if (isLoading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh' }}>
        <div className="shimmer" style={{ width: '200px', height: '2px', borderRadius: '4px', opacity: 0.3 }}></div>
      </div>
    );
  }

  return (
    <motion.div 
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
    >
      <header className="view-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '24px' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '8px' }}>
             <h2 className="view-title text-gradient" style={{ fontSize: '2rem', letterSpacing: '-1px', margin: 0 }}>Strategic Dashboards</h2>
             <div style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '4px 10px', background: 'rgba(0, 245, 212, 0.05)', borderRadius: '100px', border: '1px solid rgba(0, 245, 212, 0.1)' }}>
                <span className="status-orb" style={{ background: '#00F5D4', boxShadow: '0 0 10px #00F5D4' }}></span>
                <span style={{ fontSize: '0.7rem', fontWeight: 600, color: '#00F5D4', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Live Connection</span>
             </div>
          </div>
          <p className="view-subtitle" style={{ fontSize: '1rem', opacity: 0.7 }}>Visualizations generated deterministically by the Strategic Agent.</p>
        </div>
        <button 
          onClick={loadInsights}
          className="agent-btn execute" 
          style={{ width: 'auto', background: 'rgba(255,255,255,0.05)', color: '#fff', display: 'flex', alignItems: 'center', gap: '8px' }}
        >
          <Activity size={16} /> Sync Data
        </button>
      </header>

      <AnimatePresence mode="popLayout">
        {insights.length === 0 ? (
          <motion.div 
            key="empty"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="glass-panel" 
            style={{ padding: '80px 40px', borderRadius: '24px', textAlign: 'center', marginTop: '20px' }}
          >
            <div style={{ fontSize: '3rem', marginBottom: '24px', filter: 'drop-shadow(0 0 20px var(--primary-glow))' }}>✨</div>
            <h2 className="text-gradient" style={{ fontSize: '1.8rem', marginBottom: '16px' }}>No Dimensions Generated</h2>
            <p style={{ color: 'var(--muted)', maxWidth: '500px', margin: '0 auto', lineHeight: 1.6, fontSize: '0.95rem' }}>
              Switch to the "Agent Mode" overlay and query the CFO. The agent will orchestrate and pin live forensic visualizations here.
            </p>
          </motion.div>
        ) : (
          <div className="dashboard-grid" style={{ marginTop: '20px' }}>
            {insights.map((insight, rootIdx) => {
              if (insight.type === 'dashboard') {
                return (
                  <motion.div key={insight.id} className="col-span-12" layout initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                    <div style={{ padding: '24px', background: 'rgba(255,255,255,0.02)', borderRadius: '24px', border: '1px solid rgba(255,255,255,0.05)', marginBottom: '32px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '24px' }}>
                        <div>
                          <h3 className="text-gradient" style={{ fontSize: '1.6rem', marginBottom: '8px' }}>{insight.title}</h3>
                          <p style={{ color: 'var(--muted)', fontSize: '0.9rem' }}>{insight.description}</p>
                        </div>
                        <button onClick={() => deleteInsight(insight.id)} className="btn-glow" style={{ padding: '8px 16px', background: 'rgba(255,77,77,0.1)', color: '#FF4D4D', border: '1px solid rgba(255,77,77,0.2)' }}>Delete Dashboard</button>
                      </div>
                      <div className="dashboard-grid">
                        {insight.config.charts?.map((chart: any, idx: number) => {
                          const isWide = chart.type === 'line' || chart.type === 'bar' || chart.type === 'table';
                          const subId = `${insight.id}-chart-${idx}`;
                          return (
                            <div key={subId} className={`col-span-${isWide ? '12' : '6'}`}>
                              <WidgetErrorBoundary fallbackTitle={`Render Fault: ${chart.title}`}>
                                <InsightCard 
                                  insight={{ ...insight, id: subId, title: chart.title, description: chart.description, type: chart.type, config: chart.config }} 
                                  data={dataCache[subId]} 
                                  onDelete={() => {}}
                                />
                              </WidgetErrorBoundary>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </motion.div>
                );
              }

              // Fallback for legacy standalone charts
              const isWide = insight.type === 'line' || insight.type === 'bar' || insight.type === 'table';
              return (
                <motion.div 
                  key={insight.id || `insight-${rootIdx}`}
                  layout
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.9 }}
                  transition={{ delay: rootIdx * 0.1, duration: 0.5, ease: 'circOut' }}
                  className={`col-span-${isWide ? '12' : '6'}`}
                >
                  <WidgetErrorBoundary fallbackTitle={`Render Fault: ${insight.title}`}>
                    <InsightCard 
                      insight={insight} 
                      data={dataCache[insight.id]} 
                      onDelete={() => deleteInsight(insight.id)}
                    />
                  </WidgetErrorBoundary>
                </motion.div>
              );
            })}
          </div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function InvoiceTable({ data }: { data: any[] }) {
  if (!data || data.length === 0) return <div style={{ textAlign: 'center', padding: '40px', color: 'var(--muted)' }}>No invoices found in forensic stream.</div>;
  
  return (
    <div style={{ overflowX: 'auto', marginTop: '12px', border: '1px solid rgba(255,255,255,0.02)', borderRadius: '12px', background: 'rgba(0,0,0,0.2)' }}>
      <table className="table-glass" style={{ minWidth: '100%', fontSize: '0.85rem', borderCollapse: 'collapse' }}>
        <thead style={{ borderBottom: '1px solid rgba(255,255,255,0.05)', background: 'rgba(255,255,255,0.02)' }}>
          <tr style={{ textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--muted)' }}>
            <th style={{ padding: '16px', textAlign: 'left', fontWeight: 600 }}>Invoice #</th>
            <th style={{ padding: '16px', textAlign: 'left', fontWeight: 600 }}>Counterparty</th>
            <th style={{ padding: '16px', textAlign: 'right', fontWeight: 600 }}>Amount</th>
            <th style={{ padding: '16px', textAlign: 'center', fontWeight: 600 }}>Status</th>
            <th style={{ padding: '16px', textAlign: 'right', fontWeight: 600 }}>Date</th>
          </tr>
        </thead>
        <tbody>
          {data.slice(0, 8).map((inv, i) => (
            <tr key={i} style={{ 
              borderBottom: i === data.slice(0, 8).length - 1 ? 'none' : '1px solid rgba(255,255,255,0.03)',
              transition: 'background 0.2s ease'
             }}
             onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.02)'}
             onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
             >
              <td style={{ padding: '16px', fontWeight: 600, color: '#fff' }}>{inv.invoice_number}</td>
              <td style={{ padding: '16px', opacity: 0.8 }}>{inv.org_name}</td>
              <td style={{ padding: '16px', color: 'var(--primary)', textAlign: 'right', fontFamily: 'monospace', fontSize: '0.9rem' }}>
                {new Intl.NumberFormat('en-US', { style: 'currency', currency: inv.currency || 'USD' }).format(inv.amount)}
              </td>
              <td style={{ padding: '16px', textAlign: 'center' }}>
                <span style={{ 
                  padding: '4px 10px', 
                  borderRadius: '100px', 
                  fontSize: '0.7rem',
                  fontWeight: 700,
                  letterSpacing: '0.5px',
                  border: `1px solid ${inv.status === 'PAID' ? 'rgba(0, 245, 212, 0.2)' : 'rgba(245, 158, 11, 0.2)'}`,
                  background: inv.status === 'PAID' ? 'rgba(0, 245, 212, 0.05)' : 'rgba(245, 158, 11, 0.05)',
                  color: inv.status === 'PAID' ? '#00F5D4' : '#F59E0B'
                }}>
                  {inv.status}
                </span>
              </td>
              <td style={{ padding: '16px', opacity: 0.5, textAlign: 'right' }}>{new Date(inv.date).toLocaleDateString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function InsightCard({ insight, data, onDelete }: { insight: Insight, data: any, onDelete: () => void }) {
  const COLORS = ['#00F5D4', '#8B5CF6', '#3B82F6', '#F59E0B', '#EF4444'];

  return (
    <div className="glass-card" style={{ 
      padding: '24px', 
      minHeight: '380px', 
      display: 'flex', 
      flexDirection: 'column',
      background: 'linear-gradient(180deg, rgba(20,20,24,0.7) 0%, rgba(10,10,12,0.9) 100%)',
      border: '1px solid rgba(255,255,255,0.05)',
      boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
      position: 'relative',
      overflow: 'hidden'
    }}>
      <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '2px', background: 'var(--primary)', opacity: 0.3 }}></div>
      <div style={{ position: 'absolute', top: '-100px', right: '-100px', width: '200px', height: '200px', background: 'var(--primary)', filter: 'blur(100px)', opacity: 0.05 }}></div>

      <div style={{ position: 'absolute', top: '20px', right: '20px', display: 'flex', gap: '8px', zIndex: 10 }}>
         <button 
          onClick={onDelete}
          style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,77,77,0.1)', borderRadius: '8px', padding: '6px', color: 'rgba(255,77,77,0.5)', cursor: 'pointer', transition: 'all 0.3s' }}
          onMouseEnter={e => { e.currentTarget.style.color = '#FF4D4D'; e.currentTarget.style.borderColor = 'rgba(255,77,77,0.4)'; e.currentTarget.style.background = 'rgba(255,77,77,0.1)'; }}
          onMouseLeave={e => { e.currentTarget.style.color = 'rgba(255,77,77,0.5)'; e.currentTarget.style.borderColor = 'rgba(255,77,77,0.1)'; e.currentTarget.style.background = 'rgba(0,0,0,0.3)'; }}
        >
          <Trash2 size={14} />
        </button>
      </div>

      <div style={{ marginBottom: '28px', paddingRight: '40px', position: 'relative', zIndex: 5 }}>
        <h3 className="font-heading" style={{ fontSize: '1.25rem', color: '#fff', marginBottom: '6px', letterSpacing: '-0.3px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          {insight.title}
        </h3>
        <p style={{ fontSize: '0.85rem', color: 'var(--muted)', fontWeight: 400, opacity: 0.8, lineHeight: 1.5 }}>{insight.description}</p>
      </div>

      <div style={{ flex: 1, minHeight: '240px', display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative', zIndex: 5 }}>
        {!data ? (
          <div className="shimmer" style={{ width: '100%', height: '4px', borderRadius: '2px', opacity: 0.2 }}></div>
        ) : insight.type === 'metric' ? (
          <motion.div 
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            style={{ textAlign: 'center' }}
          >
             <div className="metric-value text-shiny" style={{ fontSize: '3.5rem', fontWeight: 800, letterSpacing: '-2px' }}>
              {typeof data === 'number' ? `$${data.toLocaleString()}` : data}
             </div>
             <motion.div 
               whileHover={{ scale: 1.05 }}
               style={{ marginTop: '24px', cursor: 'help' }}
             >
                <div style={{ padding: '8px 16px', background: 'rgba(0,245,212,0.05)', borderRadius: '100px', border: '1px solid rgba(0,245,212,0.1)', display: 'inline-flex', alignItems: 'center', gap: '10px' }}>
                  <div className="status-orb" style={{ background: 'var(--primary)', boxShadow: '0 0 10px var(--primary)' }}></div>
                  <span style={{ fontSize: '0.7rem', fontWeight: 800, color: 'var(--primary)', letterSpacing: '1px' }}>GROUNDED METRIC</span>
                </div>
             </motion.div>
          </motion.div>
        ) : (
          <ResponsiveContainer width="100%" height={260}>
            {insight.type === 'line' ? (
              <AreaChart data={data}>
                <defs>
                  {data && data.length > 0 && Object.keys(data[0]).filter(k => k !== 'name').map((key, i) => (
                    <linearGradient key={`color-${i}`} id={`colorValue-${i}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={COLORS[i % COLORS.length]} stopOpacity={0.3}/>
                      <stop offset="95%" stopColor={COLORS[i % COLORS.length]} stopOpacity={0}/>
                    </linearGradient>
                  ))}
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.03)" vertical={false} />
                <XAxis dataKey="name" stroke="var(--muted)" fontSize={10} tickLine={false} axisLine={false} dy={10} />
                <YAxis stroke="var(--muted)" fontSize={10} tickLine={false} axisLine={false} tickFormatter={(v) => `$${v > 1000 ? v/1000 + 'k' : v}`} dx={-10} />
                <Tooltip 
                  contentStyle={{ background: 'rgba(10,10,12,0.95)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '16px', backdropFilter: 'blur(10px)', boxShadow: '0 10px 30px rgba(0,0,0,0.5)' }}
                  itemStyle={{ fontWeight: 700 }}
                  cursor={{ stroke: 'rgba(255,255,255,0.1)', strokeWidth: 2 }}
                />
                <Legend wrapperStyle={{ fontSize: '10px', paddingTop: '10px' }} iconType="circle" />
                {data && data.length > 0 && Object.keys(data[0]).filter(k => k !== 'name').map((key, i) => (
                   <Area key={key} type="monotone" dataKey={key} name={key === 'value' ? 'Total' : key} stroke={COLORS[i % COLORS.length]} strokeWidth={3} fillOpacity={1} fill={`url(#colorValue-${i})`} animationDuration={1500} />
                ))}
              </AreaChart>
            ) : insight.type === 'table' ? (
              <InvoiceTable data={data} />
            ) : insight.type === 'bar' ? (
              <BarChart data={data} margin={{ top: 20, right: 0, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.03)" vertical={false} />
                <XAxis dataKey="name" stroke="var(--muted)" fontSize={10} tickLine={false} axisLine={false} dy={10} />
                <YAxis stroke="var(--muted)" fontSize={10} tickLine={false} axisLine={false} tickFormatter={(v) => `$${v > 1000 ? v/1000 + 'k' : v}`} dx={-10} />
                <Tooltip 
                  cursor={{ fill: 'rgba(255,255,255,0.03)' }}
                  contentStyle={{ background: 'rgba(10,10,12,0.95)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '16px', backdropFilter: 'blur(10px)' }}
                />
                <Legend wrapperStyle={{ fontSize: '10px', paddingTop: '10px' }} iconType="circle" />
                {data && data.length > 0 && Object.keys(data[0]).filter(k => k !== 'name').map((key, i) => (
                  <Bar key={key} dataKey={key} name={key === 'value' ? 'Total' : key} fill={COLORS[i % COLORS.length]} radius={[6, 6, 0, 0]} animationDuration={1500} />
                ))}
              </BarChart>
            ) : (
              <PieChart>
                <Pie
                  data={data}
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={85}
                  paddingAngle={8}
                  dataKey="value"
                  animationDuration={1500}
                >
                  {data.map((_entry: any, index: number) => (
                    <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} stroke="rgba(0,0,0,0.2)" strokeWidth={2} />
                  ))}
                </Pie>
                <Tooltip 
                   contentStyle={{ background: 'rgba(10,10,12,0.95)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '16px', backdropFilter: 'blur(10px)' }}
                />
                <Legend layout="vertical" align="right" verticalAlign="middle" iconType="circle" wrapperStyle={{ fontSize: '10px', opacity: 0.7 }} />
              </PieChart>
            )}
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
