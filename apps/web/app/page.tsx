"use client";

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { supabase, apiFetch } from './lib/supabase';
import './globals.css';

// --- Types ---
interface UserContext {
  user: { id: string; email: string };
  tenant: { id: string; name: string };
}

interface IngestionJob {
  id: string;
  provider: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  recordsProcessed: number;
  connectionId: string;
  orgName?: string | null;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
  metrics?: {
    dataFetchMs: number;
    llmGenerationMs: number;
    totalMs: number;
    tokensGenerated: number;
  };
  context?: {
    totalRevenue: number;
    totalExpenses: number;
    netProfit: number;
    profitMargin: number;
    totalInvoices: number;
    overdueAmount: number;
    providers: number;
    fetchTimeMs: number;
  };
}

interface AIHealth {
  status: string;
  ollama: boolean;
  model: string;
  latencyMs: number;
  advisory: string;
}

const DEFAULT_START_DATE = '2020-01-01';

const SUGGESTED_QUERIES = [
  "What is my current profitability across all providers?",
  "Compare revenue between Xero and QuickBooks",
  "How much investment do I need for $50K monthly profit?",
  "What's my overdue invoice risk exposure?",
  "Analyze my monthly revenue trend and forecast growth",
  "Which provider is generating the most revenue?",
];

