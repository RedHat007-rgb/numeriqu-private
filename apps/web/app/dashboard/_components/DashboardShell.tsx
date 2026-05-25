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
  PlugZap,
  MessageSquare,
  Users,
  Shield,
  ChevronDown,
  PanelsLeftBottom,
  ArrowLeft,
} from "lucide-react";
import { Button } from "../../../components/ui/Button";
import { cn } from "../../../components/ui/cn";
import { CommandPalette } from "./CommandPalette";
import type { WorkspaceSummary } from "../../../lib/api/types";

// ── Power BI Microsoft icon ───────────────────────────────────────────────────
function PowerBIIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="1" y="11" width="4" height="10" rx="1" fill="#F2C811" />
      <rect x="7" y="7" width="4" height="14" rx="1" fill="#F2C811" opacity="0.85" />
      <rect x="13" y="3" width="4" height="18" rx="1" fill="#F2C811" opacity="0.7" />
      <rect x="19" y="6" width="4" height="15" rx="1" fill="#F2C811" opacity="0.55" />
    </svg>
  );
}

/** Builds the Microsoft OAuth authorize URL for Power BI */
function buildMicrosoftLoginUrl(): string {
  const clientId =
    process.env.NEXT_PUBLIC_AZURE_CLIENT_ID ?? "00000000-0000-0000-0000-000000000000";
  const redirectUri = encodeURIComponent(
    (typeof window !== "undefined" ? window.location.origin : "") +
      "/dashboard/powerbi/callback",
  );
  const scope = encodeURIComponent(
    "https://analysis.windows.net/powerbi/api/.default offline_access openid profile",
  );
  return (
    `https://login.microsoftonline.com/common/oauth2/v2.0/authorize` +
    `?client_id=${clientId}` +
    `&response_type=code` +
    `&redirect_uri=${redirectUri}` +
    `&scope=${scope}` +
    `&response_mode=query`
  );
}

const NAV_ITEMS: Array<{ href: string; label: string; description: string; icon: any }> = [
  { href: "/dashboard", label: "Overview", description: "What changed, at a glance", icon: LayoutDashboard },
  { href: "/dashboard/dashboards", label: "Dashboards", description: "Saved decision surfaces", icon: LineChart },
  { href: "/dashboard/rag", label: "Prism", description: "Evidence-first answers, cited", icon: Search },
  { href: "/dashboard/agent", label: "Astra", description: "Turn questions into dashboards", icon: Bot },
  { href: "/dashboard/integrations", label: "Integrations", description: "Connect systems and sync", icon: PlugZap },
  { href: "/dashboard/messages", label: "Messages", description: "Decisions, captured in context", icon: MessageSquare },
  { href: "/dashboard/team", label: "Team", description: "Members, roles, access", icon: Users },
  { href: "/dashboard/settings", label: "Settings", description: "Workspace and session", icon: Shield },
];

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
  description,
  icon: Icon,
  collapsed,
}: {
  href: string;
  label: string;
  description: string;
  icon: any;
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
        "group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-colors",
        collapsed && "justify-center px-2",
        active
          ? "bg-accent-blue/10 text-text-primary ring-1 ring-accent-blue/25"
          : "text-text-secondary hover:bg-bg-elevated/60 hover:text-text-primary",
      )}
    >
      <div className={cn(
        "flex size-9 items-center justify-center rounded-xl ring-1 transition-colors",
        active
          ? "bg-accent-blue/10 ring-accent-blue/25 text-accent-blue"
          : "bg-bg-surface ring-default text-text-muted group-hover:text-text-primary",
      )}>
        <Icon className="size-4" />
      </div>
      {!collapsed ? (
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate font-semibold">{label}</span>
            {active ? (
              <span className="shrink-0 text-[9px] font-bold uppercase tracking-[0.18em] text-accent-blue">
                Active
              </span>
            ) : null}
          </div>
          <p className="mt-0.5 line-clamp-1 text-[11px] text-text-muted">{description}</p>
        </div>
      ) : null}
    </Link>
  );
}

