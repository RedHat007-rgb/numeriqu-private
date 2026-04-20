"use client";

import React from "react";
import { GlassCard } from "./GlassCard";

export const Testimonials: React.FC = () => {
  const testimonials = [
    {
      name: "Sarah Chen",
      company: "FinTech Solutions Inc",
      quote:
        "Numeriqu reduced our financial analysis time by 70%. The RAG search finds insights we would have missed.",
      avatar: "SC",
    },
    {
      name: "Michael Rodriguez",
      company: "Global Capital Partners",
      quote:
        "Real-time dashboards transformed how we make decisions. Our profitability improved by 24%.",
      avatar: "MR",
    },
    {
      name: "Emma Watson",
      company: "Enterprise Financial Corp",
      quote:
        "The AI-driven insights are game-changing. We now identify cost leakages instantly.",
      avatar: "EW",
    },
    {
      name: "James Park",
      company: "Quantum Analytics Group",
      quote:
        "Data integration was seamless. Everything just works out of the box.",
      avatar: "JP",
    },
    {
      name: "Lisa Anderson",
      company: "Innovation Financial",
      quote:
        "Best investment in our finance operations. ROI was achieved in 3 months.",
      avatar: "LA",
    },
    {
      name: "David Thompson",
      company: "Strategic Capital",
      quote:
        "The platform scales beautifully across our global teams. Highly recommended.",
      avatar: "DT",
    },
  ];

  return (
    <section className="py-24 px-6">
      <div className="max-w-7xl mx-auto">
        <h2 className="text-4xl md:text-5xl font-bold mb-16 text-white text-center">
          Trusted by Leading Finance Teams
        </h2>

        {/* Infinite Marquee */}
        <div className="overflow-hidden">
          <div className="flex gap-6 animate-marquee">
            {[...testimonials, ...testimonials].map((testimonial, idx) => (
              <GlassCard
                key={idx}
                className="flex-shrink-0 w-80 p-6 hover:border-blue-400/60 transition-all"
              >
                <p className="text-text-muted mb-4 text-sm leading-relaxed">
                  "{testimonial.quote}"
                </p>
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-gradient-to-br from-blue-500 to-violet-600 flex items-center justify-center text-xs font-bold text-white">
                    {testimonial.avatar}
                  </div>
                  <div>
                    <p className="text-sm font-bold text-white">
                      {testimonial.name}
                    </p>
                    <p className="text-xs text-text-muted">
                      {testimonial.company}
                    </p>
                  </div>
                </div>
              </GlassCard>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
};
