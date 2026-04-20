"use client";

import React from "react";
import { GlowButton } from "./GlowButton";
import { Badge } from "./Badge";
import { AnimatedCounter } from "./AnimatedCounter";

const PARTICLE_COUNT = 20;

const AnimatedParticles: React.FC = () => {
  const particles = Array.from({ length: PARTICLE_COUNT }, (_, i) => i);

  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none">
      {particles.map((particleId) => (
        <div
          key={particleId}
          className={`hero-particle hero-particle--${particleId}`}
        />
      ))}
    </div>
  );
};

export const HeroSection: React.FC = () => {
  return (
    <section className="relative min-h-screen w-full overflow-hidden flex items-center justify-center pt-20">
      {/* Background Layers */}
      <div className="absolute inset-0 bg-hero-luxury" />
      <div className="absolute inset-0 bg-dot-grid" />

      {/* Ambient Luxury Orbs */}
      <div className="absolute -top-24 -right-24 h-[34rem] w-[34rem] rounded-full bg-[radial-gradient(circle,rgba(124,58,237,0.28)_0%,rgba(124,58,237,0.10)_28%,transparent_68%)] blur-3xl pointer-events-none" />
      <div className="absolute top-24 -left-24 h-[28rem] w-[28rem] rounded-full bg-[radial-gradient(circle,rgba(6,182,212,0.12)_0%,rgba(59,130,246,0.08)_30%,transparent_68%)] blur-3xl pointer-events-none" />
      <div className="absolute inset-x-0 top-0 h-56 bg-[linear-gradient(180deg,rgba(255,255,255,0.08)_0%,rgba(255,255,255,0.02)_30%,transparent_100%)] opacity-35 pointer-events-none" />

      {/* Animated Particles */}
      <AnimatedParticles />

      {/* Content */}
      <div className="relative z-10 max-w-5xl mx-auto px-6 text-center">
        {/* Eyebrow Badge */}
        <div className="mb-8 flex justify-center">
          <Badge variant="glow" pulse>
            ✦ Now Powered by RAG + GPT-4o
          </Badge>
        </div>

        {/* Main Headline */}
        <h1 className="mb-6 leading-tight">
          <span className="text-white">Unlock Intelligence</span>
          <br />
          <span className="gradient-text-blue-cyan">Hidden in Your Data.</span>
        </h1>

        {/* Subheadline */}
        <p className="text-lg text-text-muted max-w-2xl mx-auto mb-12 leading-relaxed">
          Numeriqu combines Retrieval-Augmented Generation with real-time
          financial analytics to surface insights your team would otherwise miss
          — in seconds. Transform financial complexity into strategic clarity
          with AI-driven intelligence.
        </p>

        {/* CTA Row */}
        <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-16">
          <GlowButton variant="primary" size="lg" href="/dashboard">
            Start Analyzing Free →
          </GlowButton>
          <GlowButton variant="ghost" size="lg" icon="▶">
            Watch Demo
          </GlowButton>
        </div>

        {/* Platform Badge */}
        <div className="flex justify-center mb-16">
          <Badge variant="mono">
            RAG · LLM · Real-Time · Financial Analytics
          </Badge>
        </div>

        {/* Stats Row */}
        <div className="grid grid-cols-3 gap-8 max-w-2xl mx-auto">
          <AnimatedCounter value="2.4K+" label="Data Teams" />
          <AnimatedCounter value="99.7%" label="Uptime" />
          <AnimatedCounter value="<2s" label="Query Response" />
        </div>
      </div>

      {/* Bottom Gradient Fade */}
      <div className="absolute bottom-0 left-0 right-0 h-32 bg-gradient-to-t from-slate-900 to-transparent pointer-events-none" />
    </section>
  );
};
