"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Settings } from "lucide-react";
import { Button } from "../../../components/ui/Button";
import { cn } from "../../../components/ui/cn";

const NAV_ITEMS: Array<{ href: string; label: string; description: string }> = [
  { href: "/dashboard", label: "Overview", description: "What changed, at a glance" },
  { href: "/dashboard#dashboards", label: "Dashboards", description: "Saved decision surfaces" },
  { href: "/dashboard/rag", label: "RAG Advisor", description: "Ask questions, get cited answers" },
  { href: "/dashboard/agent", label: "Agent", description: "Autonomous finance tasks" },
  { href: "/dashboard/integrations", label: "Integrations", description: "Connect systems and sync" },
  { href: "/dashboard/messages", label: "Messages", description: "Decisions, captured in context" },
  { href: "/dashboard/team", label: "Team", description: "Members, roles, access" },
  { href: "/dashboard/settings", label: "Settings", description: "Workspace and session" },
];

function NavLink({
  href,
  label,
  description,
}: {
  href: string;
  label: string;
  description: string;
}) {
  const pathname = usePathname();
  const normalizedHref = href.split("#")[0] ?? href;
  const active =
    normalizedHref === "/dashboard" ? pathname === normalizedHref : pathname.startsWith(normalizedHref);

  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group block rounded-xl border px-3.5 py-3 text-sm transition-all",
        active
          ? "border-accent-blue/45 bg-accent-blue/10 text-text-primary shadow-sm"
          : "border-default bg-bg-surface text-text-secondary hover:-translate-y-0.5 hover:border-strong hover:bg-bg-elevated hover:text-text-primary",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{label}</span>
        {active ? (
          <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-accent-blue">
            Active
          </span>
        ) : null}
      </div>
      <p className="mt-1 text-xs text-text-muted">{description}</p>
    </Link>
  );
}

export function DashboardShell({
  tenantLabel,
  onSignOut,
  accountType,
  children,
}: {
  tenantLabel: string;
  onSignOut: () => Promise<void>;
  accountType: "SOLO" | "ORGANIZATION";
  children: React.ReactNode;
}) {
  const visibleNavItems =
    accountType === "SOLO"
      ? NAV_ITEMS.filter(
          (item) => item.href !== "/dashboard/messages" && item.href !== "/dashboard/team",
        )
      : NAV_ITEMS;

  return (
    <div className="relative min-h-screen bg-bg-base text-text-primary">
      <div aria-hidden className="pointer-events-none absolute inset-0 nq-grid opacity-25" />
      <div aria-hidden className="pointer-events-none absolute inset-0 nq-grain opacity-55" />

      <div className="relative">
        <header className="sticky top-0 z-40 border-b border-default bg-bg-base/80 backdrop-blur">
          <div className="mx-auto flex max-w-7xl flex-col gap-4 px-6 py-4 md:flex-row md:items-center md:justify-between">
            <div className="space-y-1">
              <Link href="/" className="text-xs text-text-muted hover:text-text-primary">
                ← Back to landing
              </Link>
              <h1 className="font-serif text-2xl font-semibold tracking-tight text-text-primary md:text-3xl">
                Workspace
              </h1>
              <p className="text-xs text-text-muted">{tenantLabel}</p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Link href="/dashboard/settings">
                <Button variant="secondary" size="sm">
                  <Settings className="size-4" /> Settings
                </Button>
              </Link>
              <Button variant="secondary" size="sm" onClick={() => void onSignOut()}>
                Sign out
              </Button>
            </div>
          </div>
        </header>

        <div className="mx-auto grid max-w-7xl gap-6 px-6 py-8 lg:grid-cols-[300px_1fr]">
          <aside className="space-y-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.24em] text-text-muted">
                Navigate
              </p>
              <nav className="mt-2 space-y-2" aria-label="Primary">
                {visibleNavItems.map((item) => (
                  <NavLink key={item.href} {...item} />
                ))}
              </nav>
            </div>

            <div className="rounded-xl border border-default bg-bg-surface/70 p-4 text-xs text-text-muted backdrop-blur">
              Scope guarantee: all views are organization-isolated. RAG, Agent, Messaging, and Dashboards
              run on separate backend domains with independent histories.
              {accountType === "SOLO" ? " Solo mode disables invites and messaging by design." : ""}
            </div>
          </aside>

          <main id="main-content" className="min-w-0">
            {children}
          </main>
        </div>
      </div>
    </div>
  );
}
