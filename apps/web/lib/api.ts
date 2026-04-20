import axios, { AxiosInstance, InternalAxiosRequestConfig } from 'axios';
import { getSupabaseClient } from './supabase';

/**
 * Browser: same-origin `/api/numeriqu` (Next rewrites → Nest) unless NEXT_PUBLIC_API_URL is set.
 * Server: direct Nest URL for any SSR usage.
 */
export function getApiBaseURL(): string {
  const explicit = process.env.NEXT_PUBLIC_API_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, '');
  if (typeof window !== 'undefined') {
    return `${window.location.origin.replace(/\/$/, '')}/api/numeriqu`;
  }
  const internal =
    process.env.API_INTERNAL_URL?.trim() ||
    process.env.API_PROXY_TARGET?.trim() ||
    'http://127.0.0.1:3000';
  return internal.replace(/\/$/, '');
}

/**
 * Event-stream POSTs must hit Nest directly. Next.js dev rewrites to `/api/numeriqu/*`
 * can buffer the whole upstream response, so the UI stays on "Streaming" with no tokens.
 */
export function getSseApiBaseURL(): string {
  const stream = process.env.NEXT_PUBLIC_API_STREAM_URL?.trim();
  if (stream) return stream.replace(/\/$/, '');
  const explicit = process.env.NEXT_PUBLIC_API_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, '');
  if (typeof window !== 'undefined') {
    return 'http://localhost:3000';
  }
  return getApiBaseURL();
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface HealthResponse {
  status: string;
  layer: string;
  ollama: boolean;
  engine: string;
  uptime: number;
  mode: string;
  advisory?: string;
}

export interface Connection {
  id: string;
  provider: 'xero' | 'quickbooks';
  orgName: string;
  orgId: string;
  isExpired: boolean;
  isActive: boolean;
  lastSyncAt: string | null;
}

export interface SyncJob {
  id: string;
  provider: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  startedAt: string;
  completedAt: string | null;
  recordsProcessed?: number;
  orgName?: string;
  error: string | null;
}

export interface DashboardResponse {
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
    monthlyTrend: any[];
    orgBreakdown: any[];
    invoiceStatus: any[];
    cashflowWaterfall: any[];
  };
  connectedOrgs: any[];
  insights: any[];
  meta: {
    computedAt: string;
    latencyMs: number;
    error?: string;
  };
}

export class ApiError extends Error {
  constructor(public message: string, public status?: number) {
    super(message);
    this.name = 'ApiError';
  }
}

const apiInstance = axios.create();

/**
 * Global Interceptor for Axios — base URL + auth
 */
apiInstance.interceptors.request.use(async (config: InternalAxiosRequestConfig) => {
  config.baseURL = getApiBaseURL();
  try {
    if (typeof window !== 'undefined') {
      const manualToken = window.localStorage.getItem('numeriqu.devToken');
      if (manualToken) {
        config.headers.Authorization = `Bearer ${manualToken}`;
        return config;
      }
    }

    const supabase = typeof window !== 'undefined' ? getSupabaseClient() : null;
    if (supabase) {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (session?.access_token) {
        config.headers.Authorization = `Bearer ${session.access_token}`;
      }
    }
  } catch (e) {
    // Silence errors during SSR or hydration
  }
  return config;
});

abstract class BaseApi {
  protected axios: AxiosInstance = apiInstance;
  constructor(protected getToken: () => Promise<string | null>) {}

  protected async getHeaders() {
    const token = await this.getToken();
    return {
      'Content-Type': 'application/json',
      'Authorization': token ? `Bearer ${token}` : '',
    };
  }
}

export class AuthApi extends BaseApi {
  async me(): Promise<{ tenant: { name: string }; user: { id: string; email?: string } }> {
    const { data } = await this.axios.get('/auth/me');
    return data;
  }
}

export class AnalyticsApi extends BaseApi {
  async getInsights() {
    const { data } = await this.axios.get('/analytics/insights');
    return data;
  }

  async dashboard(): Promise<DashboardResponse> {
    const { data } = await this.axios.get('/analytics/dashboard');
    return data;
  }
  
  async health(): Promise<HealthResponse> {
    const { data } = await this.axios.get('/analytics/health');
    return data;
  }
}

export class IntegrationsApi extends BaseApi {
  async listConnections(): Promise<Connection[]> {
    const { data } = await this.axios.get('/integrations/connections');
    return data;
  }

  async connections(): Promise<Connection[]> {
    return this.listConnections();
  }

  async listSyncJobs(): Promise<SyncJob[]> {
    const { data } = await this.axios.get('/integrations/connections/jobs');
    return data;
  }

  async syncJobs(): Promise<SyncJob[]> {
    return this.listSyncJobs();
  }

