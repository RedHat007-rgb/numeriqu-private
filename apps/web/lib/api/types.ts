export type AuthUser = {
  id: string;
  email?: string;
  metadata?: Record<string, unknown>;
};

export type CurrentUserResponse = {
  user: AuthUser;
  tenant: {
    id: string;
    name: string;
    accountType?: "SOLO" | "ORGANIZATION";
    createdAt?: string;
  };
};

export type OrganizationRole = "ADMIN" | "USER";
export type PermissionCode =
  | "VIEW_DASHBOARD"
  | "CREATE_DASHBOARD"
  | "SHARE_DASHBOARD";

export type OrganizationContextResponse = {
  organization: {
    id: string;
    name: string;
    accountType?: string;
    createdAt: string;
    updatedAt?: string;
  };
  membership: {
    id: string;
    role: OrganizationRole;
    canViewDashboard: boolean;
    canCreateDashboard: boolean;
    canShareDashboard: boolean;
  };
};

export type OrganizationMember = {
  id: string;
  user: { id: string; email: string; fullName: string | null };
  role: OrganizationRole;
  permissions: {
    canViewDashboard: boolean;
    canCreateDashboard: boolean;
    canShareDashboard: boolean;
    grants: PermissionCode[];
  };
  joinedAt: string;
};

export type OrganizationInvite = {
  id: string;
  email: string;
  role: OrganizationRole;
  canViewDashboard: boolean;
  canCreateDashboard: boolean;
  canShareDashboard: boolean;
  status: "PENDING" | "ACCEPTED" | "REVOKED" | "EXPIRED";
  expiresAt: string;
  acceptedAt: string | null;
  createdAt: string;
};

export type MessagingConversation = {
  id: string;
  type: "DM" | "GROUP";
  createdAt: string;
  updatedAt: string;
  participants: Array<{
    userId: string;
    email: string;
    fullName: string | null;
  }>;
  latestMessage: {
    id: string;
    content: string | null;
    senderId: string;
    createdAt: string;
  } | null;
};

export type ConversationMessage = {
  id: string;
  senderId: string;
  content: string | null;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  dashboardIds: string[];
};

export type WorkspaceDashboardSummary = {
  id: string;
  title: string;
  description: string | null;
  ownerId: string;
  lastSyncedAt: string | null;
  updatedAt: string;
  charts: Array<{
    id: string;
    title: string;
    type: string;
    queryConfig: Record<string, unknown>;
    chartConfig: Record<string, unknown>;
    displayOrder: number;
  }>;
};

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
  authorEmail: string | null;
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

