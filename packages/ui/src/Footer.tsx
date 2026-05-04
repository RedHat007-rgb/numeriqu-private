"use client";

import React from "react";

type FooterColumn = { title: string; links: Array<{ label: string; href: string }> };

const COLUMNS: FooterColumn[] = [
  {
    title: "Product",
    links: [
      { label: "Platform", href: "#platform" },
      { label: "Features", href: "#features" },
      { label: "Pricing", href: "#pricing" },
      { label: "Trust & Security", href: "#trust" },
    ],
  },
  {
    title: "Workflows",
    links: [
      { label: "CFO Dashboard", href: "/dashboard" },
      { label: "RAG Advisor", href: "/dashboard/chat/rag" },
      { label: "Agent Workbench", href: "/dashboard/chat/agent" },
      { label: "Integrations", href: "/dashboard/integrations" },
    ],
  },
  {
    title: "Account",
    links: [
      { label: "Sign in", href: "/login" },
      { label: "Create account", href: "/signup" },
    ],
  },
];

export const Footer: React.FC = () => {
  return (
    <footer className="border-t border-default bg-bg-base px-6 py-16">
      <div className="mx-auto max-w-7xl">
        <div className="mb-12 grid grid-cols-1 gap-12 md:grid-cols-4">
          <div>
            <h3 className="mb-2 font-display text-xl font-bold text-text-primary">
              Numeriqu
            </h3>
            <p className="text-sm text-text-muted">
              Strategic financial intelligence for modern finance teams.
            </p>
          </div>

          {COLUMNS.map((column) => (
            <div key={column.title}>
              <h4 className="mb-4 font-semibold text-text-primary">{column.title}</h4>
              <ul className="space-y-2">
                {column.links.map((link) => (
                  <li key={link.label}>
                    <a
                      href={link.href}
                      className="text-sm text-text-muted transition-colors hover:text-accent-blue"
                    >
                      {link.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="flex flex-col items-center justify-between gap-4 border-t border-default pt-8 text-sm text-text-muted md:flex-row">
          <p>© {new Date().getFullYear()} Numeriqu. All rights reserved.</p>
          <div className="flex items-center gap-6">
            <a
              href="mailto:hello@numeriqu.com"
              className="transition-colors hover:text-accent-blue"
            >
              hello@numeriqu.com
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
};
