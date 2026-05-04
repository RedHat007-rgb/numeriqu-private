"use client";

import React from "react";
import { GlassCard } from "./GlassCard";

type WorkflowCard = {
  role: string;
  title: string;
  description: string;
  steps: string[];
};

const WORKFLOWS: WorkflowCard[] = [
  {
    role: "For CFOs",
    title: "Monthly close in one calm view",
    description:
      "Trust your numbers across Xero, QuickBooks, and Workday — with anomalies and exceptions surfaced before the board call.",
    steps: [
      "Connect accounting in OAuth-only flow",
      "Numeriqu reconciles tenants and currencies",
      "RAG advisor explains drivers per metric",
    ],
  },
  {
    role: "For Controllers",
    title: "Faster diligence on invoice variance",
    description:
      "Drill from a KPI tile into invoice-level detail in two clicks. The advisor cites which sync run produced each number.",
    steps: [
      "Search across consolidated invoices",
      "Spot overdue and variance instantly",
      "Export reconciled views to your team",
    ],
  },
  {
    role: "For Finance Ops",
    title: "Hands-off ingestion, every day",
    description:
      "Sync jobs run quietly in the background. When a connector fails, you get a calm, specific message with a single recovery action.",
    steps: [
      "Job-driven incremental syncs",
      "Per-connector health and retries",
      "Audit timeline on every record",
    ],
  },
];

export const Testimonials: React.FC = () => {
  return (
    <section className="px-6 py-24">
      <div className="mx-auto max-w-7xl">
        <div className="mb-12 text-center">
          <h2 className="mb-3 text-text-primary">Built for the way finance actually works</h2>
          <p className="mx-auto max-w-2xl text-lg text-text-secondary">
            Numeriqu adapts to the role you sit in — without forcing rigid templates.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
          {WORKFLOWS.map((workflow) => (
            <GlassCard
              key={workflow.title}
              className="flex h-full flex-col p-6 transition-transform hover:-translate-y-1"
            >
              <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-accent-blue">
                {workflow.role}
              </p>
              <h3 className="mt-3 text-xl font-bold text-text-primary">{workflow.title}</h3>
              <p className="mt-3 text-sm text-text-secondary">{workflow.description}</p>
              <ol className="mt-5 space-y-2 text-sm text-text-secondary">
                {workflow.steps.map((step, index) => (
                  <li key={step} className="flex items-start gap-3">
                    <span
                      aria-hidden
                      className="mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-accent-blue/15 text-[11px] font-bold text-accent-blue"
                    >
                      {index + 1}
                    </span>
                    <span>{step}</span>
                  </li>
                ))}
              </ol>
            </GlassCard>
          ))}
        </div>
      </div>
    </section>
  );
};
