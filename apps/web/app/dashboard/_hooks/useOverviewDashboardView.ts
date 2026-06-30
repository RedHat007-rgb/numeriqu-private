"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  OVERVIEW_CARD_DEFINITIONS,
  getOverviewCardDefinition,
  getRecommendedOverviewPlacements,
  type OverviewCardDefinition,
  type OverviewCardId,
  type OverviewDashboardZone,
  type OverviewCardPlacement,
} from "../_lib/overviewDashboardConfig";

const STORAGE_KEY = "nq.dashboard.overview.view.v6";

function shouldPromoteToHero(definition: OverviewCardDefinition, candidate: Partial<OverviewCardPlacement>) {
  return (
    definition.defaultSize === "small" &&
    definition.zone.includes("hero") &&
    candidate.visible === true &&
    candidate.zone !== "hero"
  );
}

function normalizePlacements(input: unknown, showOnboardingGuide: boolean): OverviewCardPlacement[] {
  const defaults = getRecommendedOverviewPlacements(showOnboardingGuide);
  if (!Array.isArray(input)) return defaults;

  const defaultMap = new Map(defaults.map((placement) => [placement.cardId, placement]));
  const normalized: OverviewCardPlacement[] = [];

  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const candidate = item as Partial<OverviewCardPlacement>;
    if (!candidate.cardId || !defaultMap.has(candidate.cardId)) continue;

    const definition = getOverviewCardDefinition(candidate.cardId);
    const fallback = defaultMap.get(candidate.cardId);
    if (!definition || !fallback) continue;
    if (definition.onboardingOnly && !showOnboardingGuide) continue;

    normalized.push({
      cardId: candidate.cardId,
      zone: shouldPromoteToHero(definition, candidate)
        ? "hero"
        : candidate.zone && definition.zone.includes(candidate.zone)
          ? candidate.zone
          : fallback.zone,
      size: candidate.size && definition.allowedSizes.includes(candidate.size) ? candidate.size : fallback.size,
      visible:
        candidate.cardId === "next-actions"
          ? false
          : typeof candidate.visible === "boolean"
            ? candidate.visible
            : fallback.visible,
      position: Number.isFinite(candidate.position) ? Number(candidate.position) : fallback.position,
    });
  }

  for (const fallback of defaults) {
    if (!normalized.some((placement) => placement.cardId === fallback.cardId)) normalized.push(fallback);
  }

  return normalized;
}

function sortPlacements(placements: OverviewCardPlacement[]) {
  return [...placements].sort((left, right) => {
    if (left.zone !== right.zone) {
      const zoneOrder = { hero: 0, primary: 1, secondary: 2 };
      return zoneOrder[left.zone] - zoneOrder[right.zone];
    }
    if (left.position !== right.position) return left.position - right.position;
    const leftPriority = getOverviewCardDefinition(left.cardId)?.priority ?? 0;
    const rightPriority = getOverviewCardDefinition(right.cardId)?.priority ?? 0;
    return rightPriority - leftPriority;
  });
}

function preferredRevealZone(cardId: OverviewCardId): OverviewDashboardZone | null {
  const definition = getOverviewCardDefinition(cardId);
  if (!definition) return null;
  if (definition.defaultSize === "small" && definition.zone.includes("hero")) return "hero";
  if (definition.zone.includes("primary")) return "primary";
  if (definition.zone.includes("hero")) return "hero";
  if (definition.zone.includes("secondary")) return "secondary";
  return null;
}

function revealPlacement(
  placements: OverviewCardPlacement[],
  cardId: OverviewCardId,
): Pick<OverviewCardPlacement, "zone" | "position"> | null {
  const definition = getOverviewCardDefinition(cardId);
  const zone = preferredRevealZone(cardId);
  if (!definition || !zone) return null;

  const targetPlacements = placements.filter((placement) => placement.zone === zone);
  const minPosition = targetPlacements.length > 0
    ? Math.min(...targetPlacements.map((placement) => placement.position))
    : 0;

  if (zone === "primary") {
    const brief = placements.find((placement) => placement.cardId === "executive-brief");
    if (brief?.visible && brief.zone === "primary") {
      return { zone, position: brief.position - 1 };
    }
  }

  return { zone, position: minPosition - 1 };
}

