"use client";

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { supabase, apiFetch } from './lib/supabase';
import './globals.css';
import DashboardCharts from './components/DashboardCharts';
import AdvisorPanel from './components/AdvisorPanel';
import AgentPanel from './components/AgentPanel';
import { LayoutGrid, BrainCircuit, TerminalSquare, Link, LogOut, Loader2, ShieldCheck, Database, Calendar } from 'lucide-react';

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

const DEFAULT_START_DATE = '2020-01-01';

export default function NumeriquOS() {
  const [view, setView] = useState<'loading' | 'auth' | 'dashboard' | 'advisor' | 'strategic' | 'integrations'>('loading');
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
  
  const [isSigningOut, setIsSigningOut] = useState(false);
  const hasInitialHydrated = useRef(false);

  // =================== SESSION HYDRATION ===================
  useEffect(() => {
    if (hasInitialHydrated.current) return;

    const initSession = async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
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

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
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

  const hydrateUser = async (retries = 3) => {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const res = await apiFetch('/auth/me');
        if (res.ok) {
          const data = await res.json();
          setUserContext(data);
          setView(prev => (prev === 'auth' || prev === 'loading' ? 'dashboard' : prev));
          return;
        }
        if (res.status === 503 && attempt < retries) {
          await new Promise(r => setTimeout(r, 1000 * attempt));
          continue;
        }
        setView('auth');
        return;
      } catch {
        if (attempt < retries) {
          await new Promise(r => setTimeout(r, 1000 * attempt));
          continue;
        }
        setView('auth');
      }
    }
  };

  const fetchJobs = useCallback(async () => {
    if (!userContext) return;
    try {
      const res = await apiFetch('/test/jobs');
      if (res.ok) setJobs(await res.json());
    } catch (e) {
      console.warn('[Polling] Jobs fetch degraded.');
    }
  }, [userContext]);

  const fetchConnections = useCallback(async () => {
    if (!userContext) return;
    try {
      const res = await apiFetch('/integrations/connections');
      if (res.ok) setConnections(await res.json());
    } catch (e) {
      console.warn('[Polling] Connections fetch degraded.');
    }
  }, [userContext]);

  useEffect(() => {
    if (userContext) {
      fetchJobs();
      fetchConnections();
      const interval = setInterval(() => {
        if (view === 'integrations') {
          fetchJobs();
          fetchConnections();
        }
      }, 30_000);
      return () => clearInterval(interval);
    }
  }, [userContext, fetchJobs, fetchConnections, view]);

  // =================== AUTH HANDLERS ===================
  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError('');
    setIsAuthLoading(true);

    const { data, error } = await supabase.auth.signUp({
      email: authEmail,
      password: authPassword,
      options: { data: { name: authName || authEmail.split('@')[0] } },
    });

    if (error) setAuthError(error.message);
    else if (data.user && !data.session) setAuthError('Check your email for a confirmation link.');
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

    if (error) setAuthError(error.message);
    setIsAuthLoading(false);
  };

  const handleLogout = async () => {
    if (isSigningOut) return;
    setIsSigningOut(true);
    try {
      await supabase.auth.signOut();
      setUserContext(null);
      setView('auth');
      window.location.reload();
    } catch {
      alert('Unable to sign out. Please try again.');
    } finally {
      setIsSigningOut(false);
    }
  };

  // =================== OAUTH HANDLERS ===================
  const initiateOAuth = async (provider: 'xero' | 'quickbooks') => {
    if (!userContext) return;
    try {
      const res = await apiFetch(`/auth/${provider}/connect`, {
        method: 'POST',
        body: JSON.stringify({ startDate: startDate + 'T00:00:00Z' }),
      });
      if (!res.ok) throw new Error('Failed to initiate connection protocol.');
      const { url } = await res.json();
      window.location.href = url;
    } catch (e) {
      alert('Failed to connect with provider. Please verify your credentials and try again.');
    }
  };

  const handleDisconnect = async (id: string, name: string) => {
    if (!confirm(`Revoke trust for ${name}? This stops all real-time syncs.`)) return;
    try {
      const res = await apiFetch(`/integrations/connections/${id}`, { method: 'DELETE' });
      if (res.ok) {
        fetchConnections();
        fetchJobs();
      } else {
        alert('Could not terminate protocol.');
      }
    } catch (e) {
      alert('Network fault during revocation.');
    }
  };

  // =================== LOADING/AUTH VIEWS ===================
  if (view === 'loading') {
    return (
      <div className="auth-container animate-fade" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div className="premium-orb-1"></div>
        <div className="premium-orb-2"></div>
        <div style={{ textAlign: 'center', zIndex: 10 }}>
          <div className="logo-icon" style={{ width: 80, height: 80, fontSize: '2.5rem', margin: '0 auto' }}>N</div>
          <div className="text-shiny" style={{ marginTop: 24, fontSize: '1.2rem' }}>Initializing Numeriqu OS...</div>
        </div>
      </div>
    );
  }

  if (view === 'auth') {
    return (
      <div className="auth-container animate-fade">
        <div className="premium-orb-1"></div>
        <div className="premium-orb-2"></div>
        <div className="auth-card glass-panel animate-slide-up">
          <div className="logo-container" style={{ justifyContent: 'center', marginBottom: 32 }}>
            <div className="logo-icon">N</div>
            <div className="logo-text text-shiny">NUMERIQU</div>
          </div>
          <h2 className="text-gradient" style={{ textAlign: 'center', fontSize: '2rem', marginBottom: 8 }}>
            {authMode === 'login' ? 'Welcome Back' : 'Create Account'}
          </h2>
          <p style={{ textAlign: 'center', color: 'var(--muted)', marginBottom: 32 }}>
            {authMode === 'login' ? 'Sign in to your financial intelligence platform.' : 'Start orchestrating your financial data streams.'}
          </p>

          <div style={{ display: 'flex', marginBottom: 28, background: 'rgba(255,255,255,0.03)', borderRadius: 12, padding: 4 }}>
            {(['login', 'signup'] as const).map(mode => (
              <button
                key={mode}
                onClick={() => { setAuthMode(mode); setAuthError(''); }}
                style={{
                  flex: 1, padding: 10, borderRadius: 10, border: 'none',
                  background: authMode === mode ? 'rgba(0, 245, 212, 0.1)' : 'transparent',
                  color: authMode === mode ? '#00F5D4' : 'var(--muted)',
                  fontWeight: 600, fontSize: '0.85rem', cursor: 'pointer',
                  transition: 'all 0.2s ease', textTransform: 'uppercase', letterSpacing: '0.05em',
                }}
              >
                {mode === 'login' ? 'Sign In' : 'Sign Up'}
              </button>
            ))}
          </div>

          {authError && (
            <div style={{
              padding: '12px 16px', borderRadius: 12, marginBottom: 20, fontSize: '0.85rem',
              background: authError.includes('Check your email') ? 'rgba(0, 245, 212, 0.08)' : 'rgba(255, 77, 77, 0.08)',
              border: `1px solid ${authError.includes('Check your email') ? 'rgba(0, 245, 212, 0.3)' : 'rgba(255, 77, 77, 0.3)'}`,
              color: authError.includes('Check your email') ? '#00F5D4' : '#FF6B6B',
            }}>
              {authError.includes('Check your email') ? '✉️ ' : '⚠️ '}{authError}
            </div>
          )}

          <form onSubmit={authMode === 'login' ? handleLogin : handleSignup}>
            {authMode === 'signup' && (
              <div className="input-group">
                <label className="label">FULL NAME</label>
                <input type="text" placeholder="Jane Smith" className="input-modern" value={authName} onChange={e => setAuthName(e.target.value)} />
              </div>
            )}
            <div className="input-group">
              <label className="label">EMAIL</label>
              <input type="email" placeholder="cfo@company.com" className="input-modern" value={authEmail} onChange={e => setAuthEmail(e.target.value)} required />
            </div>
            <div className="input-group">
              <label className="label">PASSWORD</label>
              <input type="password" placeholder="••••••••" className="input-modern" value={authPassword} onChange={e => setAuthPassword(e.target.value)} required minLength={6} />
            </div>
            <button type="submit" className="btn-glow" disabled={isAuthLoading}>
              {isAuthLoading ? <Loader2 className="animate-spin" /> : (authMode === 'login' ? 'Sign In to Numeriqu' : 'Create Account')}
            </button>
          </form>

          <div style={{ marginTop: 28, textAlign: 'center', fontSize: '0.85rem', color: 'var(--muted)' }}>
            {authMode === 'login'
              ? <>Don't have an account? <span className="text-shiny" style={{ cursor: 'pointer' }} onClick={() => setAuthMode('signup')}>Sign Up</span></>
              : <>Already have an account? <span className="text-shiny" style={{ cursor: 'pointer' }} onClick={() => setAuthMode('login')}>Sign In</span></>
            }
          </div>
          <div style={{ marginTop: 20, textAlign: 'center', fontSize: '0.7rem', color: 'rgba(255,255,255,0.2)' }}>Secured by Supabase Auth • End-to-End Encrypted</div>
        </div>
        <style jsx>{`
          .premium-orb-1 { position: absolute; top: -10%; right: -10%; width: 600px; height: 600px; background: radial-gradient(circle, rgba(0, 245, 212, 0.1) 0%, transparent 70%); filter: blur(100px); z-index: 0; }
          .premium-orb-2 { position: absolute; bottom: -15%; left: -5%; width: 500px; height: 500px; background: radial-gradient(circle, rgba(155, 93, 229, 0.05) 0%, transparent 70%); filter: blur(80px); z-index: 0; }
          .animate-spin { animation: spin 1s linear infinite; margin: 0 auto; }
          @keyframes spin { 100% { transform: rotate(360deg); } }
        `}</style>
      </div>
    );
  }

  // =================== MAIN APP ===================
  return (
    <div className="numeriqu-app">
      {/* ── Sidebar Navigation ── */}
      <aside className="sidebar glass-panel">
        <div className="logo-container">
          <div className="logo-icon">N</div>
          <div className="logo-text text-shiny">NUMERIQU</div>
        </div>

        <nav className="nav-links">
          <div className={`nav-item ${view === 'dashboard' ? 'active' : ''}`} onClick={() => setView('dashboard')}>
            <LayoutGrid size={18} /> Overview
          </div>
          <div className={`nav-item ${view === 'advisor' ? 'active' : ''}`} onClick={() => setView('advisor')}>
            <BrainCircuit size={18} /> Personal Advisor
          </div>
          <div className={`nav-item ${view === 'strategic' ? 'active' : ''}`} onClick={() => setView('strategic')}>
            <TerminalSquare size={18} /> Strategic Agent
          </div>
          <div className={`nav-item ${view === 'integrations' ? 'active' : ''}`} onClick={() => setView('integrations')}>
            <Link size={18} /> Integrations
          </div>
        </nav>

        <div style={{ marginTop: 'auto', padding: 20, background: 'rgba(255,255,255,0.03)', borderRadius: 16 }}>
          <div style={{ fontSize: '0.7rem', color: 'var(--muted)', textTransform: 'uppercase', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
            <ShieldCheck size={12} /> Active Session
          </div>
          <div style={{ fontSize: '0.85rem', fontWeight: 600, marginBottom: 4 }}>{userContext?.tenant.name}</div>
          <div style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>{userContext?.user.email}</div>
          <button
            onClick={handleLogout}
            disabled={isSigningOut}
            style={{
              marginTop: 16, background: 'none', border: '1px solid rgba(248, 113, 113, 0.3)', color: '#f87171',
              fontSize: '0.8rem', cursor: isSigningOut ? 'not-allowed' : 'pointer', padding: '8px 12px',
              borderRadius: 8, width: '100%', opacity: isSigningOut ? 0.6 : 1, transition: 'all 0.2s ease',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8
            }}
          >
            {isSigningOut ? <Loader2 size={14} className="animate-spin" /> : <LogOut size={14} />} 
            {isSigningOut ? 'Signing out…' : 'Sign Out'}
          </button>
        </div>
      </aside>

      {/* ── Main Viewport ── */}
      <main className="main-viewport">
        {view === 'dashboard' && <DashboardCharts />}

        <div className="animate-slide-up" style={{ display: view === 'advisor' ? 'block' : 'none' }}>
          <header className="view-header">
            <h1 className="view-title text-gradient">Personal Advisor</h1>
            <p className="view-subtitle">High-fidelity conversational insights governed strictly by your live data.</p>
          </header>
          <AdvisorPanel />
        </div>

        <div className="animate-slide-up" style={{ display: view === 'strategic' ? 'block' : 'none' }}>
          <header className="view-header">
            <h1 className="view-title text-gradient">Strategic Agent</h1>
            <p className="view-subtitle">Issue missions to generate multi-dimensional charts and automated insights.</p>
          </header>
          <AgentPanel />
        </div>

        {view === 'integrations' && (
          <div className="animate-slide-up">
            <header className="view-header">
              <h1 className="view-title text-gradient">Data Integration</h1>
              <p className="view-subtitle">Connect and orchestrate your financial providers securely.</p>
            </header>

            <div className="dashboard-grid">
              {/* Providers Connections */}
              <div className="col-span-8 glass-card" style={{ padding: 32 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
                  <div>
                    <h2 className="font-heading" style={{ fontSize: '1.2rem', marginBottom: 4 }}>Data Providers</h2>
                    <p style={{ fontSize: '0.85rem', color: 'var(--muted)' }}>Authorize synchronization streams.</p>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <Calendar size={16} color="var(--muted)" />
                    <input 
                      type="date" 
                      value={startDate} 
                      onChange={e => setStartDate(e.target.value)}
                      className="input-modern"
                      style={{ padding: '8px 12px', fontSize: '0.85rem', width: 'auto' }}
                      title="Data Sync Start Date"
                    />
                  </div>
                </div>

                <div style={{ display: 'grid', gap: 16 }}>
                  {['xero', 'quickbooks'].map(provider => {
                    const conn = connections.find(c => c.provider === provider);
                    return (
                      <div key={provider} style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        padding: 24, background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: 16,
                      }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                          <div style={{ width: 48, height: 48, borderRadius: 12, background: provider === 'xero' ? '#13B5EA' : '#2CA01C', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.5rem', fontWeight: 800, color: '#fff' }}>
                            {provider === 'xero' ? 'X' : 'qb'}
                          </div>
                          <div>
                            <div style={{ fontSize: '1.1rem', fontWeight: 600, textTransform: 'capitalize' }}>{provider}</div>
                            {conn && <div style={{ fontSize: '0.8rem', color: '#00F5D4', marginTop: 4 }}>{conn.orgName || 'Connected'}</div>}
                          </div>
                        </div>
                        {conn ? (
                          <button onClick={() => handleDisconnect(conn.id, provider)} style={{ background: 'rgba(255,77,77,0.1)', color: '#FF4D4D', border: '1px solid rgba(255,77,77,0.2)', padding: '10px 20px', borderRadius: 10, cursor: 'pointer', fontWeight: 600, transition: 'all 0.2s', fontSize: '0.85rem' }}>
                            Disconnect
                          </button>
                        ) : (
                          <button onClick={() => initiateOAuth(provider as any)} className="btn-glow" style={{ padding: '10px 20px', width: 'auto', fontSize: '0.85rem' }}>
                            Connect
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Sync Pipeline Jobs */}
              <div className="col-span-12 glass-panel" style={{ padding: 40, borderRadius: 32, marginTop: 24 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
                  <h2 className="text-gradient" style={{ fontSize: '1.4rem' }}>ETL Pipeline Activity</h2>
                  <button onClick={fetchJobs} title="Refresh Jobs" style={{ background: 'transparent', border: 'none', color: 'var(--primary)', cursor: 'pointer' }}><Database size={20} /></button>
                </div>
                
                <table className="table-glass">
                  <thead>
                    <tr>
                      <th>ORCHESTRATOR</th>
                      <th>ORGANIZATION</th>
                      <th>VOLUMETRICS</th>
                      <th>SYSTEM STATE</th>
                      <th>UPDATED</th>
                    </tr>
                  </thead>
                  <tbody>
                    {jobs.length === 0 ? (
                      <tr>
                        <td colSpan={5} style={{ textAlign: 'center', padding: 40, color: 'var(--muted)' }}>No synchronization jobs active.</td>
                      </tr>
                    ) : (
                      jobs.map(job => (
                        <tr key={job.id}>
                          <td><span className="provider-badge" style={{ background: job.provider === 'xero' ? 'rgba(19, 181, 234, 0.2)' : 'rgba(44, 160, 28, 0.2)', color: job.provider === 'xero' ? '#13B5EA' : '#2CA01C' }}>{job.provider.toUpperCase()}</span></td>
                          <td style={{ fontWeight: 500 }}>{job.orgName || 'Aggregated'}</td>
                          <td><span style={{ color: 'var(--primary)', fontWeight: 600 }}>{job.recordsProcessed || 0}</span> <span style={{ opacity: 0.5, fontSize: '0.8rem' }}>records</span></td>
                          <td>
                            <span style={{
                              padding: '4px 10px', borderRadius: 8, fontSize: '0.75rem', fontWeight: 600, letterSpacing: '0.5px', textTransform: 'uppercase',
                              background: job.status === 'completed' ? 'rgba(0, 245, 212, 0.1)' : job.status === 'running' ? 'rgba(59, 130, 246, 0.1)' : 'rgba(245, 158, 11, 0.1)',
                              color: job.status === 'completed' ? '#00F5D4' : job.status === 'running' ? '#3B82F6' : '#F59E0B'
                            }}>
                              {job.status}
                            </span>
                          </td>
                          <td style={{ fontSize: '0.8rem', opacity: 0.7 }}>{new Date(job.startedAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'medium' })}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
