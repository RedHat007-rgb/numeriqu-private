"use client";

import React, { useState } from "react";
import { GlassCard } from "./GlassCard";
import { GlowButton } from "./GlowButton";

export const Pricing: React.FC = () => {
  const [isAnnual, setIsAnnual] = useState(true);

  const tiers = [
    {
      name: "Starter",
      price: "$0",
      description: "For founders evaluating Numeriqu",
      features: [
        "1 finance integration",
        "CFO overview dashboard",
        "RAG advisor (50 queries / mo)",
        "Email support",
      ],
      ctaLabel: "Start free",
      ctaHref: "/signup",
      highlighted: false,
    },
    {
      name: "Growth",
      price: isAnnual ? "$758" : "$79",
      period: isAnnual ? " / year" : " / month",
      description: "For finance teams running monthly close",
      features: [
        "Unlimited integrations",
        "Agent workbench + dashboards",
        "RAG advisor (unlimited)",
        "Per-org access controls",
        "Priority support",
      ],
      ctaLabel: "Start free trial",
      ctaHref: "/signup",
      highlighted: true,
    },
    {
      name: "Enterprise",
      price: "Custom",
      description: "Multi-entity finance with custom controls",
      features: [
        "Everything in Growth",
        "SSO + SCIM",
        "Custom integrations",
        "Dedicated success engineer",
        "SLA & data residency",
      ],
      ctaLabel: "Talk to sales",
      ctaHref: "mailto:hello@numeriqu.com?subject=Numeriqu%20Enterprise",
      highlighted: false,
    },
  ];

  return (
    <section id="pricing" className="mx-auto max-w-7xl px-6 py-24">
      <div className="mb-12 text-center">
        <h2 className="mb-4 text-text-primary">Simple, honest pricing</h2>
        <p className="text-lg text-text-secondary">Pick a plan that fits your team. Cancel any time.</p>

        <div className="mt-8 inline-flex items-center gap-3 rounded-full border border-default bg-bg-card/60 p-1.5 text-sm">
          <button
            type="button"
            onClick={() => setIsAnnual(false)}
            className={`rounded-full px-4 py-1.5 transition-colors ${
              !isAnnual ? "bg-accent-blue text-white" : "text-text-muted"
            }`}
            aria-pressed={!isAnnual}
          >
            Monthly
          </button>
          <button
            type="button"
            onClick={() => setIsAnnual(true)}
            className={`rounded-full px-4 py-1.5 transition-colors ${
              isAnnual ? "bg-accent-blue text-white" : "text-text-muted"
            }`}
            aria-pressed={isAnnual}
          >
            Annual <span className="ml-1 text-feedback-success">-20%</span>
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-8 md:grid-cols-3">
        {tiers.map((tier) => (
          <GlassCard
            key={tier.name}
            glowColor={tier.highlighted ? "blue" : "none"}
            className={`flex flex-col p-8 ${tier.highlighted ? "relative md:scale-[1.03]" : ""}`}
          >
            {tier.highlighted ? (
              <div className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-accent-blue px-4 py-1 text-xs font-bold uppercase tracking-wide text-white">
                Most popular
              </div>
            ) : null}

            <h3 className="mb-1 text-2xl font-bold text-text-primary">{tier.name}</h3>
            <p className="mb-6 text-sm text-text-muted">{tier.description}</p>

            <div className="mb-8">
              <span className="text-4xl font-bold text-text-primary">{tier.price}</span>
              {tier.period ? (
                <span className="text-sm text-text-muted">{tier.period}</span>
              ) : null}
            </div>

            <GlowButton
              variant={tier.highlighted ? "primary" : "ghost"}
              className="mb-8 w-full"
              href={tier.ctaHref}
            >
              {tier.ctaLabel}
            </GlowButton>

            <div className="flex-1 space-y-3">
              {tier.features.map((feature) => (
                <div key={feature} className="flex items-start gap-3">
                  <span className="mt-0.5 text-accent-cyan" aria-hidden>✓</span>
                  <span className="text-sm text-text-secondary">{feature}</span>
                </div>
              ))}
            </div>
          </GlassCard>
        ))}
      </div>
    </section>
  );
};
