"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

function classNames(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

function NavLink({ href, label }: { href: string; label: string }) {
  const pathname = usePathname();
  const active = pathname === href;

  return (
    <Link
      href={href}
      className={classNames(
        "flex items-center justify-between rounded-xl border px-4 py-3 text-sm transition-colors",
        active
          ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-100"
          : "border-white/10 bg-white/[0.02] text-slate-200 hover:border-white/20 hover:bg-white/[0.04]",
      )}
    >
      <span className="font-medium">{label}</span>
      {active ? <span className="text-xs text-cyan-200">ACTIVE</span> : null}
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
    <div className="min-h-screen bg-slate-950 text-white">
      <header className="sticky top-0 z-40 border-b border-white/10 bg-slate-950/85 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 px-6 py-5 md:flex-row md:items-center md:justify-between">
          <div>
            <Link href="/" className="text-sm text-cyan-300 hover:text-cyan-200">
              ← Landing
            </Link>
            <h1 className="mt-3 font-display text-3xl font-bold">Numeriqu Dashboard</h1>
            <p className="mt-1 text-sm text-slate-400">{tenantLabel}</p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={() => void onSignOut()}
              className="rounded-full bg-white px-5 py-2.5 text-sm font-semibold text-slate-950 hover:bg-cyan-100"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-7xl gap-6 px-6 py-8 lg:grid-cols-[260px_1fr]">
        <aside className="space-y-3">
          <p className="text-xs font-semibold uppercase tracking-[0.28em] text-slate-400">Navigation</p>
          <nav className="space-y-2">
            <NavLink href="/dashboard" label="Overview" />
            <NavLink href="/dashboard/intelligence" label="Intelligence Hub" />
            <NavLink href="/dashboard/integrations" label="Integrations" />
            <NavLink href="/dashboard/chat/rag" label="RAG Chat" />
            <NavLink href="/dashboard/chat/agent" label="Agent Chat" />
          </nav>

          <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4 text-sm text-slate-300">
            RAG and Agent are independent surfaces. Each page calls its own backend layer.
          </div>
        </aside>

        <main className="min-w-0">{children}</main>
      </div>
    </div>
  );
}

