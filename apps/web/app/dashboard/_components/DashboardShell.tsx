"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Settings,
  LayoutDashboard,
  LineChart,
  Bot,
  Search,
  MessageSquare,
  PlugZap,
  Users,
  Shield,
  ChevronDown,
  PanelsLeftBottom,
  ArrowLeft,
  BarChart3,
  ExternalLink,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button } from "../../../components/ui/Button";
import { cn } from "../../../components/ui/cn";
import { Logo } from "../../../components/landing/logo";
import { CommandPalette } from "./CommandPalette";
import type { WorkspaceSummary } from "../../../lib/api/types";

const NAV_ITEMS: Array<{ href: string; label: string; description: string; icon: LucideIcon }> = [
  { href: "/dashboard", label: "Overview", description: "What changed, at a glance", icon: LayoutDashboard },
  { href: "/dashboard/dashboards", label: "Dashboards", description: "Saved decision surfaces", icon: LineChart },
  { href: "/dashboard/rag", label: "Prism", description: "Evidence-first answers, cited", icon: Search },
  { href: "/dashboard/agent", label: "Astra", description: "Turn questions into dashboards", icon: Bot },
  { href: "/dashboard/messages", label: "Messages", description: "Team conversations and direct messages", icon: MessageSquare },
  { href: "/dashboard/integrations", label: "Integrations", description: "Connect systems and sync", icon: PlugZap },
  { href: "/dashboard/team", label: "Team", description: "Members, roles, access", icon: Users },
  { href: "/dashboard/settings", label: "Settings", description: "Workspace and session", icon: Shield },
];

const POWER_BI_URL =
  "https://app.powerbi.com/view?r=eyJrIjoiM2JlYTFhMjAtNGVlNy00MjIzLWFmNGYtOGQ4NTMwOWE2Y2EzIiwidCI6ImYzYzVhY2ZkLTg4OGMtNGQ2Yi1hZDNiLWQyNDYwZThhMTQ0NyJ9&pageName=ebbb890dd70e7910d663";

/**
 * PowerBI launch button with special effects: brand-amber gradient, a sweeping
 * shimmer on hover, and an animated glow ring. Opens the embedded report in a
 * new tab. Collapses to an icon-only pill when the sidebar is collapsed.
 */
