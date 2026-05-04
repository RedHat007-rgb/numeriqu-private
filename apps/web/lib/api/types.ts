export type AuthUser = {
  id: string;
  email?: string;
  metadata?: Record<string, unknown>;
};

export type CurrentUserResponse = {
  user: AuthUser;
  tenant: { id: string; name: string; accountType?: "SOLO" | "ORGANIZATION"; createdAt?: string };
};

export type OrganizationRole = "ADMIN" | "USER";
export type PermissionCode = "VIEW_DASHBOARD" | "CREATE_DASHBOARD" | "SHARE_DASHBOARD";

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

export type DashboardResponse = {
  kpis: {
    totalRevenue: number;
    totalExpenses: number;
    netProfit: number;
    profitMargin: number;
    totalInvoices: number;
    avgInvoiceValue: number;
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
  meta: { computedAt: string; latencyMs: number; error?: string };
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
};

export type ChatMessage = { role: "user" | "assistant" | "system"; content: string };
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
};

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
};

// ── Organisation management ────────────────────────────────────────────────

export type Organization = {
  id: string;             // connection id
  orgName: string;
  provider: string;
  providerAccountId: string;
  isActive: boolean | null;
  updatedAt: string;
  memberCount: number;
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