export function useOverviewDashboardView(showOnboardingGuide: boolean) {
  const [placements, setPlacements] = useState<OverviewCardPlacement[]>(() =>
    getRecommendedOverviewPlacements(showOnboardingGuide),
  );
  const [ready, setReady] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [selectedCardId, setSelectedCardId] = useState<OverviewCardId | null>(null);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) setPlacements(normalizePlacements(JSON.parse(raw), showOnboardingGuide));
      else setPlacements(getRecommendedOverviewPlacements(showOnboardingGuide));
    } catch {
      setPlacements(getRecommendedOverviewPlacements(showOnboardingGuide));
    } finally {
      setReady(true);
    }
  }, [showOnboardingGuide]);

  const persist = useCallback((next: OverviewCardPlacement[]) => {
    setPlacements(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // ignore storage write failures
    }
  }, []);

  const updatePlacement = useCallback(
    (cardId: OverviewCardId, patch: Partial<OverviewCardPlacement>) => {
      const definition = getOverviewCardDefinition(cardId);
      if (!definition) return;

      persist(
        placements.map((placement) => {
          if (placement.cardId !== cardId) return placement;
          return {
            ...placement,
            ...patch,
            zone: patch.zone && definition.zone.includes(patch.zone) ? patch.zone : placement.zone,
            size: patch.size && definition.allowedSizes.includes(patch.size) ? patch.size : placement.size,
          };
        }),
      );
    },
    [persist, placements],
  );

  const toggleVisibility = useCallback(
    (cardId: OverviewCardId, force?: boolean) => {
      const current = placements.find((placement) => placement.cardId === cardId);
      if (!current) return;

      const nextVisible = typeof force === "boolean" ? force : !current.visible;
      const reveal = !current.visible && nextVisible ? revealPlacement(placements, cardId) : null;

      persist(
        placements.map((placement) => {
          if (placement.cardId !== cardId) return placement;
          return {
            ...placement,
            visible: nextVisible,
            zone: reveal?.zone ?? placement.zone,
            position: reveal?.position ?? placement.position,
          };
        }),
      );
    },
    [persist, placements],
  );

  const movePlacement = useCallback(
    (cardId: OverviewCardId, direction: "up" | "down") => {
      const current = placements.find((placement) => placement.cardId === cardId);
      if (!current) return;
      const siblings = placements
        .filter((placement) => placement.zone === current.zone && placement.visible)
        .sort((left, right) => left.position - right.position);
      const index = siblings.findIndex((placement) => placement.cardId === cardId);
      const swapIndex = direction === "up" ? index - 1 : index + 1;
      if (index < 0 || swapIndex < 0 || swapIndex >= siblings.length) return;
      const target = siblings[swapIndex];
      if (!target) return;

      persist(
        placements.map((placement) => {
          if (placement.cardId === current.cardId) return { ...placement, position: target.position };
          if (placement.cardId === target.cardId) return { ...placement, position: current.position };
          return placement;
        }),
      );
    },
    [persist, placements],
  );

  const resetView = useCallback(() => {
    persist(getRecommendedOverviewPlacements(showOnboardingGuide));
    setSelectedCardId(null);
    setIsEditing(false);
  }, [persist, showOnboardingGuide]);

  const cards = useMemo(() => {
    const placementMap = new Map(placements.map((placement) => [placement.cardId, placement]));
    return OVERVIEW_CARD_DEFINITIONS
      .filter((definition) => (definition.onboardingOnly ? showOnboardingGuide : true))
      .map((definition) => ({
        definition,
        placement:
          placementMap.get(definition.id) ??
          getRecommendedOverviewPlacements(showOnboardingGuide).find((placement) => placement.cardId === definition.id)!,
      }))
      .sort((left, right) => left.placement.position - right.placement.position);
  }, [placements, showOnboardingGuide]);

  const visibleCards = useMemo(
    () => cards.filter((card) => card.placement.visible),
    [cards],
  );

  const hiddenCards = useMemo(
    () => cards.filter((card) => !card.placement.visible),
    [cards],
  );

  const cardsByZone = useMemo(() => {
    const zones: Record<"hero" | "primary" | "secondary", Array<{ definition: OverviewCardDefinition; placement: OverviewCardPlacement }>> = {
      hero: [],
      primary: [],
      secondary: [],
    };

    for (const card of visibleCards) zones[card.placement.zone].push(card);

    return {
      hero: sortPlacements(zones.hero.map((entry) => entry.placement)).map((placement) =>
        visibleCards.find((card) => card.placement.cardId === placement.cardId)!,
      ),
      primary: sortPlacements(zones.primary.map((entry) => entry.placement)).map((placement) =>
        visibleCards.find((card) => card.placement.cardId === placement.cardId)!,
      ),
      secondary: sortPlacements(zones.secondary.map((entry) => entry.placement)).map((placement) =>
        visibleCards.find((card) => card.placement.cardId === placement.cardId)!,
      ),
    };
  }, [visibleCards]);

  const selectedCard =
    cards.find((card) => card.definition.id === selectedCardId) ??
    visibleCards[0] ??
    hiddenCards[0] ??
    null;

  useEffect(() => {
    if (!selectedCard && cards[0]) setSelectedCardId(cards[0].definition.id);
  }, [cards, selectedCard]);

  return {
    ready,
    isEditing,
    setIsEditing,
    cards,
    visibleCards,
    hiddenCards,
    cardsByZone,
    selectedCard,
    selectedCardId,
    setSelectedCardId,
    updatePlacement,
    toggleVisibility,
    movePlacement,
    resetView,
  };
}