/** Like NavLink but fires an onClick instead of navigating — used for Power BI / external OAuth */
function NavButton({
  label,
  description,
  icon: Icon,
  collapsed,
  onClick,
}: {
  label: string;
  description: string;
  icon: any;
  collapsed: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-colors",
        collapsed && "justify-center px-2",
        "text-text-secondary hover:bg-bg-elevated/60 hover:text-text-primary",
      )}
    >
      <div
        className={cn(
          "flex size-9 items-center justify-center rounded-xl ring-1 transition-colors",
          "bg-bg-surface ring-default text-text-muted group-hover:text-text-primary",
        )}
      >
        <Icon className="size-4" />
      </div>
      {!collapsed ? (
        <div className="min-w-0 flex-1 text-left">
          <div className="flex items-center gap-2">
            <span className="truncate font-semibold">{label}</span>
            <span className="shrink-0 rounded bg-[#F2C811]/20 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.14em] text-[#c9a800]">
              Microsoft
            </span>
          </div>
          <p className="mt-0.5 line-clamp-1 text-[11px] text-text-muted">{description}</p>
        </div>
      ) : null}
    </button>
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
          (item) => item.href !== "/dashboard/messages" && item.href !== "/dashboard/team",
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
            "z-40 border-b border-default bg-white/75 backdrop-blur",
            isImmersive ? "sticky top-0" : "sticky top-0",
          )}
        >
          <div className="mx-auto flex max-w-7xl flex-col gap-3 px-6 py-4 md:flex-row md:items-center md:justify-between">
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
                <div className="flex size-9 items-center justify-center rounded-xl bg-accent-blue/10 ring-1 ring-accent-blue/20">
                  <span className="text-[11px] font-black tracking-[0.22em] text-accent-blue">NQ</span>
                </div>
                <div className="min-w-0">
                  <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-text-muted">
                    NumeriQ
                  </p>
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
                  <div className="absolute right-0 top-[calc(100%+8px)] z-50 w-64 overflow-hidden rounded-2xl border border-default bg-white shadow-xl">
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
            "mx-auto w-full max-w-7xl flex-1 min-h-0",
            isImmersive ? "overflow-hidden px-6 py-4" : "px-6 py-8",
          )}
        >
          <div
            className={cn(
              "grid h-full min-h-0 gap-6",
              isImmersive ? "grid-cols-1" : navCollapsed ? "lg:grid-cols-[86px_1fr]" : "lg:grid-cols-[300px_1fr]",
            )}
          >
            {!isImmersive ? (
              <aside className="space-y-4">
                <div className={cn("flex items-center justify-between", navCollapsed && "justify-center")}>
                  {!navCollapsed ? (
                    <p className="text-xs font-semibold uppercase tracking-[0.24em] text-text-muted">
                      Navigate
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
                    <NavLink key={item.href} {...item} collapsed={navCollapsed} />
                  ))}
                  {/* ── Power BI ──────────────────────────────────────── */}
                  <div className={cn("pt-1", !navCollapsed && "border-t border-default")} />
                  <NavButton
                    label="Power BI"
                    description="Open your Power BI dashboards"
                    icon={PowerBIIcon}
                    collapsed={navCollapsed}
                    onClick={() => { window.open(buildMicrosoftLoginUrl(), '_blank', 'noopener,noreferrer'); }}
                  />
                </nav>
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
          <div className="absolute left-0 top-0 h-full w-[320px] bg-white shadow-2xl">
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
                {/* ── Power BI ──────────────────────────────────────── */}
                <div className="border-t border-default pt-1" />
                <button
                  type="button"
                  onClick={() => {
                    setNavDrawerOpen(false);
                    window.open(buildMicrosoftLoginUrl(), '_blank', 'noopener,noreferrer');
                  }}
                  className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-text-secondary hover:bg-bg-elevated/60 hover:text-text-primary"
                >
                  <PowerBIIcon className="size-4" />
                  <span className="font-semibold">Power BI</span>
                  <span className="ml-auto shrink-0 rounded bg-[#F2C811]/20 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.14em] text-[#c9a800]">
                    Microsoft
                  </span>
                </button>
              </nav>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