function PowerBiButton({ collapsed }: { collapsed: boolean }) {
  return (
    <a
      href={POWER_BI_URL}
      target="_blank"
      rel="noopener noreferrer"
      title="Open Power BI report in a new tab"
      aria-label="Open Power BI report in a new tab"
      className={cn(
        "group relative flex items-center gap-2.5 overflow-hidden rounded-lg px-2.5 py-2 text-sm font-semibold",
        "text-[#3d2b00] transition-all duration-300",
        "bg-[linear-gradient(110deg,#F2C811_0%,#F5D33f_45%,#E8A600_100%)]",
        "shadow-[0_4px_16px_-4px_rgba(242,200,17,0.55)] ring-1 ring-amber-300/50",
        "hover:-translate-y-0.5 hover:shadow-[0_8px_28px_-4px_rgba(242,200,17,0.8)]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-200",
        collapsed && "justify-center px-2",
      )}
    >
      {/* animated glow ring */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-lg opacity-0 ring-2 ring-amber-300/70 blur-[2px] transition-opacity duration-500 group-hover:opacity-100 group-hover:animate-pulse"
      />
      {/* sweeping shimmer */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 -left-full w-1/2 skew-x-[-20deg] bg-[linear-gradient(90deg,transparent,rgba(255,255,255,0.7),transparent)] transition-transform duration-700 ease-out group-hover:translate-x-[300%]"
      />
      <span
        className={cn(
          "relative z-10 flex size-8 items-center justify-center rounded-lg bg-white/25 ring-1 ring-white/40",
        )}
      >
        <BarChart3 className="size-4" />
      </span>
      {!collapsed ? (
        <span className="relative z-10 flex min-w-0 flex-1 items-center gap-1.5">
          <span className="truncate">Power BI</span>
          <ExternalLink className="size-3.5 shrink-0 opacity-70 transition-transform duration-300 group-hover:translate-x-0.5 group-hover:opacity-100" />
        </span>
      ) : null}
    </a>
  );
}

function initials(value: string) {
  const cleaned = value.trim();
  if (!cleaned) return "U";
  const parts = cleaned.split(/[\s@.]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  return cleaned.slice(0, 2).toUpperCase();
}

function NavLink({
  href,
  label,
  icon: Icon,
  collapsed,
}: {
  href: string;
  label: string;
  icon: LucideIcon;
  collapsed: boolean;
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
        "group relative flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors",
        collapsed && "justify-center px-2",
        active
          ? "bg-accent-blue/10 text-text-primary ring-1 ring-accent-blue/25"
          : "text-text-secondary hover:bg-bg-elevated/60 hover:text-text-primary",
      )}
    >
      <div
        className={cn(
          "flex size-8 items-center justify-center rounded-lg ring-1 transition-colors",
          active
            ? "bg-accent-blue/10 ring-accent-blue/25 text-accent-blue"
            : "bg-bg-surface ring-default text-text-muted group-hover:text-text-primary",
        )}
      >
        <Icon className="size-4" />
      </div>
      {!collapsed ? (
        label === "Prism" ? (
          <div className="min-w-0 flex-1 pr-16">
            <span className="block truncate font-semibold">{label}</span>
            <span
              className={cn(
                "absolute right-2 top-1.5 whitespace-nowrap rounded-full px-1.5 py-0.5",
                "bg-text-muted/10 text-[8px] font-bold uppercase leading-none tracking-[0.14em] text-text-muted ring-1 ring-text-muted/15",
              )}
            >
              Coming soon
            </span>
          </div>
        ) : (
          <div className="min-w-0 flex-1">
            <span className="block truncate font-semibold">{label}</span>
          </div>
        )
      ) : null}
    </Link>
  );
}

export function DashboardShell({
  tenantLabel,
  userLabel,
  onSignOut,
  accountType,
  currentWorkspaceId,
  workspaces,
  onSelectWorkspace,
  children,
}: {
  tenantLabel: string;
  userLabel: string;
  onSignOut: () => Promise<void>;
  accountType: "SOLO" | "ORGANIZATION";
  currentWorkspaceId: string | null;
  workspaces: WorkspaceSummary[];
  onSelectWorkspace: (organizationId: string) => Promise<void>;
  children: React.ReactNode;
}) {
  const visibleNavItems =
    accountType === "SOLO"
      ? NAV_ITEMS.filter(
          (item) => item.href !== "/dashboard/team",
        )
      : NAV_ITEMS;

  const router = useRouter();
  const pathname = usePathname();
  const activeItem = visibleNavItems.find((item) =>
    item.href === "/dashboard" ? pathname === item.href : pathname.startsWith(item.href),
  );

  const isImmersive = pathname.startsWith("/dashboard/agent") || pathname.startsWith("/dashboard/rag") || pathname.startsWith("/dashboard/chat");

  const [navCollapsed, setNavCollapsed] = useState(false);
  const [navDrawerOpen, setNavDrawerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem("nq.nav.collapsed");
      setNavCollapsed(raw === "1");
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem("nq.nav.collapsed", navCollapsed ? "1" : "0");
    } catch {
      // ignore
    }
  }, [navCollapsed]);

  useEffect(() => {
    function onDocClick(event: MouseEvent) {
      if (!userMenuOpen) return;
      const node = event.target as Node | null;
      if (!node) return;
      if (userMenuRef.current && !userMenuRef.current.contains(node)) setUserMenuOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [userMenuOpen]);

  useEffect(() => {
    if (isImmersive) document.body.classList.add("nq-immersive");
    else document.body.classList.remove("nq-immersive");
    if (isImmersive) document.documentElement.classList.add("nq-immersive");
    else document.documentElement.classList.remove("nq-immersive");
    return () => {
      document.body.classList.remove("nq-immersive");
      document.documentElement.classList.remove("nq-immersive");
    };
  }, [isImmersive]);

  const avatar = useMemo(() => initials(userLabel || tenantLabel), [tenantLabel, userLabel]);

  return (
    <div className={cn("relative bg-transparent text-text-primary", isImmersive ? "h-screen" : "min-h-screen")}>
      <div className={cn("relative flex flex-col", isImmersive ? "h-screen" : "min-h-screen")}>
        <header
          className={cn(
            "z-40 border-b border-default bg-bg-base/85 backdrop-blur",
            isImmersive ? "sticky top-0" : "sticky top-0",
          )}
        >
          <div className="mx-auto flex max-w-[1760px] flex-col gap-3 px-4 py-3 md:flex-row md:items-center md:justify-between xl:px-6">
            <div className="min-w-0">
              <div className="flex items-center gap-3">
                {isImmersive ? (
                  <button
                    type="button"
                    onClick={() => {
                      if (typeof window !== "undefined" && window.history.length > 1) router.back();
                      else router.push("/dashboard");
                    }}
                    className="flex size-9 items-center justify-center rounded-xl border border-default bg-bg-surface text-text-muted transition-colors hover:bg-bg-elevated/60 hover:text-text-primary"
                    aria-label="Back"
                    title="Back"
                  >
                    <ArrowLeft className="size-4" />
                  </button>
                ) : null}
                <Logo className="h-10 w-auto shrink-0" />
                <div className="min-w-0">
                  <h1 className="truncate text-lg font-bold tracking-tight text-text-primary md:text-xl">
                    {activeItem?.label ?? "Workspace"}
                  </h1>
                </div>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted">
                <span className="truncate">{tenantLabel}</span>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {isImmersive ? (
                <Button variant="secondary" size="sm" onClick={() => setNavDrawerOpen(true)}>
                  <PanelsLeftBottom className="size-4" /> Navigate
                </Button>
              ) : null}

              <button
                type="button"
                onClick={() => setPaletteOpen(true)}
                className="hidden items-center gap-2 rounded-xl border border-default bg-bg-surface px-3 py-2 text-xs text-text-muted transition-colors hover:bg-bg-elevated/60 hover:text-text-primary md:flex"
                aria-label="Search"
              >
                <Search className="size-4 text-text-muted" />
                <span className="whitespace-nowrap">Search</span>
                <span className="ml-2 rounded-md bg-bg-elevated px-2 py-0.5 text-[10px] font-semibold text-text-muted ring-1 ring-default">
                  ⌘K
                </span>
              </button>

              <div className="relative" ref={userMenuRef}>
                <button
                  type="button"
                  onClick={() => setUserMenuOpen((o) => !o)}
                  className="flex items-center gap-2 rounded-xl border border-default bg-bg-surface px-3 py-2 text-xs font-semibold text-text-secondary transition-colors hover:bg-bg-elevated/60 hover:text-text-primary"
                  aria-label="Account menu"
                  aria-expanded={userMenuOpen}
                >
                  <span className="flex size-6 items-center justify-center rounded-lg bg-accent-blue/10 text-[10px] font-black tracking-[0.18em] text-accent-blue ring-1 ring-accent-blue/20">
                    {avatar}
                  </span>
                  <span className="hidden max-w-[180px] truncate md:inline">{userLabel || "Account"}</span>
                  <ChevronDown className="size-4 text-text-muted" />
                </button>

                {userMenuOpen ? (
                  <div className="absolute right-0 top-[calc(100%+8px)] z-50 w-64 overflow-hidden rounded-2xl border border-default bg-bg-card shadow-xl shadow-black/40">
                    <div className="border-b border-default px-4 py-3">
                      <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-text-muted">Workspace</p>
                      <p className="mt-1 truncate text-sm font-semibold text-text-primary">{tenantLabel}</p>
                      {userLabel ? <p className="mt-0.5 truncate text-xs text-text-muted">{userLabel}</p> : null}
                    </div>
                    {workspaces.length > 1 ? (
                      <div className="border-b border-default p-2">
                        <p className="px-2 pb-2 text-[10px] font-bold uppercase tracking-[0.22em] text-text-muted">
                          Switch workspace
                        </p>
                        <div className="space-y-1">
                          {workspaces.map((ws) => {
                            const active = ws.organization.id === currentWorkspaceId;
                            return (
                              <button
                                key={ws.organization.id}
                                type="button"
                                onClick={async () => {
                                  setUserMenuOpen(false);
                                  await onSelectWorkspace(ws.organization.id);
                                }}
                                className={cn(
                                  "flex w-full items-start justify-between gap-3 rounded-xl px-3 py-2 text-left text-sm transition-colors",
                                  active
                                    ? "bg-accent-blue/10 text-text-primary ring-1 ring-accent-blue/25"
                                    : "text-text-secondary hover:bg-bg-elevated/60 hover:text-text-primary",
                                )}
                              >
                                <div className="min-w-0 flex-1">
                                  <p className="truncate font-semibold">{ws.organization.name}</p>
                                  <p className="truncate text-[11px] text-text-muted">{ws.organization.slug}</p>
                                </div>
                                {active ? (
                                  <span className="mt-0.5 shrink-0 rounded-lg bg-accent-blue/10 px-2 py-1 text-[10px] font-bold uppercase tracking-[0.18em] text-accent-blue ring-1 ring-accent-blue/25">
                                    Active
                                  </span>
                                ) : null}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ) : null}
                    <div className="p-2">
                      <Link
                        href="/dashboard/settings"
                        onClick={() => setUserMenuOpen(false)}
                        className="flex items-center gap-2 rounded-xl px-3 py-2 text-sm text-text-secondary hover:bg-bg-elevated/60 hover:text-text-primary"
                      >
                        <Settings className="size-4" /> Settings
                      </Link>
                      <button
                        type="button"
                        onClick={() => void onSignOut()}
                        className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm text-text-secondary hover:bg-bg-elevated/60 hover:text-text-primary"
                      >
                        <span className="inline-flex size-4 items-center justify-center rounded bg-bg-elevated text-[10px]">
                          ↩
                        </span>
                        Sign out
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </header>

        <div
          className={cn(
            "mx-auto w-full max-w-[1760px] flex-1 min-h-0",
            isImmersive ? "overflow-hidden px-4 py-4 xl:px-6" : "px-4 py-5 xl:px-6",
          )}
        >
          <div
            className={cn(
              "grid h-full min-h-0 gap-4",
              isImmersive ? "grid-cols-1" : navCollapsed ? "lg:grid-cols-[74px_1fr]" : "lg:grid-cols-[224px_1fr]",
            )}
          >
            {!isImmersive ? (
              <aside className="space-y-3">
                <div className={cn("flex items-center justify-between", navCollapsed && "justify-center")}>
                  {!navCollapsed ? (
                    <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-text-muted">
                      Workspace
                    </p>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => setNavCollapsed((v) => !v)}
                    className="flex h-9 w-9 items-center justify-center rounded-xl border border-default bg-bg-surface text-text-muted hover:bg-bg-elevated/60 hover:text-text-primary"
                    aria-label={navCollapsed ? "Expand navigation" : "Collapse navigation"}
                  >
                    <PanelsLeftBottom className="size-4" />
                  </button>
                </div>

                <nav className="space-y-2" aria-label="Primary">
                  {visibleNavItems.map((item) => (
                    <NavLink
                      key={item.href}
                      href={item.href}
                      label={item.label}
                      icon={item.icon}
                      collapsed={navCollapsed}
                    />
                  ))}
                </nav>

                <div className="pt-1">
                  <PowerBiButton collapsed={navCollapsed} />
                </div>
              </aside>
            ) : null}

            <main
              id="main-content"
              className={cn("min-w-0 min-h-0", isImmersive ? "h-full overflow-hidden" : null)}
            >
              {children}
            </main>
          </div>
        </div>
      </div>

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
      />

      {/* Immersive nav drawer */}
      {navDrawerOpen ? (
        <div className="fixed inset-0 z-50">
          <button
            type="button"
            className="absolute inset-0 bg-black/30"
            aria-label="Close navigation"
            onClick={() => setNavDrawerOpen(false)}
          />
          <div className="absolute left-0 top-0 h-full w-[320px] bg-bg-surface shadow-2xl shadow-black/50">
            <div className="flex items-center justify-between border-b border-default px-4 py-4">
              <div className="min-w-0">
                <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-text-muted">Navigate</p>
                <p className="truncate text-sm font-semibold text-text-primary">{tenantLabel}</p>
              </div>
              <Button variant="secondary" size="sm" onClick={() => setNavDrawerOpen(false)}>
                Close
              </Button>
            </div>
            <div className="p-3">
              <nav className="space-y-2" aria-label="Primary">
                {visibleNavItems.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setNavDrawerOpen(false)}
                    className={cn(
                      "flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-text-secondary hover:bg-bg-elevated/60 hover:text-text-primary",
                      (item.href === "/dashboard" ? pathname === "/dashboard" : pathname.startsWith(item.href))
                        ? "bg-accent-blue/10 text-text-primary ring-1 ring-accent-blue/25"
                        : null,
                    )}
                  >
                    <item.icon className="size-4" />
                    <span className="font-semibold">{item.label}</span>
                  </Link>
                ))}
                <div className="pt-1">
                  <PowerBiButton collapsed={false} />
                </div>
              </nav>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
