"use client";

import Link from "next/link";
import { CheckCircle2, LayoutGrid, Minus, Settings2, Sparkles } from "lucide-react";
import { Button } from "../../../components/ui/Button";
import { EmptyState } from "../../../components/ui/EmptyState";
import { ErrorBanner } from "../../../components/ui/ErrorBanner";
import { Skeleton } from "../../../components/ui/Skeleton";
import { cn } from "../../../components/ui/cn";
import { useDashboard } from "../_hooks/useDashboard";
import { useDashboardPreferences } from "../_hooks/dashboardPreferences";
import { useOverviewDashboardView } from "../_hooks/useOverviewDashboardView";
import { ConnectedEntitiesCard } from "../_components/overview/ConnectedEntitiesCard";
import { NextActionsCard } from "../_components/overview/NextActionsCard";
import { OverviewDashboardEditor } from "../_components/overview/OverviewDashboardEditor";
import { InvoiceStatusCard } from "../_components/overview/OrgBreakdownCard";
import { CashflowCard } from "../_components/overview/RevenueTrendCard";
import { SystemSnapshot } from "../_components/overview/SystemSnapshot";
import { TimeRangeSelect } from "../_components/overview/TimeRangeSelect";
import {
  formatMoneyWithCurrency,
  formatNumber,
  formatPercentDelta,
  formatRelativeTime,
} from "../_components/overview/format";
import type { DashboardResponse } from "../../../lib/api";
import type { OverviewCardId, OverviewCardPlacement } from "../_lib/overviewDashboardConfig";

