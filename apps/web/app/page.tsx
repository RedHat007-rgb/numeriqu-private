"use client";

import Link from "next/link";
import { Suspense, useEffect, useRef, useState } from "react";
import { ParticleHero } from "./_components/landing/ParticleHero";
import { MagneticButton } from "./_components/landing/MagneticButton";
import { CountUp } from "./_components/landing/CountUp";

/* ─── Navbar ─────────────────────────────────────────────── */
function Navbar() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 20);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={`fixed top-0 left-0 right-0 z-50 transition-all duration-500 ${
        scrolled
          ? "bg-ink/80 backdrop-blur-xl border-b border-white/[0.06] shadow-glass"
          : "bg-transparent"
      }`}
    >
      <nav className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2.5 group">
          <div className="w-7 h-7 rounded-lg bg-accent flex items-center justify-center shadow-glow-blue group-hover:scale-110 transition-transform duration-300">
            <svg viewBox="0 0 24 24" fill="none" className="w-4 h-4 text-white" aria-hidden>
              <path d="M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z" fill="currentColor" />
            </svg>
          </div>
          <span className="font-display font-semibold text-text-primary tracking-tight">NumeriQu</span>
        </Link>

        <div className="hidden md:flex items-center gap-8">
          {["Features", "How it works", "Pricing"].map((item) => (
            <a
              key={item}
              href={`#${item.toLowerCase().replace(/\s+/g, "-")}`}
              className="text-sm text-text-secondary hover:text-text-primary transition-colors duration-200"
            >
              {item}
            </a>
          ))}
        </div>

        <div className="flex items-center gap-3">
          <Link
            href="/login"
            className="hidden md:block text-sm text-text-secondary hover:text-text-primary transition-colors duration-200 px-4 py-2"
          >
            Sign in
          </Link>
          <MagneticButton
            href="/signup"
            className="px-5 py-2.5 rounded-lg bg-accent hover:bg-accent-glow text-white text-sm font-medium shadow-glow-blue/50 transition-all duration-300 hover:shadow-glow-blue"
          >
            Get started free
          </MagneticButton>
        </div>
      </nav>
    </header>
  );
}

