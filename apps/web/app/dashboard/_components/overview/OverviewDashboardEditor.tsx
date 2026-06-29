"use client";

import { EyeOff, MoveLeft, MoveRight, RotateCcw, Sparkles, X } from "lucide-react";
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

  return (
    <div className="fixed inset-0 z-40 bg-black/45 backdrop-blur-[2px]">
      <button
        type="button"
        className="absolute inset-0"
        onClick={onClose}
        aria-label="Close dashboard customization"
      />

      <section className="dashboard-surface absolute right-4 top-4 z-10 flex h-[calc(100dvh-2rem)] w-full max-w-[390px] flex-col overflow-hidden p-0">
        <div className="flex items-center justify-between border-b border-default/70 px-4 py-3">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-accent-violet">Customize</p>
            <h3 className="mt-1 font-display text-lg font-bold text-text-primary">Dashboard cards</h3>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onReset} aria-label="Reset recommended dashboard">
              <RotateCcw className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close dashboard editor">
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4">
          <div className="space-y-4">
            <section>
              <div className="mb-2 flex items-center justify-between">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-text-muted">On dashboard</p>
                <StatusPill tone="info">{visibleCards.length} visible</StatusPill>
              </div>
              <div className="space-y-2">
                {visibleCards.map(({ definition, placement }) => (
                  <button
                    key={definition.id}
                    type="button"
                    onClick={() => onSelectCard(definition.id)}
                    className={cn(
                      "w-full rounded-lg border px-3 py-2.5 text-left transition-all duration-200",
                      selectedCard.definition.id === definition.id
                        ? "border-accent-blue/40 bg-accent-blue/10"
                        : "border-default bg-bg-elevated/25 hover:border-accent-blue/20",
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
            </section>

            <section>
              <div className="mb-2 flex items-center justify-between">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-text-muted">Add more finance cards</p>
                <StatusPill tone="neutral">{hiddenCards.length} available</StatusPill>
              </div>
              <div className="space-y-2">
                {hiddenCards.map(({ definition }) => (
                  <button
                    key={definition.id}
                    type="button"
                    onClick={() => {
                      onSelectCard(definition.id);
                      onToggleCard(definition.id, true);
                    }}
                    className="w-full rounded-lg border border-default bg-bg-elevated/20 px-3 py-2.5 text-left transition-colors hover:border-accent-blue/20 hover:bg-bg-elevated/35"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-medium text-text-primary">{definition.title}</span>
                      <Sparkles className="h-4 w-4 text-accent-cyan" />
                    </div>
                  </button>
                ))}
              </div>
            </section>

            <section className="rounded-lg border border-default bg-bg-elevated/25 p-4">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-text-muted">Selected</p>
                  <p className="mt-1 font-semibold text-text-primary">{selectedCard.definition.title}</p>
                </div>
                <StatusPill tone={selectedCard.placement.visible ? "info" : "neutral"}>
                  {selectedCard.placement.visible ? "Visible" : "Hidden"}
                </StatusPill>
              </div>

              <div className="mt-4 space-y-3">
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => onMoveCard(selectedCard.definition.id, "up")}
                    disabled={!selectedCard.placement.visible}
                  >
                    <MoveLeft className="h-4 w-4" />
                    Earlier
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => onMoveCard(selectedCard.definition.id, "down")}
                    disabled={!selectedCard.placement.visible}
                  >
                    <MoveRight className="h-4 w-4" />
                    Later
                  </Button>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <label className="space-y-1">
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

                  <label className="space-y-1">
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

                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full justify-center text-feedback-danger hover:bg-feedback-danger/10"
                  onClick={() => onToggleCard(selectedCard.definition.id, false)}
                >
                  <EyeOff className="h-4 w-4" />
                  Hide this card
                </Button>
              </div>
            </section>
          </div>
        </div>
      </section>
    </div>
  );
}
