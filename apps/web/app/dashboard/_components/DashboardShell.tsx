"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ThemeToggle } from "../../../components/ui/ThemeToggle";
import { Button } from "../../../components/ui/Button";
import { cn } from "../../../components/ui/cn";

const NAV_ITEMS: Array<{ href: string; label: string; description: string }> = [
  { href: "/dashboard", label: "Overview", description: "What changed since last week" },
  { href: "/dashboard/intelligence", label: "Intelligence Hub", description: "Advisor + agent + live view" },
  { href: "/dashboard/integrations", label: "Integrations", description: "Connections and sync jobs" },
  { href: "/dashboard/chat/rag", label: "RAG Advisor", description: "Source-cited answers" },
  { href: "/dashboard/chat/agent", label: "Agent Workbench", description: "Autonomous analysis missions" },
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
  const active = pathname === href;

  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group block rounded-xl border px-3.5 py-3 text-sm transition-colors",
        active
          ? "border-accent-blue/40 bg-accent-blue/10 text-text-primary"
          : "border-default bg-surface-card/40 text-text-secondary hover:border-strong hover:bg-surface-card/70 hover:text-text-primary",
      )}
    >
      <div className="flex items-center justify-between">
        <span className="font-medium">{label}</span>
        {active ? (
          <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-accent-blue">
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
  children,
}: {
  tenantLabel: string;
  onSignOut: () => Promise<void>;
  children: React.ReactNode;
}) {
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
            <Button variant="secondary" size="sm" onClick={() => void onSignOut()}>
              Sign out
            </Button>
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-7xl gap-6 px-6 py-8 lg:grid-cols-[280px_1fr]">
        <aside className="space-y-3">
          <p className="text-xs font-semibold uppercase tracking-[0.28em] text-text-muted">
            Navigation
          </p>
          <nav className="space-y-2" aria-label="Primary">
            {NAV_ITEMS.map((item) => (
              <NavLink key={item.href} {...item} />
            ))}
          </nav>

          <div className="rounded-2xl border border-default bg-surface-card/40 p-4 text-xs text-text-muted">
            RAG and Agent are independent surfaces. Each calls its own backend layer
            so you can compare answers side-by-side in Intelligence Hub.
          </div>
        </aside>

        <main id="main-content" className="min-w-0">
          {children}
        </main>
      </div>
    </div>
  );
}
