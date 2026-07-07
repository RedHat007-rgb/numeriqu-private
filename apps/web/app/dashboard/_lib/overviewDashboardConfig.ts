export type OverviewDashboardZone = "hero" | "primary" | "secondary";
export type OverviewCardSize = "small" | "medium" | "wide";

export type OverviewCardId =
  | "executive-brief"
  | "revenue-command"
  | "margin-quality"
  | "open-invoices"
  | "cash-runway"
  | "cash-discipline"
  | "working-capital"
  | "client-concentration"
  | "service-levels"
  | "payroll-discipline"
  | "cash-on-hand"
  | "overdue-exposure"
  | "invoice-volume"
  | "avg-invoice"
  | "burn-rate"
  | "entity-count"
  | "provider-coverage"
  | "collection-risk"
  | "largest-entity"
  | "avg-entity-revenue"
  | "efficiency"
  | "cashflow"
  | "next-actions"
  | "business-units"
  | "cost-elements"
  | "workforce-department"
  | "workforce-geography"
  | "delivery-centers";

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
    id: "executive-brief",
    title: "Board Brief",
    description: "A board-ready command strip showing where capital, risk, and delivery pressure are moving.",
    zone: ["primary", "hero"],
    defaultZone: "primary",
    defaultSize: "wide",
    allowedSizes: ["medium", "wide"],
    defaultVisible: true,
    priority: 220,
  },
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
    title: "Gross Margin Percentage",
    description: "Gross margin percentage (gross profit ÷ revenue) for the current scope.",
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
    id: "cash-discipline",
    title: "Treasury Radar",
    description: "Free cash flow, operating cash flow, and cash-conversion pressure in one view.",
    zone: ["primary", "secondary"],
    defaultZone: "primary",
    defaultSize: "medium",
    allowedSizes: ["medium", "wide"],
    defaultVisible: true,
    priority: 182,
  },
  {
    id: "working-capital",
    title: "Working Capital",
    description: "Cash, AR, AP, and liquidity pressure in one place.",
    zone: ["hero", "primary"],
    defaultZone: "hero",
    defaultSize: "small",
    allowedSizes: ["small", "medium"],
    defaultVisible: true,
    priority: 181,
  },
  {
    id: "client-concentration",
    title: "Concentration Risk",
    description: "Shows whether revenue dependence is becoming a renewal or pricing risk.",
    zone: ["primary", "secondary"],
    defaultZone: "secondary",
    defaultSize: "medium",
    allowedSizes: ["medium", "wide"],
    defaultVisible: false,
    priority: 179,
  },
  {
    id: "service-levels",
    title: "KPIs Impacting the efficiency of business",
    description: "Operational reliability metrics that can silently erode margin quality.",
    zone: ["primary", "secondary"],
    defaultZone: "secondary",
    defaultSize: "medium",
    allowedSizes: ["medium", "wide"],
    defaultVisible: false,
    priority: 178,
  },
  {
    id: "payroll-discipline",
    title: "High Payroll to Revenue Percentage",
    description: "Protect margin by tracking payroll absorption against revenue.",
    zone: ["hero", "secondary", "primary"],
    defaultZone: "secondary",
    defaultSize: "small",
    allowedSizes: ["small", "medium"],
    defaultVisible: false,
    priority: 177,
  },
  {
    id: "cash-on-hand",
    title: "Cash on Hand",
    description: "Current liquidity available to the workspace.",
    zone: ["hero", "primary", "secondary"],
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
    zone: ["hero", "primary", "secondary"],
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
    zone: ["hero", "primary", "secondary"],
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
    zone: ["hero", "primary", "secondary"],
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
    zone: ["hero", "secondary", "primary"],
    defaultZone: "secondary",
    defaultSize: "small",
    allowedSizes: ["small", "medium"],
    defaultVisible: false,
    priority: 150,
  },
  {
    id: "entity-count",
    title: "Entity Count",
    description: "How many legal entities are currently represented in the backend.",
    zone: ["hero", "secondary", "primary"],
    defaultZone: "secondary",
    defaultSize: "small",
    allowedSizes: ["small", "medium"],
    defaultVisible: false,
    priority: 149,
  },
  {
    id: "provider-coverage",
    title: "Provider Coverage",
    description: "How many finance systems are actively feeding the workspace.",
    zone: ["hero", "secondary", "primary"],
    defaultZone: "secondary",
    defaultSize: "small",
    allowedSizes: ["small", "medium"],
    defaultVisible: false,
    priority: 147,
  },
  {
    id: "collection-risk",
    title: "Collection Risk",
    description: "Share of open receivables that are already overdue.",
    zone: ["hero", "secondary", "primary"],
    defaultZone: "secondary",
    defaultSize: "small",
    allowedSizes: ["small", "medium"],
    defaultVisible: false,
    priority: 146,
  },
  {
    id: "largest-entity",
    title: "Exposure of the biggest client in revenue",
    description: "Revenue exposure from the largest client in the current scope.",
    zone: ["hero", "secondary", "primary"],
    defaultZone: "secondary",
    defaultSize: "small",
    allowedSizes: ["small", "medium"],
    defaultVisible: false,
    priority: 145,
  },
  {
    id: "avg-entity-revenue",
    title: "Avg Entity Revenue",
    description: "Average revenue generated per connected entity.",
    zone: ["hero", "secondary", "primary"],
    defaultZone: "secondary",
    defaultSize: "small",
    allowedSizes: ["small", "medium"],
    defaultVisible: false,
    priority: 144,
  },
  {
    id: "efficiency",
    title: "Efficiency",
    description: "Revenue generated per burn dollar.",
    zone: ["hero", "secondary", "primary"],
    defaultZone: "secondary",
    defaultSize: "small",
    allowedSizes: ["small", "medium"],
    defaultVisible: false,
    priority: 148,
  },
  {
    id: "cashflow",
    title: "Capital Bridge",
    description: "The movement from revenue to cost, payroll, and residual cash power.",
    zone: ["primary", "secondary"],
    defaultZone: "primary",
    defaultSize: "medium",
    allowedSizes: ["medium", "wide"],
    defaultVisible: true,
    priority: 140,
  },
  {
    id: "next-actions",
    title: "CFO Agenda",
    description: "Priority finance actions that deserve executive attention next.",
    zone: ["primary", "secondary"],
    defaultZone: "secondary",
    defaultSize: "medium",
    allowedSizes: ["medium", "wide"],
    defaultVisible: false,
    priority: 120,
  },
  {
    id: "business-units",
    title: "Business Unit Performance",
    description: "Revenue and gross margin ranked by business unit, so you can see where the portfolio earns.",
    zone: ["primary", "secondary"],
    defaultZone: "primary",
    defaultSize: "medium",
    allowedSizes: ["medium", "wide"],
    defaultVisible: true,
    priority: 176,
  },
  {
    id: "cost-elements",
    title: "Payroll Elements",
    description: "Total payroll broken into base salary, overtime, bonus, and benefits.",
    zone: ["primary", "secondary"],
    defaultZone: "primary",
    defaultSize: "medium",
    allowedSizes: ["medium", "wide"],
    defaultVisible: true,
    priority: 175,
  },
  {
    id: "workforce-department",
    title: "Workforce by Department",
    description: "Headcount and payroll distribution across departments.",
    zone: ["primary", "secondary"],
    defaultZone: "secondary",
    defaultSize: "medium",
    allowedSizes: ["medium", "wide"],
    defaultVisible: true,
    priority: 174,
  },
  {
    id: "workforce-geography",
    title: "Global Delivery Footprint",
    description: "Delivery headcount ranked by geography and country.",
    zone: ["primary", "secondary"],
    defaultZone: "secondary",
    defaultSize: "medium",
    allowedSizes: ["medium", "wide"],
    defaultVisible: true,
    priority: 173,
  },
  {
    id: "delivery-centers",
    title: "Delivery Center Scorecard",
    description: "SLA compliance, utilization, and CSAT ranked by delivery center.",
    zone: ["primary", "secondary"],
    defaultZone: "secondary",
    defaultSize: "medium",
    allowedSizes: ["medium", "wide"],
    defaultVisible: true,
    priority: 172,
  },
];