export type SignalDetail = SignalSummary & {
  evidence: SignalEvidenceSection[];
  comments: SignalCommentSummary[];
  boardPacks: SignalBoardPackSummary[];
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

export type DashboardResponse = {
  kpis: {
    totalRevenue: number;
    totalExpenses: number;
    netProfit: number;
    profitMargin: number;
    grossProfit?: number;
    grossMarginPct?: number;
    totalInvoices: number;
    avgInvoiceValue: number;
    openInvoiceAmount?: number;
    openInvoiceCount?: number;
    overdueAmount: number;
    overdueCount: number;
    orgCount: number;
    providerCount: number;
  };
  venture: {
    burnRate: number;
    runwayMonths: number;
    cashOnHand: number;
    efficiencyMultiplier: number;
  };
  cfo?: {
    mode: "generic" | "ebpo";
    headline: string;
    cashBalance: number;
    workingCapital: number;
    freeCashFlow: number;
    operatingCashFlow: number;
    grossMarginPct: number;
    payrollToRevenuePct: number;
    dsoDays: number;
    dpoDays: number;
    cashConversionDays: number;
    slaCompliancePct: number;
    utilizationPct: number;
    csatPct: number;
    apOutstanding?: number;
    topClientName?: string | null;
    topClientRevenue?: number;
    topClientConcentrationPct?: number;
    smallestClientName?: string | null;
    smallestClientRevenue?: number;
    smallestClientConcentrationPct?: number;
    topBusinessUnitName?: string | null;
    topBusinessUnitMarginPct?: number;
    businessUnits?: Array<{ name: string; revenue: number; cost: number; marginPct: number }>;
    costElements?: Array<{ name: string; value: number }>;
    headcountByDepartment?: Array<{ name: string; headcount: number; payroll: number }>;
    headcountByGeography?: Array<{ name: string; headcount: number }>;
    smallestDepartment?: { name: string; headcount: number; payroll: number } | null;
    smallestGeography?: { name: string; headcount: number } | null;
    deliveryCenters?: Array<{
      name: string;
      slaPct: number;
      utilizationPct: number;
      csatPct: number;
      callsHandled: number;
    }>;
    /** Latest-month mean handle time (minutes) across delivery centers. */
    avgHandleTimeMinutes?: number;
    /** Latest-month total tickets resolved across delivery centers. */
    ticketsResolved?: number;
    /** Distinct employees active within the selected range (full set, not top-6 rows). */
    workforceHeadcount?: number;
    /** Total payroll summed over the selected range. */
    workforcePayroll?: number;
    /** Distinct countries with workforce in the selected range. */
    workforceCountries?: number;
  };
  charts: {
    monthlyTrend: Array<{
      name: string;
      month: string;
      revenue: number;
      expenses: number;
      invoices: number;
    }>;
    orgBreakdown: Array<{
      name: string;
      value: number;
      provider?: string;
      invoiceCount?: number;
      currency?: string;
    }>;
    invoiceStatus: Array<{ name: string; count: number; amount: number }>;
    cashflowWaterfall: Array<{ name: string; value: number; fill?: string }>;
  };
  connectedOrgs: Array<{
    orgName: string;
    provider: string;
    totalRevenue: number;
    invoiceCount: number;
    currency?: string;
  }>;
  insights: Array<{
    id: string;
    title: string;
    description?: string | null;
    type: string;
    createdAt: string;
  }>;
  meta: {
    computedAt: string;
    latencyMs: number;
    error?: string;
    range?: TimeRange;
  };
};

export type Connection = {
  id: string;
  provider: string;
  providerAccountId: string;
  orgName: string;
  isActive: boolean | null;
  updatedAt: string;
};

export type SyncJob = {
  id: string;
  connectionId: string;
  tenantId: string;
  provider: string;
  status: string;
  recordsProcessed: number | null;
  errorDetails: string | null;
  startedAt: string | null;
  completedAt: string | null;
  syncWindowStart: string | null;
  syncWindowEnd: string | null;
  orgName: string | null;
};

export type HealthResponse = {
  status: "operational" | "degraded" | string;
  advisory?: string;
  ollama?: boolean;
  mode?: string;
  provider?: "ollama" | "openai";
  model?: string;
  backendUrl?: string;
  modelLoaded?: boolean;
  uptime?: number;
};

export type ChatMessage = {
  role: "user" | "assistant" | "system";
  content: string;
  metadata?: Record<string, unknown> | null;
};
export type ChatMode = "rag" | "agent";

export type ChatSessionSummary = {
  id: string;
  title?: string | null;
  createdAt?: string;
  updatedAt?: string;
  messageCount?: number;
};

export type ChatSessionDetail = {
  id: string;
  title?: string | null;
  messages: ChatMessage[];
};

export type ChartConfig = {
  metric: string;
  grouping: string;
  timeRange?: TimeRange | null;
  providerHint?: string | null;
  clientName?: string | null;
  clientNames?: string[] | null;
  orgId?: string | null;
  orgName?: string | null;
  breakdown?: Breakdown | null;
  topN?: number | null;
  display?: {
    donut?: boolean | null;
    highlightMaxMin?: boolean | null;
    showAllSeries?: boolean | null;
    highlightSeries?: string[] | null;
    highlightNames?: string[] | null;
    labelSeries?: string | null;
    labelMode?: "percent" | "value" | null;
    labelFormat?: "currency" | "number" | "percent" | null;
    showDataLabels?: boolean | null;
    normalized?: boolean | null;
    referenceSeries?: string | null;
    movingAverageSuffix?: string | null;
    secondaryAxisFormat?: "number" | "currency" | "percent" | null;
    secondaryLabel?: string | null;
    series?: Array<{
      key: string;
      role: "bar" | "line";
      axis: "left" | "right";
      format: "currency" | "number" | "percent";
      decimals?: number | null;
    }> | null;
    valueFormat?: "currency" | "number" | "percent" | null;
    valueDecimals?: number | null;
    requestedChartLabel?: string | null;
    colorMetric?: string | null;
    colorMetricLabel?: string | null;
    colorMetricFormat?: "currency" | "number" | "percent" | null;
    showTotals?: boolean | null;
    conditionalThreshold?: number | null;
    conditionalThresholdMode?: "columnAverage" | "rowAverage" | "overallAverage" | null;
    conditionalColor?: "green" | "red" | null;
    highlightExtremes?: "max" | "min" | "both" | null;
    highlightNegative?: boolean;
    highlightTopN?: number;
  } | null;
  /** Axis titles describing what X and Y actually represent (with units). */
  xAxisLabel?: string | null;
  yAxisLabel?: string | null;
};

export type TimeRange =
  | { kind: "ALL_TIME" }
  | { kind: "MTD" }
  | { kind: "QTD" }
  | { kind: "YTD" }
  | { kind: "SINCE_DATE"; start: string } // YYYY-MM-DD
  | { kind: "BETWEEN_DATES"; start: string; end: string } // YYYY-MM-DD
  | { kind: "LAST_N_DAYS"; days: number }
  | { kind: "LAST_N_WEEKS"; weeks: number }
  | { kind: "LAST_N_MONTHS"; months: number }
  | { kind: "LAST_N_QUARTERS"; quarters: number }
  | { kind: "LAST_N_YEARS"; years: number };

export type Breakdown = "client";

export type DashboardChart = {
  id: string;
  title: string;
  description?: string | null;
  type: string;
  config: ChartConfig;
  layoutIndex?: number;
};

export type GeneratedDashboard = {
  id: string;
  title: string;
  description?: string | null;
  charts: DashboardChart[];
};

export type MetricsResponse = {
  data: Array<Record<string, unknown>>;
  metric?: string;
  grouping?: string;
  rangeNotice?: string;
  requestedRangeLabel?: string;
  availableRange?: { start: string; end: string };
};

// Glass Ledger: the provenance behind a clicked figure — its definition, the rows
// that make it up, an independently recomputed total, and a trust stamp.
export type FigureEvidence = {
  ok: boolean;
  headline: string;
  definition: string;
  measureLabel: string;
  dimensionLabel: string;
  category: string;
  format: "currency" | "number" | "percent";
  rowsFormat?: "currency" | "number" | "percent";
  rows: Array<{ label: string; value: number }>;
  total: number;
  totalLabel?: string;
  reconciled: "match" | "mismatch" | "unchecked" | "not_applicable";
  reconcileNote: string;
  sql: string;
  error?: string;
};

// ── Organisation management ────────────────────────────────────────────────

export type Organization = {
  id: string; // connection id
  orgName: string;
  provider: string;
  providerAccountId: string;
  isActive: boolean | null;
  updatedAt: string;
  memberCount: number;
};

// ── Workspace switcher (app organizations) ─────────────────────────────────

export type WorkspaceSummary = {
  organization: {
    id: string;
    name: string;
    slug: string;
    accountType: "SOLO" | "ORGANIZATION";
    /** Per-org embedded Power BI report URL; null ⇒ no Power BI button. */
    powerBiUrl: string | null;
    createdAt: string;
    updatedAt: string;
  };
  membership: {
    id: string;
    role: OrganizationRole;
    canViewDashboard: boolean;
    canCreateDashboard: boolean;
    canShareDashboard: boolean;
    joinedAt: string;
  };
};

export type OrgMember = {
  userId: string;
  email: string;
  name: string | null;
  role: string;
  joinedAt: string;
};

export type OrgInvite = {
  id: string;
  email: string;
  role: string;
  expiresAt: string;
  createdAt: string;
};

export type OrgDetail = {
  org: Organization;
  members: OrgMember[];
  invites: OrgInvite[];
};

export type InviteDetails = {
  email: string;
  orgName: string;
  role: string;
  expired: boolean;
};

// ── Stream ─────────────────────────────────────────────────────────────────

export type StreamControlMessage = {
  type?: string;
  action?: string;
  metrics?: { sessionId?: string } & Record<string, unknown>;
  message?: string;
  [key: string]: unknown;
};

export type StreamQueryParams = {
  query: string;
  history?: ChatMessage[];
  sessionId?: string | null;
  onDelta: (delta: string) => void;
  onMessage?: (msg: StreamControlMessage) => void;
};
