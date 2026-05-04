"use client";

import React from "react";
import { GlowButton } from "./GlowButton";
import { Badge } from "./Badge";

const PARTICLE_COUNT = 16;

const AnimatedParticles: React.FC = () => {
  const particles = Array.from({ length: PARTICLE_COUNT }, (_, i) => i);

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
      {particles.map((particleId) => (
        <div key={particleId} className={`hero-particle hero-particle--${particleId}`} />
      ))}
    </div>
  );
};

const TRUST_POINTS = [
  { label: "Bank-grade encryption", detail: "AES-256 at rest, TLS in transit" },
  { label: "OAuth-only ingestion", detail: "Xero, QuickBooks, Workday, Dynamics" },
  { label: "Tenant-isolated data", detail: "Per-org Postgres + ClickHouse" },
];

export const HeroSection: React.FC = () => {
  return (
    <section className="relative flex min-h-[88vh] w-full items-center justify-center overflow-hidden pt-28 pb-16">
      <div className="absolute inset-0 bg-hero-luxury" aria-hidden />
      <div className="absolute inset-0 bg-dot-grid opacity-50" aria-hidden />

      <div
        className="hero-luxury-orb -right-24 -top-24 h-[34rem] w-[34rem] bg-[radial-gradient(circle,rgba(124,58,237,0.28)_0%,rgba(124,58,237,0.10)_28%,transparent_68%)]"
        aria-hidden
      />
      <div
        className="hero-luxury-orb -left-24 top-24 h-[28rem] w-[28rem] bg-[radial-gradient(circle,rgba(6,182,212,0.12)_0%,rgba(59,130,246,0.08)_30%,transparent_68%)]"
        aria-hidden
      />

      <AnimatedParticles />

      <div className="relative z-10 mx-auto max-w-5xl px-6 text-center">
        <div className="mb-7 flex justify-center animate-fade-in-up">
          <Badge variant="glow" pulse>
            ✦ RAG advisor + agent automations, in one calm surface
          </Badge>
        </div>

        <h1 className="mb-6 leading-tight animate-fade-in-up">
          <span className="text-text-primary">Turn your financial data</span>
          <br />
          <span className="gradient-text-blue-cyan">into clear decisions.</span>
        </h1>

        <p className="mx-auto mb-10 max-w-2xl text-lg leading-relaxed text-text-secondary animate-fade-in-up">
          Numeriqu unifies Xero, QuickBooks, and your accounting stack into a
          CFO-grade dashboard, then layers a retrieval-augmented advisor and
          autonomous analysis agent on top — so your team gets to answers,
          not just charts.
        </p>

        <div className="mb-12 flex flex-col items-center justify-center gap-3 sm:flex-row animate-fade-in-up">
          <GlowButton variant="primary" size="lg" href="/signup">
            Start free →
          </GlowButton>
          <GlowButton variant="ghost" size="lg" href="#platform">
            See the platform
          </GlowButton>
        </div>

        <div
          id="trust"
          className="mx-auto grid max-w-3xl grid-cols-1 gap-4 text-left sm:grid-cols-3 animate-fade-in-up"
        >
          {TRUST_POINTS.map((point) => (
            <div
              key={point.label}
              className="rounded-2xl border border-default bg-bg-card/60 p-4 backdrop-blur"
            >
              <p className="text-sm font-semibold text-text-primary">{point.label}</p>
              <p className="mt-1 text-xs text-text-muted">{point.detail}</p>
            </div>
          ))}
        </div>
      </div>

      <div
        className="pointer-events-none absolute bottom-0 left-0 right-0 h-32 bg-gradient-to-t from-bg-base to-transparent"
        aria-hidden
      />
    </section>
  );
};
