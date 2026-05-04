"use client";

import React from "react";
import { GlassCard } from "./GlassCard";

export const InsightsChatbot: React.FC = () => {
  return (
    <section id="rag" className="mx-auto max-w-7xl px-6 py-24">
      <div className="grid grid-cols-1 items-center gap-12 md:grid-cols-2">
        <div>
          <p className="mb-4 font-mono text-xs uppercase tracking-[0.28em] text-accent-blue">
            RAG Advisor
          </p>
          <h2 className="mb-6 text-text-primary">Ask your finance data anything</h2>
          <p className="mb-8 text-lg leading-relaxed text-text-secondary">
            Numeriqu&apos;s retrieval-augmented advisor reads your synced
            invoices, ledgers, and reports — then answers in plain English with
            sources you can verify in one click.
          </p>

          <div className="flex flex-wrap gap-3">
            {[
              "Source-cited answers",
              "Tenant-isolated retrieval",
              "Streaming responses",
            ].map((feature) => (
              <div
                key={feature}
                className="rounded-full border border-accent-blue/30 bg-accent-blue/10 px-4 py-2 text-sm text-accent-blue"
              >
                ✓ {feature}
              </div>
            ))}
          </div>
        </div>

        <GlassCard glowColor="blue" className="p-6">
          <div className="space-y-4">
            <div className="text-sm text-text-muted">
              💬 Advisor:{" "}
              <span className="text-accent-blue">Connected to Acme Inc · last sync 4m ago</span>
            </div>

            <div className="rounded-xl bg-accent-blue/10 p-4 text-right ring-1 ring-accent-blue/20">
              <p className="text-sm text-text-primary">
                What drove the revenue spike in Q3?
              </p>
            </div>

            <div className="rounded-xl border border-accent-violet/20 bg-accent-violet/10 p-4">
              <p className="text-sm leading-relaxed text-text-primary">
                Three factors explain the +24% Q3 lift:
                <br />
                <br />
                • Two enterprise renewals shipped early (+$1.2M)
                <br />
                • Seasonal demand for Plan B SKUs (+18% units)
                <br />
                • One-time consulting revenue from Acme East (+$340K)
                <span className="animate-blink">|</span>
              </p>
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              {["Q3_Close.pdf", "Invoices_2026Q3.csv", "Plan_B_Demand.xlsx"].map((source) => (
                <div
                  key={source}
                  className="rounded border border-accent-cyan/30 bg-accent-cyan/10 px-2 py-1 text-xs text-accent-cyan"
                >
                  {source}
                </div>
              ))}
            </div>

            <div className="mt-6 flex gap-2 border-t border-default pt-4">
              <input
                type="text"
                placeholder="Ask another question..."
                aria-label="Sample advisor input"
                className="flex-1 rounded-md border border-default bg-bg-elevated/40 px-3 py-2 text-sm text-text-primary placeholder:text-text-muted outline-none"
              />
              <button
                aria-label="Send (preview only)"
                className="rounded-md bg-accent-blue px-4 py-2 text-sm font-medium text-white hover:bg-accent-blue/80"
              >
                ↑
              </button>
            </div>
          </div>
        </GlassCard>
      </div>
    </section>
  );
};
