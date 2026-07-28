"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Search, LineChart, Bot, BookOpen, PlugZap, Users, Shield, Gauge } from "lucide-react";
import { cn } from "../../../components/ui/cn";
import { useNumeriquApi } from "../../../lib/useNumeriquApi";

type InvoiceRow = {
  invoice_number?: string;
  org_name?: string;
  amount?: number | string;
  currency?: string;
  status?: string;
  date?: string;
};

type EntityRow = { name?: string; value?: number };

type Command = {
  id: string;
  label: string;
  detail?: string;
  icon: any;
  onSelect: () => void;
};

function normalize(value: string) {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { agent, dashboards, loading } = useNumeriquApi();

  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  const [invoices, setInvoices] = useState<InvoiceRow[] | null>(null);
  const [entities, setEntities] = useState<EntityRow[] | null>(null);
  const [dashList, setDashList] = useState<Array<{ id: string; title: string; description: string | null }> | null>(null);
  const [dataLoading, setDataLoading] = useState(false);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const isCmdK = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k";
      if (isCmdK) {
        event.preventDefault();
        onOpenChange(!open);
        return;
      }
      if (!open) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onOpenChange(false);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onOpenChange]);

  useEffect(() => {
    if (!open) return;
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (loading) return;
    if (invoices && entities && dashList) return;
    if (dataLoading) return;

    setDataLoading(true);
    Promise.allSettled([
      invoices
        ? Promise.resolve(invoices)
        : agent.getMetrics("invoices", "list").then((r) => (r.data ?? []) as any[]).then((rows) => rows as InvoiceRow[]),
      entities
        ? Promise.resolve(entities)
        : agent.getMetrics("expense", "vendor").then((r) => (r.data ?? []) as any[]).then((rows) => rows as EntityRow[]),
      dashList
        ? Promise.resolve(dashList)
        : dashboards.list().then((rows) =>
            rows.map((d) => ({ id: d.id, title: d.title, description: d.description ?? null })),
          ),
    ])
      .then(([inv, ent, dashes]) => {
        if (inv.status === "fulfilled") setInvoices(inv.value);
        if (ent.status === "fulfilled") setEntities(ent.value);
        if (dashes.status === "fulfilled") setDashList(dashes.value);
      })
      .finally(() => setDataLoading(false));
  }, [open, loading, invoices, entities, dashList, dataLoading, agent, dashboards]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setActiveIndex(0);
    }
  }, [open]);

  const baseCommands: Command[] = useMemo(() => {
    const nav = [
      { href: "/dashboard", label: "Overview", detail: "CFO insights command center", icon: Gauge },
      { href: "/dashboard/dashboards", label: "Dashboards", detail: "Saved decision surfaces", icon: LineChart },
      { href: "/dashboard/rag", label: "Prism", detail: "Evidence-first answers, cited", icon: BookOpen },
      { href: "/dashboard/agent", label: "Astra", detail: "Turn questions into dashboards", icon: Bot },
      { href: "/dashboard/integrations", label: "Integrations", detail: "Connect systems and sync", icon: PlugZap },
      { href: "/dashboard/team", label: "Team", detail: "Members, roles, access", icon: Users },
      { href: "/dashboard/settings", label: "Settings", detail: "Workspace and security", icon: Shield },
    ];

    return nav.map((item) => ({
      id: `nav:${item.href}`,
      label: item.label,
      detail: item.detail,
      icon: item.icon,
      onSelect: () => {
        onOpenChange(false);
        router.push(item.href);
      },
    }));
  }, [router, onOpenChange]);

  const dynamicCommands: Command[] = useMemo(() => {
    const q = normalize(query);
    const commands: Command[] = [];

    if (q.length >= 2) {
      commands.push({
        id: `ask:prism:${q}`,
        label: `Ask Prism: “${query.trim()}”`,
        detail: "Cited answer — no guessing",
        icon: Search,
        onSelect: () => {
          onOpenChange(false);
          router.push(`/dashboard/rag?q=${encodeURIComponent(query.trim())}`);
        },
      });
      commands.push({
        id: `run:astra:${q}`,
        label: `Run Astra mission: “${query.trim()}”`,
        detail: "Build or refine a dashboard",
        icon: Bot,
        onSelect: () => {
          onOpenChange(false);
          router.push(`/dashboard/agent?q=${encodeURIComponent(query.trim())}`);
        },
      });
    }

    if (dashList && q) {
      const matches = dashList
        .filter((d) => normalize(d.title).includes(q) || normalize(d.description ?? "").includes(q))
        .slice(0, 6);
      for (const d of matches) {
        commands.push({
          id: `dash:${d.id}`,
          label: d.title,
          detail: d.description ?? "Dashboard",
          icon: LineChart,
          onSelect: () => {
            onOpenChange(false);
            router.push("/dashboard/dashboards");
          },
        });
      }
    }

    if (entities && q) {
      const matches = entities
        .filter((e) => normalize(String(e.name ?? "")).includes(q))
        .slice(0, 6);
      for (const e of matches) {
        commands.push({
          id: `entity:${String(e.name ?? "")}`,
          label: String(e.name ?? "Entity"),
          detail: "Entity",
          icon: Users,
          onSelect: () => {
            onOpenChange(false);
            router.push(`/dashboard/rag?q=${encodeURIComponent(`Summarize ${String(e.name ?? "")} spend and overdue exposure.`)}`);
          },
        });
      }
    }

    if (invoices && q) {
      const matches = invoices
        .filter((row) => {
          const hay = normalize(
            `${row.invoice_number ?? ""} ${row.org_name ?? ""} ${row.status ?? ""} ${row.currency ?? ""}`,
          );
          return hay.includes(q);
        })
        .slice(0, 6);
      for (const row of matches) {
        const title = row.invoice_number ? `Invoice ${row.invoice_number}` : "Invoice";
        const detail = `${row.org_name ?? "Entity"}${row.status ? ` · ${row.status}` : ""}`;
        commands.push({
          id: `inv:${row.invoice_number ?? detail}`,
          label: title,
          detail,
          icon: Search,
          onSelect: () => {
            onOpenChange(false);
            router.push(`/dashboard/rag?q=${encodeURIComponent(`Show details for invoice ${row.invoice_number ?? ""} from ${row.org_name ?? ""}.`)}`);
          },
        });
      }
    }

    return commands;
  }, [query, dashList, entities, invoices, router, onOpenChange]);

  const commands = useMemo(() => {
    const q = normalize(query);
    if (!q) return baseCommands;
    const baseMatches = baseCommands.filter((c) => normalize(`${c.label} ${c.detail ?? ""}`).includes(q));
    return [...dynamicCommands, ...baseMatches].slice(0, 14);
  }, [query, baseCommands, dynamicCommands]);

  useEffect(() => {
    if (!open) return;
    setActiveIndex(0);
  }, [query, open]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((i) => Math.min(i + 1, commands.length - 1));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, 0));
      } else if (event.key === "Enter") {
        const current = commands[activeIndex];
        if (!current) return;
        event.preventDefault();
        current.onSelect();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, commands, activeIndex]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50">
      <button
        type="button"
        className="absolute inset-0 bg-black/30"
        aria-label="Close search"
        onClick={() => onOpenChange(false)}
      />

      <div className="absolute left-1/2 top-20 w-[min(760px,calc(100vw-32px))] -translate-x-1/2 overflow-hidden rounded-3xl border border-default bg-bg-card shadow-2xl shadow-black/50">
        <div className="flex items-center gap-2 border-b border-default px-4 py-3">
          <Search className="size-4 text-text-muted" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search pages, dashboards, entities… (⌘K)"
            className="w-full bg-transparent py-1 text-sm text-text-primary outline-none placeholder:text-text-muted"
          />
          <span className="rounded-full bg-bg-elevated px-2 py-1 text-[10px] font-semibold text-text-muted ring-1 ring-default">
            {dataLoading ? "Indexing…" : pathname === "/dashboard/agent" ? "Astra" : pathname === "/dashboard/rag" ? "Prism" : "Workspace"}
          </span>
        </div>

        <div className="max-h-[420px] overflow-y-auto p-2">
          {commands.length === 0 ? (
            <div className="px-4 py-8 text-sm text-text-muted">No results.</div>
          ) : (
            <div className="space-y-1">
              {commands.map((cmd, idx) => (
                <button
                  key={cmd.id}
                  type="button"
                  onMouseEnter={() => setActiveIndex(idx)}
                  onClick={cmd.onSelect}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-2xl px-3 py-2 text-left transition-colors",
                    idx === activeIndex ? "bg-accent-blue/10 ring-1 ring-accent-blue/20" : "hover:bg-bg-elevated/60",
                  )}
                >
                  <div className={cn(
                    "flex size-9 items-center justify-center rounded-2xl ring-1",
                    idx === activeIndex ? "bg-accent-blue/10 ring-accent-blue/20 text-accent-blue" : "bg-bg-surface ring-default text-text-muted",
                  )}>
                    <cmd.icon className="size-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-text-primary">{cmd.label}</p>
                    {cmd.detail ? <p className="mt-0.5 line-clamp-1 text-xs text-text-muted">{cmd.detail}</p> : null}
                  </div>
                  <span className="text-[10px] font-semibold text-text-muted">↩</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-default px-4 py-2 text-[11px] text-text-muted">
          <span>Tip: type a question to launch Prism or Astra.</span>
          <span className="hidden sm:inline">Esc to close · ↑↓ to navigate · Enter to run</span>
        </div>
      </div>
    </div>
  );
}
