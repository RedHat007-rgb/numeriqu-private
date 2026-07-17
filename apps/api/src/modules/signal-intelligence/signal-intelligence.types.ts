export type SignalSeverity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type SignalStatus =
  | "NEW"
  | "ACKNOWLEDGED"
  | "INVESTIGATING"
  | "RESOLVED"
  | "DISMISSED";

export type SignalType =
  | "REVENUE_VARIANCE"
  | "MARGIN_PRESSURE"
  | "CASH_RISK"
  | "COLLECTIONS_RISK"
  | "CONCENTRATION_RISK"
  | "PAYROLL_PRESSURE"
  | "UTILIZATION_RISK";

export type SignalEntityScope = {
  kind: "organization" | "entity" | "group";
  entityId?: string | null;
  entityName?: string | null;
  provider?: string | null;
};

export type SignalTimeWindow = {
  kind: "current_month" | "last_month" | "last_3_months" | "last_6_months";
  start?: string | null;
  end?: string | null;
  label?: string | null;
};

export type SignalComparisonWindow = {
  kind: "previous_month" | "previous_period" | "rolling_average";
  start?: string | null;
  end?: string | null;
  label?: string | null;
};

export type SignalMetricSummary = {
  id: string;
  metricKey: string;
  label: string;
  unit: string | null;
  description: string | null;
  isActive: boolean;
};

export type SignalEvidenceSection = {
  id: string;
  evidenceType: string;
  title: string;
  sortOrder: number;
  payload: Record<string, unknown>;
};

export type SignalCommentSummary = {
  id: string;
  authorId: string;
  authorEmail: string;
  content: string;
  createdAt: string;
  updatedAt: string;
};

export type SignalSummary = {
  id: string;
  title: string;
  summary: string;
  signalType: SignalType;
  severity: SignalSeverity;
  status: SignalStatus;
  impactAmount: number;
  confidenceScore: number;
  metric: SignalMetricSummary;
  entityScope: SignalEntityScope;
  timeWindow: SignalTimeWindow;
  comparisonWindow: SignalComparisonWindow;
  assignedToUserId: string | null;
  assignedToEmail: string | null;
  acknowledgedAt: string | null;
  dismissedAt: string | null;
  dismissedReason: string | null;
  evidenceComputedAt: string | null;
  lastRefreshedAt: string | null;
  createdAt: string;
  updatedAt: string;
  evidenceCount?: number;
  commentCount?: number;
};

export type SignalDetail = SignalSummary & {
  evidence: SignalEvidenceSection[];
  comments: SignalCommentSummary[];
  boardPacks: SignalBoardPackSummary[];
};

export type SignalBoardPackPayload = {
  executiveSummary: string;
  sections: Array<{
    heading: string;
    body: string;
    type: "narrative" | "kpi" | "table" | "chart";
    data?: Record<string, unknown>;
  }>;
};

export type SignalBoardPackSummary = {
  id: string;
  title: string;
  audience: string;
  exportFormat: string;
  dashboardId: string | null;
  createdById: string;
  createdByEmail: string | null;
  createdAt: string;
  updatedAt: string;
  payload: SignalBoardPackPayload;
};

export type SignalWatchlistItemSummary = {
  id: string;
  metricKey: string;
  entityId: string | null;
  entityLabel: string | null;
  thresholdType: string;
  thresholdValue: number;
  severity: SignalSeverity;
  createdAt: string;
};

export type SignalWatchlistSummary = {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
  items: SignalWatchlistItemSummary[];
};

export type SignalActionStep = {
  label: string;
  description: string;
};

export type SignalNarrative = {
  executiveAngle: string;
  likelyDriver: string;
  recommendedAction: string;
  watchlistNote: string;
  actionSteps: SignalActionStep[];
};

export type SignalMetricsOverview = {
  signalCount: number;
  newCount: number;
  investigatingCount: number;
  dismissedCount: number;
  criticalCount: number;
  averageConfidence: number;
  totalImpact: number;
};
