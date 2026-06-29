export type OverviewDashboardZone = "hero" | "primary" | "secondary";
export type OverviewCardSize = "small" | "medium" | "wide";

export type OverviewCardId =
  | "revenue-command"
  | "margin-quality"
  | "open-invoices"
  | "cash-runway"
  | "cash-on-hand"
  | "overdue-exposure"
  | "invoice-volume"
  | "avg-invoice"
  | "burn-rate"
  | "efficiency"
  | "cashflow"
  | "invoice-status"
  | "next-actions"
  | "connected-entities"
  | "system-snapshot";

export type OverviewCardDefinition = {
  id: OverviewCardId;
  title: string;
  description: string;
  zone: OverviewDashboardZone[];
  defaultZone: OverviewDashboardZone;
  defaultSize: OverviewCardSize;
  allowedSizes: OverviewCardSize[];
  defaultVisible: boolean;
  priority: number;
  onboardingOnly?: boolean;
};

export type OverviewCardPlacement = {
  cardId: OverviewCardId;
  zone: OverviewDashboardZone;
  position: number;
  size: OverviewCardSize;
  visible: boolean;
};

export const OVERVIEW_CARD_DEFINITIONS: OverviewCardDefinition[] = [
  {
    id: "revenue-command",
    title: "Revenue",
    description: "Total billed revenue across the selected range.",
    zone: ["hero", "primary"],
    defaultZone: "hero",
    defaultSize: "small",
    allowedSizes: ["small", "medium"],
    defaultVisible: true,
    priority: 190,
  },
  {
    id: "margin-quality",
    title: "Margin Quality",
    description: "Net margin and contribution signal for the current scope.",
    zone: ["hero", "primary"],
    defaultZone: "hero",
    defaultSize: "small",
    allowedSizes: ["small", "medium"],
    defaultVisible: true,
    priority: 188,
  },
  {
    id: "open-invoices",
    title: "Open Invoices",
    description: "Uncollected invoice balance and overdue pressure.",
    zone: ["hero", "primary"],
    defaultZone: "hero",
    defaultSize: "small",
    allowedSizes: ["small", "medium"],
    defaultVisible: true,
    priority: 186,
  },
  {
    id: "cash-runway",
    title: "Cash Runway",
    description: "Months of runway based on current burn.",
    zone: ["hero", "primary"],
    defaultZone: "hero",
    defaultSize: "small",
    allowedSizes: ["small", "medium"],
    defaultVisible: true,
    priority: 184,
  },
  {
    id: "cash-on-hand",
    title: "Cash on Hand",
    description: "Current liquidity available to the workspace.",
    zone: ["primary", "secondary"],
    defaultZone: "primary",
    defaultSize: "small",
    allowedSizes: ["small", "medium"],
    defaultVisible: false,
    priority: 170,
  },
  {
    id: "overdue-exposure",
    title: "Overdue Exposure",
    description: "Past-due balance and invoice follow-up burden.",
    zone: ["primary", "secondary"],
    defaultZone: "primary",
    defaultSize: "small",
    allowedSizes: ["small", "medium"],
    defaultVisible: false,
    priority: 168,
  },
  {
    id: "invoice-volume",
    title: "Invoice Volume",
    description: "Total invoice count for the selected window.",
    zone: ["primary", "secondary"],
    defaultZone: "primary",
    defaultSize: "small",
    allowedSizes: ["small", "medium"],
    defaultVisible: false,
    priority: 166,
  },
  {
    id: "avg-invoice",
    title: "Average Invoice",
    description: "Average invoice value across current scope.",
    zone: ["primary", "secondary"],
    defaultZone: "primary",
    defaultSize: "small",
    allowedSizes: ["small", "medium"],
    defaultVisible: false,
    priority: 164,
  },
  {
    id: "burn-rate",
    title: "Burn Rate",
    description: "Current monthly burn based on synced spend.",
    zone: ["secondary", "primary"],
    defaultZone: "secondary",
    defaultSize: "small",
    allowedSizes: ["small", "medium"],
    defaultVisible: false,
    priority: 150,
  },
  {
    id: "efficiency",
    title: "Efficiency",
    description: "Revenue generated per burn dollar.",
    zone: ["secondary", "primary"],
    defaultZone: "secondary",
    defaultSize: "small",
    allowedSizes: ["small", "medium"],
    defaultVisible: false,
    priority: 148,
  },
  {
    id: "cashflow",
    title: "Cash Flow",
    description: "Spend, runway, and net position across the selected scope.",
    zone: ["primary", "secondary"],
    defaultZone: "primary",
    defaultSize: "medium",
    allowedSizes: ["medium", "wide"],
    defaultVisible: true,
    priority: 140,
  },
  {
    id: "invoice-status",
    title: "Invoice Status",
    description: "Open and overdue exposure by invoice bucket.",
    zone: ["primary", "secondary"],
    defaultZone: "primary",
    defaultSize: "medium",
    allowedSizes: ["medium", "wide"],
    defaultVisible: true,
    priority: 130,
  },
  {
    id: "next-actions",
    title: "Next Actions",
    description: "Priority finance tasks and recommendations.",
    zone: ["primary", "secondary"],
    defaultZone: "secondary",
    defaultSize: "medium",
    allowedSizes: ["medium", "wide"],
    defaultVisible: true,
    priority: 120,
  },
  {
    id: "connected-entities",
    title: "Connected Providers",
    description: "Connected accounting systems and entity coverage.",
    zone: ["primary", "secondary"],
    defaultZone: "secondary",
    defaultSize: "medium",
    allowedSizes: ["medium", "wide"],
    defaultVisible: false,
    priority: 110,
  },
  {
    id: "system-snapshot",
    title: "System Snapshot",
    description: "Freshness, scope, and status of the current overview.",
    zone: ["secondary"],
    defaultZone: "secondary",
    defaultSize: "wide",
    allowedSizes: ["wide"],
    defaultVisible: false,
    priority: 100,
  },
];

export function getOverviewCardDefinition(cardId: OverviewCardId) {
  return OVERVIEW_CARD_DEFINITIONS.find((definition) => definition.id === cardId);
}

export function getRecommendedOverviewPlacements(showOnboardingGuide: boolean): OverviewCardPlacement[] {
  let position = 0;

  return OVERVIEW_CARD_DEFINITIONS
    .filter((definition) => (definition.onboardingOnly ? showOnboardingGuide : true))
    .map((definition) => ({
      cardId: definition.id,
      zone: definition.defaultZone,
      position: position++,
      size: definition.defaultSize,
      visible: definition.onboardingOnly ? showOnboardingGuide : definition.defaultVisible,
    }));
}
