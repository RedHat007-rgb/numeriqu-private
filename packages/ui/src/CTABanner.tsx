"use client";

import React from "react";
import { GlowButton } from "./GlowButton";

export const CTABanner: React.FC = () => {
  return (
    <section className="py-24 px-6">
      <div className="max-w-5xl mx-auto relative">
        {/* Background */}
        <div className="absolute inset-0 bg-gradient-to-r from-blue-600/20 to-violet-600/20 rounded-2xl blur-3xl" />

        {/* Content */}
        <div className="relative z-10 bg-gradient-to-r from-slate-900/90 to-slate-800/90 rounded-2xl border border-blue-400/20 p-12 text-center backdrop-blur-xl">
          <h2 className="text-4xl md:text-5xl font-bold mb-6 text-white">
            The future of analytics is conversational.
          </h2>
          <p className="text-lg text-text-muted mb-10 max-w-2xl mx-auto">
            Join 2,400+ finance teams using Numeriqu to make faster, smarter
            decisions with AI-driven insights from their data.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <GlowButton variant="primary" size="lg" href="/dashboard">
              Start for Free →
            </GlowButton>
            <GlowButton variant="ghost" size="lg">
              Schedule Demo
            </GlowButton>
          </div>
        </div>
      </div>
    </section>
  );
};
