"use client";

import { useEffect, useState } from "react";
import { ChevronDown, EyeOff, MoveLeft, MoveRight, Plus, RotateCcw, X } from "lucide-react";
import { Button } from "../../../../components/ui/Button";
import { StatusPill } from "../../../../components/ui/StatusPill";
import { cn } from "../../../../components/ui/cn";
import type { OverviewCardDefinition, OverviewCardPlacement } from "../../_lib/overviewDashboardConfig";

type DashboardCard = {
  definition: OverviewCardDefinition;
  placement: OverviewCardPlacement;
};

const selectClassName =
  "w-full rounded-lg border border-default bg-bg-elevated/70 px-3 py-2 text-sm text-text-primary outline-none transition-colors focus:border-accent-blue/60";

export function OverviewDashboardEditor({
  visibleCards,
  hiddenCards,
  selectedCard,
  onSelectCard,
  onToggleCard,
  onMoveCard,
  onUpdatePlacement,
  onReset,
  onClose,
}: {
  visibleCards: DashboardCard[];
  hiddenCards: DashboardCard[];
  selectedCard: DashboardCard | null;
  onSelectCard: (cardId: OverviewCardPlacement["cardId"]) => void;
  onToggleCard: (cardId: OverviewCardPlacement["cardId"], force?: boolean) => void;
  onMoveCard: (cardId: OverviewCardPlacement["cardId"], direction: "up" | "down") => void;
  onUpdatePlacement: (cardId: OverviewCardPlacement["cardId"], patch: Partial<OverviewCardPlacement>) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  if (!selectedCard) return null;
  const [showAddCards, setShowAddCards] = useState(false);

  useEffect(() => {
    const previousHtmlOverflow = document.documentElement.style.overflow;
    const previousBodyOverflow = document.body.style.overflow;
    document.documentElement.style.overflow = "hidden";
    document.body.style.overflow = "hidden";

    return () => {
      document.documentElement.style.overflow = previousHtmlOverflow;
      document.body.style.overflow = previousBodyOverflow;
    };
  }, []);

  return (
    <div className="fixed inset-0 z-50 isolate">
      <button
        type="button"
        className="absolute inset-0 bg-[rgba(5,10,25,0.58)] backdrop-blur-xl"
        onClick={onClose}
        aria-label="Close dashboard customization"
      />

      <div className="absolute inset-0 flex items-center justify-center p-3 sm:p-5">
        <section className="dashboard-surface relative z-10 flex h-full max-h-[min(900px,calc(100vh-1.5rem))] w-full max-w-5xl flex-col overflow-hidden border-[rgba(126,186,255,0.22)] bg-[linear-gradient(135deg,rgba(255,255,255,0.05),transparent_24%),linear-gradient(180deg,rgba(20,31,70,0.985),rgba(15,24,55,0.99))] p-0 shadow-[0_36px_120px_-42px_rgba(0,0,0,0.88)] sm:max-h-[calc(100vh-2.5rem)]">
          <div className="border-b border-default/70 px-5 py-4 sm:px-6 sm:py-5">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0">
                <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-accent-violet">Customize</p>
                <h3 className="mt-1 font-display text-[1.9rem] font-bold leading-none text-text-primary">
                  Dashboard cards
                </h3>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-text-secondary">
                  Curate what matters, restore hidden cards, and reshape the command deck without losing your place.
                </p>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2 lg:shrink-0">
                <StatusPill tone="info" className="h-10 px-4 text-sm">
                  {visibleCards.length} visible
                </StatusPill>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setShowAddCards((value) => !value)}
                  aria-expanded={showAddCards}
                  className="h-10 rounded-2xl px-4"
                >
                  <Plus className="h-4 w-4" />
                  Add card
                  <ChevronDown className={cn("h-4 w-4 transition-transform", showAddCards && "rotate-180")} />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onReset}
                  aria-label="Reset recommended dashboard"
                  className="h-10 w-10 rounded-2xl p-0"
                >
                  <RotateCcw className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onClose}
                  aria-label="Close dashboard editor"
                  className="h-10 w-10 rounded-2xl p-0"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>
          {showAddCards ? (
            <div className="border-b border-default/70 px-5 py-3 sm:px-6">
              <div className="rounded-[1.2rem] border border-white/10 bg-white/[0.04] p-4">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-text-muted">Add cards</p>
                    <p className="mt-1 text-sm text-text-secondary">Restore hidden cards and they&apos;ll drop back near the top automatically.</p>
                  </div>
                  <StatusPill tone="neutral">{hiddenCards.length} hidden</StatusPill>
                </div>

                {hiddenCards.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-white/10 px-3 py-3 text-sm text-text-muted">
                    Everything available is already on the dashboard.
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {hiddenCards.map(({ definition }) => (
                      <button
                        key={definition.id}
                        type="button"
                        onClick={() => {
                          onSelectCard(definition.id);
                          onToggleCard(definition.id, true);
                          setShowAddCards(false);
                        }}
                        className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-2 text-sm font-medium text-text-secondary transition-colors hover:border-accent-blue/30 hover:text-text-primary"
                      >
                        <Plus className="h-4 w-4 text-accent-cyan" />
                        {definition.title}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ) : null}

          <div className="grid min-h-0 flex-1 gap-0 lg:grid-cols-[minmax(0,1.15fr)_minmax(320px,0.85fr)]">
            <div className="min-h-0 border-b border-default/60 px-5 py-4 lg:border-b-0 lg:border-r lg:px-6">
              <div className="mb-3 flex items-center justify-between">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-text-muted">On dashboard</p>
                  <p className="mt-1 text-sm text-text-secondary">Select a card to adjust its placement and size.</p>
                </div>
                <StatusPill tone="info">{visibleCards.length} visible</StatusPill>
              </div>
              <div className="max-h-full space-y-2 overflow-y-auto overscroll-contain pr-1">
                {visibleCards.map(({ definition, placement }) => (
                  <button
                    key={definition.id}
                    type="button"
                    onClick={() => onSelectCard(definition.id)}
                    className={cn(
                      "w-full rounded-[1.1rem] border px-4 py-3.5 text-left transition-all duration-200",
                      selectedCard.definition.id === definition.id
                        ? "border-accent-blue/40 bg-accent-blue/10 shadow-[0_0_0_1px_rgba(0,119,255,0.18)]"
                        : "border-default bg-bg-elevated/25 hover:border-accent-blue/20 hover:bg-bg-elevated/35",
                    )}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-medium text-text-primary">{definition.title}</span>
                      <span className="text-[11px] text-text-muted">
                        {placement.zone === "hero"
                          ? "Top"
                          : placement.zone === "primary"
                            ? "Main"
                            : "Lower"}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            </div>

            <div className="min-h-0 px-5 py-4 lg:px-6">
              <section className="flex h-full flex-col rounded-[1.2rem] border border-default bg-bg-elevated/25 p-4">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-text-muted">Selected card</p>
                    <p className="mt-1 font-semibold text-text-primary">{selectedCard.definition.title}</p>
                  </div>
                  <StatusPill tone={selectedCard.placement.visible ? "info" : "neutral"}>
                    {selectedCard.placement.visible ? "Visible" : "Hidden"}
                  </StatusPill>
                </div>

                <div className="mt-4 flex-1 space-y-4 overflow-y-auto overscroll-contain pr-1">
                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => onMoveCard(selectedCard.definition.id, "up")}
                      disabled={!selectedCard.placement.visible}
                      className="rounded-xl"
                    >
                      <MoveLeft className="h-4 w-4" />
                      Earlier
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => onMoveCard(selectedCard.definition.id, "down")}
                      disabled={!selectedCard.placement.visible}
                      className="rounded-xl"
                    >
                      <MoveRight className="h-4 w-4" />
                      Later
                    </Button>
                  </div>

                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <label className="space-y-1.5">
                      <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-text-muted">Row</span>
                      <select
                        className={selectClassName}
                        value={selectedCard.placement.zone}
                        onChange={(event) =>
                          onUpdatePlacement(selectedCard.definition.id, {
                            zone: event.target.value as OverviewCardPlacement["zone"],
                          })
                        }
                      >
                        {selectedCard.definition.zone.map((zone) => (
                          <option key={zone} value={zone}>
                            {zone === "hero" ? "Top row" : zone === "primary" ? "Main row" : "Lower row"}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="space-y-1.5">
                      <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-text-muted">Width</span>
                      <select
                        className={selectClassName}
                        value={selectedCard.placement.size}
                        onChange={(event) =>
                          onUpdatePlacement(selectedCard.definition.id, {
                            size: event.target.value as OverviewCardPlacement["size"],
                          })
                        }
                      >
                        {selectedCard.definition.allowedSizes.map((size) => (
                          <option key={size} value={size}>
                            {size === "small" ? "Compact" : size === "medium" ? "Standard" : "Wide"}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>

                  <div className="rounded-[1rem] border border-white/8 bg-white/[0.03] p-3 text-sm text-text-secondary">
                    Use the left list to jump between cards. This panel only scrolls inside itself, so the dashboard behind stays locked and readable.
                  </div>
                </div>

                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-4 w-full justify-center rounded-xl text-feedback-danger hover:bg-feedback-danger/10"
                  onClick={() => onToggleCard(selectedCard.definition.id, false)}
                >
                  <EyeOff className="h-4 w-4" />
                  Hide this card
                </Button>
              </section>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