  async connectProvider(provider: string): Promise<{ url: string }> {
    const { data } = await this.axios.get(`/integrations/connect/${provider}`);
    return data;
  }

  async syncConnection(id: string): Promise<void> {
    await this.axios.post(`/integrations/connections/${id}/sync`);
  }

  async syncAllConnections(): Promise<void> {
    await this.axios.post('/integrations/connections/sync-all');
  }

  async deleteConnection(id: string): Promise<void> {
    await this.axios.delete(`/integrations/connections/${id}`);
  }
}

/** Accumulate partial SSE lines across fetch chunks so JSON is not dropped mid-line. */
async function readSseTokenStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onJsonLine: (obj: Record<string, unknown>) => void,
) {
  const decoder = new TextDecoder();
  let carry = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    carry += decoder.decode(value, { stream: true });
    const lines = carry.split('\n');
    carry = lines.pop() ?? '';
    for (const raw of lines) {
      const line = raw.replace(/\r$/, '').trim();
      if (!line.startsWith('data: ')) continue;
      try {
        onJsonLine(JSON.parse(line.slice(6)) as Record<string, unknown>);
      } catch {
        /* ignore malformed frame */
      }
    }
  }
  const tail = carry.replace(/\r$/, '').trim();
  if (tail.startsWith('data: ')) {
    try {
      onJsonLine(JSON.parse(tail.slice(6)) as Record<string, unknown>);
    } catch {
      /* ignore */
    }
  }
}

export class RagApi extends BaseApi {
  async health(): Promise<HealthResponse> {
    const { data } = await this.axios.get('/rag/health');
    return data;
  }

  async query(query: string, sessionId?: string) {
    const { data } = await this.axios.post('/rag/query', { query, sessionId });
    return data;
  }
  
  async streamQuery({ query, history, sessionId, onDelta, onMessage }: { 
    query: string; 
    history?: ChatMessage[]; 
    sessionId?: string | null;
    onDelta: (delta: string) => void;
    onMessage?: (msg: any) => void;
  }) {
    const headers = await this.getHeaders();
    const response = await fetch(`${getSseApiBaseURL()}/rag/query`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, history, sessionId }),
    });

    if (!response.ok) {
      let msg = `RAG request failed (${response.status})`;
      try {
        const t = await response.text();
        if (t) msg = t.slice(0, 800);
      } catch {
        /* ignore */
      }
      throw new ApiError(msg, response.status);
    }

    if (!response.body) return;
    await readSseTokenStream(response.body.getReader(), (parsed) => {
      if (onMessage) onMessage(parsed);
      if (parsed.type === 'token' && typeof parsed.content === 'string') {
        onDelta(parsed.content);
      }
    });
  }

  async sessions(): Promise<any[]> {
    const { data } = await this.axios.get('/rag/sessions');
    return data;
  }

  async session(id: string): Promise<any> {
    const { data } = await this.axios.get(`/rag/sessions/${id}`);
    return data;
  }
}

export class AgentApi extends BaseApi {
  async health(): Promise<HealthResponse> {
    const { data } = await this.axios.get('/agent/health');
    return data;
  }

  async query(query: string, sessionId?: string) {
    const { data } = await this.axios.post('/agent/query', { query, sessionId });
    return data;
  }
  
  async getMetrics(metric: string, grouping: string) {
    const { data } = await this.axios.get('/agent/metrics', { params: { metric, grouping } });
    return data;
  }

  async streamQuery({ query, history, sessionId, onDelta, onMessage }: { 
    query: string; 
    history?: ChatMessage[]; 
    sessionId?: string | null;
    onDelta: (delta: string) => void;
    onMessage?: (msg: any) => void;
  }) {
    const headers = await this.getHeaders();
    const response = await fetch(`${getSseApiBaseURL()}/agent/query`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, history, sessionId }),
    });

    if (!response.ok) {
      let msg = `Agent request failed (${response.status})`;
      try {
        const t = await response.text();
        if (t) msg = t.slice(0, 800);
      } catch {
        /* ignore */
      }
      throw new ApiError(msg, response.status);
    }

    if (!response.body) return;
    await readSseTokenStream(response.body.getReader(), (parsed) => {
      if (onMessage) onMessage(parsed);
      if (parsed.type === 'token' && typeof parsed.content === 'string') {
        onDelta(parsed.content);
      }
    });
  }

  async sessions(): Promise<any[]> {
    const { data } = await this.axios.get('/agent/sessions');
    return data;
  }

  async session(id: string): Promise<any> {
    const { data } = await this.axios.get(`/agent/sessions/${id}`);
    return data;
  }

  async latestDashboard(): Promise<any> {
    const { data } = await this.axios.get('/agent/dashboards/latest');
    return data;
  }
}

export default apiInstance;