function spanClass(size: OverviewCardPlacement["size"]) {
  if (size === "wide") return "lg:col-span-12";
  if (size === "medium") return "lg:col-span-6";
  return "lg:col-span-3";
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
  className,
}: {
  eyebrow: string;
  value: string;
  detail: string;
  delta?: { value: string; tone: "neutral" | "positive" | "negative" } | null;
  className?: string;
}) {
  return (
    <div className={cn("dashboard-surface h-full min-h-[132px] p-4", className)}>
      <div className="flex h-full flex-col justify-between gap-4">
        <div className="flex items-start justify-between gap-3">
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-text-muted">{eyebrow}</p>
          {delta ? (
            <span
              className={cn(
                "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold",
                delta.tone === "positive"
                  ? "bg-feedback-success/10 text-feedback-success"
                  : delta.tone === "negative"
                    ? "bg-feedback-danger/10 text-feedback-danger"
                    : "bg-bg-elevated/70 text-text-muted",
              )}
            >
              {delta.value}
            </span>
          ) : null}
        </div>
        <div>
          <p className="dashboard-metric-value font-display text-[2.35rem] font-bold leading-none text-text-primary">
            {value}
          </p>
          <p className="mt-2 line-clamp-2 text-xs leading-5 text-text-muted">{detail}</p>
        </div>
      </div>
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
}: {
  range: ReturnType<typeof useDashboard>["range"];
  setRange: ReturnType<typeof useDashboard>["setRange"];
  isEditing: boolean;
  setIsEditing: (value: boolean) => void;
  refresh: ReturnType<typeof useDashboard>["refresh"];
  state: ReturnType<typeof useDashboard>["state"];
  computedAt: string;
}) {
  return (
    <header className="dashboard-surface dashboard-surface-muted px-4 py-3">
      <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-accent-blue">Finance command</p>
            <span className="text-[11px] text-text-muted">Updated {formatRelativeTime(computedAt)}</span>
          </div>
          <h2 className="mt-1 font-display text-2xl font-bold leading-none text-text-primary md:text-[2rem]">
            Executive overview
          </h2>
        </div>
        <div className="flex flex-wrap items-center gap-2">
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

function HiddenCardTray({
  hiddenCards,
  onShow,
}: {
  hiddenCards: Array<{ definition: { id: OverviewCardId; title: string } }>;
  onShow: (cardId: OverviewCardId) => void;
}) {
  if (hiddenCards.length === 0) return null;

  return (
    <div className="dashboard-surface dashboard-surface-muted px-3 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="px-1 text-[10px] font-semibold uppercase tracking-[0.22em] text-text-muted">
          Add cards
        </span>
        {hiddenCards.map((entry) => (
          <button
            key={entry.definition.id}
            type="button"
            onClick={() => onShow(entry.definition.id)}
            className="inline-flex items-center gap-2 rounded-full border border-default bg-bg-elevated/30 px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:border-accent-blue/35 hover:text-text-primary"
          >
            <Sparkles className="h-3.5 w-3.5 text-accent-cyan" />
            {entry.definition.title}
          </button>
        ))}
      </div>
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
    cardsByZone,
    selectedCard,
    setSelectedCardId,
    updatePlacement,
    toggleVisibility,
    movePlacement,
    resetView,
  } = useOverviewDashboardView(showOnboardingGuide);

  if ((state === "loading" && !hasLoadedOnce) || !layoutReady) {
    return <OverviewSkeleton />;
  }

  const trend = dashboard.charts.monthlyTrend ?? [];
  const last = trend[trend.length - 1];
  const prev = trend[trend.length - 2];
  const revenueDelta = last && prev ? trendDelta(last.revenue, prev.revenue) : null;
  const invoiceDelta = last && prev ? trendDelta(last.invoices, prev.invoices) : null;
  const profitDelta = last && prev ? trendDelta(last.revenue - last.expenses, prev.revenue - prev.expenses) : null;
  const connectedOrgCount = dashboard.connectedOrgs.length;
  const providerCount = dashboard.kpis.providerCount;
  const topEntity = dashboard.connectedOrgs[0] ?? null;
  const avgEntityRevenue = connectedOrgCount > 0 ? dashboard.kpis.totalRevenue / connectedOrgCount : 0;
  const collectionRiskRatio =
    (dashboard.kpis.openInvoiceAmount ?? 0) > 0
      ? dashboard.kpis.overdueAmount / (dashboard.kpis.openInvoiceAmount ?? 1)
      : null;

  const renderCard = (cardId: OverviewCardId) => {
    switch (cardId) {
      case "revenue-command":
        return (
          <MetricTile
            eyebrow="Revenue"
            value={formatMoneyWithCurrency(dashboard.kpis.totalRevenue, prefs.currencyDisplay)}
            detail={`${formatNumber(dashboard.kpis.totalInvoices)} invoices in scope`}
            delta={revenueDelta}
          />
        );
      case "margin-quality":
        return (
          <MetricTile
            eyebrow="Margin Quality"
            value={formatPercentDelta(dashboard.kpis.profitMargin)}
            detail={`${formatMoneyWithCurrency(dashboard.kpis.netProfit, prefs.currencyDisplay)} net contribution`}
            delta={profitDelta}
          />
        );
      case "open-invoices":
        return (
          <MetricTile
            eyebrow="Open Invoices"
            value={formatMoneyWithCurrency(dashboard.kpis.openInvoiceAmount, prefs.currencyDisplay)}
            detail={`${formatNumber(dashboard.kpis.openInvoiceCount ?? 0)} open · ${formatMoneyWithCurrency(dashboard.kpis.overdueAmount, prefs.currencyDisplay)} overdue`}
          />
        );
      case "cash-runway":
        return (
          <MetricTile
            eyebrow="Cash Runway"
            value={`${dashboard.venture.runwayMonths.toFixed(1)} mo`}
            detail={`${formatMoneyWithCurrency(dashboard.venture.burnRate, prefs.currencyDisplay)} monthly burn`}
          />
        );
      case "cash-on-hand":
        return (
          <MetricTile
            eyebrow="Cash on Hand"
            value={formatMoneyWithCurrency(dashboard.venture.cashOnHand, prefs.currencyDisplay)}
            detail={`${dashboard.kpis.orgCount} connected entities`}
          />
        );
      case "overdue-exposure":
        return (
          <MetricTile
            eyebrow="Overdue"
            value={formatMoneyWithCurrency(dashboard.kpis.overdueAmount, prefs.currencyDisplay)}
            detail={`${formatNumber(dashboard.kpis.overdueCount)} invoices past due`}
          />
        );
      case "invoice-volume":
        return (
          <MetricTile
            eyebrow="Invoices"
            value={formatNumber(dashboard.kpis.totalInvoices)}
            detail={`${dashboard.kpis.providerCount} providers online`}
            delta={invoiceDelta}
          />
        );
      case "avg-invoice":
        return (
          <MetricTile
            eyebrow="Average Invoice"
            value={formatMoneyWithCurrency(dashboard.kpis.avgInvoiceValue, prefs.currencyDisplay)}
            detail="Across the selected scope"
          />
        );
      case "burn-rate":
        return (
          <MetricTile
            eyebrow="Burn Rate"
            value={formatMoneyWithCurrency(dashboard.venture.burnRate, prefs.currencyDisplay)}
            detail="Current monthly spend pressure"
          />
        );
      case "entity-count":
        return (
          <MetricTile
            eyebrow="Entities"
            value={formatNumber(connectedOrgCount)}
            detail={`${providerCount} provider${providerCount === 1 ? "" : "s"} feeding the backend`}
          />
        );
      case "provider-coverage":
        return (
          <MetricTile
            eyebrow="Coverage"
            value={formatNumber(providerCount)}
            detail={`${formatNumber(connectedOrgCount)} connected entit${connectedOrgCount === 1 ? "y" : "ies"} in scope`}
          />
        );
      case "collection-risk":
        return (
          <MetricTile
            eyebrow="Collection Risk"
            value={collectionRiskRatio === null ? "0%" : formatPercentDelta(collectionRiskRatio)}
            detail={`${formatNumber(dashboard.kpis.overdueCount)} overdue of ${formatNumber(dashboard.kpis.openInvoiceCount ?? 0)} open invoices`}
          />
        );
      case "largest-entity":
        return (
          <MetricTile
            eyebrow="Largest Entity"
            value={formatMoneyWithCurrency(topEntity?.totalRevenue ?? 0, prefs.currencyDisplay)}
            detail={topEntity ? `${topEntity.orgName} · ${topEntity.provider}` : "No connected entities in scope yet"}
          />
        );
      case "avg-entity-revenue":
        return (
          <MetricTile
            eyebrow="Avg Entity Revenue"
            value={formatMoneyWithCurrency(avgEntityRevenue, prefs.currencyDisplay)}
            detail="Average revenue across connected entities"
          />
        );
      case "efficiency":
        return (
          <MetricTile
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
      case "connected-entities":
        return (
          <ConnectedEntitiesCard orgs={dashboard.connectedOrgs} currency={prefs.currencyDisplay} />
        );
      case "system-snapshot":
        return (
          <SystemSnapshot
            meta={dashboard.meta}
            fiscalYearStart={prefs.fiscalYearStart}
            timezone={prefs.timezone}
          />
        );
      default:
        return null;
    }
  };

  const renderZone = (
    zoneCards: Array<{ definition: { id: OverviewCardId; title: string }; placement: OverviewCardPlacement }>,
  ) => (
    <div className="grid gap-3 lg:grid-cols-12">
      {zoneCards.map((entry) => {
        const size =
          zoneCards.length === 1 && entry.placement.size === "medium"
            ? "wide"
            : entry.placement.size;

        return (
          <div key={entry.definition.id} className={spanClass(size)}>
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
        "grid gap-3 sm:grid-cols-2",
        showOnboardingGuide ? "xl:col-span-8 xl:grid-cols-2" : "xl:col-span-12 xl:grid-cols-4",
      )}
    >
      {zoneCards.map((entry) => (
        <CanvasCard
          key={entry.definition.id}
          isEditing={isEditing}
          isSelected={selectedCard?.definition.id === entry.definition.id}
          entry={entry}
          onSelect={() => setSelectedCardId(entry.definition.id)}
          onHide={() => toggleVisibility(entry.definition.id, false)}
        >
          {renderCard(entry.definition.id)}
        </CanvasCard>
      ))}
    </div>
  );

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
      />

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
        {cardsByZone.hero.length > 0 || showOnboardingGuide ? (
          <div className="grid gap-3 xl:grid-cols-12">
            {cardsByZone.hero.length > 0 ? renderHeroCards(cardsByZone.hero) : null}
            {showOnboardingGuide ? (
              <div className="xl:col-span-4">
                <SetupCard dashboard={dashboard} onOpenCustomize={() => setIsEditing(true)} />
              </div>
            ) : null}
          </div>
        ) : null}

        {cardsByZone.primary.length === 0 ? (
          <ZoneEmptyState
            title="No main cards selected"
            detail="Turn on one or more finance cards in Customize to bring the core analysis into view."
          />
        ) : (
          renderZone(cardsByZone.primary)
        )}

        {cardsByZone.secondary.length > 0 ? renderZone(cardsByZone.secondary) : null}

        {isEditing ? (
          <HiddenCardTray
            hiddenCards={hiddenCards}
            onShow={(cardId) => {
              toggleVisibility(cardId, true);
              setSelectedCardId(cardId);
            }}
          />
        ) : null}
      </section>
    </div>
  );
}