export default function NumeriquOS() {
  const [view, setView] = useState<'loading' | 'auth' | 'dashboard' | 'integrations' | 'intelligence'>('loading');
  const [authMode, setAuthMode] = useState<'login' | 'signup'>('login');
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authName, setAuthName] = useState('');
  const [authError, setAuthError] = useState('');
  const [isAuthLoading, setIsAuthLoading] = useState(false);

  const [userContext, setUserContext] = useState<UserContext | null>(null);
  const [jobs, setJobs] = useState<IngestionJob[]>([]);
  const [connections, setConnections] = useState<any[]>([]);
  const [startDate, setStartDate] = useState(DEFAULT_START_DATE);

  const [stats, setStats] = useState({
    totalRevenue: "$0.00",
    activeConnections: 0,
    orgCount: 0,
    orgBreakdown: '' as string,
    syncsToday: 0
  });
  // logout loading flag to prevent double clicks
  const [isSigningOut, setIsSigningOut] = useState(false);

  // --- Intelligence State ---
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [isQuerying, setIsQuerying] = useState(false);
  const [aiHealth, setAiHealth] = useState<AIHealth | null>(null);
  const [streamingContent, setStreamingContent] = useState('');
  const [streamingStatus, setStreamingStatus] = useState('');
  const chatEndRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const hasInitialHydrated = useRef(false);

  // =================== SESSION HYDRATION ===================
  useEffect(() => {
    // SINGLETON HYDRATION: Prevents redundant locks/fetches in Strict Mode
    if (hasInitialHydrated.current) return;

    const initSession = async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        
        // Check for success params in URL (after OAuth redirect)
        const params = new URLSearchParams(window.location.search);
        const isOAuthSuccess = params.get('success')?.includes('connected');

        if (session?.user) {
          await hydrateUser();
          if (isOAuthSuccess) setView('dashboard');
        } else {
          setView('auth');
        }
        hasInitialHydrated.current = true;
      } catch (e) {
        console.error('[Auth] Init failed', e);
        setView('auth');
      }
    };

    initSession();

    // Listen for auth state changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      console.log(`[Auth Event] ${event}`);
      if (event === 'SIGNED_IN' && session?.user) {
        await hydrateUser();
      } else if (event === 'SIGNED_OUT') {
        setUserContext(null);
        setView('auth');
        hasInitialHydrated.current = false;
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  // Hydrate user context from API (triggers JIT provisioning on first login)
  const hydrateUser = async () => {
    try {
      const res = await apiFetch('/auth/me');
      if (res.ok) {
        const data = await res.json();
        setUserContext(data);
        setView(prev => (prev === 'auth' || prev === 'loading' ? 'dashboard' : prev));
      } else {
        setView('auth');
      }
    } catch {
      setView('auth');
    }
  };

  // Auto-scroll chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages, streamingContent]);

  // Check AI health when intelligence view is active
  useEffect(() => {
    if (view === 'intelligence' && !aiHealth) {
      apiFetch('/ai/health')
        .then(res => res.json())
        .then(setAiHealth)
        .catch(() => setAiHealth({ status: 'offline', ollama: false, model: 'unknown', latencyMs: 0, advisory: 'API unreachable' }));
    }
  }, [view, aiHealth]);

  const fetchMetrics = useCallback(async () => {
    if (!userContext) return;
    try {
      const res = await apiFetch('/metrics/revenue');
      if (!res.ok) {
        console.warn(`[Polling] Metrics fetch degraded temporarily (HTTP ${res.status}).`);
        return;
      }
      const data = await res.json();
      if (data && data.length > 0) {
        const total = data.reduce((sum: number, r: any) => sum + parseFloat(r.amount), 0);
        setStats(prev => ({
          ...prev,
          totalRevenue: new Intl.NumberFormat('en-US', { style: 'currency', currency: data[0].currency || 'USD' }).format(total)
        }));
      }
    } catch (e) {
      console.warn('[Polling] Metrics fetch degraded temporarily.');
    }
  }, [userContext]);

  const fetchJobs = useCallback(async () => {
    if (!userContext) return;
    try {
      const res = await apiFetch('/test/jobs');
      if (!res.ok) {
        console.warn(`[Polling] Jobs fetch degraded temporarily (HTTP ${res.status}).`);
        return;
      }
      const data = await res.json();
      if (!Array.isArray(data)) return;
      setJobs(data);

      // Count distinct (provider, orgName) pairs in recent jobs
      const orgMap = new Map<string, string>(); // orgKey → provider
      for (const j of data) {
        const orgKey = j.orgName || j.provider;
        orgMap.set(orgKey, j.provider);
      }
      const xeroOrgs = [...orgMap.entries()].filter(([, p]) => p === 'xero').length;
      const qbOrgs = [...orgMap.entries()].filter(([, p]) => p === 'quickbooks').length;
      const breakdown = [
        xeroOrgs > 0 ? `${xeroOrgs} Xero` : '',
        qbOrgs > 0 ? `${qbOrgs} QuickBooks` : '',
      ].filter(Boolean).join(' · ') || 'No providers';

      setStats(prev => ({
        ...prev,
        activeConnections: new Set(data.map((j: any) => j.provider)).size,
        orgCount: orgMap.size,
        orgBreakdown: breakdown,
        syncsToday: data.filter((j: any) => j.status === 'completed').length
      }));
    } catch (e) {
      console.warn('[Polling] Jobs fetch degraded temporarily.');
    }
  }, [userContext]);

  const fetchConnections = useCallback(async () => {
    if (!userContext) return;
    try {
      const res = await apiFetch('/integrations/connections');
      if (!res.ok) {
        console.warn(`[Polling] Connections fetch degraded temporarily (HTTP ${res.status}).`);
        return;
      }
      const data = await res.json();
      setConnections(data);
    } catch (e) {
      console.warn('[Polling] Connections fetch degraded temporarily.');
    }
  }, [userContext]);

  const handleDisconnect = async (id: string, name: string) => {
    if (!confirm(`Revoke trust for ${name}? This will sever all orchestration channels and stop syncing immediately.`)) return;
    
    try {
      const res = await apiFetch(`/integrations/connections/${id}`, { method: 'DELETE' });
      if (res.ok) {
        fetchConnections();
        fetchJobs(); // Refresh dependents
      } else {
        alert('Could not terminate protocol. Please try again.');
      }
    } catch (e) {
      alert('Network fault during revocation.');
    }
  };

  useEffect(() => {
    if (userContext) {
      fetchJobs();
      fetchMetrics();
      fetchConnections();
      const interval = setInterval(() => {
        fetchJobs();
        fetchMetrics();
        fetchConnections();
      }, 5000);
      return () => clearInterval(interval);
    }
  }, [userContext, fetchJobs, fetchMetrics, fetchConnections]);

  // =================== AUTH HANDLERS ===================
  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError('');
    setIsAuthLoading(true);

    const { data, error } = await supabase.auth.signUp({
      email: authEmail,
      password: authPassword,
      options: {
        data: { name: authName || authEmail.split('@')[0] },
      },
    });

    if (error) {
      setAuthError(error.message);
    } else if (data.user && !data.session) {
      setAuthError('Check your email for a confirmation link.');
    }
    // If session exists, onAuthStateChange will handle the redirect
    setIsAuthLoading(false);
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError('');
    setIsAuthLoading(true);

    const { error } = await supabase.auth.signInWithPassword({
      email: authEmail,
      password: authPassword,
    });

    if (error) {
      setAuthError(error.message);
    }
    setIsAuthLoading(false);
  };

  const handleLogout = async () => {
    if (isSigningOut) return;
    setIsSigningOut(true);
    try {
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
      setUserContext(null);
      setView('auth');
      // Force a full page reload to clear any stale client state
      window.location.reload();
    } catch (err: any) {
      console.error('[Logout] Failed:', err);
      alert('Unable to sign out – please try again.');
    } finally {
      setIsSigningOut(false);
    }
  };

  // =================== INTELLIGENCE CHAT ===================
  const cancelQuery = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
  };

  const handleAIQuery = async (queryOverride?: string) => {
    const query = queryOverride || chatInput.trim();
    if (!query || !userContext || isQuerying) return;

    // Create new AbortController for this request
    const controller = new AbortController();
    abortControllerRef.current = controller;

    const userMessage: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: query,
      timestamp: new Date(),
    };

    setChatMessages(prev => [...prev, userMessage]);
    setChatInput('');
    setIsQuerying(true);
    setStreamingContent('');
    setStreamingStatus('');

    let fullContent = '';
    let messageContext: ChatMessage['context'] = undefined;
    let messageMetrics: ChatMessage['metrics'] = undefined;

    try {
      const response = await apiFetch('/ai/query', {
        method: 'POST',
        body: JSON.stringify({
          query,
          tenantId: userContext.tenant.id,
        }),
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
              case 'context':
                messageContext = parsed.data;
                break;
              case 'done':
                messageMetrics = parsed.metrics;
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
        fullContent = fullContent || '⏹️ Query cancelled.';
      } else {
        // Suppress technical topology references (No "Ollama", no "API SERVER")
        fullContent = `⚠️ The Financial Intelligence Engine is currently unavailable. Please check your connection or wait a moment while streams self-heal.`;
      }
    }

    const assistantMessage: ChatMessage = {
      id: `assistant-${Date.now()}`,
      role: 'assistant',
      content: fullContent || 'No response generated.',
      timestamp: new Date(),
      context: messageContext,
      metrics: messageMetrics,
    };

    setChatMessages(prev => [...prev, assistantMessage]);
    setStreamingContent('');
    setStreamingStatus('');
    setIsQuerying(false);
    abortControllerRef.current = null;
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleAIQuery();
    }
    if (e.key === 'Escape' && isQuerying) {
      cancelQuery();
    }
  };

  // =================== LOADING ===================
  if (view === 'loading') {
    return (
      <div className="auth-container animate-fade" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div className="premium-orb-1"></div>
        <div className="premium-orb-2"></div>
        <div style={{ textAlign: 'center', zIndex: 10 }}>
          <div className="logo-icon" style={{ width: '80px', height: '80px', fontSize: '2.5rem', margin: '0 auto' }}>N</div>
          <div className="text-shiny" style={{ marginTop: '24px', fontSize: '1.2rem' }}>Initializing Numeriqu OS...</div>
        </div>
      </div>
    );
  }

  // =================== AUTH VIEW ===================
  if (view === 'auth') {
    return (
      <div className="auth-container animate-fade">
        <div className="premium-orb-1"></div>
        <div className="premium-orb-2"></div>

        <div className="auth-card glass-panel animate-slide-up" style={{ zIndex: 10, maxWidth: '440px', width: '100%' }}>
          <div className="logo-container" style={{ justifyContent: 'center', marginBottom: '32px' }}>
            <div className="logo-icon">N</div>
            <div className="logo-text text-shiny">NUMERIQU</div>
          </div>
          <h2 className="text-gradient" style={{ textAlign: 'center', fontSize: '2rem', marginBottom: '8px' }}>
            {authMode === 'login' ? 'Welcome Back' : 'Create Account'}
          </h2>
          <p style={{ textAlign: 'center', color: 'var(--muted)', marginBottom: '32px' }}>
            {authMode === 'login'
              ? 'Sign in to your financial intelligence platform.'
              : 'Start orchestrating your financial data streams.'}
          </p>

          {/* Auth Tab Switcher */}
          <div style={{
            display: 'flex',
            marginBottom: '28px',
            background: 'rgba(255,255,255,0.03)',
            borderRadius: '12px',
            padding: '4px',
          }}>
            {(['login', 'signup'] as const).map(mode => (
              <button
                key={mode}
                onClick={() => { setAuthMode(mode); setAuthError(''); }}
                style={{
                  flex: 1,
                  padding: '10px',
                  borderRadius: '10px',
                  border: 'none',
                  background: authMode === mode ? 'rgba(0, 245, 212, 0.1)' : 'transparent',
                  color: authMode === mode ? '#00F5D4' : 'var(--muted)',
                  fontWeight: 600,
                  fontSize: '0.85rem',
                  cursor: 'pointer',
                  transition: 'all 0.2s ease',
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                }}
              >
                {mode === 'login' ? 'Sign In' : 'Sign Up'}
              </button>
            ))}
          </div>

          {/* Error Display */}
          {authError && (
            <div style={{
              padding: '12px 16px',
              background: authError.includes('Check your email') ? 'rgba(0, 245, 212, 0.08)' : 'rgba(255, 77, 77, 0.08)',
              border: `1px solid ${authError.includes('Check your email') ? 'rgba(0, 245, 212, 0.3)' : 'rgba(255, 77, 77, 0.3)'}`,
              borderRadius: '12px',
              marginBottom: '20px',
              fontSize: '0.85rem',
              color: authError.includes('Check your email') ? '#00F5D4' : '#FF6B6B',
            }}>
              {authError.includes('Check your email') ? '✉️ ' : '⚠️ '}{authError}
            </div>
          )}

          <form onSubmit={authMode === 'login' ? handleLogin : handleSignup}>
            {authMode === 'signup' && (
              <div className="input-group">
                <label className="label">FULL NAME</label>
                <input
                  type="text"
                  placeholder="Jane Smith"
                  className="input-modern"
                  value={authName}
                  onChange={e => setAuthName(e.target.value)}
                />
              </div>
            )}
            <div className="input-group">
              <label className="label">EMAIL</label>
              <input
                type="email"
                placeholder="cfo@company.com"
                className="input-modern"
                value={authEmail}
                onChange={e => setAuthEmail(e.target.value)}
                required
              />
            </div>
            <div className="input-group">
              <label className="label">PASSWORD</label>
              <input
                type="password"
                placeholder="••••••••"
                className="input-modern"
                value={authPassword}
                onChange={e => setAuthPassword(e.target.value)}
                required
                minLength={6}
              />
            </div>
            <button type="submit" className="btn-glow" disabled={isAuthLoading}>
              {isAuthLoading
                ? 'Processing...'
                : authMode === 'login'
                  ? 'Sign In to Numeriqu'
                  : 'Create Account'}
            </button>
          </form>

          <div style={{ marginTop: '28px', textAlign: 'center', fontSize: '0.85rem', color: 'var(--muted)' }}>
            {authMode === 'login'
              ? <>Don&apos;t have an account? <span className="text-shiny" style={{ cursor: 'pointer' }} onClick={() => setAuthMode('signup')}>Sign Up</span></>
              : <>Already have an account? <span className="text-shiny" style={{ cursor: 'pointer' }} onClick={() => setAuthMode('login')}>Sign In</span></>
            }
          </div>

          <div style={{ marginTop: '20px', textAlign: 'center', fontSize: '0.7rem', color: 'rgba(255,255,255,0.2)' }}>
            Secured by Supabase Auth • End-to-End Encrypted
          </div>
        </div>

        <style jsx>{`
          .premium-orb-1 {
            position: absolute; top: -10%; right: -10%; width: 600px; height: 600px;
            background: radial-gradient(circle, rgba(0, 245, 212, 0.1) 0%, transparent 70%);
            filter: blur(100px); z-index: 0;
          }
          .premium-orb-2 {
            position: absolute; bottom: -15%; left: -5%; width: 500px; height: 500px;
            background: radial-gradient(circle, rgba(155, 93, 229, 0.05) 0%, transparent 70%);
            filter: blur(80px); z-index: 0;
          }
        `}</style>
      </div>
    );
  }

  // =================== MAIN APP ===================
  return (
    <div className="numeriqu-app">
      <aside className="sidebar glass-panel">
        <div className="logo-container">
          <div className="logo-icon">N</div>
          <div className="logo-text text-shiny">NUMERIQU</div>
        </div>

        <nav className="nav-links">
          <div className={`nav-item ${view === 'dashboard' ? 'active' : ''}`} onClick={() => setView('dashboard')}>
            <span>💎</span> Overview
          </div>
          <div className={`nav-item ${view === 'intelligence' ? 'active' : ''}`} onClick={() => setView('intelligence')}>
            <span>🧠</span> Intelligence
          </div>
          <div className={`nav-item ${view === 'integrations' ? 'active' : ''}`} onClick={() => setView('integrations')}>
            <span>⚡</span> Integrations
          </div>
          <div className="nav-item"><span>🏦</span> Accounts</div>
          <div className="nav-item"><span>📑</span> Ledgers</div>
          <div className="nav-item"><span>📈</span> Analytics</div>
        </nav>

        <div style={{ marginTop: 'auto', padding: '20px', background: 'rgba(255,255,255,0.03)', borderRadius: '16px' }}>
          <div style={{ fontSize: '0.7rem', color: 'var(--muted)', textTransform: 'uppercase', marginBottom: '8px' }}>Active Session</div>
          <div style={{ fontSize: '0.85rem', fontWeight: 600, marginBottom: '4px' }}>{userContext?.tenant.name}</div>
          <div style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>{userContext?.user.email}</div>
          <button
            onClick={handleLogout}
            disabled={isSigningOut}
            style={{
              marginTop: '16px',
              background: 'none',
              border: '1px solid rgba(248, 113, 113, 0.3)',
              color: '#f87171',
              fontSize: '0.8rem',
              cursor: isSigningOut ? 'not-allowed' : 'pointer',
              padding: '6px 12px',
              borderRadius: '8px',
              width: '100%',
              opacity: isSigningOut ? 0.6 : 1,
              transition: 'all 0.2s ease',
            }}
          >
            {isSigningOut ? 'Signing out…' : 'Sign Out'}
          </button>
        </div>
      </aside>

      <main className="main-viewport">
        {/* =================== DASHBOARD VIEW =================== */}
        {view === 'dashboard' && (
          <div className="animate-slide-up">
            <header className="view-header">
              <h1 className="view-title text-gradient">Executive Summary</h1>
              <p className="view-subtitle">Your unified financial state across all authorized providers.</p>
            </header>

            <div className="dashboard-grid">
              <div className="col-span-4 glass-card stat-widget">
                <div className="stat-icon">💰</div>
                <div>
                  <div className="metric-label">Managed Revenue</div>
                  <div className="metric-value">{stats.totalRevenue}</div>
                </div>
                <div className="metric-trend trend-up">↑ 8.2% current quarter</div>
              </div>

              <div className="col-span-4 glass-card stat-widget">
                <div className="stat-icon">🔗</div>
                <div>
                  <div className="metric-label">Connected Orgs</div>
                  <div className="metric-value">{stats.orgCount > 0 ? stats.orgCount : stats.activeConnections} Orgs</div>
                </div>
                <div className="metric-trend" style={{ color: '#fff', opacity: 0.6 }}>{stats.orgBreakdown || 'Xero & QuickBooks Active'}</div>
              </div>

              <div className="col-span-4 glass-card stat-widget">
                <div className="stat-icon">🤖</div>
                <div>
                  <div className="metric-label">Autonomous Syncs</div>
                  <div className="metric-value">{stats.syncsToday} Jobs</div>
                </div>
                <div className="metric-trend text-shiny">All Systems Optimal</div>
              </div>

              <div className="col-span-12 glass-panel" style={{ padding: '40px', borderRadius: '32px', marginTop: '12px' }}>
                <div className="table-header">
                  <h2 className="text-gradient" style={{ fontSize: '1.6rem' }}>Data Orbis Engine</h2>
                  <div className="shimmer" style={{ width: '120px', height: '4px', borderRadius: '2px' }}></div>
                </div>

                <table className="table-glass" style={{ marginTop: '24px' }}>
                  <thead>
                    <tr>
                      <th>ORCHESTRATOR</th>
                      <th>IDENTIFIER</th>
                      <th>VOLUMETRICS</th>
                      <th>SYSTEM STATE</th>
                      <th>UPDATED</th>
                    </tr>
                  </thead>
                  <tbody>
                    {jobs.length === 0 ? (
                      <tr>
                        <td colSpan={5} style={{ textAlign: 'center', padding: '40px', color: 'var(--muted)', opacity: 0.7 }}>
                          <div style={{ fontSize: '2rem', marginBottom: '12px', opacity: 0.5 }}>📭</div>
                          No synchronization jobs active.<br/>
                          <span style={{ fontSize: '0.8rem', marginTop: '8px', display: 'inline-block' }}>Navigate to the Integrations tab to connect your financial providers.</span>
                        </td>
                      </tr>
                    ) : (
                      jobs.map(job => (
                      <tr key={job.id} className="animate-fade">
                        <td className="text-shiny" style={{ fontSize: '0.9rem' }}>
                          {job.orgName ? (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                              <span>{job.orgName}</span>
                              <span style={{ fontSize: '0.7rem', opacity: 0.45, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{job.provider}</span>
                            </div>
                          ) : (
                            job.provider.toUpperCase()
                          )}
                        </td>
                        <td style={{ fontFamily: 'monospace', opacity: 0.5 }}>{job.id.substring(0, 15)}...</td>
                        <td style={{ fontWeight: 700, fontSize: '1.1rem' }}>{job.recordsProcessed || 0} items</td>
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <div className="status-orb" style={{ background: job.status === 'running' ? '#3B82F6' : job.status === 'completed' ? '#10B981' : '#EF4444' }}></div>
                            <span style={{ fontSize: '0.75rem', fontWeight: 700, opacity: 0.8 }}>{job.status.toUpperCase()}</span>
                          </div>
                        </td>
                        <td style={{ opacity: 0.6 }}>{new Date(job.startedAt).toLocaleTimeString()}</td>
                      </tr>
                    )))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* =================== INTELLIGENCE VIEW =================== */}
        {view === 'intelligence' && (
          <div className="animate-slide-up intelligence-view">
            <header className="view-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <h1 className="view-title text-gradient">Numeriqu Intelligence</h1>
                <p className="view-subtitle">AI-powered financial advisory with real-time data from your connected providers.</p>
              </div>
              <div style={{
                padding: '8px 16px',
                borderRadius: '100px',
                background: aiHealth?.ollama ? 'rgba(0, 245, 212, 0.1)' : (aiHealth ? 'rgba(255, 184, 0, 0.1)' : 'rgba(255, 77, 77, 0.1)'),
                border: `1px solid ${aiHealth?.ollama ? 'rgba(0, 245, 212, 0.3)' : (aiHealth ? 'rgba(255, 184, 0, 0.3)' : 'rgba(255, 77, 77, 0.3)')}`,
                fontSize: '0.75rem',
                fontWeight: 600,
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                cursor: 'help',
              }} title={aiHealth?.ollama ? 'Ollama is running (Agentic Mode)' : (aiHealth ? 'Ollama not detected. Simulation Mode enabled.' : 'AI Service is not reachable.')}>
                <div className="status-orb" style={{ 
                  background: aiHealth?.ollama ? '#00F5D4' : (aiHealth ? '#FFB800' : '#FF4D4D'), 
                  width: '8px', 
                  height: '8px',
                  boxShadow: aiHealth?.ollama ? '0 0 8px #00F5D4' : 'none'
                }}></div>
                <span style={{ color: aiHealth?.ollama ? '#00F5D4' : (aiHealth ? '#FFB800' : '#FF4D4D') }}>
                  {aiHealth?.ollama ? `Agentic • ${aiHealth.model} • ${aiHealth.latencyMs}ms` : (aiHealth ? 'Simulation Mode' : 'AI Offline')}
                </span>
              </div>
            </header>

            <div className="intelligence-chat-container glass-panel" style={{
              borderRadius: '32px',
              display: 'flex',
              flexDirection: 'column',
              height: 'calc(100vh - 240px)',
              overflow: 'hidden',
            }}>
              <div className="chat-messages" style={{
                flex: 1,
                overflowY: 'auto',
                padding: '32px',
                display: 'flex',
                flexDirection: 'column',
                gap: '24px',
              }}>
                {chatMessages.length === 0 && !isQuerying && (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, gap: '32px' }}>
                    <div style={{
                      width: '80px', height: '80px', borderRadius: '24px',
                      background: 'linear-gradient(135deg, rgba(0, 245, 212, 0.15), rgba(155, 93, 229, 0.15))',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '2.5rem',
                    }}>🧠</div>
                    <div style={{ textAlign: 'center' }}>
                      <h2 className="text-gradient" style={{ fontSize: '1.8rem', marginBottom: '8px' }}>Financial Intelligence Engine</h2>
                      <p style={{ color: 'var(--muted)', maxWidth: '500px', lineHeight: 1.6 }}>
                        Ask anything about your financial data. I analyze real-time metrics from all your connected providers with zero hallucination.
                      </p>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '12px', maxWidth: '700px', width: '100%' }}>
                      {SUGGESTED_QUERIES.map((sq, i) => (
                        <button key={i} onClick={() => handleAIQuery(sq)} className="suggestion-chip" style={{
                          padding: '16px 20px', background: 'rgba(255, 255, 255, 0.03)',
                          border: '1px solid rgba(255, 255, 255, 0.08)', borderRadius: '16px',
                          color: '#ccc', fontSize: '0.85rem', cursor: 'pointer', textAlign: 'left',
                          transition: 'all 0.3s ease', lineHeight: 1.4,
                        }}
                        onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'rgba(0, 245, 212, 0.3)'; e.currentTarget.style.background = 'rgba(0, 245, 212, 0.05)'; e.currentTarget.style.color = '#fff'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.08)'; e.currentTarget.style.background = 'rgba(255, 255, 255, 0.03)'; e.currentTarget.style.color = '#ccc'; }}
                        >
                          <span style={{ marginRight: '8px', opacity: 0.5 }}>→</span> {sq}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {chatMessages.map((msg) => (
                  <div key={msg.id} style={{
                    display: 'flex', flexDirection: 'column', gap: '8px',
                    maxWidth: msg.role === 'user' ? '70%' : '100%',
                    alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
                    animation: 'fadeIn 0.4s ease forwards',
                  }}>
                    {msg.role === 'assistant' && msg.context && (
                      <div style={{
                        display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px',
                        padding: '16px', background: 'rgba(0, 245, 212, 0.04)',
                        border: '1px solid rgba(0, 245, 212, 0.15)', borderRadius: '16px', marginBottom: '8px',
                      }}>
                        {[
                          { label: 'Revenue', value: `$${msg.context.totalRevenue?.toLocaleString()}`, color: '#00F5D4' },
                          { label: 'Net Profit', value: `$${msg.context.netProfit?.toLocaleString()}`, color: msg.context.netProfit >= 0 ? '#00F5D4' : '#FF4D4D' },
                          { label: 'Margin', value: `${msg.context.profitMargin}%`, color: '#fff' },
                          { label: 'Data Fetch', value: `${msg.context.fetchTimeMs}ms`, color: 'var(--muted)' },
                        ].map((m, i) => (
                          <div key={i} style={{ textAlign: 'center' }}>
                            <div style={{ fontSize: '0.65rem', color: 'var(--muted)', textTransform: 'uppercase', marginBottom: '4px' }}>{m.label}</div>
                            <div style={{ fontSize: '1rem', fontWeight: 700, color: m.color }}>{m.value}</div>
                          </div>
                        ))}
                      </div>
                    )}
                    <div style={{
                      padding: msg.role === 'user' ? '16px 20px' : '24px',
                      background: msg.role === 'user'
                        ? 'linear-gradient(135deg, rgba(0, 245, 212, 0.15), rgba(155, 93, 229, 0.15))'
                        : 'rgba(255, 255, 255, 0.03)',
                      border: `1px solid ${msg.role === 'user' ? 'rgba(0, 245, 212, 0.3)' : 'rgba(255, 255, 255, 0.06)'}`,
                      borderRadius: msg.role === 'user' ? '20px 20px 4px 20px' : '20px 20px 20px 4px',
                      fontSize: '0.95rem', lineHeight: 1.7, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                    }}>
                      {msg.role === 'assistant' && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px', paddingBottom: '12px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                          <span style={{ fontSize: '1.1rem' }}>🧠</span>
                          <span className="text-shiny" style={{ fontSize: '0.8rem' }}>NUMERIQU INTELLIGENCE</span>
                        </div>
                      )}
                      {msg.content}
                    </div>
                    {msg.metrics && (
                      <div style={{ display: 'flex', gap: '16px', fontSize: '0.7rem', color: 'var(--muted)', paddingLeft: '8px' }}>
                        <span>⚡ Data: {msg.metrics.dataFetchMs}ms</span>
                        <span>🧠 LLM: {msg.metrics.llmGenerationMs}ms</span>
                        <span>📊 Total: {msg.metrics.totalMs}ms</span>
                      </div>
                    )}
                  </div>
                ))}

                {isQuerying && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxWidth: '100%', alignSelf: 'flex-start' }}>
                    <div style={{
                      padding: '24px', background: 'rgba(255, 255, 255, 0.03)',
                      border: '1px solid rgba(255, 255, 255, 0.06)', borderRadius: '20px 20px 20px 4px',
                      fontSize: '0.95rem', lineHeight: 1.7, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px', paddingBottom: '12px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                        <span style={{ fontSize: '1.1rem' }}>🧠</span>
                        <span className="text-shiny" style={{ fontSize: '0.8rem' }}>NUMERIQU INTELLIGENCE</span>
                        {!streamingContent && (
                          <div style={{ display: 'flex', gap: '4px', marginLeft: '8px' }}>
                            <div className="thinking-dot"></div><div className="thinking-dot"></div><div className="thinking-dot"></div>
                          </div>
                        )}
                      </div>
                      {streamingStatus && !streamingContent && (
                        <span style={{ color: 'var(--muted)', fontStyle: 'italic' }}>{streamingStatus}</span>
                      )}
                      {!streamingStatus && !streamingContent && (
                        <span style={{ color: 'var(--muted)', fontStyle: 'italic' }}>Connecting to intelligence engine...</span>
                      )}
                      {streamingContent}
                      {streamingContent && <span className="cursor-blink">▊</span>}
                    </div>
                  </div>
                )}
                <div ref={chatEndRef} />
              </div>

              <div style={{ padding: '20px 32px 24px', borderTop: '1px solid rgba(255, 255, 255, 0.06)', background: 'rgba(0, 0, 0, 0.3)' }}>
                <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-end' }}>
                  <textarea
                    value={chatInput}
                    onChange={e => setChatInput(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Ask about your financial data..."
                    disabled={isQuerying}
                    rows={1}
                    style={{
                      flex: 1, background: 'rgba(255, 255, 255, 0.04)',
                      border: '1px solid rgba(255, 255, 255, 0.1)', borderRadius: '16px',
                      padding: '16px 20px', color: '#fff', fontSize: '0.95rem', resize: 'none',
                      outline: 'none', fontFamily: 'Inter, sans-serif', lineHeight: 1.5,
                      minHeight: '54px', maxHeight: '150px', transition: 'border-color 0.2s ease',
                    }}
                    onFocus={e => e.target.style.borderColor = 'rgba(0, 245, 212, 0.4)'}
                    onBlur={e => e.target.style.borderColor = 'rgba(255, 255, 255, 0.1)'}
                  />
                  <button
                    onClick={() => isQuerying ? cancelQuery() : handleAIQuery()}
                    disabled={!isQuerying && !chatInput.trim()}
                    title={isQuerying ? 'Stop generation (Esc)' : 'Send message (Enter)'}
                    style={{
                      width: '54px', height: '54px', borderRadius: '16px',
                      background: isQuerying
                        ? 'rgba(255, 77, 77, 0.15)'
                        : chatInput.trim()
                          ? 'linear-gradient(135deg, var(--primary), var(--secondary))'
                          : 'rgba(255, 255, 255, 0.05)',
                      color: isQuerying ? '#FF6B6B' : chatInput.trim() ? '#000' : 'var(--muted)',
                      fontSize: '1.3rem',
                      cursor: isQuerying || chatInput.trim() ? 'pointer' : 'not-allowed',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      transition: 'all 0.3s ease', flexShrink: 0,
                      border: isQuerying ? '1px solid rgba(255, 77, 77, 0.4)' : 'none',
                    }}
                  >{isQuerying ? '⏹' : '↑'}</button>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '8px', fontSize: '0.7rem', color: 'var(--muted)', padding: '0 4px' }}>
                  <span>{isQuerying ? 'Press Esc or ⏹ to cancel' : 'Press Enter to send'}</span>
                  <span>Powered by {aiHealth?.model || 'Ollama'} • Ground Truth from ClickHouse</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* =================== INTEGRATIONS VIEW =================== */}
        {view === 'integrations' && (
          <div className="animate-slide-up">
            <header className="view-header">
              <h1 className="view-title text-gradient">Channel Control</h1>
              <p className="view-subtitle">Securely authorize and monitor third-party financial endpoints.</p>
            </header>

            <div className="dashboard-grid">
              <div className="col-span-6 glass-card" style={{ padding: '32px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '32px' }}>
                  <div style={{ padding: '16px', background: 'rgba(19, 181, 234, 0.1)', borderRadius: '16px' }}>
                    <img src="https://upload.wikimedia.org/wikipedia/en/thumb/9/9f/Xero_software_logo.svg/200px-Xero_software_logo.svg.png" style={{ height: '32px', filter: 'brightness(0) invert(1)' }} alt="Xero" />
                  </div>
                  <div className="status-orb" style={{ background: '#10B981' }}></div>
                </div>
                <h3 style={{ fontSize: '1.4rem', marginBottom: '8px' }}>Xero Accounting</h3>
                <p style={{ color: 'var(--muted)', fontSize: '0.9rem', marginBottom: '32px' }}>Connected via OAuth 2.0 refresh layer.</p>
                <div className="input-group">
                  <label className="label">SYNC HORIZON</label>
                  <input type="date" className="input-modern" value={startDate} onChange={e => setStartDate(e.target.value)} />
                </div>
                <div style={{ display: 'flex', gap: '16px' }}>
                  <a href={`http://localhost:3000/auth/xero/connect?tenantId=${userContext?.tenant.id}&userId=${userContext?.user.id}&startDate=${startDate}T00:00:00Z`} className="btn-glow" style={{ textDecoration: 'none', textAlign: 'center', flex: 1 }}>Authorize</a>
                  <button onClick={() => apiFetch('/test/trigger-sync?provider=xero', { method: 'POST' })} className="btn-glow" style={{ background: 'rgba(255,255,255,0.05)', color: '#fff', flex: 1 }}>Orchestrate</button>
                </div>
              </div>

              <div className="col-span-6 glass-card" style={{ padding: '32px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '32px' }}>
                  <div style={{ padding: '16px', background: 'rgba(44, 160, 28, 0.1)', borderRadius: '16px' }}>
                    <img src="https://upload.wikimedia.org/wikipedia/commons/2/2c/Quickbooks_logo.svg" style={{ height: '32px', filter: 'brightness(0) invert(1)' }} alt="QB" />
                  </div>
                  <div className="status-orb" style={{ background: '#3B82F6' }}></div>
                </div>
                <h3 style={{ fontSize: '1.4rem', marginBottom: '8px' }}>QuickBooks Online</h3>
                <p style={{ color: 'var(--muted)', fontSize: '0.9rem', marginBottom: '32px' }}>Direct native SDK pipeline active.</p>
                <div style={{ height: '84px', opacity: 0.5, fontSize: '0.85rem' }}>No configuration required for standard SDK ingestion.</div>
                <div style={{ display: 'flex', gap: '16px' }}>
                  <a href={`http://localhost:3000/auth/quickbooks/connect?tenantId=${userContext?.tenant.id}&userId=${userContext?.user.id}`} className="btn-glow" style={{ textDecoration: 'none', textAlign: 'center', flex: 1 }}>Link QB</a>
                  <button onClick={() => apiFetch('/test/trigger-sync?provider=quickbooks', { method: 'POST' })} className="btn-glow" style={{ background: 'rgba(255,255,255,0.05)', color: '#fff', flex: 1 }}>Sync Hub</button>
                </div>
              </div>
            </div>

            <div className="dashboard-grid" style={{ marginTop: '24px' }}>
              <div className="col-span-12 glass-panel" style={{ padding: '40px', borderRadius: '32px' }}>
                <div className="table-header">
                  <h2 className="text-gradient" style={{ fontSize: '1.6rem' }}>Active Orchestrators</h2>
                  <div className="shimmer" style={{ width: '120px', height: '4px', borderRadius: '2px' }}></div>
                </div>

                <table className="table-glass" style={{ marginTop: '24px' }}>
                  <thead>
                    <tr>
                      <th>PROVIDER</th>
                      <th>ORGANIZATION IDENTITY</th>
                      <th>TRUST STATUS</th>
                      <th>LAST ESTABLISHED</th>
                      <th>ACTION</th>
                    </tr>
                  </thead>
                  <tbody>
                    {connections.length === 0 ? (
                      <tr>
                        <td colSpan={5} style={{ textAlign: 'center', padding: '40px', color: 'var(--muted)', opacity: 0.7 }}>
                          <div style={{ fontSize: '2rem', marginBottom: '12px', opacity: 0.5 }}>⚡</div>
                          No active integrations established.<br/>
                          <span style={{ fontSize: '0.8rem', marginTop: '8px', display: 'inline-block' }}>Authorize a platform above to begin data orchestration.</span>
                        </td>
                      </tr>
                    ) : (
                      connections.map(conn => (
                      <tr key={conn.id} className="animate-fade">
                        <td style={{ opacity: 0.6, textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: '0.8rem' }}>
                          <span style={{ padding: '4px 8px', background: 'rgba(255,255,255,0.05)', borderRadius: '4px', border: '1px solid rgba(255,255,255,0.1)' }}>
                            {conn.provider}
                          </span>
                        </td>
                        <td className="text-shiny" style={{ fontWeight: 600, fontSize: '1.05rem' }}>{conn.orgName}</td>
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <div className="status-orb" style={{ background: conn.isActive ? '#10B981' : '#EF4444' }}></div>
                            <span style={{ fontSize: '0.75rem', fontWeight: 700, opacity: 0.8, color: conn.isActive ? '#10B981' : '#EF4444' }}>
                              {conn.isActive ? 'VERIFIED' : 'SUSPENDED'}
                            </span>
                          </div>
                        </td>
                        <td style={{ opacity: 0.6, fontSize: '0.9rem' }}>{new Date(conn.updatedAt).toLocaleString()}</td>
                        <td>
                          <button 
                            onClick={() => handleDisconnect(conn.id, conn.orgName)}
                            style={{
                              background: 'rgba(255, 77, 77, 0.08)',
                              border: '1px solid rgba(255, 77, 77, 0.3)',
                              color: '#FF6B6B',
                              padding: '8px 16px',
                              borderRadius: '8px',
                              fontSize: '0.75rem',
                              cursor: 'pointer',
                              fontWeight: 600,
                              transition: 'all 0.2s',
                              textTransform: 'uppercase',
                              letterSpacing: '0.05em',
                              boxShadow: '0 4px 12px rgba(255, 77, 77, 0.1)'
                            }}
                            onMouseEnter={(e) => { 
                              e.currentTarget.style.background = 'rgba(255, 77, 77, 0.2)'; 
                              e.currentTarget.style.boxShadow = '0 0 12px rgba(255, 77, 77, 0.4)';
                            }}
                            onMouseLeave={(e) => { 
                              e.currentTarget.style.background = 'rgba(255, 77, 77, 0.08)'; 
                              e.currentTarget.style.boxShadow = '0 4px 12px rgba(255, 77, 77, 0.1)';
                            }}
                          >
                            Revoke
                          </button>
                        </td>
                      </tr>
                    )))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </main>

      <style jsx>{`
        .thinking-dot {
          width: 6px; height: 6px; border-radius: 50%; background: var(--primary);
          animation: thinking 1.4s infinite ease-in-out both;
        }
        .thinking-dot:nth-child(1) { animation-delay: 0s; }
        .thinking-dot:nth-child(2) { animation-delay: 0.2s; }
        .thinking-dot:nth-child(3) { animation-delay: 0.4s; }
        @keyframes thinking {
          0%, 80%, 100% { transform: scale(0.4); opacity: 0.3; }
          40% { transform: scale(1); opacity: 1; }
        }
        .cursor-blink { animation: blink 1s steps(1) infinite; color: var(--primary); }
        @keyframes blink { 0%, 50% { opacity: 1; } 51%, 100% { opacity: 0; } }
        .chat-messages::-webkit-scrollbar { width: 4px; }
        .chat-messages::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 4px; }
      `}</style>
    </div>
  );
}
