"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Settings } from "lucide-react";
import { ThemeToggle } from "../../../components/ui/ThemeToggle";
import { Button } from "../../../components/ui/Button";
import { cn } from "../../../components/ui/cn";

const NAV_ITEMS: Array<{ href: string; label: string; description: string }> = [
  { href: "/dashboard", label: "Overview", description: "North-star financial performance" },
  { href: "/dashboard/intelligence", label: "Intelligence Hub", description: "Advisor + agent canvas" },
  { href: "/dashboard/integrations", label: "Integrations", description: "Connections and sync operations" },
  { href: "/dashboard/messages", label: "Messages", description: "Organization conversations" },
  { href: "/dashboard/team", label: "Team & Access", description: "Members, invites, permissions" },
  { href: "/dashboard/chat/rag", label: "RAG Advisor", description: "Source-cited answers" },
  { href: "/dashboard/chat/agent", label: "Agent Workbench", description: "Dashboard generation missions" },
  { href: "/dashboard/settings", label: "Settings", description: "Workspace and session preferences" },
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
  const active = href === "/dashboard" ? pathname === href : pathname.startsWith(href);

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
    <div className="min-h-screen bg-bg-base text-text-primary">
      <header className="sticky top-0 z-40 border-b border-default bg-bg-base/85 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 px-6 py-4 md:flex-row md:items-center md:justify-between">
          <div className="space-y-1">
            <Link href="/" className="text-xs text-text-muted hover:text-text-primary">
              ← Back to landing
            </Link>
            <h1 className="font-display text-2xl font-bold text-text-primary md:text-3xl">
              Numeriqu Workspace
            </h1>
            <p className="text-xs text-text-muted">{tenantLabel}</p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <ThemeToggle />
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
              Navigation
            </p>
            <nav className="mt-2 space-y-2" aria-label="Primary">
              {visibleNavItems.map((item) => (
                <NavLink key={item.href} {...item} />
              ))}
            </nav>
          </div>

          <div className="rounded-xl border border-default bg-bg-surface p-4 text-xs text-text-muted">
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
  );
}
