import { HttpException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@repo/db';
import { createHash } from 'node:crypto';
import { PRISMA_TOKEN } from '../../database/database.module';
import { OrganizationContextService } from '../org-context/org-context.service';
import { FinancialDataService } from '../../financial-data/financial-data.service';
import { resolveLlmRuntimeConfig, type LlmProvider } from '../../common/llm/llm-config';
import type {
  SignalBoardPackPayload,
  SignalComparisonWindow,
  SignalDetail,
  SignalEntityScope,
  SignalMetricsOverview,
  SignalNarrative,
  SignalSeverity,
  SignalStatus,
  SignalSummary,
  SignalTimeWindow,
  SignalType,
  SignalWatchlistSummary,
} from './signal-intelligence.types';

type OrgTrendRow = {
  month: string;
  provider: string;
  org_id: string;
  org_name: string;
  revenue: string | number;
  invoice_count: string | number;
  currency?: string;
};

type ComputedSignal = {
  sourceKey: string;
  metricKey: string;
  signalType: SignalType;
  severity: SignalSeverity;
  title: string;
  summary: string;
  impactAmount: number;
  confidenceScore: number;
  entityScope: SignalEntityScope;
  timeWindow: SignalTimeWindow;
  comparisonWindow: SignalComparisonWindow;
  evidence: Array<{ evidenceType: string; title: string; payload: Record<string, unknown> }>;
  narrative?: SignalNarrative | null;
};

type SignalEvidenceCatalogEntry = {
  id: string;
  label: string;
  kind: 'metric' | 'trend' | 'org' | 'snapshot';
  value: unknown;
};

type SignalDiscoveryOutput = {
  sourceKey: string;
  metricKey: string;
  signalType: SignalType;
  severity: SignalSeverity;
  title: string;
  summary: string;
  entityScope: SignalEntityScope;
  timeWindow: SignalTimeWindow;
  comparisonWindow: SignalComparisonWindow;
  evidenceIds: string[];
  narrative: SignalNarrative;
};

const DEFAULT_SIGNAL_METRICS = [
  { metricKey: 'revenue', label: 'Revenue', unit: 'currency', description: 'Revenue movement and concentration.' },
  { metricKey: 'gross_margin', label: 'Gross Margin', unit: 'currency', description: 'Gross profit and margin pressure.' },
  { metricKey: 'cash_balance', label: 'Cash Balance', unit: 'currency', description: 'Cash position and runway.' },
  { metricKey: 'overdue_amount', label: 'Overdue Amount', unit: 'currency', description: 'Past due receivables pressure.' },
  { metricKey: 'payroll_to_revenue_pct', label: 'Payroll / Revenue %', unit: 'percent', description: 'Payroll pressure relative to revenue.' },
  { metricKey: 'utilization_pct', label: 'Utilization %', unit: 'percent', description: 'Delivery or workforce utilization.' },
];

const DEFAULT_WATCHLIST_NAME = 'Finance Watchlist';
const REFRESH_TTL_MS = 15 * 60 * 1000;

@Injectable()
export class SignalIntelligenceService {
  private readonly logger = new Logger(SignalIntelligenceService.name);
  private readonly llmProvider: LlmProvider;
  private readonly llmBaseUrl: string;
  private readonly llmModel: string;

  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient,
    private readonly orgContext: OrganizationContextService,
    private readonly financialData: FinancialDataService,
  ) {
    const llm = resolveLlmRuntimeConfig('llama3:latest');
    this.llmProvider = llm.provider;
    this.llmBaseUrl = llm.url;
    this.llmModel = llm.model;
  }

  async listSignals(organizationId: string, userId: string) {
    await this.orgContext.assertOrganizationMember(organizationId, userId);
    await this.ensureSignals(organizationId, userId);
    const signals = await this.prisma.signal.findMany({
      where: { organizationId },
      orderBy: [{ createdAt: 'desc' }],
      include: {
        signalMetric: true,
        assignedToUser: { select: { id: true, email: true } },
        evidence: { orderBy: { sortOrder: 'asc' } },
        comments: true,
      },
    });
    return {
      overview: this.getOverview(signals),
      signals: signals.map((signal) => this.mapSignalSummary(signal)),
      watchlists: await this.listWatchlists(organizationId, userId),
      computedAt: new Date().toISOString(),
    };
  }

  async getSignal(organizationId: string, userId: string, signalId: string) {
    await this.orgContext.assertOrganizationMember(organizationId, userId);
    await this.ensureSignals(organizationId, userId);
    const signal = await this.prisma.signal.findFirst({
      where: { id: signalId, organizationId },
      include: {
        signalMetric: true,
        assignedToUser: { select: { id: true, email: true } },
        evidence: { orderBy: { sortOrder: 'asc' } },
        comments: {
          orderBy: { createdAt: 'asc' },
          include: { author: { select: { id: true, email: true } } },
        },
        boardPacks: {
          orderBy: { createdAt: 'desc' },
          include: { createdBy: { select: { id: true, email: true } } },
        },
      },
    });
    if (!signal) {
      throw new HttpException(
        { message: 'Signal not found.', code: 'NOT_FOUND' },
        HttpStatus.NOT_FOUND,
      );
    }
    return this.mapSignalDetail(signal);
  }

  async acknowledge(organizationId: string, userId: string, signalId: string, note?: string) {
    await this.orgContext.assertOrganizationMember(organizationId, userId);
    const signal = await this.assertSignal(organizationId, signalId);
    if (signal.status === 'DISMISSED') {
      throw new HttpException(
        { message: 'Dismissed signals cannot be acknowledged.', code: 'VALIDATION_FAILED' },
        HttpStatus.BAD_REQUEST,
      );
    }
    await this.prisma.signal.update({
      where: { id: signal.id },
      data: {
        status: 'ACKNOWLEDGED',
        acknowledgedAt: signal.acknowledgedAt ?? new Date(),
        lastRefreshedAt: new Date(),
        summary: note ? `${signal.summary} Note: ${note}` : signal.summary,
      },
    });
    return { success: true };
  }

  async dismiss(organizationId: string, userId: string, signalId: string, reason: string) {
    await this.orgContext.assertOrganizationMember(organizationId, userId);
    const signal = await this.assertSignal(organizationId, signalId);
    await this.prisma.signal.update({
      where: { id: signal.id },
      data: {
        status: 'DISMISSED',
        dismissedAt: new Date(),
        dismissedReason: reason,
        lastRefreshedAt: new Date(),
      },
    });
    return { success: true };
  }

  async assign(organizationId: string, userId: string, signalId: string, assignedToUserId: string | null) {
    await this.orgContext.assertPermission(organizationId, userId, 'VIEW_DASHBOARD');
    const signal = await this.assertSignal(organizationId, signalId);
    if (assignedToUserId) {
      await this.orgContext.assertOrganizationMember(organizationId, assignedToUserId);
    }
    await this.prisma.signal.update({
      where: { id: signal.id },
      data: { assignedToUserId, lastRefreshedAt: new Date() },
    });
    return { success: true };
  }

  async addComment(organizationId: string, userId: string, signalId: string, content: string) {
    await this.orgContext.assertOrganizationMember(organizationId, userId);
    const signal = await this.assertSignal(organizationId, signalId);
    const comment = await this.prisma.signalComment.create({
      data: {
        organizationId,
        signalId: signal.id,
        authorId: userId,
        content,
      },
      include: { author: { select: { id: true, email: true } } },
    });
    return this.mapComment(comment);
  }

  async createBoardPack(
    organizationId: string,
    userId: string,
    signalId: string,
    params: { title: string; audience: string; exportFormat: string },
  ) {
    await this.orgContext.assertPermission(organizationId, userId, 'CREATE_DASHBOARD');
    const signal = await this.getSignal(organizationId, userId, signalId);
    const payload = this.buildBoardPackPayload(signal);
    const boardPack = await this.prisma.signalBoardPack.create({
      data: {
        organizationId,
        signalId: signal.id,
        title: params.title,
        audience: params.audience,
        exportFormat: params.exportFormat,
        payload: payload as Prisma.InputJsonValue,
        createdById: userId,
      },
      include: { createdBy: { select: { id: true, email: true } } },
    });
    return this.mapBoardPack(boardPack);
  }

  async listBoardPacks(organizationId: string, userId: string) {
    await this.orgContext.assertOrganizationMember(organizationId, userId);
    const boardPacks = await this.prisma.signalBoardPack.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
      include: { createdBy: { select: { id: true, email: true } } },
    });
    return boardPacks.map((pack) => this.mapBoardPack(pack));
  }

  async listWatchlists(organizationId: string, userId: string) {
    await this.orgContext.assertOrganizationMember(organizationId, userId);
    await this.ensureDefaultWatchlist(organizationId, userId);
    const watchlists = await this.prisma.signalWatchlist.findMany({
      where: { organizationId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
      include: { items: { orderBy: { createdAt: 'asc' } } },
    });
    return watchlists.map((watchlist) => ({
      id: watchlist.id,
      name: watchlist.name,
      description: watchlist.description,
      isDefault: watchlist.isDefault,
      createdAt: watchlist.createdAt.toISOString(),
      updatedAt: watchlist.updatedAt.toISOString(),
      items: watchlist.items.map((item) => ({
        id: item.id,
        metricKey: item.metricKey,
        entityId: item.entityId,
        entityLabel: item.entityLabel,
        thresholdType: item.thresholdType,
        thresholdValue: Number(item.thresholdValue),
        severity: this.normalizeSeverity(item.severity),
        createdAt: item.createdAt.toISOString(),
      })),
    })) satisfies SignalWatchlistSummary[];
  }

  async createWatchlist(
    organizationId: string,
    userId: string,
    params: { name: string; description?: string | null },
  ) {
    await this.orgContext.assertOrganizationMember(organizationId, userId);
    const watchlist = await this.prisma.signalWatchlist.create({
      data: {
        organizationId,
        ownerId: userId,
        name: params.name,
        description: params.description ?? null,
      },
    });
    return watchlist;
  }

  async deleteWatchlist(organizationId: string, userId: string, watchlistId: string) {
    await this.orgContext.assertOrganizationMember(organizationId, userId);
    await this.prisma.signalWatchlist.deleteMany({
      where: {
        id: watchlistId,
        organizationId,
        isDefault: false,
      },
    });
    return { success: true };
  }

  async recompute(organizationId: string, userId: string) {
    await this.orgContext.assertOrganizationMember(organizationId, userId);
    await this.ensureSignals(organizationId, userId, true);
    return { success: true };
  }

  private async ensureSignals(organizationId: string, userId: string, force = false) {
    const latest = await this.prisma.signal.findFirst({
      where: { organizationId },
      orderBy: { lastRefreshedAt: 'desc' },
      select: { lastRefreshedAt: true },
    });
    const stale =
      force ||
      !latest?.lastRefreshedAt ||
      Date.now() - latest.lastRefreshedAt.getTime() > REFRESH_TTL_MS;
    if (!stale) return;
    await this.seedDefaults(organizationId, userId);
    await this.recomputeSignals(organizationId);
  }

  private async seedDefaults(organizationId: string, userId: string) {
    for (const metric of DEFAULT_SIGNAL_METRICS) {
      const created = await this.prisma.signalMetric.upsert({
        where: {
          organizationId_metricKey: { organizationId, metricKey: metric.metricKey },
        },
        create: {
          organizationId,
          metricKey: metric.metricKey,
          label: metric.label,
          unit: metric.unit,
          description: metric.description,
          defaultThresholds: { auto: true } as Prisma.InputJsonValue,
          supportedDimensions: { auto: true } as Prisma.InputJsonValue,
          isActive: true,
        },
        update: {
          label: metric.label,
          unit: metric.unit,
          description: metric.description,
          isActive: true,
        },
      });
      await this.prisma.signalRule.upsert({
        where: {
          organizationId_signalMetricId_signalType: {
            organizationId,
            signalMetricId: created.id,
            signalType: metric.metricKey.toUpperCase(),
          },
        },
        create: {
          organizationId,
          signalMetricId: created.id,
          signalType: metric.metricKey.toUpperCase(),
          severity: metric.metricKey === 'cash_balance' ? 'CRITICAL' : 'HIGH',
          threshold: { enabled: true } as Prisma.InputJsonValue,
          isEnabled: true,
        },
        update: {
          severity: metric.metricKey === 'cash_balance' ? 'CRITICAL' : 'HIGH',
          isEnabled: true,
        },
      });
    }
    await this.prisma.signalWatchlist.upsert({
      where: {
        organizationId_name: {
          organizationId,
          name: DEFAULT_WATCHLIST_NAME,
        },
      },
      create: {
        organizationId,
        ownerId: userId,
        name: DEFAULT_WATCHLIST_NAME,
        description: 'Default finance exceptions watchlist',
        isDefault: true,
      },
      update: {
        isDefault: true,
      },
    });
  }

  private async recomputeSignals(organizationId: string) {
    const [profile, trendRows, executive] = await Promise.all([
      this.financialData.getFinancialProfile(organizationId),
      this.financialData.getMonthlyRevenueTrend(organizationId),
      this.financialData.getExecutiveSnapshot(organizationId, { kind: 'LAST_N_MONTHS', months: 3 } as any),
    ]);
    const executiveSnapshot = executive as Record<string, unknown> | null;
    const activeConns = await this.prisma.erpConnection.findMany({
      where: { organizationId, status: 'ACTIVE' },
      select: { externalOrganizationId: true, provider: true, metadata: true },
    });
    const connectedOrgs = await this.financialData.getConnectedOrgs(organizationId, activeConns);

    const metrics = await this.prisma.signalMetric.findMany({
      where: { organizationId, isActive: true },
    });
    const metricMap = new Map(metrics.map((metric) => [metric.metricKey, metric]));

    const evidenceCatalog = this.buildEvidenceCatalog(profile, trendRows as OrgTrendRow[], executiveSnapshot, connectedOrgs);
    const factPack = {
      organizationId,
      profile: {
        revenue: profile?.revenue,
        expenses: profile?.expenses,
        netProfit: profile?.netProfit,
        profitMargin: profile?.profitMargin,
      },
      executive: {
        runwayMonths: executiveSnapshot?.runwayMonths,
        cashBalance: executiveSnapshot?.cashBalance,
        grossMarginPct: executiveSnapshot?.grossMarginPct,
        payrollToRevenuePct: executiveSnapshot?.payrollToRevenuePct,
        utilizationPct: executiveSnapshot?.utilizationPct,
        overdueAmount: executiveSnapshot?.overdueAmount,
        overdueCount: executiveSnapshot?.overdueCount,
      },
      connectedOrgs: connectedOrgs.slice(0, 8),
      trendRows: (trendRows as OrgTrendRow[]).slice(-24),
    };

    const discoveredSignals =
      (await this.discoverSignalsWithOpenAi(factPack, evidenceCatalog)) ??
      this.composeFallbackSignals(organizationId, metricMap, profile, trendRows as OrgTrendRow[], executiveSnapshot);

    const activeKeys = new Set(discoveredSignals.map((signal) => signal.sourceKey));
    for (const signal of discoveredSignals) {
      if (!signal || !signal.sourceKey) continue;
      const metric = metricMap.get(signal.metricKey);
      if (!metric) continue;
      const persisted = await this.prisma.signal.upsert({
        where: { sourceKey: signal.sourceKey },
        create: {
          organizationId,
          sourceKey: signal.sourceKey,
          signalMetricId: metric.id,
          signalType: signal.signalType,
          severity: signal.severity,
          title: signal.title,
          summary: signal.summary,
          impactAmount: signal.impactAmount,
          confidenceScore: signal.confidenceScore,
          entityScope: signal.entityScope as Prisma.InputJsonValue,
          timeWindow: signal.timeWindow as Prisma.InputJsonValue,
          comparisonWindow: signal.comparisonWindow as Prisma.InputJsonValue,
          status: 'NEW',
          lastRefreshedAt: new Date(),
        },
        update: {
          signalMetricId: metric.id,
          signalType: signal.signalType,
          severity: signal.severity,
          title: signal.title,
          summary: signal.summary,
          impactAmount: signal.impactAmount,
          confidenceScore: signal.confidenceScore,
          entityScope: signal.entityScope as Prisma.InputJsonValue,
          timeWindow: signal.timeWindow as Prisma.InputJsonValue,
          comparisonWindow: signal.comparisonWindow as Prisma.InputJsonValue,
          lastRefreshedAt: new Date(),
          status: 'NEW',
        },
      });

      await this.prisma.signalEvidence.deleteMany({ where: { signalId: persisted.id } });
      const evidenceRows = signal.evidence.map((section, index) => ({
        organizationId,
        signalId: persisted.id,
        evidenceType: section.evidenceType,
        title: section.title,
        payload: section.payload as Prisma.InputJsonValue,
        sortOrder: index,
      }));
      if (signal.narrative) {
        evidenceRows.push({
          organizationId,
          signalId: persisted.id,
          evidenceType: 'ai_narrative',
          title: 'AI interpretation',
          payload: signal.narrative as unknown as Prisma.InputJsonValue,
          sortOrder: evidenceRows.length,
        });
      }
      const uniqueEvidenceRows = evidenceRows.filter(
        (row, index, values) =>
          values.findIndex(
            (candidate) =>
              candidate.evidenceType === row.evidenceType &&
              candidate.title === row.title &&
              JSON.stringify(candidate.payload) === JSON.stringify(row.payload),
          ) === index,
      );
      await this.prisma.signalEvidence.createMany({ data: uniqueEvidenceRows });
      await this.prisma.signal.update({
        where: { id: persisted.id },
        data: { evidenceComputedAt: new Date() },
      });
    }

    await this.prisma.signal.updateMany({
      where: {
        organizationId,
        sourceKey: { notIn: Array.from(activeKeys) },
        status: { in: ['NEW', 'ACKNOWLEDGED', 'INVESTIGATING'] },
      },
      data: { status: 'RESOLVED', lastRefreshedAt: new Date() },
    });
  }

  private computeRevenueSignals(
    organizationId: string,
    metricId: string | undefined,
    trendRows: OrgTrendRow[],
  ): ComputedSignal[] {
    if (!metricId || trendRows.length === 0) return [];
    const byOrg = new Map<string, OrgTrendRow[]>();
    for (const row of trendRows) {
      const key = String(row.org_id ?? row.org_name ?? '');
      if (!key) continue;
      const items = byOrg.get(key) ?? [];
      items.push(row);
      byOrg.set(key, items);
    }

    const results: ComputedSignal[] = [];
    for (const rows of byOrg.values()) {
      const ordered = rows
        .slice()
        .sort((a, b) => String(a.month).localeCompare(String(b.month)));
      if (ordered.length < 2) continue;
      const latest = ordered[ordered.length - 1]!;
      const previous = ordered[ordered.length - 2]!;
      const latestValue = Number(latest.revenue) || 0;
      const previousValue = Number(previous.revenue) || 0;
      if (previousValue <= 0) continue;
      const delta = latestValue - previousValue;
      const deltaPct = delta / previousValue;
      if (deltaPct > -0.15) continue;

      const entityName = String(latest.org_name ?? previous.org_name ?? 'Unknown entity');
      results.push({
        sourceKey: `revenue:${organizationId}:${String(latest.org_id ?? entityName)}:${String(latest.month)}`,
        metricKey: 'revenue',
        signalType: 'REVENUE_VARIANCE',
        severity: deltaPct <= -0.3 ? 'CRITICAL' : 'HIGH',
        title: `${entityName} revenue declined ${this.formatPct(Math.abs(deltaPct))}`,
        summary: `${entityName} revenue fell from ${this.formatCurrency(previousValue)} to ${this.formatCurrency(latestValue)} in ${String(latest.month)} versus ${String(previous.month)}.`,
        impactAmount: Math.abs(delta),
        confidenceScore: Math.min(0.97, 0.72 + Math.min(0.2, Math.abs(deltaPct))),
        entityScope: {
          kind: 'entity',
          entityId: String(latest.org_id ?? null) || null,
          entityName,
          provider: String(latest.provider ?? null) || null,
        },
        timeWindow: { kind: 'last_month', label: String(latest.month) },
        comparisonWindow: { kind: 'previous_month', label: String(previous.month) },
        evidence: [
          {
            evidenceType: 'trend',
            title: 'Revenue comparison',
            payload: {
              current: latestValue,
              previous: previousValue,
              delta,
              deltaPct,
              currentMonth: latest.month,
              previousMonth: previous.month,
            },
          },
          {
            evidenceType: 'transaction_sample',
            title: 'Top recent activity',
            payload: {
              entityName,
              monthlyRows: ordered.slice(-3).map((row) => ({
                month: row.month,
                revenue: Number(row.revenue) || 0,
                invoices: Number(row.invoice_count) || 0,
              })),
            },
          },
        ],
      });
    }
    return results.sort((a, b) => b.impactAmount - a.impactAmount).slice(0, 5);
  }

  private computeCashSignals(
    organizationId: string,
    metricId: string | undefined,
    executive: any,
  ): ComputedSignal[] {
    if (!metricId || !executive) return [];
    const runwayMonths = Number(executive.runwayMonths ?? 0);
    const cashBalance = Number(executive.cashBalance ?? 0);
    if (runwayMonths >= 3 && cashBalance > 0) return [];
    return [
      {
        sourceKey: `cash_balance:${organizationId}:runway`,
        metricKey: 'cash_balance',
        signalType: 'CASH_RISK',
        severity: runwayMonths <= 1 ? 'CRITICAL' : 'HIGH',
        title: `Cash runway is ${runwayMonths.toFixed(1)} months`,
        summary: `Cash balance is ${this.formatCurrency(cashBalance)} with an estimated runway of ${runwayMonths.toFixed(1)} months.`,
        impactAmount: Math.abs(cashBalance),
        confidenceScore: 0.93,
        entityScope: { kind: 'organization' },
        timeWindow: { kind: 'last_3_months', label: 'Latest view' },
        comparisonWindow: { kind: 'rolling_average', label: 'Trailing burn rate' },
        evidence: [
          {
            evidenceType: 'kpi',
            title: 'Cash and burn snapshot',
            payload: {
              cashBalance,
              burnRate: Number(executive.burnRate ?? 0) || Number(executive.operatingCashFlow ?? 0),
              runwayMonths,
              freeCashFlow: Number(executive.freeCashFlow ?? 0),
            },
          },
          {
            evidenceType: 'risk',
            title: 'Operational context',
            payload: {
              cashConversionDays: Number(executive.cashConversionDays ?? 0),
              dsoDays: Number(executive.dsoDays ?? 0),
              dpoDays: Number(executive.dpoDays ?? 0),
            },
          },
        ],
      },
    ];
  }

  private computeCollectionsSignals(
    organizationId: string,
    metricId: string | undefined,
    profile: any,
    executive: any,
  ): ComputedSignal[] {
    if (!metricId) return [];
    const overdueAmount = Number(executive?.overdueAmount ?? profile?.expenses?.overdueAmount ?? 0);
    const overdueCount = Number(executive?.overdueCount ?? profile?.expenses?.overdueCount ?? 0);
    const totalRevenue = Number(executive?.totalRevenue ?? profile?.revenue?.totalRevenue ?? 0);
    if (overdueAmount <= 0) return [];
    const overdueShare = totalRevenue > 0 ? overdueAmount / totalRevenue : 0;
    if (overdueShare < 0.1 && overdueCount < 5) return [];
    return [
      {
        sourceKey: `overdue_amount:${organizationId}:collections`,
        metricKey: 'overdue_amount',
        signalType: 'COLLECTIONS_RISK',
        severity: overdueShare >= 0.25 ? 'CRITICAL' : 'HIGH',
        title: `Collections risk is elevated`,
        summary: `Overdue amount is ${this.formatCurrency(overdueAmount)} across ${overdueCount} invoices, or ${this.formatPct(overdueShare)} of revenue.`,
        impactAmount: overdueAmount,
        confidenceScore: 0.88,
        entityScope: { kind: 'organization' },
        timeWindow: { kind: 'last_3_months', label: 'Current collections view' },
        comparisonWindow: { kind: 'previous_period', label: 'Revenue baseline' },
        evidence: [
          {
            evidenceType: 'kpi',
            title: 'Collections snapshot',
            payload: { overdueAmount, overdueCount, overdueShare, totalRevenue },
          },
          {
            evidenceType: 'risk',
            title: 'Collections impact',
            payload: {
              arOutstanding: Number(executive?.arOutstanding ?? 0),
              dsoDays: Number(executive?.dsoDays ?? 0),
              cashConversionDays: Number(executive?.cashConversionDays ?? 0),
            },
          },
        ],
      },
    ];
  }

  private computeMarginSignals(
    organizationId: string,
    metricId: string | undefined,
    executive: any,
  ): ComputedSignal[] {
    if (!metricId || !executive) return [];
    const grossMarginPct = Number(executive.grossMarginPct ?? 0);
    if (grossMarginPct >= 30) return [];
    return [
      {
        sourceKey: `gross_margin:${organizationId}:pressure`,
        metricKey: 'gross_margin',
        signalType: 'MARGIN_PRESSURE',
        severity: grossMarginPct <= 15 ? 'CRITICAL' : 'HIGH',
        title: `Gross margin pressure at ${grossMarginPct.toFixed(1)}%`,
        summary: `Gross margin is ${grossMarginPct.toFixed(1)}%, with gross margin value ${this.formatCurrency(Number(executive.grossMargin ?? 0))}.`,
        impactAmount: Math.abs(Number(executive.grossMargin ?? 0)),
        confidenceScore: 0.84,
        entityScope: { kind: 'organization' },
        timeWindow: { kind: 'last_3_months', label: 'Current operating view' },
        comparisonWindow: { kind: 'rolling_average', label: 'Trailing margin' },
        evidence: [
          {
            evidenceType: 'kpi',
            title: 'Margin snapshot',
            payload: {
              grossMarginPct,
              grossMargin: Number(executive.grossMargin ?? 0),
              totalRevenue: Number(executive.totalRevenue ?? 0),
              totalCost: Number(executive.totalCost ?? 0),
            },
          },
          {
            evidenceType: 'driver',
            title: 'Business unit pressure',
            payload: {
              businessUnits: (executive.businessUnits ?? []).slice(0, 5),
            },
          },
        ],
      },
    ];
  }

  private computePayrollSignals(
    organizationId: string,
    metricId: string | undefined,
    executive: any,
  ): ComputedSignal[] {
    if (!metricId || !executive) return [];
    const payrollPct = Number(executive.payrollToRevenuePct ?? 0);
    if (payrollPct <= 60) return [];
    return [
      {
        sourceKey: `payroll_to_revenue_pct:${organizationId}:pressure`,
        metricKey: 'payroll_to_revenue_pct',
        signalType: 'PAYROLL_PRESSURE',
        severity: payrollPct >= 80 ? 'CRITICAL' : 'HIGH',
        title: `Payroll consumes ${payrollPct.toFixed(1)}% of revenue`,
        summary: `Payroll to revenue is ${payrollPct.toFixed(1)}%, indicating elevated operating leverage.`,
        impactAmount: Number(executive.totalPayroll ?? 0),
        confidenceScore: 0.9,
        entityScope: { kind: 'organization' },
        timeWindow: { kind: 'last_3_months', label: 'Current operating view' },
        comparisonWindow: { kind: 'rolling_average', label: 'Trailing payroll ratio' },
        evidence: [
          {
            evidenceType: 'kpi',
            title: 'Payroll vs revenue',
            payload: {
              payrollToRevenuePct: payrollPct,
              totalPayroll: Number(executive.totalPayroll ?? 0),
              totalRevenue: Number(executive.totalRevenue ?? 0),
            },
          },
        ],
      },
    ];
  }

  private computeUtilizationSignals(
    organizationId: string,
    metricId: string | undefined,
    executive: any,
  ): ComputedSignal[] {
    if (!metricId || !executive) return [];
    const utilizationPct = Number(executive.utilizationPct ?? 0);
    if (utilizationPct >= 70) return [];
    return [
      {
        sourceKey: `utilization_pct:${organizationId}:pressure`,
        metricKey: 'utilization_pct',
        signalType: 'UTILIZATION_RISK',
        severity: utilizationPct <= 55 ? 'HIGH' : 'MEDIUM',
        title: `Utilization is ${utilizationPct.toFixed(1)}%`,
        summary: `Utilization is below the desired operating band and may be suppressing margin.`,
        impactAmount: Number(executive.totalPayroll ?? 0),
        confidenceScore: 0.8,
        entityScope: { kind: 'organization' },
        timeWindow: { kind: 'last_3_months', label: 'Current operating view' },
        comparisonWindow: { kind: 'rolling_average', label: 'Trailing utilization' },
        evidence: [
          {
            evidenceType: 'kpi',
            title: 'Utilization snapshot',
            payload: {
              utilizationPct,
              slaCompliancePct: Number(executive.slaCompliancePct ?? 0),
              csatPct: Number(executive.csatPct ?? 0),
            },
          },
        ],
      },
    ];
  }

  private async discoverSignalsWithOpenAi(
    factPack: {
      organizationId: string;
      profile: any;
      executive: any;
      connectedOrgs: Array<{ provider: string; orgId: string; orgName: string; invoiceCount: number; totalRevenue: number }>;
      trendRows: OrgTrendRow[];
    },
    evidenceCatalog: SignalEvidenceCatalogEntry[],
  ): Promise<ComputedSignal[] | null> {
    if (this.llmProvider !== 'openai') return null;

    try {
      const response = await fetch(`${this.llmBaseUrl.replace(/\/$/, '')}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.llmModel,
          stream: false,
          options: {
            temperature: 0,
            top_p: 0.2,
            num_predict: 1600,
          },
          format: {
            type: 'object',
            properties: {
              signals: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    sourceKey: { type: 'string' },
                    metricKey: { type: 'string' },
                    signalType: { type: 'string' },
                    severity: { type: 'string' },
                    title: { type: 'string' },
                    summary: { type: 'string' },
                    entityScope: {
                      type: 'object',
                      properties: {
                        kind: { type: 'string' },
                        entityId: { type: ['string', 'null'] },
                        entityName: { type: ['string', 'null'] },
                        provider: { type: ['string', 'null'] },
                      },
                      required: ['kind'],
                      additionalProperties: false,
                    },
                    timeWindow: {
                      type: 'object',
                      properties: {
                        kind: { type: 'string' },
                        label: { type: ['string', 'null'] },
                      },
                      required: ['kind'],
                      additionalProperties: false,
                    },
                    comparisonWindow: {
                      type: 'object',
                      properties: {
                        kind: { type: 'string' },
                        label: { type: ['string', 'null'] },
                      },
                      required: ['kind'],
                      additionalProperties: false,
                    },
                    evidenceIds: {
                      type: 'array',
                      items: { type: 'string' },
                    },
                    narrative: {
                      type: 'object',
                      properties: {
                        executiveAngle: { type: 'string' },
                        likelyDriver: { type: 'string' },
                        recommendedAction: { type: 'string' },
                        watchlistNote: { type: 'string' },
                        actionSteps: {
                          type: 'array',
                          items: {
                            type: 'object',
                            properties: {
                              label: { type: 'string' },
                              description: { type: 'string' },
                            },
                            required: ['label', 'description'],
                            additionalProperties: false,
                          },
                        },
                      },
                      required: [
                        'executiveAngle',
                        'likelyDriver',
                        'recommendedAction',
                        'watchlistNote',
                        'actionSteps',
                      ],
                      additionalProperties: false,
                    },
                  },
                  required: [
                    'sourceKey',
                    'metricKey',
                    'signalType',
                    'severity',
                    'title',
                    'summary',
                    'entityScope',
                    'timeWindow',
                    'comparisonWindow',
                    'evidenceIds',
                    'narrative',
                  ],
                  additionalProperties: false,
                },
              },
            },
            required: ['signals'],
            additionalProperties: false,
          },
          messages: [
            {
              role: 'system',
              content:
                'You are a finance signal discovery engine. Find the most important business signals from the supplied facts. Only create signals that are supported by the evidence catalog. Do not invent entities, numbers, dates, or causes. Prefer fewer, higher-quality signals. The output must reference evidenceIds that already exist in the provided catalog. Use the signalType enum only. For every signal, include a practical next-step plan with three short steps that a finance or operations leader can actually do.',
            },
            {
              role: 'user',
              content: JSON.stringify({
                organizationId: factPack.organizationId,
                factPack: {
                  profile: factPack.profile,
                  executive: factPack.executive,
                  connectedOrgs: factPack.connectedOrgs,
                  trendRows: factPack.trendRows,
                },
                evidenceCatalog,
                availableSignalTypes: [
                  'REVENUE_VARIANCE',
                  'MARGIN_PRESSURE',
                  'CASH_RISK',
                  'COLLECTIONS_RISK',
                  'CONCENTRATION_RISK',
                  'PAYROLL_PRESSURE',
                  'UTILIZATION_RISK',
                ],
                availableMetricKeys: ['revenue', 'gross_margin', 'cash_balance', 'overdue_amount', 'payroll_to_revenue_pct', 'utilization_pct'],
                instructions: {
                  maxSignals: 5,
                  creativeButGrounded: true,
                  avoidHallucinations: true,
                  noDigitsInText: true,
                },
              }),
            },
          ],
        }),
      });

      if (!response.ok) return null;

      const payload = (await response.json()) as { message?: { content?: string } };
      const raw = payload?.message?.content?.trim();
      if (!raw) return null;

      const parsed = JSON.parse(raw) as { signals?: SignalDiscoveryOutput[] };
      if (!Array.isArray(parsed.signals) || parsed.signals.length === 0) return null;

      const catalog = new Map(evidenceCatalog.map((entry) => [entry.id, entry]));
      const discovered = parsed.signals
        .filter((item): item is SignalDiscoveryOutput => this.isValidDiscoveryOutput(item, catalog))
        .map((item) => this.materializeDiscoveryOutput(item, catalog, factPack.organizationId));

      return discovered.length > 0 ? discovered : null;
    } catch (error) {
      this.logger.warn(
        `OpenAI signal discovery failed for organization=${factPack.organizationId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  private isValidDiscoveryOutput(
    item: SignalDiscoveryOutput,
    catalog: Map<string, SignalEvidenceCatalogEntry>,
  ): boolean {
    if (!item?.sourceKey || !item?.signalType || !item?.title || !item?.summary) return false;
    if (!item.metricKey) return false;
    if (!item.evidenceIds?.length) return false;
    if (new Set(item.evidenceIds).size !== item.evidenceIds.length) return false;
    if (!item.narrative) return false;
    if (!this.isAllowedMetricKey(item.metricKey)) return false;
    if (!this.isAllowedSignalType(item.signalType)) return false;
    if (!this.isAllowedSeverity(item.severity)) return false;
    if (!this.isAllowedEntityScope(item.entityScope)) return false;
    if (!this.isAllowedTimeWindow(item.timeWindow)) return false;
    if (!this.isAllowedComparisonWindow(item.comparisonWindow)) return false;
    if (!item.evidenceIds.every((id) => catalog.has(id))) return false;
    const text = [
      item.title,
      item.summary,
      item.narrative.executiveAngle,
      item.narrative.likelyDriver,
      item.narrative.recommendedAction,
      item.narrative.watchlistNote,
      ...item.narrative.actionSteps.flatMap((step) => [step.label, step.description]),
    ].join(' ');
    if (/[0-9$%]/.test(text)) return false;
    return true;
  }

  private materializeDiscoveryOutput(
    item: SignalDiscoveryOutput,
    catalog: Map<string, SignalEvidenceCatalogEntry>,
    organizationId: string,
  ): ComputedSignal {
    const evidence = item.evidenceIds
      .filter((id, index, values) => values.indexOf(id) === index)
      .map((id) => catalog.get(id))
      .filter((entry): entry is SignalEvidenceCatalogEntry => Boolean(entry))
      .map((entry) => ({
        evidenceType: entry.kind,
        title: entry.label,
        payload: { value: entry.value, evidenceId: entry.id, kind: entry.kind },
      }));

    const impactAmount = this.computeImpactAmount(evidence);
    const confidenceScore = this.computeConfidenceScore(item.severity, evidence.length);
    const sourceKey = this.stabilizeSourceKey(organizationId, item.metricKey, item.signalType, item.evidenceIds, item.entityScope);

    return {
      sourceKey,
      metricKey: item.metricKey,
      signalType: item.signalType,
      severity: item.severity,
      title: item.title.trim(),
      summary: item.summary.trim(),
      impactAmount,
      confidenceScore,
      entityScope: item.entityScope,
      timeWindow: item.timeWindow,
      comparisonWindow: item.comparisonWindow,
      evidence,
      narrative: {
        executiveAngle: item.narrative.executiveAngle.trim(),
        likelyDriver: item.narrative.likelyDriver.trim(),
        recommendedAction: item.narrative.recommendedAction.trim(),
        watchlistNote: item.narrative.watchlistNote.trim(),
        actionSteps: item.narrative.actionSteps.slice(0, 3).map((step) => ({
          label: step.label.trim(),
          description: step.description.trim(),
        })),
      },
    };
  }

  private buildEvidenceCatalog(
    profile: any,
    trendRows: OrgTrendRow[],
    executive: any,
    connectedOrgs: Array<{ provider: string; orgId: string; orgName: string; invoiceCount: number; totalRevenue: number }>,
  ): SignalEvidenceCatalogEntry[] {
    const entries: SignalEvidenceCatalogEntry[] = [];
    const push = (entry: SignalEvidenceCatalogEntry) => entries.push(entry);

    push({ id: 'profile.revenue.totalRevenue', label: 'Total revenue', kind: 'metric', value: profile?.revenue?.totalRevenue ?? 0 });
    push({ id: 'profile.expenses.totalExpenses', label: 'Total expenses', kind: 'metric', value: profile?.expenses?.totalExpenses ?? 0 });
    push({ id: 'profile.netProfit', label: 'Net profit', kind: 'metric', value: profile?.netProfit ?? 0 });
    push({ id: 'profile.profitMargin', label: 'Profit margin', kind: 'metric', value: profile?.profitMargin ?? 0 });
    push({ id: 'executive.cashBalance', label: 'Cash balance', kind: 'snapshot', value: executive?.cashBalance ?? 0 });
    push({ id: 'executive.runwayMonths', label: 'Runway months', kind: 'snapshot', value: executive?.runwayMonths ?? 0 });
    push({ id: 'executive.grossMarginPct', label: 'Gross margin percentage', kind: 'snapshot', value: executive?.grossMarginPct ?? 0 });
    push({ id: 'executive.payrollToRevenuePct', label: 'Payroll to revenue percentage', kind: 'snapshot', value: executive?.payrollToRevenuePct ?? 0 });
    push({ id: 'executive.utilizationPct', label: 'Utilization percentage', kind: 'snapshot', value: executive?.utilizationPct ?? 0 });
    push({ id: 'executive.overdueAmount', label: 'Overdue amount', kind: 'snapshot', value: executive?.overdueAmount ?? 0 });
    push({ id: 'executive.overdueCount', label: 'Overdue count', kind: 'snapshot', value: executive?.overdueCount ?? 0 });

    for (const org of connectedOrgs.slice(0, 8)) {
      push({
        id: `org.${org.orgId}.revenue`,
        label: `${org.orgName} revenue`,
        kind: 'org',
        value: org.totalRevenue,
      });
      push({
        id: `org.${org.orgId}.invoiceCount`,
        label: `${org.orgName} invoice count`,
        kind: 'org',
        value: org.invoiceCount,
      });
    }

    for (const row of trendRows.slice(-24)) {
      push({
        id: `trend.${String(row.org_id)}.${String(row.month)}.revenue`,
        label: `${String(row.org_name)} revenue in ${String(row.month)}`,
        kind: 'trend',
        value: {
          month: row.month,
          provider: row.provider,
          orgId: row.org_id,
          orgName: row.org_name,
          revenue: Number(row.revenue) || 0,
          invoiceCount: Number(row.invoice_count) || 0,
        },
      });
    }

    return entries;
  }

  private composeFallbackSignals(
    organizationId: string,
    metricMap: Map<string, { id: string }>,
    profile: any,
    trendRows: OrgTrendRow[],
    executive: any,
  ): ComputedSignal[] {
    const signals: ComputedSignal[] = [];
    signals.push(...this.computeRevenueSignals(organizationId, metricMap.get('revenue')?.id, trendRows));
    signals.push(...this.computeCashSignals(organizationId, metricMap.get('cash_balance')?.id, executive));
    signals.push(...this.computeCollectionsSignals(organizationId, metricMap.get('overdue_amount')?.id, profile, executive));
    signals.push(...this.computeMarginSignals(organizationId, metricMap.get('gross_margin')?.id, executive));
    signals.push(...this.computePayrollSignals(organizationId, metricMap.get('payroll_to_revenue_pct')?.id, executive));
    signals.push(...this.computeUtilizationSignals(organizationId, metricMap.get('utilization_pct')?.id, executive));
    return signals;
  }

  private computeImpactAmount(evidence: Array<{ payload: Record<string, unknown> }>) {
    let max = 0;
    for (const section of evidence) {
      const value = this.findLargestNumericValue(section.payload);
      if (Math.abs(value) > Math.abs(max)) {
        max = value;
      }
    }
    return Math.round(Math.abs(max) * 100) / 100;
  }

  private findLargestNumericValue(value: unknown): number {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (!value || typeof value !== 'object') return 0;
    if (Array.isArray(value)) {
      return value.reduce<number>((max, item) => {
        const current = this.findLargestNumericValue(item);
        return Math.abs(current) > Math.abs(max) ? current : max;
      }, 0);
    }
    return (Object.values(value as Record<string, unknown>) as unknown[]).reduce<number>((max, item) => {
      const current = this.findLargestNumericValue(item);
      return Math.abs(current) > Math.abs(max) ? current : max;
    }, 0);
  }

  private computeConfidenceScore(severity: SignalSeverity, evidenceCount: number) {
    const base = severity === 'CRITICAL' ? 0.94 : severity === 'HIGH' ? 0.88 : severity === 'MEDIUM' ? 0.8 : 0.72;
    const bonus = Math.min(0.06, evidenceCount * 0.015);
    return Math.round(Math.min(0.98, base + bonus) * 100) / 100;
  }

  private stabilizeSourceKey(
    organizationId: string,
    metricKey: string,
    signalType: SignalType,
    evidenceIds: string[],
    entityScope: SignalEntityScope,
  ) {
    const digest = createHash('sha256')
      .update(
        JSON.stringify({
          organizationId,
          metricKey,
          signalType,
          evidenceIds: [...evidenceIds].sort(),
          entityScope,
        }),
      )
      .digest('hex')
      .slice(0, 24);
    return `ai:${signalType.toLowerCase()}:${digest}`;
  }

  private isAllowedSignalType(value: unknown): value is SignalType {
    return (
      value === 'REVENUE_VARIANCE' ||
      value === 'MARGIN_PRESSURE' ||
      value === 'CASH_RISK' ||
      value === 'COLLECTIONS_RISK' ||
      value === 'CONCENTRATION_RISK' ||
      value === 'PAYROLL_PRESSURE' ||
      value === 'UTILIZATION_RISK'
    );
  }

  private isAllowedSeverity(value: unknown): value is SignalSeverity {
    return value === 'LOW' || value === 'MEDIUM' || value === 'HIGH' || value === 'CRITICAL';
  }

  private isAllowedEntityScope(value: unknown): value is SignalEntityScope {
    return Boolean(value && typeof value === 'object' && 'kind' in value);
  }

  private isAllowedTimeWindow(value: unknown): value is SignalTimeWindow {
    return Boolean(value && typeof value === 'object' && 'kind' in value);
  }

  private isAllowedComparisonWindow(value: unknown): value is SignalComparisonWindow {
    return Boolean(value && typeof value === 'object' && 'kind' in value);
  }

  private isAllowedMetricKey(value: unknown): boolean {
    return (
      value === 'revenue' ||
      value === 'gross_margin' ||
      value === 'cash_balance' ||
      value === 'overdue_amount' ||
      value === 'payroll_to_revenue_pct' ||
      value === 'utilization_pct'
    );
  }

  private async ensureDefaultWatchlist(organizationId: string, userId: string) {
    const existing = await this.prisma.signalWatchlist.findFirst({
      where: { organizationId, isDefault: true },
      select: { id: true },
    });
    if (existing) return existing;
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { createdById: true },
    });
    return this.prisma.signalWatchlist.create({
      data: {
        organizationId,
        ownerId: organization?.createdById ?? userId,
        name: DEFAULT_WATCHLIST_NAME,
        description: 'Default finance exceptions watchlist',
        isDefault: true,
      },
    });
  }

  private async assertSignal(organizationId: string, signalId: string) {
    const signal = await this.prisma.signal.findFirst({
      where: { id: signalId, organizationId },
    });
    if (!signal) {
      throw new HttpException(
        { message: 'Signal not found.', code: 'NOT_FOUND' },
        HttpStatus.NOT_FOUND,
      );
    }
    return signal;
  }

  private getOverview(signals: Array<{ status: string; severity: string; confidenceScore: Prisma.Decimal; impactAmount: Prisma.Decimal }>): SignalMetricsOverview {
    const overview = {
      signalCount: signals.length,
      newCount: 0,
      investigatingCount: 0,
      dismissedCount: 0,
      criticalCount: 0,
      averageConfidence: 0,
      totalImpact: 0,
    };
    if (signals.length === 0) return overview;
    for (const signal of signals) {
      if (signal.status === 'NEW') overview.newCount += 1;
      if (signal.status === 'INVESTIGATING' || signal.status === 'ACKNOWLEDGED') overview.investigatingCount += 1;
      if (signal.status === 'DISMISSED' || signal.status === 'RESOLVED') overview.dismissedCount += 1;
      if (signal.severity === 'CRITICAL') overview.criticalCount += 1;
      overview.averageConfidence += Number(signal.confidenceScore ?? 0);
      overview.totalImpact += Number(signal.impactAmount ?? 0);
    }
    overview.averageConfidence = Math.round((overview.averageConfidence / signals.length) * 100) / 100;
    overview.totalImpact = Math.round(overview.totalImpact * 100) / 100;
    return overview;
  }

  private mapSignalSummary(signal: any): SignalSummary {
    return {
      id: signal.id,
      title: signal.title,
      summary: signal.summary,
      signalType: signal.signalType,
      severity: this.normalizeSeverity(signal.severity),
      status: this.normalizeStatus(signal.status),
      impactAmount: Number(signal.impactAmount ?? 0),
      confidenceScore: Number(signal.confidenceScore ?? 0),
      metric: {
        id: signal.signalMetric.id,
        metricKey: signal.signalMetric.metricKey,
        label: signal.signalMetric.label,
        unit: signal.signalMetric.unit,
        description: signal.signalMetric.description,
        isActive: signal.signalMetric.isActive,
      },
      entityScope: signal.entityScope as SignalEntityScope,
      timeWindow: signal.timeWindow as SignalTimeWindow,
      comparisonWindow: signal.comparisonWindow as SignalComparisonWindow,
      assignedToUserId: signal.assignedToUserId ?? null,
      assignedToEmail: signal.assignedToUser?.email ?? null,
      acknowledgedAt: signal.acknowledgedAt?.toISOString() ?? null,
      dismissedAt: signal.dismissedAt?.toISOString() ?? null,
      dismissedReason: signal.dismissedReason ?? null,
      evidenceComputedAt: signal.evidenceComputedAt?.toISOString() ?? null,
      lastRefreshedAt: signal.lastRefreshedAt?.toISOString() ?? null,
      createdAt: signal.createdAt.toISOString(),
      updatedAt: signal.updatedAt.toISOString(),
      evidenceCount: signal.evidence?.length ?? 0,
      commentCount: signal.comments?.length ?? 0,
    };
  }

  private mapSignalDetail(signal: any): SignalDetail {
    return {
      ...this.mapSignalSummary(signal),
      evidence: (signal.evidence ?? []).map((item: any) => ({
        id: item.id,
        evidenceType: item.evidenceType,
        title: item.title,
        sortOrder: item.sortOrder,
        payload: item.payload as Record<string, unknown>,
      })),
      comments: (signal.comments ?? []).map((comment: any) => this.mapComment(comment)),
      boardPacks: (signal.boardPacks ?? []).map((pack: any) => this.mapBoardPack(pack)),
    };
  }

  private mapComment(comment: any) {
    return {
      id: comment.id,
      authorId: comment.authorId,
      authorEmail: comment.author?.email ?? null,
      content: comment.content,
      createdAt: comment.createdAt.toISOString(),
      updatedAt: comment.updatedAt.toISOString(),
    };
  }

  private mapBoardPack(pack: any) {
    return {
      id: pack.id,
      title: pack.title,
      audience: pack.audience,
      exportFormat: pack.exportFormat,
      dashboardId: pack.dashboardId ?? null,
      createdById: pack.createdById,
      createdByEmail: pack.createdBy?.email ?? null,
      createdAt: pack.createdAt.toISOString(),
      updatedAt: pack.updatedAt.toISOString(),
      payload: pack.payload as SignalBoardPackPayload,
    };
  }

  private normalizeSeverity(value: string): SignalSeverity {
    const upper = String(value ?? '').toUpperCase();
    if (upper === 'CRITICAL') return 'CRITICAL';
    if (upper === 'HIGH') return 'HIGH';
    if (upper === 'MEDIUM') return 'MEDIUM';
    return 'LOW';
  }

  private normalizeStatus(value: string): SignalStatus {
    const upper = String(value ?? '').toUpperCase();
    if (upper === 'ACKNOWLEDGED') return 'ACKNOWLEDGED';
    if (upper === 'INVESTIGATING') return 'INVESTIGATING';
    if (upper === 'RESOLVED') return 'RESOLVED';
    if (upper === 'DISMISSED') return 'DISMISSED';
    return 'NEW';
  }

  private buildBoardPackPayload(signal: SignalDetail): SignalBoardPackPayload {
    const trend = signal.evidence.find((section) => section.evidenceType === 'trend');
    const driver = signal.evidence.find((section) => section.evidenceType === 'driver');
    return {
      executiveSummary: signal.summary,
      sections: [
        {
          heading: 'Signal summary',
          body: signal.summary,
          type: 'narrative',
        },
        {
          heading: 'Evidence',
          body: 'This board pack is grounded in the signal evidence collected during investigation.',
          type: 'table',
          data: { evidence: signal.evidence },
        },
        {
          heading: 'Primary comparison',
          body: 'The comparison section can be rendered as a chart or table in the frontend.',
          type: 'chart',
          data: trend?.payload ?? {},
        },
        {
          heading: 'Driver analysis',
          body: 'Key drivers and context extracted from the underlying financial data.',
          type: 'table',
          data: driver?.payload ?? {},
        },
      ],
    };
  }

  private formatCurrency(value: number) {
    if (!Number.isFinite(value)) return '$0';
    if (Math.abs(value) >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
    if (Math.abs(value) >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
    return `$${value.toFixed(0)}`;
  }

  private formatPct(value: number) {
    return `${(value * 100).toFixed(1)}%`;
  }
}
