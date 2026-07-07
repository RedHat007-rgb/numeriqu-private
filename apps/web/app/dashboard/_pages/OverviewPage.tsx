"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { CheckCircle2, Info, LayoutGrid, Minus, Settings2, Sparkles, X } from "lucide-react";
import { Button } from "../../../components/ui/Button";
import { EmptyState } from "../../../components/ui/EmptyState";
import { ErrorBanner } from "../../../components/ui/ErrorBanner";
import { Skeleton } from "../../../components/ui/Skeleton";
import { StatusPill } from "../../../components/ui/StatusPill";
import { cn } from "../../../components/ui/cn";
import { useDashboard } from "../_hooks/useDashboard";
import { useDashboardPreferences } from "../_hooks/dashboardPreferences";
import { useOverviewDashboardView } from "../_hooks/useOverviewDashboardView";
import {
  CfoFocusCard,
  makeCashDisciplineItems,
  makeClientConcentrationItems,
  makeServiceLevelItems,
} from "../_components/overview/CfoFocusCard";
import {
  BusinessUnitBreakdownCard,
  CostElementsCard,
  DeliveryCenterScorecardCard,
  WorkforceByDepartmentCard,
  WorkforceByGeographyCard,
} from "../_components/overview/BreakdownCards";
import { ExecutiveBriefCard } from "../_components/overview/ExecutiveBriefCard";
import { deriveInsights, NextActionsCard, toneFromType } from "../_components/overview/NextActionsCard";
import { OverviewDashboardEditor } from "../_components/overview/OverviewDashboardEditor";
import { InvoiceStatusCard } from "../_components/overview/OrgBreakdownCard";
import { CashflowCard } from "../_components/overview/RevenueTrendCard";
import { TimeRangeSelect } from "../_components/overview/TimeRangeSelect";
import {
  formatMoneyWithCurrency,
  formatNumber,
  formatPercentDelta,
  formatRunwayDaysFromMonths,
  formatRelativeTime,
} from "../_components/overview/format";
import type { DashboardResponse } from "../../../lib/api";
import { getOverviewCardDefinition } from "../_lib/overviewDashboardConfig";
import type { OverviewCardId, OverviewCardPlacement } from "../_lib/overviewDashboardConfig";
import { getCardGlossary } from "../_lib/glossary";
import type { CardGlossary } from "../_lib/glossary";
import { GlossaryBackFace } from "../_components/overview/GlossaryBackFace";

const CFO_AGENDA_STORAGE_KEY = "nq.dashboard.cfo-agenda.v1";

type AgendaPreference = {
  dismissedFingerprint?: string | null;
  snoozeUntil?: string | null;
  hiddenForDate?: string | null;
};

function spanClass(size: OverviewCardPlacement["size"]) {
  if (size === "wide") return "lg:col-span-12";
  if (size === "medium") return "lg:col-span-6";
  return "lg:col-span-3";
}

function heroSpanClass(size: OverviewCardPlacement["size"]) {
  if (size === "wide") return "col-span-12";
  if (size === "medium") return "md:col-span-6 xl:col-span-4";
  return "md:col-span-6 xl:col-span-2";
}

function toneFromDelta(value: number) {
  if (value > 0) return "positive" as const;
  if (value < 0) return "negative" as const;
  return "neutral" as const;
}

function trendDelta(current: number, previous: number): { value: string; tone: "neutral" | "positive" | "negative" } | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
  if (previous === 0) {
    if (current === 0) return null;
    return { value: "new", tone: current > 0 ? "positive" : "negative" };
  }

  const ratio = (current - previous) / Math.abs(previous);
  return { value: formatPercentDelta(ratio), tone: toneFromDelta(ratio) };
}

function marginRatio(revenue: number, expenses: number) {
  if (!Number.isFinite(revenue) || revenue === 0) return null;
  return (revenue - expenses) / revenue;
}

function OverviewSkeleton() {
  return (
    <div className="space-y-5">
      <div className="flex justify-between gap-4">
        <Skeleton height={64} width="30%" rounded="xl" />
        <Skeleton height={56} width="34%" rounded="xl" />
      </div>
      <div className="grid gap-4 lg:grid-cols-12">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} height={168} rounded="xl" className="lg:col-span-3" />
        ))}
      </div>
      <div className="grid gap-5 lg:grid-cols-12">
        <Skeleton height={360} rounded="xl" className="lg:col-span-12" />
        <Skeleton height={300} rounded="xl" className="lg:col-span-6" />
        <Skeleton height={300} rounded="xl" className="lg:col-span-6" />
      </div>
    </div>
  );
}

function ZoneEmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <EmptyState
      title={title}
      detail={detail}
      icon={<LayoutGrid className="h-5 w-5" />}
      className="min-h-[180px]"
    />
  );
}

function SetupCard({
  dashboard,
  onOpenCustomize,
}: {
  dashboard: DashboardResponse;
  onOpenCustomize: () => void;
}) {
  const steps = [
    {
      key: "connect",
      title: "Connect source",
      detail:
        dashboard.kpis.providerCount > 0
          ? `${dashboard.kpis.providerCount} finance source${dashboard.kpis.providerCount === 1 ? "" : "s"} connected`
          : "Link Xero, QuickBooks, or your first accounting source",
      done: dashboard.kpis.providerCount > 0,
    },
    {
      key: "coverage",
      title: "Sync coverage",
      detail:
        dashboard.kpis.orgCount > 0
          ? `${dashboard.kpis.orgCount} entit${dashboard.kpis.orgCount === 1 ? "y" : "ies"} in scope`
          : "Bring at least one business entity into the workspace",
      done: dashboard.kpis.orgCount > 0,
    },
    {
      key: "customize",
      title: "Shape the dashboard",
      detail: "Keep only the finance cards your team will actually use daily",
      done: false,
    },
  ];

  return (
    <section className="dashboard-surface h-full p-4" aria-label="First sign-in setup">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-accent-cyan">Setup</p>
          <h3 className="mt-1 font-display text-xl font-bold text-text-primary">First sign-in</h3>
        </div>
        <span className="rounded-full border border-default bg-bg-elevated/45 px-2.5 py-1 text-[11px] font-semibold text-text-secondary">
          {steps.filter((step) => step.done).length}/3 ready
        </span>
      </div>

      <div className="mt-4 space-y-2.5">
        {steps.map((step, index) => (
          <div key={step.key} className="flex items-start gap-3 rounded-lg border border-default bg-bg-elevated/20 p-3">
            <span
              className={cn(
                "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold",
                step.done
                  ? "bg-feedback-success/15 text-feedback-success"
                  : "bg-accent-blue/15 text-accent-cyan",
              )}
            >
              {step.done ? <CheckCircle2 className="h-4 w-4" /> : index + 1}
            </span>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-text-primary">{step.title}</p>
              <p className="mt-0.5 text-xs leading-5 text-text-muted">{step.detail}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2">
        <Link href="/dashboard/integrations">
          <Button size="sm" className="w-full">Connect</Button>
        </Link>
        <Button variant="secondary" size="sm" onClick={onOpenCustomize} className="w-full">
          <Settings2 className="h-4 w-4" />
          Cards
        </Button>
      </div>
    </section>
  );
}

function MetricTile({
  eyebrow,
  value,
  detail,
  delta,
  overview,
  glossary,
  interactive = false,
  className,
}: {
  eyebrow: string;
  value: string;
  detail: string;
  delta?: { value: string; tone: "neutral" | "positive" | "negative" } | null;
  overview?: string;
  glossary?: CardGlossary | null;
  interactive?: boolean;
  className?: string;
}) {
  const [showInfo, setShowInfo] = useState(false);
  const canFlip = interactive && (Boolean(glossary) || Boolean(overview));
  const toggleInfo = () => setShowInfo((value) => !value);

  return (
    <div
      className={cn(
        "dashboard-metric-tile h-full min-h-[132px] p-4",
        canFlip && "cursor-pointer transition hover:border-accent-blue/40",
        className,
      )}
      onClick={canFlip ? toggleInfo : undefined}
      role={canFlip ? "button" : undefined}
      tabIndex={canFlip ? 0 : undefined}
      aria-expanded={canFlip ? showInfo : undefined}
      onKeyDown={
        canFlip
          ? (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                toggleInfo();
              }
            }
          : undefined
      }
    >
      <div className="grid h-full min-w-0 grid-rows-[auto_auto_auto] gap-4">
        <div className="flex min-h-[3.5rem] min-w-0 items-start justify-between gap-2">
          <p className="line-clamp-2 min-w-0 flex-1 text-[10px] font-semibold uppercase tracking-[0.22em] text-[#86a7d0]">
            {eyebrow}
          </p>
          {/* Keep the delta badge and the info icon together in the flex row so the
              badge can never slide under (or overlap) the icon. */}
          <div className="flex shrink-0 items-center gap-1.5">
            {delta ? (
              <span
                className={cn(
                  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-semibold",
                  delta.tone === "positive"
                    ? "border-feedback-success/25 bg-feedback-success/10 text-feedback-success"
                    : delta.tone === "negative"
                      ? "border-feedback-danger/25 bg-feedback-danger/10 text-feedback-danger"
                      : "border-white/10 bg-white/[0.04] text-[#9db4d8]",
                )}
              >
                {delta.value}
              </span>
            ) : null}
            {canFlip ? (
              <span className="pointer-events-none text-[#7f9bc4]" aria-hidden="true">
                <Info className="h-4 w-4" />
              </span>
            ) : null}
          </div>
        </div>
        <div className="flex min-w-0 items-start">
          <p className="dashboard-metric-value max-w-full font-display text-[clamp(1.75rem,4.8vw,2.2rem)] font-bold leading-none tracking-[-0.04em] text-white break-words">
            {value}
          </p>
        </div>
        <p className="line-clamp-2 text-xs leading-5 text-[#b8c8e4]">{detail}</p>
      </div>

      {canFlip && showInfo ? (
        glossary ? (
          <GlossaryBackFace glossary={glossary} onClose={() => setShowInfo(false)} />
        ) : (
          <div className="absolute inset-0 z-10 flex flex-col bg-[rgba(9,16,36,0.95)] p-4 backdrop-blur-sm">
            <div className="flex items-start justify-between gap-3">
              <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-accent-cyan">
                {eyebrow}
              </p>
              <span className="text-text-muted" aria-hidden="true">
                <X className="h-4 w-4" />
              </span>
            </div>
            <p className="mt-2 text-[13px] leading-6 text-[#c4d3ee]">{overview}</p>
            <p className="mt-auto pt-2 text-[10px] uppercase tracking-[0.18em] text-text-muted">
              Tap to close
            </p>
          </div>
        )
      ) : null}
    </div>
  );
}

function CommandHeader({
  range,
  setRange,
  isEditing,
  setIsEditing,
  refresh,
  state,
  computedAt,
  onOpenAgenda,
}: {
  range: ReturnType<typeof useDashboard>["range"];
  setRange: ReturnType<typeof useDashboard>["setRange"];
  isEditing: boolean;
  setIsEditing: (value: boolean) => void;
  refresh: ReturnType<typeof useDashboard>["refresh"];
  state: ReturnType<typeof useDashboard>["state"];
  computedAt: string;
  onOpenAgenda: () => void;
}) {
  return (
    <header className="dashboard-surface dashboard-surface-muted px-4 py-3">
      <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-accent-blue">Boardroom command center</p>
            <span className="text-[11px] text-text-muted">Updated {formatRelativeTime(computedAt)}</span>
          </div>
          <h2 className="mt-1 font-display text-2xl font-bold leading-none text-text-primary md:text-[2rem]">
            Financial command deck
          </h2>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="sm" onClick={onOpenAgenda}>
            <Sparkles className="h-4 w-4" />
            CFO Agenda
          </Button>
          <TimeRangeSelect value={range} onChange={setRange} />
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void refresh(range)}
            loading={state === "loading"}
          >
            {state === "loading" ? "Refreshing..." : "Refresh"}
          </Button>
          <Button
            variant={isEditing ? "primary" : "secondary"}
            size="sm"
            onClick={() => setIsEditing(!isEditing)}
          >
            <Settings2 className="h-4 w-4" />
            Customize
          </Button>
        </div>
      </div>
    </header>
  );
}

function CfoAgendaOverlay({
  insights,
  onClose,
  onHideToday,
  onRemindLater,
}: {
  insights: DashboardResponse["insights"];
  onClose: () => void;
  onHideToday: () => void;
  onRemindLater: () => void;
}) {
  const top = insights.slice(0, 3);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4 py-8">
      <button
        type="button"
        className="absolute inset-0 bg-[rgba(5,10,25,0.45)] backdrop-blur-md"
        aria-label="Close CFO agenda"
        onClick={onClose}
      />
      <section
        role="dialog"
        aria-modal="true"
        aria-label="CFO agenda"
        className="relative z-10 w-full max-w-5xl overflow-hidden rounded-[2rem] border border-[rgb(126,186,255,0.2)] bg-[linear-gradient(135deg,rgba(255,255,255,0.05),transparent_26%),linear-gradient(180deg,rgba(20,31,70,0.98),rgba(15,24,55,0.99))] p-6 shadow-[0_40px_120px_-40px_rgba(0,0,0,0.85)] md:p-8"
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute right-5 top-5 flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] text-white transition hover:bg-white/[0.08]"
          aria-label="Dismiss CFO agenda"
        >
          <X className="h-4 w-4" />
        </button>

        <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[#91a2ff]">
          CFO agenda
        </p>
        <h2 className="mt-3 max-w-3xl font-display text-3xl font-bold leading-tight text-white md:text-[3.2rem]">
          Decisions that deserve today
        </h2>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-[#b8c8e4]">
          A focused welcome briefing for the current finance picture. Review what changed, then jump into the dashboard when you are ready.
        </p>

        <div className="mt-6 space-y-3">
          {top.map((insight) => (
            <article
              key={insight.id}
              className="rounded-[1.4rem] border border-white/10 bg-white/[0.05] p-5 md:p-6"
            >
              <div className="flex flex-col gap-4 md:flex-row md:items-start">
                <StatusPill tone={toneFromType(insight.type)} className="w-fit md:mt-0.5">
                  {insight.type}
                </StatusPill>
                <div className="min-w-0 flex-1">
                  <p className="text-xl font-semibold text-white md:text-2xl">{insight.title}</p>
                  {insight.description ? (
                    <p className="mt-3 max-w-3xl text-base leading-8 text-[#bfd0eb]">
                      {insight.description}
                    </p>
                  ) : null}
                  <p className="mt-4 text-sm text-[#8ea9d0]">{formatRelativeTime(insight.createdAt)}</p>
                </div>
              </div>
            </article>
          ))}
        </div>

        <div className="mt-6 flex flex-col gap-3 border-t border-white/8 pt-5 md:flex-row md:items-center md:justify-between">
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={onHideToday}>
              Don&apos;t show again today
            </Button>
            <Button variant="ghost" size="sm" onClick={onRemindLater}>
              Remind me later
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={onClose}>
              Close
            </Button>
            <Button size="sm" onClick={onClose}>
              View dashboard
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}

type EditableEntry = {
  definition: { id: OverviewCardId; title: string };
  placement: OverviewCardPlacement;
};

function CanvasCard({
  isEditing,
  isSelected,
  entry,
  onSelect,
  onHide,
  children,
}: {
  isEditing: boolean;
  isSelected: boolean;
  entry: EditableEntry;
  onSelect: () => void;
  onHide: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "relative h-full",
        isEditing && "dashboard-edit-card",
        isSelected && "rounded-xl ring-2 ring-accent-blue/45 ring-offset-2 ring-offset-bg-base",
      )}
      onClick={isEditing ? onSelect : undefined}
      role={isEditing ? "button" : undefined}
      tabIndex={isEditing ? 0 : undefined}
      onKeyDown={
        isEditing
          ? (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelect();
              }
            }
          : undefined
      }
    >
      {isEditing ? (
        <>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onHide();
            }}
            className="absolute -left-2 -top-2 z-10 flex h-8 w-8 items-center justify-center rounded-full border border-default bg-feedback-danger text-white shadow-lg"
            aria-label={`Hide ${entry.definition.title}`}
          >
            <Minus className="h-4 w-4" />
          </button>
          <div className="pointer-events-none absolute inset-0 z-10 rounded-xl border border-dashed border-accent-blue/30" />
        </>
      ) : null}
      {children}
    </div>
  );
}

