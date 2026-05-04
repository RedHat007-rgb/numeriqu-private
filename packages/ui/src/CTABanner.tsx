"use client";

import React from "react";
import { GlowButton } from "./GlowButton";

export const CTABanner: React.FC = () => {
  return (
    <section className="px-6 py-24">
      <div className="relative mx-auto max-w-5xl">
        <div className="absolute inset-0 rounded-3xl bg-gradient-to-r from-accent-blue/15 to-accent-violet/15 blur-3xl" aria-hidden />

        <div className="relative z-10 rounded-3xl border border-default bg-bg-card/85 p-12 text-center backdrop-blur-xl">
          <h2 className="mb-5 text-text-primary">
            Ready to make finance feel{" "}
            <span className="gradient-text-blue-cyan">calm and decisive?</span>
          </h2>
          <p className="mx-auto mb-10 max-w-2xl text-lg text-text-secondary">
            Plug in your accounting stack, and within minutes Numeriqu surfaces
            what changed, what matters, and what to do next — backed by your
            own data.
          </p>
          <div className="flex flex-col items-center justify-center gap-4 sm:flex-row">
            <GlowButton variant="primary" size="lg" href="/signup">
              Start free →
            </GlowButton>
            <GlowButton variant="ghost" size="lg" href="mailto:hello@numeriqu.com?subject=Numeriqu%20demo">
              Book a demo
            </GlowButton>
          </div>
        </div>
      </div>
    </section>
  );
};