export function getOverviewCardDefinition(cardId: OverviewCardId) {
  return OVERVIEW_CARD_DEFINITIONS.find((definition) => definition.id === cardId);
}

export function getRecommendedOverviewPlacements(showOnboardingGuide: boolean): OverviewCardPlacement[] {
  const recommended: OverviewCardPlacement[] = [
    { cardId: "revenue-command", zone: "hero", position: 0, size: "small", visible: true },
    { cardId: "margin-quality", zone: "hero", position: 1, size: "small", visible: true },
    { cardId: "open-invoices", zone: "hero", position: 2, size: "small", visible: true },
    { cardId: "cash-runway", zone: "hero", position: 3, size: "small", visible: true },
    { cardId: "working-capital", zone: "hero", position: 4, size: "small", visible: true },
    { cardId: "collection-risk", zone: "hero", position: 5, size: "small", visible: true },
    { cardId: "executive-brief", zone: "primary", position: 6, size: "wide", visible: true },
    { cardId: "cash-discipline", zone: "primary", position: 7, size: "medium", visible: true },
    { cardId: "cashflow", zone: "primary", position: 8, size: "medium", visible: true },
    { cardId: "client-concentration", zone: "primary", position: 10, size: "medium", visible: true },
    { cardId: "service-levels", zone: "secondary", position: 11, size: "medium", visible: true },
    { cardId: "next-actions", zone: "secondary", position: 12, size: "medium", visible: false },
    { cardId: "cash-on-hand", zone: "secondary", position: 14, size: "small", visible: false },
    { cardId: "overdue-exposure", zone: "secondary", position: 15, size: "small", visible: false },
    { cardId: "invoice-volume", zone: "secondary", position: 16, size: "small", visible: false },
    { cardId: "avg-invoice", zone: "secondary", position: 17, size: "small", visible: false },
    { cardId: "burn-rate", zone: "secondary", position: 18, size: "small", visible: false },
    { cardId: "entity-count", zone: "secondary", position: 19, size: "small", visible: false },
    { cardId: "provider-coverage", zone: "secondary", position: 20, size: "small", visible: false },
    { cardId: "largest-entity", zone: "secondary", position: 21, size: "small", visible: false },
    { cardId: "avg-entity-revenue", zone: "secondary", position: 22, size: "small", visible: false },
    { cardId: "efficiency", zone: "secondary", position: 23, size: "small", visible: false },
    { cardId: "payroll-discipline", zone: "secondary", position: 24, size: "small", visible: false },
    { cardId: "business-units", zone: "primary", position: 25, size: "medium", visible: true },
    { cardId: "cost-elements", zone: "primary", position: 26, size: "medium", visible: true },
    { cardId: "workforce-department", zone: "secondary", position: 27, size: "medium", visible: true },
    { cardId: "workforce-geography", zone: "secondary", position: 28, size: "medium", visible: true },
    { cardId: "delivery-centers", zone: "secondary", position: 29, size: "medium", visible: true },
  ];

  return recommended
    .filter((placement) => {
      const definition = getOverviewCardDefinition(placement.cardId);
      return definition ? (definition.onboardingOnly ? showOnboardingGuide : true) : false;
    })
    .map((placement) => {
      const definition = getOverviewCardDefinition(placement.cardId)!;
      return {
        ...placement,
        visible: definition.onboardingOnly ? showOnboardingGuide : placement.visible,
      };
    });
}