export function OverviewPage() {
  const { state, dashboard, error, refresh, hasLoadedOnce, range, setRange } = useDashboard();
  const { prefs } = useDashboardPreferences();
  const [agendaOpen, setAgendaOpen] = useState(false);
  const [agendaReady, setAgendaReady] = useState(false);

  const showOnboardingGuide =
    dashboard.kpis.orgCount === 0 &&
    dashboard.kpis.totalRevenue === 0 &&
    dashboard.kpis.totalInvoices === 0;

  const {
    ready: layoutReady,
    isEditing,
    setIsEditing,
    visibleCards,
    hiddenCards,
    selectedCard,
    setSelectedCardId,
    updatePlacement,
    toggleVisibility,
    movePlacement,
    resetView,
  } = useOverviewDashboardView(showOnboardingGuide);
  const agendaInsights = useMemo(
    () =>
      dashboard.insights.length > 0
        ? dashboard.insights
        : deriveInsights(dashboard.kpis, prefs.currencyDisplay),
    [dashboard.insights, dashboard.kpis, prefs.currencyDisplay],
  );
  const agendaFingerprint = useMemo(
    () => agendaInsights.slice(0, 5).map((insight) => `${insight.id}:${insight.createdAt}`).join("|"),
    [agendaInsights],
  );

  useEffect(() => {
    if (!hasLoadedOnce) return;

    const today = new Date().toISOString().slice(0, 10);
    let preference: AgendaPreference = {};

    try {
      const raw = window.localStorage.getItem(CFO_AGENDA_STORAGE_KEY);
      if (raw) preference = JSON.parse(raw) as AgendaPreference;
    } catch {
      preference = {};
    }

    const snoozed =
      preference.snoozeUntil && new Date(preference.snoozeUntil).getTime() > Date.now();
    const hiddenToday = preference.hiddenForDate === today;
    const dismissedCurrent = preference.dismissedFingerprint === agendaFingerprint;
    const firstVisit = !preference.dismissedFingerprint;
    const newInsightsAvailable = !!preference.dismissedFingerprint && !dismissedCurrent;

    const shouldOpen =
      agendaInsights.length > 0 &&
      !snoozed &&
      !hiddenToday &&
      (firstVisit || newInsightsAvailable);

    setAgendaOpen(shouldOpen);
    setAgendaReady(true);
  }, [agendaFingerprint, agendaInsights.length, hasLoadedOnce]);

  function persistAgendaPreference(next: AgendaPreference) {
    try {
      window.localStorage.setItem(CFO_AGENDA_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // ignore local storage write failures
    }
  }

  function closeAgenda() {
    setAgendaOpen(false);
    persistAgendaPreference({
      dismissedFingerprint: agendaFingerprint,
      snoozeUntil: null,
      hiddenForDate: null,
    });
  }

  function hideAgendaToday() {
    setAgendaOpen(false);
    persistAgendaPreference({
      dismissedFingerprint: agendaFingerprint,
      snoozeUntil: null,
      hiddenForDate: new Date().toISOString().slice(0, 10),
    });
  }

  function remindAgendaLater() {
    const snoozeUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    setAgendaOpen(false);
    persistAgendaPreference({
      dismissedFingerprint: null,
      snoozeUntil,
      hiddenForDate: null,
    });
  }

  if ((state === "loading" && !hasLoadedOnce) || !layoutReady) {
    return <OverviewSkeleton />;
  }

  const trend = dashboard.charts.monthlyTrend ?? [];
  const last = trend[trend.length - 1];
  const prev = trend[trend.length - 2];
  const revenueDelta = last && prev ? trendDelta(last.revenue, prev.revenue) : null;
  const invoiceDelta = last && prev ? trendDelta(last.invoices, prev.invoices) : null;
  const marginDelta =
    last && prev
      ? (() => {
          const current = marginRatio(last.revenue, last.expenses);
          const previous = marginRatio(prev.revenue, prev.expenses);
          if (current === null || previous === null) return null;
          return trendDelta(current, previous);
        })()
      : null;
  const connectedOrgCount = dashboard.connectedOrgs.length;
  const providerCount = dashboard.kpis.providerCount;
  const topEntity = dashboard.connectedOrgs[0] ?? null;
  const avgEntityRevenue = connectedOrgCount > 0 ? dashboard.kpis.totalRevenue / connectedOrgCount : 0;
  const collectionRiskRatio =
    (dashboard.kpis.openInvoiceAmount ?? 0) > 0
      ? dashboard.kpis.overdueAmount / (dashboard.kpis.openInvoiceAmount ?? 1)
      : null;

  const renderCard = (cardId: OverviewCardId) => {
    const glossary = getCardGlossary(cardId);
    const overview = glossary?.primary.definition ?? getOverviewCardDefinition(cardId)?.description;
    switch (cardId) {
      case "executive-brief":
        return <ExecutiveBriefCard dashboard={dashboard} currency={prefs.currencyDisplay} />;
      case "revenue-command":
        return (
          <MetricTile
            overview={overview}
            glossary={glossary}
            interactive={!isEditing}
            eyebrow="Revenue"
            value={formatMoneyWithCurrency(dashboard.kpis.totalRevenue, prefs.currencyDisplay)}
            detail={`${formatNumber(dashboard.kpis.totalInvoices)} invoices in scope`}
            delta={revenueDelta}
          />
        );
      case "margin-quality":
        return (
          <MetricTile
            overview={overview}
            glossary={glossary}
            interactive={!isEditing}
            eyebrow="Net Margin Percentage"
            value={formatPercentDelta(dashboard.kpis.profitMargin / 100)}
            detail={`${formatMoneyWithCurrency(dashboard.kpis.netProfit, prefs.currencyDisplay)} net contribution`}
            delta={marginDelta}
          />
        );
      case "open-invoices":
        return (
          <MetricTile
            overview={overview}
            glossary={glossary}
            interactive={!isEditing}
            eyebrow="Open Invoices"
            value={formatMoneyWithCurrency(dashboard.kpis.openInvoiceAmount, prefs.currencyDisplay)}
            detail={`${formatNumber(dashboard.kpis.openInvoiceCount ?? 0)} open · ${formatMoneyWithCurrency(dashboard.kpis.overdueAmount, prefs.currencyDisplay)} overdue`}
          />
        );
      case "cash-runway":
        return (
          <MetricTile
            overview={overview}
            glossary={glossary}
            interactive={!isEditing}
            eyebrow="Cash Runway"
            value={formatRunwayDaysFromMonths(dashboard.venture.runwayMonths)}
            detail={`${formatMoneyWithCurrency(dashboard.venture.burnRate, prefs.currencyDisplay)} monthly operating load`}
          />
        );
      case "cash-discipline":
        return (
          <CfoFocusCard
            eyebrow="Treasury radar"
            title="How quickly revenue turns into usable cash"
            items={makeCashDisciplineItems(dashboard, prefs.currencyDisplay)}
            glossary={glossary}
            interactive={!isEditing}
          />
        );
      case "working-capital":
        return (
          <MetricTile
            overview={overview}
            glossary={glossary}
            interactive={!isEditing}
            eyebrow="Working Capital"
            value={formatMoneyWithCurrency(dashboard.cfo?.workingCapital ?? 0, prefs.currencyDisplay)}
            detail={`${formatMoneyWithCurrency(dashboard.cfo?.cashBalance ?? 0, prefs.currencyDisplay)} cash balance`}
          />
        );
      case "client-concentration":
        return (
          <CfoFocusCard
            eyebrow="Concentration risk"
            title="Where client dependence can blindside the board"
            items={makeClientConcentrationItems(dashboard, prefs.currencyDisplay)}
            glossary={glossary}
            interactive={!isEditing}
          />
        );
      case "service-levels":
        return (
          <CfoFocusCard
            eyebrow="KPIs Impacting the efficiency of business"
            title="Operational strain that can quietly destroy margin"
            items={makeServiceLevelItems(dashboard)}
            glossary={glossary}
            interactive={!isEditing}
          />
        );
      case "payroll-discipline":
        return (
          <MetricTile
            overview={overview}
            glossary={glossary}
            interactive={!isEditing}
            eyebrow="High Payroll to Revenue Percentage"
            value={formatPercentDelta((dashboard.cfo?.payrollToRevenuePct ?? 0) / 100)}
            detail="Labor absorption on the latest operating month"
          />
        );
      case "cash-on-hand":
        return (
          <MetricTile
            overview={overview}
            glossary={glossary}
            interactive={!isEditing}
            eyebrow="Cash on Hand"
            value={formatMoneyWithCurrency(dashboard.venture.cashOnHand, prefs.currencyDisplay)}
            detail={`${dashboard.kpis.orgCount} connected entities`}
          />
        );
      case "overdue-exposure":
        return (
          <MetricTile
            overview={overview}
            glossary={glossary}
            interactive={!isEditing}
            eyebrow="Overdue"
            value={formatMoneyWithCurrency(dashboard.kpis.overdueAmount, prefs.currencyDisplay)}
            detail={`${formatNumber(dashboard.kpis.overdueCount)} invoices past due`}
          />
        );
      case "invoice-volume":
        return (
          <MetricTile
            overview={overview}
            glossary={glossary}
            interactive={!isEditing}
            eyebrow="Invoices"
            value={formatNumber(dashboard.kpis.totalInvoices)}
            detail={`${dashboard.kpis.providerCount} providers online`}
            delta={invoiceDelta}
          />
        );
      case "avg-invoice":
        return (
          <MetricTile
            overview={overview}
            glossary={glossary}
            interactive={!isEditing}
            eyebrow="Average Invoice"
            value={formatMoneyWithCurrency(dashboard.kpis.avgInvoiceValue, prefs.currencyDisplay)}
            detail="Across the selected scope"
          />
        );
      case "burn-rate":
        return (
          <MetricTile
            overview={overview}
            glossary={glossary}
            interactive={!isEditing}
            eyebrow="Burn Rate"
            value={formatMoneyWithCurrency(dashboard.venture.burnRate, prefs.currencyDisplay)}
            detail="Current monthly spend pressure"
          />
        );
      case "entity-count":
        return (
          <MetricTile
            overview={overview}
            glossary={glossary}
            interactive={!isEditing}
            eyebrow="Entities"
            value={formatNumber(connectedOrgCount)}
            detail={`${providerCount} provider${providerCount === 1 ? "" : "s"} feeding the backend`}
          />
        );
      case "provider-coverage":
        return (
          <MetricTile
            overview={overview}
            glossary={glossary}
            interactive={!isEditing}
            eyebrow="Coverage"
            value={formatNumber(providerCount)}
            detail={`${formatNumber(connectedOrgCount)} connected entit${connectedOrgCount === 1 ? "y" : "ies"} in scope`}
          />
        );
      case "collection-risk":
        return (
          <MetricTile
            overview={overview}
            glossary={glossary}
            interactive={!isEditing}
            eyebrow="Collection Risk"
            value={collectionRiskRatio === null ? "0%" : formatPercentDelta(collectionRiskRatio)}
            detail={`${formatNumber(dashboard.kpis.overdueCount)} overdue of ${formatNumber(dashboard.kpis.openInvoiceCount ?? 0)} open invoices`}
          />
        );
      case "largest-entity":
        return (
          <MetricTile
            overview={overview}
            glossary={glossary}
            interactive={!isEditing}
            eyebrow="Exposure of the biggest client in revenue"
            value={formatMoneyWithCurrency(topEntity?.totalRevenue ?? 0, prefs.currencyDisplay)}
            detail={topEntity ? `${topEntity.orgName} · ${topEntity.provider}` : "No connected entities in scope yet"}
          />
        );
      case "avg-entity-revenue":
        return (
          <MetricTile
            overview={overview}
            glossary={glossary}
            interactive={!isEditing}
            eyebrow="Avg Entity Revenue"
            value={formatMoneyWithCurrency(avgEntityRevenue, prefs.currencyDisplay)}
            detail="Average revenue across connected entities"
          />
        );
      case "efficiency":
        return (
          <MetricTile
            overview={overview}
            glossary={glossary}
            interactive={!isEditing}
            eyebrow="Efficiency"
            value={`${dashboard.venture.efficiencyMultiplier.toFixed(2)}x`}
            detail="Revenue generated per burn dollar"
          />
        );
      case "cashflow":
        return <CashflowCard dashboard={dashboard} currency={prefs.currencyDisplay} />;
      case "invoice-status":
        return <InvoiceStatusCard dashboard={dashboard} currency={prefs.currencyDisplay} />;
      case "next-actions":
        return (
          <NextActionsCard
            insights={dashboard.insights}
            kpis={dashboard.kpis}
            currency={prefs.currencyDisplay}
          />
        );
      case "business-units":
        return <BusinessUnitBreakdownCard dashboard={dashboard} currency={prefs.currencyDisplay} />;
      case "cost-elements":
        return <CostElementsCard dashboard={dashboard} currency={prefs.currencyDisplay} />;
      case "workforce-department":
        return <WorkforceByDepartmentCard dashboard={dashboard} currency={prefs.currencyDisplay} />;
      case "workforce-geography":
        return <WorkforceByGeographyCard dashboard={dashboard} />;
      case "delivery-centers":
        return <DeliveryCenterScorecardCard dashboard={dashboard} />;
      default:
        return null;
    }
  };

  const renderPackedCards = (
    zoneCards: Array<{ definition: { id: OverviewCardId; title: string }; placement: OverviewCardPlacement }>,
  ) => (
    <div className="grid gap-3 lg:grid-cols-12 lg:grid-flow-dense lg:items-stretch">
      {zoneCards.map((entry) => {
        return (
          <div key={entry.definition.id} className={cn(spanClass(entry.placement.size), "min-w-0")}>
            <CanvasCard
              isEditing={isEditing}
              isSelected={selectedCard?.definition.id === entry.definition.id}
              entry={entry}
              onSelect={() => setSelectedCardId(entry.definition.id)}
              onHide={() => toggleVisibility(entry.definition.id, false)}
            >
              {renderCard(entry.definition.id)}
            </CanvasCard>
          </div>
        );
      })}
    </div>
  );

  const renderHeroCards = (
    zoneCards: Array<{ definition: { id: OverviewCardId; title: string }; placement: OverviewCardPlacement }>,
  ) => (
    <div
      className={cn(
        "grid gap-3 xl:grid-cols-12 xl:grid-flow-dense xl:items-stretch",
        showOnboardingGuide ? "xl:col-span-10" : "xl:col-span-12",
      )}
    >
      {zoneCards.map((entry) => {
        const size =
          zoneCards.length === 1 && entry.placement.size === "medium"
            ? "wide"
            : entry.placement.size;

        return (
          <div key={entry.definition.id} className={cn(heroSpanClass(size), "min-w-0")}>
            <CanvasCard
              isEditing={isEditing}
              isSelected={selectedCard?.definition.id === entry.definition.id}
              entry={entry}
              onSelect={() => setSelectedCardId(entry.definition.id)}
              onHide={() => toggleVisibility(entry.definition.id, false)}
            >
              {renderCard(entry.definition.id)}
            </CanvasCard>
          </div>
        );
      })}
    </div>
  );

  // The CFO command brief acts as a hard divider:
  //   • only small KPI tiles render above it
  //   • all bigger cards (medium/wide) render below it
  const briefEntry = visibleCards.find((card) => card.definition.id === "executive-brief") ?? null;
  const smallBandCards = visibleCards.filter(
    (card) => card.definition.id !== "executive-brief" && card.placement.size === "small",
  );
  const bigBandCardsRaw = visibleCards.filter(
    (card) => card.definition.id !== "executive-brief" && card.placement.size !== "small",
  );
  // These four dimensional breakdowns must always sit directly below the CFO brief,
  // in this fixed order, whenever they are visible. Pinning here (at render time,
  // rather than via stored positions) means hiding then re-showing any of them
  // always returns it to the front of the band instead of the end.
  const pinnedBelowBrief: OverviewCardId[] = [
    "workforce-department", // Workforce
    "workforce-geography", // Global footprint
    "delivery-centers", // Service delivery
    "cost-elements", // Cost structure
  ];
  const pinnedBigBandCards = pinnedBelowBrief
    .map((cardId) => bigBandCardsRaw.find((card) => card.definition.id === cardId))
    .filter((card): card is (typeof bigBandCardsRaw)[number] => Boolean(card));
  const bigBandCards = [
    ...pinnedBigBandCards,
    ...bigBandCardsRaw.filter((card) => !pinnedBelowBrief.includes(card.definition.id)),
  ];
  const hasAnyCard = smallBandCards.length > 0 || bigBandCards.length > 0 || briefEntry !== null;

  return (
    <div className="space-y-3">
      <CommandHeader
        range={range}
        setRange={setRange}
        isEditing={isEditing}
        setIsEditing={setIsEditing}
        refresh={refresh}
        state={state}
        computedAt={dashboard.meta.computedAt}
        onOpenAgenda={() => setAgendaOpen(true)}
      />

      {agendaReady && agendaOpen ? (
        <CfoAgendaOverlay
          insights={agendaInsights}
          onClose={closeAgenda}
          onHideToday={hideAgendaToday}
          onRemindLater={remindAgendaLater}
        />
      ) : null}

      {state === "error" && error ? (
        <ErrorBanner
          title="We couldn't load your overview"
          tone="danger"
          action={
            <Button variant="secondary" size="sm" onClick={() => void refresh()}>
              Retry
            </Button>
          }
        >
          {error}
        </ErrorBanner>
      ) : null}

      {isEditing ? (
        <OverviewDashboardEditor
          visibleCards={visibleCards}
          hiddenCards={hiddenCards}
          selectedCard={selectedCard}
          onSelectCard={setSelectedCardId}
          onToggleCard={toggleVisibility}
          onMoveCard={movePlacement}
          onUpdatePlacement={updatePlacement}
          onReset={resetView}
          onClose={() => setIsEditing(false)}
        />
      ) : null}

      <section className="space-y-3" aria-label="Overview dashboard canvas">
        {/* Small KPI band — everything above the CFO command brief */}
        {smallBandCards.length > 0 || showOnboardingGuide ? (
          <div className="grid gap-3 xl:grid-cols-12">
            {smallBandCards.length > 0 ? renderHeroCards(smallBandCards) : null}
            {showOnboardingGuide ? (
              <div className="xl:col-span-2">
                <SetupCard dashboard={dashboard} onOpenCustomize={() => setIsEditing(true)} />
              </div>
            ) : null}
          </div>
        ) : null}

        {/* CFO command brief — the divider between small KPIs and the big cards */}
        {briefEntry ? renderPackedCards([briefEntry]) : null}

        {/* Big cards band — everything below the CFO command brief */}
        {bigBandCards.length > 0 ? renderPackedCards(bigBandCards) : null}

        {!hasAnyCard ? (
          <ZoneEmptyState
            title="No main cards selected"
            detail="Turn on one or more finance cards in Customize to bring the core analysis into view."
          />
        ) : null}
      </section>
    </div>
  );
}