/* ─── Hero ────────────────────────────────────────────────── */
function HeroSection() {
  return (
    <section className="relative min-h-screen flex flex-col items-center justify-center px-6 pt-24 pb-16 overflow-hidden bg-gradient-hero">
      <Suspense fallback={null}>
        <ParticleHero />
      </Suspense>

      {/* Background glows */}
      <div className="absolute top-1/3 left-1/4 w-[600px] h-[600px] bg-accent/10 rounded-full blur-[120px] pointer-events-none" />
      <div className="absolute bottom-1/4 right-1/4 w-[400px] h-[400px] bg-accent-violet/8 rounded-full blur-[100px] pointer-events-none" />

      <div className="relative z-10 max-w-5xl mx-auto text-center">
        <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border border-accent/30 bg-accent/5 backdrop-blur-sm mb-8">
          <span className="w-1.5 h-1.5 rounded-full bg-accent-emerald animate-pulse-subtle" />
          <span className="text-xs text-accent-glow font-medium tracking-wide">Now in private beta · 200+ finance teams</span>
        </div>

        <h1 className="text-5xl md:text-7xl font-display font-bold text-text-primary leading-[1.05] tracking-tight mb-6">
          Strategic clarity{" "}
          <span className="font-serif italic text-transparent bg-clip-text bg-gradient-to-r from-accent-glow to-accent-cyan">
            from every
          </span>
          <br />
          data source you own
        </h1>

        <p className="max-w-2xl mx-auto text-lg md:text-xl text-text-secondary leading-relaxed mb-12">
          NumeriQu connects your entire financial stack — ERP, CRM, spreadsheets — into a single live intelligence layer.
          Ask questions in plain English. Get answers your CFO can act on.
        </p>

        <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
          <MagneticButton
            href="/signup"
            className="group relative px-8 py-4 rounded-xl bg-accent hover:bg-accent-glow text-white font-semibold text-base shadow-glow-blue transition-all duration-300 hover:shadow-[0_0_40px_rgba(37,99,235,0.6)] hover:scale-[1.02]"
          >
            <span className="relative z-10">Start for free</span>
            <div className="absolute inset-0 rounded-xl bg-gradient-to-r from-accent to-accent-glow opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
          </MagneticButton>

          <MagneticButton
            href="#how-it-works"
            className="px-8 py-4 rounded-xl border border-white/10 hover:border-white/20 bg-white/5 hover:bg-white/8 text-text-primary font-medium text-base backdrop-blur-sm transition-all duration-300"
          >
            See how it works
          </MagneticButton>
        </div>

        {/* Social proof strip */}
        <div className="mt-20 grid grid-cols-3 gap-px bg-white/5 rounded-2xl overflow-hidden max-w-2xl mx-auto border border-white/[0.07]">
          {[
            { value: 98, suffix: "%", label: "faster reporting" },
            { value: 2.4, suffix: "M+", label: "data points / day", decimals: 1 },
            { value: 40, suffix: "%", label: "hidden leakage found" },
          ].map(({ value, suffix, label, decimals = 0 }) => (
            <div key={label} className="flex flex-col items-center py-6 px-4 bg-ink/60">
              <span className="text-3xl font-display font-bold text-text-primary">
                <CountUp end={value} suffix={suffix} decimals={decimals} />
              </span>
              <span className="text-xs text-text-muted mt-1 tracking-wide">{label}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ─── Problem Section ─────────────────────────────────────── */
function ProblemSection() {
  const problems = [
    {
      icon: (
        <svg viewBox="0 0 24 24" fill="none" className="w-5 h-5" aria-hidden>
          <path d="M4 6a2 2 0 012-2h12a2 2 0 012 2v7a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" stroke="currentColor" strokeWidth="1.5" />
          <path d="M2 15l4-4 4 4 4-4 4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      ),
      title: "Data lives in silos",
      body: "QuickBooks, Salesforce, Notion, and 14 spreadsheets — none of them talk to each other. Your team wastes Monday mornings reconciling numbers that should be automatic.",
      accent: "accent-rose",
    },
    {
      icon: (
        <svg viewBox="0 0 24 24" fill="none" className="w-5 h-5" aria-hidden>
          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.5" />
          <path d="M12 7v5l3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      ),
      title: "Reports are always stale",
      body: "By the time your board deck is ready, the numbers are three days old. Strategic decisions get made on yesterday's reality — not today's.",
      accent: "accent-gold",
    },
    {
      icon: (
        <svg viewBox="0 0 24 24" fill="none" className="w-5 h-5" aria-hidden>
          <path d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      ),
      title: "Leakage stays hidden",
      body: "Duplicate subscriptions, unused licenses, margin erosion buried in line items — you know it's there. You just can't see it until the quarter closes.",
      accent: "accent-violet",
    },
  ];

  return (
    <section className="relative py-32 px-6 bg-ink" id="features">
      <div className="max-w-7xl mx-auto">
        <div className="text-center mb-16">
          <p className="text-sm font-medium text-accent-glow tracking-widest uppercase mb-4">The problem</p>
          <h2 className="text-4xl md:text-5xl font-display font-bold text-text-primary leading-tight">
            Your financial data is{" "}
            <span className="font-serif italic text-text-secondary">working against you</span>
          </h2>
        </div>

        <div className="grid md:grid-cols-3 gap-6">
          {problems.map(({ icon, title, body, accent }) => (
            <div
              key={title}
              className="group relative p-8 rounded-2xl bg-surface border border-white/[0.06] hover:border-white/[0.12] transition-all duration-500 hover:shadow-glass-heavy overflow-hidden"
            >
              <div className={`w-10 h-10 rounded-xl bg-${accent}/10 flex items-center justify-center text-${accent} mb-6 group-hover:scale-110 transition-transform duration-300`}>
                {icon}
              </div>
              <h3 className="text-lg font-semibold text-text-primary mb-3">{title}</h3>
              <p className="text-sm text-text-secondary leading-relaxed">{body}</p>
              <div className={`absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-${accent}/40 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500`} />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ─── Solution / How it works ─────────────────────────────── */
function SolutionSection() {
  const steps = [
    {
      number: "01",
      title: "Connect your stack",
      body: "OAuth integrations with QuickBooks, Xero, Salesforce, HubSpot, NetSuite, and more. Plus CSV/Excel upload for anything else.",
    },
    {
      number: "02",
      title: "Your data unifies instantly",
      body: "NumeriQu normalises and joins your datasets into a single semantic layer. No ETL pipelines. No data engineering team required.",
    },
    {
      number: "03",
      title: "Ask. Explore. Decide.",
      body: "Ask questions in plain English. Get live charts, anomaly alerts, and executive summaries — powered by your own data.",
    },
  ];

  return (
    <section className="relative py-32 px-6 bg-gradient-to-b from-ink to-void" id="how-it-works">
      <div className="max-w-7xl mx-auto">
        <div className="grid lg:grid-cols-2 gap-16 items-center">
          <div>
            <p className="text-sm font-medium text-accent-glow tracking-widest uppercase mb-4">How it works</p>
            <h2 className="text-4xl md:text-5xl font-display font-bold text-text-primary leading-tight mb-8">
              From raw data to{" "}
              <span className="font-serif italic">boardroom clarity</span>
              <br />
              in minutes
            </h2>

            <div className="space-y-8">
              {steps.map(({ number, title, body }) => (
                <div key={number} className="flex gap-5 group">
                  <div className="flex-shrink-0 w-10 h-10 rounded-full border border-accent/30 bg-accent/5 flex items-center justify-center text-xs font-mono font-bold text-accent group-hover:border-accent/60 group-hover:bg-accent/10 transition-all duration-300">
                    {number}
                  </div>
                  <div>
                    <h3 className="text-base font-semibold text-text-primary mb-1">{title}</h3>
                    <p className="text-sm text-text-secondary leading-relaxed">{body}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Dashboard mockup */}
          <div className="relative">
            <div className="absolute inset-0 bg-accent/5 rounded-3xl blur-3xl" />
            <div className="relative rounded-2xl border border-white/[0.08] bg-surface overflow-hidden shadow-glass-heavy">
              {/* Fake window chrome */}
              <div className="flex items-center gap-2 px-4 py-3 border-b border-white/[0.06] bg-panel/50">
                <div className="w-3 h-3 rounded-full bg-accent-rose/60" />
                <div className="w-3 h-3 rounded-full bg-accent-gold/60" />
                <div className="w-3 h-3 rounded-full bg-accent-emerald/60" />
                <div className="flex-1 mx-4 h-5 rounded bg-white/[0.04] flex items-center px-3">
                  <span className="text-[10px] text-text-muted font-mono">app.numeriqu.com/dashboard</span>
                </div>
              </div>

              <div className="p-6 space-y-4">
                {/* KPI row */}
                <div className="grid grid-cols-3 gap-3">
                  {[
                    { label: "MRR", value: "$284K", change: "+12.4%" },
                    { label: "Burn Rate", value: "$31K", change: "-8.2%" },
                    { label: "Runway", value: "18 mo", change: "+2 mo" },
                  ].map(({ label, value, change }) => (
                    <div key={label} className="rounded-xl bg-panel p-3 border border-white/[0.05]">
                      <p className="text-[10px] text-text-muted mb-1">{label}</p>
                      <p className="text-lg font-mono font-bold text-text-primary">{value}</p>
                      <p className="text-[10px] text-accent-emerald">{change}</p>
                    </div>
                  ))}
                </div>

                {/* Chart placeholder */}
                <div className="rounded-xl bg-panel border border-white/[0.05] h-32 relative overflow-hidden">
                  <svg viewBox="0 0 400 120" className="w-full h-full opacity-60" preserveAspectRatio="none">
                    <defs>
                      <linearGradient id="chartGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#2563EB" stopOpacity="0.4" />
                        <stop offset="100%" stopColor="#2563EB" stopOpacity="0" />
                      </linearGradient>
                    </defs>
                    <path d="M0,100 C40,90 60,60 100,55 C140,50 160,70 200,45 C240,20 260,30 300,20 C340,10 360,25 400,15 L400,120 L0,120 Z" fill="url(#chartGrad)" />
                    <path d="M0,100 C40,90 60,60 100,55 C140,50 160,70 200,45 C240,20 260,30 300,20 C340,10 360,25 400,15" fill="none" stroke="#3B82F6" strokeWidth="2" />
                  </svg>
                </div>

                {/* AI chat bubble */}
                <div className="rounded-xl bg-accent/5 border border-accent/20 p-3 flex gap-3">
                  <div className="w-6 h-6 rounded-full bg-accent flex items-center justify-center flex-shrink-0">
                    <span className="text-[10px] text-white font-bold">AI</span>
                  </div>
                  <p className="text-xs text-text-secondary leading-relaxed">
                    <span className="text-text-primary font-medium">Heads up:</span> Your SaaS subscriptions increased by $4,200 this month — 3 unused licenses detected in your Salesforce account.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ─── Stats Section ───────────────────────────────────────── */
function StatsSection() {
  const stats = [
    { value: 98, suffix: "%", label: "Faster reporting cycles", caption: "vs manual processes" },
    { value: 40, suffix: "%", label: "Average cost leakage found", caption: "in first 30 days" },
    { value: 2.4, suffix: "M+", label: "Data points processed daily", caption: "across all integrations", decimals: 1 },
    { value: 200, suffix: "+", label: "Finance teams trust NumeriQu", caption: "from seed to Series C" },
  ];

  return (
    <section className="py-24 px-6 bg-void border-y border-white/[0.04]">
      <div className="max-w-7xl mx-auto grid sm:grid-cols-2 lg:grid-cols-4 gap-8">
        {stats.map(({ value, suffix, label, caption, decimals = 0 }) => (
          <div key={label} className="text-center">
            <div className="text-5xl md:text-6xl font-display font-bold text-text-primary mb-2">
              <CountUp end={value} suffix={suffix} decimals={decimals} />
            </div>
            <p className="text-sm font-medium text-text-secondary">{label}</p>
            <p className="text-xs text-text-muted mt-1">{caption}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ─── Features Bento ──────────────────────────────────────── */
function FeaturesSection() {
  return (
    <section className="py-32 px-6 bg-ink" id="features-detail">
      <div className="max-w-7xl mx-auto">
        <div className="text-center mb-16">
          <p className="text-sm font-medium text-accent-glow tracking-widest uppercase mb-4">The platform</p>
          <h2 className="text-4xl md:text-5xl font-display font-bold text-text-primary">
            Everything your finance team needs,{" "}
            <span className="font-serif italic text-text-secondary">nothing they don&apos;t</span>
          </h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {/* Large card */}
          <div className="lg:col-span-2 group relative p-8 rounded-2xl bg-surface border border-white/[0.06] hover:border-accent/20 transition-all duration-500 overflow-hidden">
            <div className="absolute top-0 right-0 w-64 h-64 bg-accent/5 rounded-full blur-3xl group-hover:bg-accent/10 transition-colors duration-700" />
            <div className="relative">
              <div className="w-10 h-10 rounded-xl bg-accent/10 flex items-center justify-center text-accent mb-6">
                <svg viewBox="0 0 24 24" fill="none" className="w-5 h-5" aria-hidden>
                  <path d="M9 3H5a2 2 0 00-2 2v4m6-6h10a2 2 0 012 2v4M9 3v18m0 0h10a2 2 0 002-2V9M9 21H5a2 2 0 01-2-2V9m0 0h18" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </div>
              <h3 className="text-xl font-semibold text-text-primary mb-3">Live unified dashboard</h3>
              <p className="text-text-secondary leading-relaxed mb-6">
                One source of truth, updated in real time. Every integration feeds into a single live view — no manual exports, no version conflicts.
              </p>
              <div className="flex flex-wrap gap-2">
                {["QuickBooks", "Xero", "Salesforce", "HubSpot", "NetSuite", "CSV/Excel"].map((tag) => (
                  <span key={tag} className="px-3 py-1 rounded-full text-xs border border-white/[0.08] bg-white/[0.03] text-text-secondary">{tag}</span>
                ))}
              </div>
            </div>
          </div>

          {/* RAG chat card */}
          <div className="group relative p-8 rounded-2xl bg-surface border border-white/[0.06] hover:border-accent-violet/20 transition-all duration-500 overflow-hidden">
            <div className="absolute bottom-0 left-0 w-48 h-48 bg-accent-violet/5 rounded-full blur-3xl group-hover:bg-accent-violet/10 transition-colors duration-700" />
            <div className="relative">
              <div className="w-10 h-10 rounded-xl bg-accent-violet/10 flex items-center justify-center text-accent-violet mb-6">
                <svg viewBox="0 0 24 24" fill="none" className="w-5 h-5" aria-hidden>
                  <path d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </div>
              <h3 className="text-xl font-semibold text-text-primary mb-3">Ask your data anything</h3>
              <p className="text-sm text-text-secondary leading-relaxed">
                RAG-powered chat over your organisation&apos;s financials. Ask &ldquo;What drove the Q3 margin drop?&rdquo; and get a sourced answer instantly.
              </p>
            </div>
          </div>

          {/* AI agent card */}
          <div className="group relative p-8 rounded-2xl bg-surface border border-white/[0.06] hover:border-accent-cyan/20 transition-all duration-500 overflow-hidden">
            <div className="absolute top-0 right-0 w-40 h-40 bg-accent-cyan/5 rounded-full blur-3xl group-hover:bg-accent-cyan/10 transition-colors duration-700" />
            <div className="relative">
              <div className="w-10 h-10 rounded-xl bg-accent-cyan/10 flex items-center justify-center text-accent-cyan mb-6">
                <svg viewBox="0 0 24 24" fill="none" className="w-5 h-5" aria-hidden>
                  <path d="M13 10V3L4 14h7v7l9-11h-7z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>
              <h3 className="text-xl font-semibold text-text-primary mb-3">Live AI agent</h3>
              <p className="text-sm text-text-secondary leading-relaxed">
                Describe the dashboard you need. The agent builds it live — charts, KPIs, and all — using real-time data from your connected sources.
              </p>
            </div>
          </div>

          {/* Role management card */}
          <div className="group relative p-8 rounded-2xl bg-surface border border-white/[0.06] hover:border-accent-emerald/20 transition-all duration-500 overflow-hidden">
            <div className="absolute bottom-0 right-0 w-48 h-48 bg-accent-emerald/5 rounded-full blur-3xl group-hover:bg-accent-emerald/10 transition-colors duration-700" />
            <div className="relative">
              <div className="w-10 h-10 rounded-xl bg-accent-emerald/10 flex items-center justify-center text-accent-emerald mb-6">
                <svg viewBox="0 0 24 24" fill="none" className="w-5 h-5" aria-hidden>
                  <path d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </div>
              <h3 className="text-xl font-semibold text-text-primary mb-3">Role-based access</h3>
              <p className="text-sm text-text-secondary leading-relaxed">
                Admins control exactly which team members see which data sources. Share dashboards selectively — your board sees what the board needs.
              </p>
            </div>
          </div>

          {/* Anomaly card */}
          <div className="group relative p-8 rounded-2xl bg-surface border border-white/[0.06] hover:border-accent-gold/20 transition-all duration-500 overflow-hidden">
            <div className="absolute top-0 left-0 w-40 h-40 bg-accent-gold/5 rounded-full blur-3xl group-hover:bg-accent-gold/10 transition-colors duration-700" />
            <div className="relative">
              <div className="w-10 h-10 rounded-xl bg-accent-gold/10 flex items-center justify-center text-accent-gold mb-6">
                <svg viewBox="0 0 24 24" fill="none" className="w-5 h-5" aria-hidden>
                  <path d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </div>
              <h3 className="text-xl font-semibold text-text-primary mb-3">Anomaly alerts</h3>
              <p className="text-sm text-text-secondary leading-relaxed">
                NumeriQu watches for unusual spends, margin shifts, and budget overruns — and alerts you before they become problems.
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ─── CTA Section ─────────────────────────────────────────── */
function CTASection() {
  return (
    <section className="relative py-32 px-6 overflow-hidden bg-void">
      <div className="absolute inset-0 bg-gradient-hero opacity-60" />
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[400px] bg-accent/10 rounded-full blur-[120px] pointer-events-none" />

      <div className="relative z-10 max-w-3xl mx-auto text-center">
        <h2 className="text-4xl md:text-6xl font-display font-bold text-text-primary leading-tight mb-6">
          Your CFO&apos;s next decision
          <br />
          <span className="font-serif italic text-transparent bg-clip-text bg-gradient-to-r from-accent-glow to-accent-cyan">
            deserves live data
          </span>
        </h2>
        <p className="text-lg text-text-secondary mb-10 max-w-xl mx-auto">
          Join 200+ finance teams who moved from manual reports to real-time intelligence. Set up takes under 10 minutes.
        </p>

        <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
          <MagneticButton
            href="/signup"
            className="px-10 py-4 rounded-xl bg-accent hover:bg-accent-glow text-white font-semibold text-base shadow-glow-blue transition-all duration-300 hover:shadow-[0_0_50px_rgba(37,99,235,0.7)] hover:scale-[1.03]"
          >
            Get started — it&apos;s free
          </MagneticButton>
          <p className="text-sm text-text-muted">No credit card required · SOC 2 compliant</p>
        </div>
      </div>
    </section>
  );
}

/* ─── Footer ──────────────────────────────────────────────── */
function Footer() {
  return (
    <footer className="bg-ink border-t border-white/[0.04] py-16 px-6">
      <div className="max-w-7xl mx-auto">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-8 mb-12">
          <div className="col-span-2 md:col-span-1">
            <div className="flex items-center gap-2.5 mb-4">
              <div className="w-7 h-7 rounded-lg bg-accent flex items-center justify-center">
                <svg viewBox="0 0 24 24" fill="none" className="w-4 h-4 text-white" aria-hidden>
                  <path d="M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z" fill="currentColor" />
                </svg>
              </div>
              <span className="font-display font-semibold text-text-primary">NumeriQu</span>
            </div>
            <p className="text-sm text-text-muted leading-relaxed">
              Strategic financial intelligence for modern CFOs and finance teams.
            </p>
          </div>

          {[
            { heading: "Product", links: ["Features", "Integrations", "Pricing", "Changelog"] },
            { heading: "Company", links: ["About", "Blog", "Careers", "Contact"] },
            { heading: "Legal", links: ["Privacy", "Terms", "Security", "SOC 2"] },
          ].map(({ heading, links }) => (
            <div key={heading}>
              <p className="text-xs font-semibold text-text-secondary uppercase tracking-widest mb-4">{heading}</p>
              <ul className="space-y-2.5">
                {links.map((link) => (
                  <li key={link}>
                    <a href="#" className="text-sm text-text-muted hover:text-text-secondary transition-colors duration-200">
                      {link}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="flex flex-col sm:flex-row items-center justify-between pt-8 border-t border-white/[0.04] gap-4">
          <p className="text-xs text-text-muted">© 2025 NumeriQu. All rights reserved.</p>
          <p className="text-xs text-text-muted">Built for the world&apos;s most ambitious finance teams.</p>
        </div>
      </div>
    </footer>
  );
}

/* ─── Page ────────────────────────────────────────────────── */
export default function Home() {
  return (
    <main className="w-full overflow-x-hidden bg-void text-text-primary">
      <Navbar />
      <HeroSection />
      <ProblemSection />
      <SolutionSection />
      <StatsSection />
      <FeaturesSection />
      <CTASection />
      <Footer />
    </main>
  );
}
