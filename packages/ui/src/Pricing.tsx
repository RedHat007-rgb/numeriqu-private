"use client";

import React, { useState } from "react";
import { GlassCard } from "./GlassCard";
import { GlowButton } from "./GlowButton";

export const Pricing: React.FC = () => {
  const [isAnnual, setIsAnnual] = useState(false);

  const tiers = [
    {
      name: "Free",
      price: "$0",
      description: "Get started with basics",
      features: [
        "1 data integration",
        "Basic dashboards",
        "5 users",
        "Community support",
      ],
      highlighted: false,
    },
    {
      name: "Pro",
      price: isAnnual ? "$758" : "$79",
      period: isAnnual ? "/year" : "/month",
      description: "Most Popular - Perfect for growing teams",
      features: [
        "Unlimited integrations",
        "Advanced analytics",
        "50 users",
        "Priority support",
        "RAG-powered search",
        "Scheduled reports",
      ],
      highlighted: true,
    },
    {
      name: "Enterprise",
      price: "Custom",
      description: "Advanced features for large organizations",
      features: [
        "Everything in Pro",
        "White-label platform",
        "Custom integrations",
        "Dedicated support",
        "SLA guarantee",
        "Advanced security",
      ],
      highlighted: false,
    },
  ];

  return (
    <section id="pricing" className="py-24 px-6 max-w-7xl mx-auto">
      <div className="text-center mb-16">
        <h2 className="text-4xl md:text-5xl font-bold mb-6 text-white">
          Simple, Transparent Pricing
        </h2>
        <p className="text-lg text-text-muted mb-8">
          Choose the perfect plan for your team
        </p>

        {/* Annual Toggle */}
        <div className="flex items-center justify-center gap-4 mb-12">
          <span
            className={`text-sm ${!isAnnual ? "text-white" : "text-text-muted"}`}
          >
            Monthly
          </span>
          <button
            onClick={() => setIsAnnual(!isAnnual)}
            className="relative inline-flex h-8 w-14 items-center rounded-full bg-slate-700 cursor-pointer transition-colors"
            title="Toggle between monthly and annual billing"
            aria-label={`Switch to ${isAnnual ? "monthly" : "annual"} billing`}
          >
            <span
              className={`inline-block h-6 w-6 transform rounded-full bg-white transition-transform ${
                isAnnual ? "translate-x-7" : "translate-x-1"
              }`}
              aria-hidden="true"
            />
          </button>
          <span
            className={`text-sm ${isAnnual ? "text-white" : "text-text-muted"}`}
          >
            Annual
          </span>
          {isAnnual && (
            <span className="ml-2 px-3 py-1 bg-green-500/20 border border-green-400/50 text-green-300 text-xs rounded-full">
              Save 20%
            </span>
          )}
        </div>
      </div>

      {/* Pricing Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
        {tiers.map((tier) => (
          <GlassCard
            key={tier.name}
            glowColor={tier.highlighted ? "blue" : "none"}
            className={`p-8 flex flex-col ${tier.highlighted ? "md:scale-105 relative z-10" : ""}`}
          >
            {tier.highlighted && (
              <div className="absolute -top-4 left-1/2 transform -translate-x-1/2 px-4 py-1 bg-blue-500 text-white text-xs font-bold rounded-full">
                MOST POPULAR
              </div>
            )}

            <h3 className="text-2xl font-bold mb-2 text-white">{tier.name}</h3>
            <p className="text-sm text-text-muted mb-6">{tier.description}</p>

            <div className="mb-8">
              <span className="text-4xl font-bold text-white">
                {tier.price}
              </span>
              {tier.period && (
                <span className="text-sm text-text-muted">{tier.period}</span>
              )}
            </div>

            <GlowButton
              variant={tier.highlighted ? "primary" : "ghost"}
              className="mb-8 w-full"
            >
              Get Started
            </GlowButton>

            <div className="space-y-4 flex-1">
              {tier.features.map((feature) => (
                <div key={feature} className="flex items-start gap-3">
                  <span className="text-cyan-400 mt-1">✓</span>
                  <span className="text-sm text-text-primary">{feature}</span>
                </div>
              ))}
            </div>
          </GlassCard>
        ))}
      </div>
    </section>
  );
};
