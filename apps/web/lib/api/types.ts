export type AuthUser = {
  id: string;
  email?: string;
  metadata?: Record<string, unknown>;
};

export type CurrentUserResponse = {
  user: AuthUser;
  tenant: { id: string; name: string; createdAt?: string };
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
    monthlyTrend: Array<{ name: string; month: string; revenue: number; expenses: number; invoices: number }>;
    orgBreakdown: Array<{ name: string; value: number; provider?: string; invoiceCount?: number; currency?: string }>;
    invoiceStatus: Array<{ name: string; count: number; amount: number }>;
    cashflowWaterfall: Array<{ name: string; value: number; fill?: string }>;
  };
  connectedOrgs: Array<{ orgName: string; provider: string; totalRevenue: number; invoiceCount: number; currency?: string }>;
  insights: Array<{ id: string; title: string; description?: string | null; type: string; createdAt: string }>;
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

export type ChatMessage = { role: "user" | "assistant"; content: string };
export type ChatMode = "rag" | "agent";

