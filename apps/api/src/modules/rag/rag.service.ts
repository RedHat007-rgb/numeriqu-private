import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { PrismaClient } from '@repo/db';
import {
  CLICKHOUSE_ANALYTICS_TOKEN,
  PRISMA_TOKEN,
} from '../../database/database.module';
import type { ClickHouseClient } from '@clickhouse/client';
import {
  classifyPrismScope,
  prismGreeting,
  prismScopeRefusal,
  type PrismTone,
} from './prism-policy';
import {
  formatPrismMoney,
  formatPrismPercentage,
  safePercentage,
} from './prism-calculations';
import {
  planPrismQuery,
  type PrismIntent,
  type PrismPlan,
} from './prism-planner';
import {
  ChartEngineService,
  type EngineAnswer,
} from '../chart-engine/chart-engine.service';
import { PrismModelGateway } from './prism-model.gateway';
import { capabilityAnswerEnvelope } from './prism-presenter';
import type { PrismEvidenceSummary } from './prism-contracts';
import { validatePrismOutput } from './prism-output-validator';
import { PrismRuntimeService } from './prism-runtime.service';
import { PRISM_SEMANTIC_VERSION } from './prism-contracts';
import { PrismWorkloadService } from './prism-workload.service';

// ─── Types ────────────────────────────────────────────────────────────────────

interface FinancialContext {
  source: 'invoices' | 'none';
  connectionCount: number;
  externalOrgIds: string[];
  connectionIds: string[];
  summary: {
    revenueAvailable: boolean;
    receivablesAvailable: boolean;
    invoiceMetricsAvailable: boolean;
    totalRevenue: number;
    openAmount: number;
    overdueAmount: number;
    overdueCount: number;
    invoiceCount: number;
    avgInvoiceValue: number;
    currency: string | null;
    mixedCurrencies: boolean;
    periodCount: number;
    coverageStart: string | null;
    coverageEnd: string | null;
    currencyBreakdown: Array<{
      currency: string;
      totalRevenue: number;
      openAmount: number;
      overdueAmount: number;
      overdueCount: number;
      invoiceCount: number;
      avgInvoiceValue: number;
    }>;
  };
  monthlyTrend: Array<{ month: string; revenue: number; invoiceCount: number }>;
  entityBreakdown: Array<{
    orgName: string;
    provider: string;
    totalRevenue: number;
    invoiceCount: number;
    currency: string | null;
  }>;
  invoiceStatusBreakdown: Array<{
    status: string;
    count: number;
    amount: number;
  }>;
  computedAt: string;
  qualityIssues: string[];
}

type NumericCell = string | number | null | undefined;

type ActiveConnection = {
  id: string;
  externalOrganizationId: string;
  provider: string;
  metadata: unknown;
};

type InvoiceSummaryRow = {
  currency?: string | null;
  total_revenue: NumericCell;
  open_amount: NumericCell;
  overdue_amount: NumericCell;
  overdue_count: NumericCell;
  invoice_count: NumericCell;
  avg_invoice: NumericCell;
};
type InvoiceTrendRow = {
  month: string;
  revenue: NumericCell;
  invoice_count: NumericCell;
};
type InvoiceEntityRow = {
  org_name?: string | null;
  provider?: string | null;
  currency?: string | null;
  total_revenue: NumericCell;
  invoice_count: NumericCell;
};
type InvoiceStatusRow = {
  status?: string | null;
  invoice_count: NumericCell;
  total_amount: NumericCell;
};

function numeric(value: NumericCell): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function textValue(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value)
    : '';
}

type TimeRange =
  | { kind: 'ALL_TIME' }
  | { kind: 'DATE_RANGE'; start: string; end: string; label: string }
  | { kind: 'MTD' }
  | { kind: 'QTD' }
  | { kind: 'YTD' }
  | { kind: 'LAST_N_DAYS'; days: number }
  | { kind: 'LAST_N_WEEKS'; weeks: number }
  | { kind: 'LAST_N_MONTHS'; months: number }
  | { kind: 'LAST_N_QUARTERS'; quarters: number }
  | { kind: 'LAST_N_YEARS'; years: number };

const SAFE_QUERY_SETTINGS = {
  max_memory_usage: '536870912',
  max_execution_time: 25,
};

// ─── Prism Query Helpers ──────────────────────────────────────────────────────

function parseTimeRangeFromQuery(query: string): TimeRange | null {
  const q = query.toLowerCase();
  const quarterFirst = q.match(/\bq([1-4])\s+(20\d{2})\b/);
  const yearFirstQuarter = q.match(/\b(20\d{2})\s+q([1-4])\b/);
  if (quarterFirst || yearFirstQuarter) {
    const quarter = Number(quarterFirst?.[1] ?? yearFirstQuarter?.[2]);
    const year = Number(quarterFirst?.[2] ?? yearFirstQuarter?.[1]);
    const startMonth = (quarter - 1) * 3 + 1;
    const endMonth = startMonth + 2;
    const endDay = new Date(Date.UTC(year, endMonth, 0)).getUTCDate();
    return {
      kind: 'DATE_RANGE',
      start: `${year}-${String(startMonth).padStart(2, '0')}-01`,
      end: `${year}-${String(endMonth).padStart(2, '0')}-${String(endDay).padStart(2, '0')}`,
      label: `Q${quarter} ${year}`,
    };
  }

  const monthNames: Record<string, number> = {
    january: 1,
    february: 2,
    march: 3,
    april: 4,
    may: 5,
    june: 6,
    july: 7,
    august: 8,
    september: 9,
    october: 10,
    november: 11,
    december: 12,
  };
  const monthYear = q.match(
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(20\d{2})\b/,
  );
  if (monthYear) {
    const month = monthNames[monthYear[1]];
    const year = Number(monthYear[2]);
    const endDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return {
      kind: 'DATE_RANGE',
      start: `${year}-${String(month).padStart(2, '0')}-01`,
      end: `${year}-${String(month).padStart(2, '0')}-${String(endDay).padStart(2, '0')}`,
      label: `${monthYear[1][0].toUpperCase()}${monthYear[1].slice(1)} ${year}`,
    };
  }

  const calendarYear = q.match(/\b(20\d{2})\b/);
  if (calendarYear && !/\bfy\s*20\d{2}\b/.test(q)) {
    const year = Number(calendarYear[1]);
    return {
      kind: 'DATE_RANGE',
      start: `${year}-01-01`,
      end: `${year}-12-31`,
      label: String(year),
    };
  }
  if (/\b(all time|all-time|lifetime|since inception)\b/.test(q))
    return { kind: 'ALL_TIME' };
  if (/\b(mtd|month to date|month-to-date|this month)\b/.test(q))
    return { kind: 'MTD' };
  if (/\b(qtd|quarter to date|quarter-to-date|this quarter)\b/.test(q))
    return { kind: 'QTD' };
  if (/\b(ytd|year to date|year-to-date|this year)\b/.test(q))
    return { kind: 'YTD' };

  const days = q.match(/\b(last|past)\s+(\d{1,3})\s+days?\b/);
  if (days)
    return {
      kind: 'LAST_N_DAYS',
      days: Math.max(1, Math.floor(Number(days[2]))),
    };
  const weeks = q.match(/\b(last|past)\s+(\d{1,3})\s+weeks?\b/);
  if (weeks)
    return {
      kind: 'LAST_N_WEEKS',
      weeks: Math.max(1, Math.floor(Number(weeks[2]))),
    };
  const months = q.match(/\b(last|past)\s+(\d{1,3})\s+months?\b/);
  if (months)
    return {
      kind: 'LAST_N_MONTHS',
      months: Math.max(1, Math.floor(Number(months[2]))),
    };
  const quarters = q.match(/\b(last|past)\s+(\d{1,2})\s+quarters?\b/);
  if (quarters)
    return {
      kind: 'LAST_N_QUARTERS',
      quarters: Math.max(1, Math.floor(Number(quarters[2]))),
    };
  const years = q.match(/\b(last|past)\s+(\d{1,2})\s+years?\b/);
  if (years)
    return {
      kind: 'LAST_N_YEARS',
      years: Math.max(1, Math.floor(Number(years[2]))),
    };

  if (/\b(last month|previous month)\b/.test(q))
    return { kind: 'LAST_N_MONTHS', months: 1 };
  if (/\b(last quarter|previous quarter)\b/.test(q))
    return { kind: 'LAST_N_QUARTERS', quarters: 1 };
  if (/\b(last year|previous year)\b/.test(q))
    return { kind: 'LAST_N_YEARS', years: 1 };

  return null;
}

function queryNeedsRangeClarification(query: string): boolean {
  const q = query.toLowerCase();
  const impliesPeriod =
    /\b(compare|comparison|trend|month|monthly|quarter|quarterly|qoq|mom|growth|decline|increase|decrease|change|delta|over time|fy\s*20\d{2})\b/.test(
      q,
    );
  if (!impliesPeriod) return false;
  return parseTimeRangeFromQuery(query) == null;
}

function formatRangeLabel(range: TimeRange): string {
  if (range.kind === 'ALL_TIME') return 'All time';
  if (range.kind === 'DATE_RANGE') return range.label;
  if (range.kind === 'MTD') return 'Month to date';
  if (range.kind === 'QTD') return 'Quarter to date';
  if (range.kind === 'YTD') return 'Year to date';
  if (range.kind === 'LAST_N_DAYS') return `Last ${range.days} days`;
  if (range.kind === 'LAST_N_WEEKS') return `Last ${range.weeks} weeks`;
  if (range.kind === 'LAST_N_MONTHS') return `Last ${range.months} months`;
  if (range.kind === 'LAST_N_QUARTERS')
    return `Last ${range.quarters} quarters`;
  if (range.kind === 'LAST_N_YEARS') return `Last ${range.years} years`;
  return 'All time';
}

function enginePeriodFromRange(range: TimeRange): {
  dateRange?: { start: string; end: string };
  period?: {
    kind:
      | 'MTD'
      | 'QTD'
      | 'YTD'
      | 'LAST_N_DAYS'
      | 'LAST_N_WEEKS'
      | 'LAST_N_MONTHS'
      | 'LAST_N_QUARTERS'
      | 'LAST_N_YEARS';
    value?: number;
  };
} {
  if (range.kind === 'DATE_RANGE') {
    return { dateRange: { start: range.start, end: range.end } };
  }
  if (range.kind === 'ALL_TIME') return {};
  if (range.kind === 'MTD' || range.kind === 'QTD' || range.kind === 'YTD') {
    return { period: { kind: range.kind } };
  }
  if (range.kind === 'LAST_N_DAYS')
    return { period: { kind: range.kind, value: range.days } };
  if (range.kind === 'LAST_N_WEEKS')
    return { period: { kind: range.kind, value: range.weeks } };
  if (range.kind === 'LAST_N_MONTHS')
    return { period: { kind: range.kind, value: range.months } };
  if (range.kind === 'LAST_N_QUARTERS')
    return { period: { kind: range.kind, value: range.quarters } };
  return { period: { kind: range.kind, value: range.years } };
}

function timeRangeFromPlan(plan: PrismPlan | null): TimeRange | null {
  if (!plan || plan.timeRange === 'UNSPECIFIED') return null;
  if (
    plan.timeRange === 'ALL_TIME' ||
    plan.timeRange === 'MTD' ||
    plan.timeRange === 'QTD' ||
    plan.timeRange === 'YTD'
  ) {
    return { kind: plan.timeRange };
  }
  const count = Math.max(1, Math.floor(plan.periodCount));
  if (plan.timeRange === 'LAST_N_DAYS')
    return { kind: 'LAST_N_DAYS', days: count };
  if (plan.timeRange === 'LAST_N_WEEKS')
    return { kind: 'LAST_N_WEEKS', weeks: count };
  if (plan.timeRange === 'LAST_N_MONTHS')
    return { kind: 'LAST_N_MONTHS', months: count };
  if (plan.timeRange === 'LAST_N_QUARTERS')
    return { kind: 'LAST_N_QUARTERS', quarters: count };
  if (plan.timeRange === 'LAST_N_YEARS')
    return { kind: 'LAST_N_YEARS', years: count };
  return null;
}

function pct(n: number): string {
  return formatPrismPercentage(Number.isFinite(n) ? n : null);
}

function humanizeCapabilityKey(key: string): string {
  return key
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function formatCapabilityDimension(
  key: string,
  value: unknown,
  answer: Extract<EngineAnswer, { ok: true }>,
): string {
  if (key !== 'period' || typeof value !== 'string') return String(value);
  const date = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(date.getTime())) return value;
  if (answer.spec.timeGrain === 'year') return String(date.getUTCFullYear());
  if (answer.spec.timeGrain === 'quarter')
    return `Q${Math.floor(date.getUTCMonth() / 3) + 1} ${date.getUTCFullYear()}`;
  if (answer.spec.timeGrain === 'month')
    return new Intl.DateTimeFormat('en', {
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(date);
  return new Intl.DateTimeFormat('en', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

function formatCapabilityValue(
  value: unknown,
  unit: string,
  valueRepresentation: Extract<
    EngineAnswer,
    { ok: true }
  >['measures'][number]['valueRepresentation'],
): string {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return 'Unavailable';
  if (/^[A-Z]{3}$/.test(unit)) return formatPrismMoney(amount, unit);
  if (unit === '%')
    return formatPrismPercentage(
      valueRepresentation === 'ratio' ? amount * 100 : amount,
    );
  const formatted = new Intl.NumberFormat('en', {
    maximumFractionDigits: Number.isInteger(amount) ? 0 : 2,
  }).format(amount);
  if (unit === 'count' || !unit) return formatted;
  return `${formatted} ${unit}`;
}

function buildCapabilityAnswer(
  answer: Extract<EngineAnswer, { ok: true }>,
  range: TimeRange,
  tone: PrismTone,
): string {
  const heading = tone === 'friendly' ? 'Here’s the result' : 'Direct answer';
  const measureKeys = new Set(answer.measures.map((measure) => measure.key));
  const rows = answer.rows.slice(0, 24);
  const lines: string[] = [`**${heading} — ${formatRangeLabel(range)}**`];

  if (rows.length === 0) {
    return [
      ...lines,
      `No verified records matched the selected scope. Prism will not present missing data as zero.`,
    ].join('\n\n');
  }

  for (const row of rows) {
    const dimensions = Object.entries(row)
      .filter(
        ([key, value]) =>
          !measureKeys.has(key) &&
          value != null &&
          !(rows.length === 1 && key === 'period'),
      )
      .map(
        ([key, value]) =>
          `${humanizeCapabilityKey(key)}: ${formatCapabilityDimension(key, value, answer)}`,
      );
    const values = answer.measures
      .filter((measure) => row[measure.key] != null)
      .map(
        (measure) =>
          `${measure.label}: ${formatCapabilityValue(row[measure.key], measure.unit, measure.valueRepresentation)}`,
      );
    if (values.length) {
      lines.push(`- ${[...dimensions, ...values].join(' · ')}`);
    }
  }

  lines.push(
    ``,
    `**CALCULATION**`,
    `- Calculated from the governed metric definitions for the selected organization and period.`,
  );
  if (answer.rows.length > rows.length) {
    lines.push(
      `- Showing ${rows.length} of ${answer.rows.length} verified rows.`,
    );
  }
  return lines.join('\n');
}

function capabilityEvidence(
  answer: EngineAnswer,
  range: TimeRange,
): PrismEvidenceSummary {
  const verified = answer.ok && answer.rows.length > 0;
  return {
    status: verified ? 'verified' : 'unavailable',
    period: formatRangeLabel(range),
    calculatedAt: new Date().toISOString(),
    checks: [
      { code: 'tenant_scope', passed: true },
      { code: 'governed_metric', passed: answer.ok },
      { code: 'unit_validation', passed: answer.ok },
      { code: 'reconciliation', passed: answer.ok },
    ],
    limitations: answer.ok
      ? answer.rows.length === 0
        ? ['No verified records matched the requested scope.']
        : []
      : [
          'The requested metric is not available in the governed capability catalog.',
        ],
  };
}

function contextEvidence(
  ctx: FinancialContext,
  range: TimeRange,
): PrismEvidenceSummary {
  const partial = ctx.qualityIssues.length > 0;
  const available =
    ctx.connectionCount > 0 &&
    !ctx.qualityIssues.includes('summary_unavailable');
  return {
    status: !available ? 'unavailable' : partial ? 'partial' : 'verified',
    period: formatRangeLabel(range),
    calculatedAt: ctx.computedAt,
    checks: [
      { code: 'tenant_scope', passed: true },
      { code: 'governed_metric', passed: available },
      { code: 'unit_validation', passed: !ctx.summary.mixedCurrencies },
      { code: 'reconciliation', passed: available && !partial },
    ],
    limitations: [
      ...ctx.qualityIssues,
      ...(ctx.summary.mixedCurrencies
        ? ['Monetary values use multiple currencies and were not consolidated.']
        : []),
    ],
  };
}

function buildDeterministicPrismAnswer(
  query: string,
  ctx: FinancialContext,
  range: TimeRange,
  tone: PrismTone,
  plannedIntent?: PrismIntent,
): string | null {
  const q = query.toLowerCase();
  const scope = formatRangeLabel(range);
  const s = ctx.summary;

  const heading = tone === 'friendly' ? 'Here’s the result' : 'Direct answer';
  const currency = s.currency;

  if (ctx.connectionCount === 0) {
    return [
      `**${heading}**`,
      `I don't have an active finance connection for this organization, so I can't calculate this reliably yet.`,
      ``,
      `Connect or refresh an accounting source, then ask the question again.`,
    ].join('\n');
  }

  if (ctx.qualityIssues.includes('summary_unavailable')) {
    return [
      `**${heading}**`,
      `The required financial totals are temporarily unavailable, so I won't present a number that cannot be verified.`,
      ``,
      `Please retry after the finance data refresh completes.`,
    ].join('\n');
  }

  const asksForMoney =
    /\b(revenue|income|sales|invoice|open|outstanding|unpaid|overdue|burn|runway|cash|profit|margin|expense|cost|entity|entities|client|customer|status)\b/.test(
      q,
    );
  if (asksForMoney && s.mixedCurrencies) {
    const lines = s.currencyBreakdown.map(
      (row) =>
        `- **${row.currency}:** revenue ${formatPrismMoney(row.totalRevenue, row.currency)}; open ${formatPrismMoney(row.openAmount, row.currency)}; overdue ${formatPrismMoney(row.overdueAmount, row.currency)}`,
    );
    return [
      `**${heading} — ${scope}**`,
      `Your selected scope contains multiple currencies. I have kept them separate because combining them without an approved FX policy would be misleading.`,
      ``,
      ...lines,
      ``,
      `**Required decision**`,
      `Choose a reporting currency and an approved exchange-rate policy if you want a consolidated result.`,
    ].join('\n');
  }

  const asksProfit =
    plannedIntent === 'profitability' ||
    /\b(net profit|profit|margin|ebitda|gross margin|net margin|operating margin)\b/.test(
      q,
    );
  if (asksProfit) {
    return [
      `**${heading}**`,
      `Profit and margin are not calculable from the currently verified inputs. Revenue is available, but a reconciled expense measure is not.`,
      ``,
      `CALCULATION`,
      `- Profit/margin requires a verified expenses/bills model (not present here).`,
      ``,
      `DATA USED`,
      `- Revenue (${scope}): ${formatPrismMoney(s.totalRevenue, currency)}`,
      `- Open invoices (${scope}): ${formatPrismMoney(s.openAmount, currency)}`,
    ].join('\n');
  }

  const wantsOverdue = plannedIntent === 'receivables' || /\boverdue\b/.test(q);
  const wantsOpen =
    plannedIntent === 'receivables' ||
    /\b(open|outstanding|unpaid|accounts receivable|ar)\b/.test(q);
  const wantsRunway =
    plannedIntent === 'liquidity_runway' ||
    /\b(runway|burn|cash on hand|cliff)\b/.test(q);
  const wantsStatus =
    plannedIntent === 'invoice_status' ||
    (/\b(status|paid|authorised|submitted|draft|breakdown)\b/.test(q) &&
      /\binvoice\b/.test(q));
  const wantsEntities =
    plannedIntent === 'entity_breakdown' ||
    (/\b(entity|entities|org|organization|client|customers?)\b/.test(q) &&
      (/\btop\b/.test(q) || /\bcompare\b/.test(q) || /\bbreakdown\b/.test(q)));
  const wantsTrend =
    plannedIntent === 'revenue_trend' ||
    (/\b(trend|monthly|month|month-wise|over time|mom|qoq|quarter)\b/.test(q) &&
      /\b(revenue|income|invoic)\b/.test(q));
  const wantsRevenue =
    plannedIntent === 'revenue_summary' ||
    /\b(revenue|income|invoic(ed)?|sales)\b/.test(q);

  if ((wantsRevenue || wantsTrend) && !s.revenueAvailable) {
    return [
      `**${heading}**`,
      `Revenue is unavailable for this organization in the selected period. Prism found no verified revenue records and will not present that as zero.`,
      ``,
      `Refresh the finance dataset or choose a period with loaded data, then retry.`,
    ].join('\n');
  }

  if (wantsOverdue || wantsOpen) {
    if (!s.receivablesAvailable) {
      return `**${heading}**\n\nReceivables are not available in the verified dataset for this organization, so Prism cannot calculate open or overdue exposure reliably.`;
    }
    const overdueRate = safePercentage(s.overdueAmount, s.openAmount);
    const lines = [
      `**${heading} — ${scope}**`,
      `- Open invoices: ${formatPrismMoney(s.openAmount, currency)}`,
      s.invoiceMetricsAvailable
        ? `- Overdue: ${formatPrismMoney(s.overdueAmount, currency)} across ${s.overdueCount} invoices`
        : `- Overdue: ${formatPrismMoney(s.overdueAmount, currency)}`,
      ``,
      `**CALCULATION**`,
      overdueRate === null
        ? `- Overdue rate: not calculable because the open balance is zero.`
        : `- Overdue rate = Overdue ÷ Open = ${formatPrismMoney(s.overdueAmount, currency)} ÷ ${formatPrismMoney(s.openAmount, currency)} = ${pct(overdueRate)}`,
      ``,
      `**DATA USED**`,
      `- Open invoices: ${formatPrismMoney(s.openAmount, currency)}`,
      `- Overdue amount: ${formatPrismMoney(s.overdueAmount, currency)}`,
      `- Overdue invoice count: ${s.overdueCount}`,
    ];
    if (s.coverageEnd) lines.push('', `- Balance date: ${s.coverageEnd}`);
    return lines.join('\n');
  }

  if (wantsRunway) {
    return [
      `**${heading}**`,
      `Runway is not calculable from the currently verified inputs.`,
      ``,
      `**Required inputs**`,
      `- Reconciled cash balance as of a specific date`,
      `- Governed monthly net-burn definition and period`,
      ``,
      `Invoice values are not a cash balance, so Prism will not use them as a substitute.`,
    ].join('\n');
  }

  if (wantsStatus) {
    if (ctx.source !== 'invoices') {
      return `**${heading}**\n\nInvoice-status detail is not available in this organization's verified finance dataset, so Prism cannot produce that breakdown reliably.`;
    }
    if (ctx.qualityIssues.includes('status_breakdown_unavailable')) {
      return `**${heading}**\n\nThe invoice-status breakdown is temporarily unavailable, so I can't verify this result yet.`;
    }
    const top = ctx.invoiceStatusBreakdown.slice(0, 8);
    const total = top.reduce((sum, row) => sum + (row.amount || 0), 0);
    const lines = top.map((row) => {
      const shareValue = safePercentage(row.amount, total);
      const share = shareValue === null ? 'share unavailable' : pct(shareValue);
      return `- ${row.status}: ${row.count} invoices · ${formatPrismMoney(row.amount, currency)} (${share})`;
    });
    return [
      `**${heading} — ${scope}**`,
      ...lines,
      ``,
      `**Coverage**`,
      `- ${top.length} invoice statuses in the authorized scope.`,
    ].join('\n');
  }

  if (wantsEntities) {
    if (ctx.qualityIssues.includes('entity_breakdown_unavailable')) {
      return `**${heading}**\n\nThe entity comparison is temporarily unavailable, so I can't verify this result yet.`;
    }
    const top = ctx.entityBreakdown.slice(0, 6);
    const total = ctx.entityBreakdown.reduce(
      (sum, row) => sum + (row.totalRevenue || 0),
      0,
    );
    const lines = top.map((row) => {
      const shareValue = safePercentage(row.totalRevenue, total);
      const share =
        shareValue === null ? 'share unavailable' : `${pct(shareValue)} share`;
      return s.invoiceMetricsAvailable
        ? `- ${row.orgName} (${row.provider}): ${formatPrismMoney(row.totalRevenue, row.currency)} · ${row.invoiceCount} invoices · ${share}`
        : `- ${row.orgName}: ${formatPrismMoney(row.totalRevenue, row.currency)} · ${share}`;
    });
    return [
      `**${heading} — ${scope}**`,
      ...lines,
      ``,
      `**CALCULATION**`,
      `- Share % = Entity revenue / Total revenue across entities`,
      ``,
      `**Calculation basis**`,
      `- Entity share = entity revenue ÷ total revenue in the same currency and scope.`,
    ].join('\n');
  }

  if (wantsTrend) {
    if (ctx.qualityIssues.includes('trend_unavailable')) {
      return `**${heading}**\n\nThe time-series data is temporarily unavailable, so I can't verify this trend yet.`;
    }
    const series = ctx.monthlyTrend.slice(-12);
    const lines = series.map((row) =>
      s.invoiceMetricsAvailable
        ? `- ${row.month}: ${formatPrismMoney(row.revenue, currency)} · ${row.invoiceCount} invoices`
        : `- ${row.month}: ${formatPrismMoney(row.revenue, currency)}`,
    );
    return [
      `**${heading} — ${scope}**`,
      ...lines,
      ``,
      `**Calculation basis**`,
      `- Verified revenue grouped by calendar month.`,
    ].join('\n');
  }

  if (wantsRevenue) {
    const lines = [
      `**${heading} — ${scope}**`,
      `- Revenue: ${formatPrismMoney(s.totalRevenue, currency)}`,
    ];
    if (s.coverageStart && s.coverageEnd) {
      lines.push(`- Coverage: ${s.coverageStart} to ${s.coverageEnd}`);
    }
    if (s.invoiceMetricsAvailable) {
      lines.push(
        `- Invoices: ${s.invoiceCount}`,
        `- Average invoice value: ${formatPrismMoney(s.avgInvoiceValue, currency)}`,
        ``,
        `**CALCULATION**`,
        `- Average invoice value = Revenue ÷ invoice count`,
      );
    } else {
      lines.push(
        ``,
        `**CALCULATION**`,
        `- Sum of verified monthly revenue across ${s.periodCount} loaded periods.`,
      );
    }
    return lines.join('\n');
  }

  return null;
}

// ─── RagService ───────────────────────────────────────────────────────────────

@Injectable()
export class RagService {
  private readonly logger = new Logger(RagService.name);
  private readonly analyticsDb: string;
  private readonly ctxCache = new Map<
    string,
    { ctx: FinancialContext; expiresAt: number }
  >();
  private readonly CACHE_TTL_MS = 90_000; // 90 seconds — fresh enough, cheap enough

  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient,
    @Inject(CLICKHOUSE_ANALYTICS_TOKEN)
    private readonly clickhouse: ClickHouseClient,
    private readonly chartEngine: ChartEngineService,
    private readonly prismModel: PrismModelGateway,
    private readonly prismRuntime: PrismRuntimeService,
    private readonly prismWorkload: PrismWorkloadService,
  ) {
    const analyticsDb = process.env.CLICKHOUSE_ANALYTICS_DB || 'analytics';
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(analyticsDb)) {
      throw new Error('CLICKHOUSE_ANALYTICS_DB must be a valid identifier.');
    }
    this.analyticsDb = analyticsDb;
  }

  // ─── Public Query Entry Point ──────────────────────────────────────────────

  async *query(
    organizationId: string,
    userId: string,
    userQuery: string,
    sessionId?: string,
    tone: PrismTone = 'professional',
    signal?: AbortSignal,
  ): AsyncGenerator<string> {
    const startTime = Date.now();
    const requestId = randomUUID();
    signal?.throwIfAborted();
    const span = trace.getTracer('prism').startSpan('prism.query', {
      attributes: {
        'prism.request_id': requestId,
        'prism.tone': tone,
      },
    });

    try {
      // ── Session management ────────────────────────────────────────────────
      const session = sessionId
        ? await this.prisma.ragChatSession.findFirst({
            where: { id: sessionId, organizationId, userId },
          })
        : null;

      const currentSession =
        session ??
        (await this.prisma.ragChatSession.create({
          data: { organizationId, userId, title: userQuery.slice(0, 80) },
        }));

      await this.prisma.ragChatMessage.create({
        data: {
          sessionId: currentSession.id,
          organizationId,
          role: 'USER',
          content: userQuery,
        },
      });

      // ── Finance boundary ────────────────────────────────────────────────
      const scopeDecision = classifyPrismScope(userQuery);

      if (scopeDecision.kind === 'greeting') {
        const text = prismGreeting(tone);
        yield this.chunk('status', { message: 'Ready.' });
        yield this.chunk('token', { content: text });
        await this.prisma.ragChatMessage.create({
          data: {
            sessionId: currentSession.id,
            organizationId,
            role: 'ASSISTANT',
            content: text,
          },
        });
        yield this.chunk('done', {
          metrics: {
            requestId,
            totalMs: Date.now() - startTime,
            mode: 'greeting',
            sessionId: currentSession.id,
          },
        });
        return;
      }

      if (scopeDecision.kind !== 'finance') {
        const text = prismScopeRefusal(scopeDecision);
        yield this.chunk('status', { message: 'Domain check.' });
        yield this.chunk('token', { content: text });
        await this.prisma.ragChatMessage.create({
          data: {
            sessionId: currentSession.id,
            organizationId,
            role: 'ASSISTANT',
            content: text,
          },
        });
        yield this.chunk('done', {
          metrics: {
            requestId,
            totalMs: Date.now() - startTime,
            mode:
              scopeDecision.kind === 'off_topic'
                ? 'domain-gate'
                : 'policy-gate',
            sessionId: currentSession.id,
          },
        });
        return;
      }

      // OpenAI interprets natural language into a strict allow-listed plan. It
      // cannot access data or calculate values; failure safely falls back to
      // deterministic intent parsing below.
      yield this.chunk('status', {
        message: 'Understanding the finance request…',
      });
      let plan: PrismPlan | null = null;
      try {
        plan = await planPrismQuery(userQuery, this.prismModel, signal);
      } catch (error) {
        this.logger.warn(
          `[Prism] OpenAI planner unavailable; using safe fallback: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      }

      // ── Context retrieval ──────────────────────────────────────────────
      yield this.chunk('status', {
        message: 'Loading live financial intelligence...',
      });

      const parsedRange =
        parseTimeRangeFromQuery(userQuery) ?? timeRangeFromPlan(plan);
      const range: TimeRange = parsedRange ?? { kind: 'ALL_TIME' };

      if (queryNeedsRangeClarification(userQuery)) {
        const question = 'Which time range should Prism use?';
        const options = [
          { label: 'Last 30 days', value: `${userQuery} (last 30 days)` },
          { label: 'Last 90 days', value: `${userQuery} (last 90 days)` },
          { label: 'MTD', value: `${userQuery} (MTD)` },
          { label: 'QTD', value: `${userQuery} (QTD)` },
          { label: 'YTD', value: `${userQuery} (YTD)` },
          { label: 'All time', value: `${userQuery} (all time)` },
        ];

        yield this.chunk('clarify', {
          question,
          reason:
            'Your question implies a time period, but none was specified.',
          options,
        });

        const text = `${question}\n\n- ${options.map((o) => o.label).join('\n- ')}`;
        yield this.chunk('token', { content: text });
        await this.prisma.ragChatMessage.create({
          data: {
            sessionId: currentSession.id,
            organizationId,
            role: 'ASSISTANT',
            content: text,
          },
        });

        yield this.chunk('done', {
          metrics: {
            requestId,
            totalMs: Date.now() - startTime,
            mode: 'clarify',
            sessionId: currentSession.id,
          },
        });
        return;
      }

      // Registry-backed organizations are served exclusively through the
      // generated semantic capability catalog. Prism does not know physical
      // view or column names; the chart engine discovers, validates, compiles,
      // scopes, and reconciles the selected metric.
      const activeConnections = await this.prisma.erpConnection.findMany({
        where: { organizationId, status: 'ACTIVE' },
        select: { externalOrganizationId: true, updatedAt: true },
      });
      const externalOrgIds = activeConnections
        .map((connection) => connection.externalOrganizationId)
        .filter(Boolean);
      const semanticScope = {
        organizationId,
        tenantId: organizationId,
        externalOrgIds,
        ...enginePeriodFromRange(range),
      };
      const latestSync = await this.prisma.syncJob.findFirst({
        where: { organizationId, status: 'SUCCEEDED' },
        orderBy: { completedAt: 'desc' },
        select: { completedAt: true },
      });
      const sourceWatermark =
        latestSync?.completedAt?.toISOString() ??
        activeConnections
          .map((connection) => connection.updatedAt.toISOString())
          .sort()
          .at(-1) ??
        'no-source-watermark';
      const useSemanticEngine =
        (await this.chartEngine.isEngineOnlyOrg(organizationId)) ||
        (await this.chartEngine.hasScopedCubeData(semanticScope));

      if (useSemanticEngine) {
        signal?.throwIfAborted();
        yield this.chunk('status', {
          message: 'Calculating verified metrics…',
        });

        let text: string;
        if (externalOrgIds.length === 0) {
          text =
            "**Direct answer**\n\nI don't have an active finance connection for this organization, so I can't calculate this reliably yet.";
        } else {
          const answer = await this.awaitAnalysis(
            this.prismRuntime.cached(
              {
                organizationId,
                capability: userQuery.normalize('NFKC').trim().toLowerCase(),
                period: this.rangeKey(range),
                semanticVersion: PRISM_SEMANTIC_VERSION,
                sourceWatermark,
              },
              () =>
                this.prismWorkload.withPermit(organizationId, () =>
                  this.chartEngine.answer(semanticScope, userQuery),
                ),
            ),
            signal,
          );
          text = answer.ok
            ? buildCapabilityAnswer(answer, range, tone)
            : '**Direct answer**\n\nThe requested figure is not available in the governed finance capabilities for this organization and period. Prism has not substituted another metric or presented missing data as zero.';
          const evidence = capabilityEvidence(answer, range);
          const structuredAnswer = answer.ok
            ? capabilityAnswerEnvelope(
                answer,
                formatRangeLabel(range),
                tone,
                evidence,
              )
            : null;
          const validation = structuredAnswer
            ? validatePrismOutput(structuredAnswer, text)
            : { ok: true as const };
          if (!validation.ok) {
            this.logger.error(
              `[Prism] Output validation refused answer: ${validation.reasons.join(',')}`,
            );
            text =
              '**Direct answer**\n\nThe verified result could not be presented safely. Prism has not substituted or estimated a value.';
          }
          yield this.chunk('answer', {
            evidence,
            ...(structuredAnswer && validation.ok
              ? { answer: structuredAnswer }
              : {}),
          });
        }

        yield this.chunk('token', { content: text });
        await this.prisma.ragChatMessage.create({
          data: {
            sessionId: currentSession.id,
            organizationId,
            role: 'ASSISTANT',
            content: text,
          },
        });
        yield this.chunk('done', {
          metrics: {
            requestId,
            totalMs: Date.now() - startTime,
            mode: 'semantic-capability',
            sessionId: currentSession.id,
            scope: formatRangeLabel(range),
          },
        });
        return;
      }

      let ctx: FinancialContext;
      const cacheKey = `${organizationId}::${this.rangeKey(range)}`;
      const cached = this.ctxCache.get(cacheKey);
      if (cached && Date.now() < cached.expiresAt) {
        ctx = cached.ctx;
        this.backgroundRefresh(cacheKey, organizationId, range); // warm for next request
      } else {
        ctx = await this.fetchFinancialContext(organizationId, range);
        this.ctxCache.set(cacheKey, {
          ctx,
          expiresAt: Date.now() + this.CACHE_TTL_MS,
        });
      }

      // Emit financial snapshot so frontend can render context panel
      yield this.chunk('context', {
        data: {
          totalRevenue: ctx.summary.totalRevenue,
          openAmount: ctx.summary.openAmount,
          overdueAmount: ctx.summary.overdueAmount,
          invoiceCount: ctx.summary.invoiceMetricsAvailable
            ? ctx.summary.invoiceCount
            : null,
          entityCount: ctx.entityBreakdown.length,
          connectionCount: ctx.connectionCount,
          trend: ctx.summary.mixedCurrencies ? [] : ctx.monthlyTrend.slice(-6),
          scope: formatRangeLabel(range),
          currency: ctx.summary.currency,
          mixedCurrencies: ctx.summary.mixedCurrencies,
          computedAt: ctx.computedAt,
        },
      });
      if (ctx.qualityIssues.length > 0) {
        yield this.chunk('warning', {
          message:
            'Some finance data is temporarily unavailable. Prism will omit any result that cannot be verified.',
          codes: ctx.qualityIssues,
        });
      }

      // ── Deterministic Prism answer (default) ──────────────────────────
      yield this.chunk('status', { message: 'Calculating…' });

      const deterministic = buildDeterministicPrismAnswer(
        userQuery,
        ctx,
        range,
        tone,
        plan?.intent,
      );
      if (deterministic) {
        yield this.chunk('answer', {
          evidence: contextEvidence(ctx, range),
        });
        yield this.chunk('token', { content: deterministic });
        await this.prisma.ragChatMessage.create({
          data: {
            sessionId: currentSession.id,
            organizationId,
            role: 'ASSISTANT',
            content: deterministic,
          },
        });
        yield this.chunk('done', {
          metrics: {
            requestId,
            totalMs: Date.now() - startTime,
            mode: plan
              ? 'openai-planned-deterministic'
              : 'deterministic-fallback',
            sessionId: currentSession.id,
            scope: formatRangeLabel(range),
          },
        });
        return;
      }

      // If Prism can't confidently map the question to a supported calculation, ask.
      const clarifyQuestion = 'What should Prism calculate from your data?';
      const clarifyOptions = [
        {
          label: 'Revenue (total)',
          value: `What is my total revenue? (${formatRangeLabel(range)})`,
        },
        {
          label: 'Revenue trend (monthly)',
          value: `Show my monthly revenue trend. (${formatRangeLabel(range)})`,
        },
        {
          label: 'Overdue exposure',
          value: `How much is overdue? (${formatRangeLabel(range)})`,
        },
        {
          label: 'Open invoices',
          value: `How much is open (unpaid)? (${formatRangeLabel(range)})`,
        },
        {
          label: 'Entity breakdown',
          value: `Show top entities by revenue. (${formatRangeLabel(range)})`,
        },
        {
          label: 'Invoice status breakdown',
          value: `Break down invoices by status. (${formatRangeLabel(range)})`,
        },
      ];
      yield this.chunk('clarify', {
        question: clarifyQuestion,
        reason:
          'Your request is not specific enough to compute deterministically.',
        options: clarifyOptions,
      });
      const clarifyText = `${clarifyQuestion}\n\n- ${clarifyOptions.map((o) => o.label).join('\n- ')}`;
      yield this.chunk('token', { content: clarifyText });
      await this.prisma.ragChatMessage.create({
        data: {
          sessionId: currentSession.id,
          organizationId,
          role: 'ASSISTANT',
          content: clarifyText,
        },
      });
      yield this.chunk('done', {
        metrics: {
          requestId,
          totalMs: Date.now() - startTime,
          mode: 'clarify',
          sessionId: currentSession.id,
        },
      });
      return;
    } catch (error: unknown) {
      if (signal?.aborted) return;
      const message = error instanceof Error ? error.message : 'Unknown error';
      const stack = error instanceof Error ? error.stack : undefined;
      span.recordException(error instanceof Error ? error : new Error(message));
      span.setStatus({ code: SpanStatusCode.ERROR, message });
      this.logger.error(`[Prism] Query failed: ${message}`, stack);
      yield this.chunk('error', {
        message:
          '**The verified finance result is temporarily unavailable.** Please retry shortly. Prism has not produced an estimate or substituted missing data.',
      });
    } finally {
      span.setAttribute('prism.latency_ms', Date.now() - startTime);
      span.end();
    }
  }

  private async awaitAnalysis<T>(
    analysis: Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const configured = Number(process.env.PRISM_ANALYSIS_TIMEOUT_MS);
    const timeoutMs =
      Number.isFinite(configured) && configured >= 5_000 ? configured : 30_000;
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

    return await new Promise<T>((resolve, reject) => {
      const abort = () =>
        reject(
          combined.reason instanceof Error
            ? combined.reason
            : new Error('Prism analysis deadline exceeded.'),
        );
      combined.addEventListener('abort', abort, { once: true });
      analysis.then(resolve, reject).finally(() => {
        combined.removeEventListener('abort', abort);
      });
    });
  }

  // ─── Health Check ──────────────────────────────────────────────────────────

  health() {
    return {
      status: 'operational',
      advisory: 'Prism verified-finance engine ready.',
      mode: 'openai-planned-verified-finance',
      uptime: process.uptime(),
      runtime: this.prismRuntime.snapshot(),
      workload: this.prismWorkload.snapshot(),
    };
  }

  // ─── Session Management ────────────────────────────────────────────────────

  async listSessions(organizationId: string, userId: string) {
    const sessions = await this.prisma.ragChatSession.findMany({
      where: { organizationId, userId },
      orderBy: { updatedAt: 'desc' },
      take: 50,
      include: { _count: { select: { messages: true } } },
    });
    return sessions.map((s) => ({
      id: s.id,
      title: s.title,
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
      messageCount: s._count.messages,
    }));
  }

  async getSession(organizationId: string, userId: string, sessionId: string) {
    const session = await this.prisma.ragChatSession.findFirst({
      where: { id: sessionId, organizationId, userId },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
    if (!session) return null;
    return {
      id: session.id,
      title: session.title,
      messages: session.messages.map((m) => ({
        role: m.role.toLowerCase(),
        content: m.content,
      })),
    };
  }

  // ─── Private: Financial Context Fetching ──────────────────────────────────

  private timeWhere(range?: TimeRange | null): string {
    if (!range || range.kind === 'ALL_TIME') return '';
    if (range.kind === 'DATE_RANGE')
      return `AND issued_at >= toDateTime('${range.start} 00:00:00') AND issued_at < addDays(toDateTime('${range.end} 00:00:00'), 1)`;
    if (range.kind === 'MTD') return `AND issued_at >= toStartOfMonth(now())`;
    if (range.kind === 'QTD') return `AND issued_at >= toStartOfQuarter(now())`;
    if (range.kind === 'YTD') return `AND issued_at >= toStartOfYear(now())`;
    if (range.kind === 'LAST_N_DAYS')
      return `AND issued_at >= (now() - INTERVAL ${Math.max(1, Math.floor(range.days))} DAY)`;
    if (range.kind === 'LAST_N_WEEKS')
      return `AND issued_at >= (now() - INTERVAL ${Math.max(1, Math.floor(range.weeks))} WEEK)`;
    if (range.kind === 'LAST_N_MONTHS')
      return `AND issued_at >= (now() - INTERVAL ${Math.max(1, Math.floor(range.months))} MONTH)`;
    if (range.kind === 'LAST_N_QUARTERS')
      return `AND issued_at >= (now() - INTERVAL ${Math.max(1, Math.floor(range.quarters)) * 3} MONTH)`;
    if (range.kind === 'LAST_N_YEARS')
      return `AND issued_at >= (now() - INTERVAL ${Math.max(1, Math.floor(range.years))} YEAR)`;
    return '';
  }

  private rangeKey(range?: TimeRange | null): string {
    if (!range) return 'ALL_TIME';
    if (range.kind === 'DATE_RANGE')
      return `DATE_RANGE:${range.start}:${range.end}`;
    if (
      range.kind === 'ALL_TIME' ||
      range.kind === 'MTD' ||
      range.kind === 'QTD' ||
      range.kind === 'YTD'
    )
      return range.kind;
    if (range.kind === 'LAST_N_DAYS') return `LAST_N_DAYS:${range.days}`;
    if (range.kind === 'LAST_N_WEEKS') return `LAST_N_WEEKS:${range.weeks}`;
    if (range.kind === 'LAST_N_MONTHS') return `LAST_N_MONTHS:${range.months}`;
    if (range.kind === 'LAST_N_QUARTERS')
      return `LAST_N_QUARTERS:${range.quarters}`;
    if (range.kind === 'LAST_N_YEARS') return `LAST_N_YEARS:${range.years}`;
    return 'ALL_TIME';
  }

  private async fetchFinancialContext(
    organizationId: string,
    range?: TimeRange | null,
  ): Promise<FinancialContext> {
    const connections = await this.prisma.erpConnection.findMany({
      where: { organizationId, status: 'ACTIVE' },
      select: {
        id: true,
        externalOrganizationId: true,
        provider: true,
        metadata: true,
      },
    });

    if (connections.length === 0) {
      return this.emptyContext();
    }

    const connectionIds = connections.map((c) => c.id);
    const externalOrgIds = connections
      .map((c) => c.externalOrganizationId)
      .filter(Boolean);

    const [summary, trend, entities, statusBreakdown] =
      await Promise.allSettled([
        this.fetchSummary(organizationId, connectionIds, range),
        this.fetchMonthlyTrend(organizationId, externalOrgIds, range),
        this.fetchEntityBreakdown(
          organizationId,
          connectionIds,
          connections,
          range,
        ),
        this.fetchStatusBreakdown(organizationId, connectionIds, range),
      ]);

    const qualityIssues = [
      summary.status === 'rejected' ? 'summary_unavailable' : null,
      summary.status === 'fulfilled' &&
      summary.value.currencyBreakdown.length === 0
        ? 'summary_unavailable'
        : null,
      trend.status === 'rejected' ? 'trend_unavailable' : null,
      entities.status === 'rejected' ? 'entity_breakdown_unavailable' : null,
      statusBreakdown.status === 'rejected'
        ? 'status_breakdown_unavailable'
        : null,
    ].filter((issue): issue is string => issue !== null);

    return {
      source: 'invoices',
      connectionCount: connections.length,
      externalOrgIds,
      connectionIds,
      summary:
        summary.status === 'fulfilled'
          ? {
              ...summary.value,
              revenueAvailable: summary.value.currencyBreakdown.length > 0,
              receivablesAvailable: summary.value.currencyBreakdown.length > 0,
              invoiceMetricsAvailable:
                summary.value.currencyBreakdown.length > 0,
              periodCount: 0,
              coverageStart: null,
              coverageEnd: null,
            }
          : {
              revenueAvailable: false,
              receivablesAvailable: false,
              invoiceMetricsAvailable: false,
              totalRevenue: 0,
              openAmount: 0,
              overdueAmount: 0,
              overdueCount: 0,
              invoiceCount: 0,
              avgInvoiceValue: 0,
              currency: null,
              mixedCurrencies: false,
              periodCount: 0,
              coverageStart: null,
              coverageEnd: null,
              currencyBreakdown: [],
            },
      monthlyTrend: trend.status === 'fulfilled' ? trend.value : [],
      entityBreakdown: entities.status === 'fulfilled' ? entities.value : [],
      invoiceStatusBreakdown:
        statusBreakdown.status === 'fulfilled' ? statusBreakdown.value : [],
      computedAt: new Date().toISOString(),
      qualityIssues,
    };
  }

  private async fetchSummary(
    organizationId: string,
    connectionIds: string[],
    range?: TimeRange | null,
  ) {
    const time = this.timeWhere(range);
    const result = await this.clickhouse.query({
      query: `
        SELECT
          upperUTF8(ifNull(nullIf(currency, ''), 'UNKNOWN'))             AS currency,
          count()                                                        AS invoice_count,
          coalesce(sumIf(total_amount, total_amount > 0), 0)             AS total_revenue,
          coalesce(avgIf(total_amount, total_amount > 0), 0)             AS avg_invoice,
          coalesce(sumIf(total_amount, total_amount > 0 AND lowerUTF8(status) NOT IN ('paid','closed','authorised')), 0) AS open_amount,
          coalesce(sumIf(total_amount, total_amount > 0 AND lowerUTF8(status) IN ('overdue')), 0) AS overdue_amount,
          coalesce(countIf(lowerUTF8(status) = 'overdue'), 0)           AS overdue_count
        FROM ${this.analyticsDb}.fact_accounting_invoices
        WHERE tenant_id = {organizationId:String}
          AND connection_id IN ({connectionIds:Array(String)})
          ${time}
        GROUP BY currency
        ORDER BY currency ASC
      `,
      query_params: { organizationId, connectionIds },
      format: 'JSONEachRow',
      clickhouse_settings: SAFE_QUERY_SETTINGS,
    });
    const rows = await result.json<InvoiceSummaryRow>();
    const currencyBreakdown = rows.map((r) => ({
      currency: String(r.currency || 'UNKNOWN'),
      totalRevenue: numeric(r.total_revenue),
      openAmount: numeric(r.open_amount),
      overdueAmount: numeric(r.overdue_amount),
      overdueCount: Math.floor(numeric(r.overdue_count)),
      invoiceCount: Math.floor(numeric(r.invoice_count)),
      avgInvoiceValue: numeric(r.avg_invoice),
    }));
    const totals = currencyBreakdown.reduce(
      (acc, row) => ({
        totalRevenue: acc.totalRevenue + row.totalRevenue,
        openAmount: acc.openAmount + row.openAmount,
        overdueAmount: acc.overdueAmount + row.overdueAmount,
        overdueCount: acc.overdueCount + row.overdueCount,
        invoiceCount: acc.invoiceCount + row.invoiceCount,
      }),
      {
        totalRevenue: 0,
        openAmount: 0,
        overdueAmount: 0,
        overdueCount: 0,
        invoiceCount: 0,
      },
    );
    const single = currencyBreakdown.length === 1 ? currencyBreakdown[0] : null;
    return {
      ...totals,
      avgInvoiceValue:
        totals.invoiceCount > 0 ? totals.totalRevenue / totals.invoiceCount : 0,
      currency:
        single && single.currency !== 'UNKNOWN' ? single.currency : null,
      mixedCurrencies: currencyBreakdown.length > 1,
      currencyBreakdown,
    };
  }

  private async fetchMonthlyTrend(
    organizationId: string,
    externalOrgIds: string[],
    range?: TimeRange | null,
  ) {
    if (externalOrgIds.length === 0) return [];
    const time = this.timeWhere(range);
    const result = await this.clickhouse.query({
      query: `
        SELECT
          formatDateTime(toStartOfMonth(issued_at), '%Y-%m') AS month,
          coalesce(sumIf(total_amount, total_amount > 0), 0) AS revenue,
          count()                                            AS invoice_count
        FROM ${this.analyticsDb}.fact_accounting_invoices
        WHERE tenant_id = {organizationId:String}
          AND org_id IN ({externalOrgIds:Array(String)})
          ${time}
        GROUP BY month
        ORDER BY month ASC
        LIMIT 48
      `,
      query_params: { organizationId, externalOrgIds },
      format: 'JSONEachRow',
      clickhouse_settings: SAFE_QUERY_SETTINGS,
    });
    const rows = await result.json<InvoiceTrendRow>();
    return rows.map((r) => ({
      month: r.month,
      revenue: numeric(r.revenue),
      invoiceCount: Math.floor(numeric(r.invoice_count)),
    }));
  }

  private async fetchEntityBreakdown(
    organizationId: string,
    connectionIds: string[],
    connections: ActiveConnection[],
    range?: TimeRange | null,
  ) {
    const time = this.timeWhere(range);
    const result = await this.clickhouse.query({
      query: `
        SELECT
          org_name,
          provider,
          any(currency)              AS currency,
          coalesce(sumIf(total_amount, total_amount > 0), 0) AS total_revenue,
          count()                    AS invoice_count
        FROM ${this.analyticsDb}.fact_accounting_invoices
        WHERE tenant_id = {organizationId:String}
          AND connection_id IN ({connectionIds:Array(String)})
          ${time}
        GROUP BY org_name, provider
        ORDER BY total_revenue DESC
      `,
      query_params: { organizationId, connectionIds },
      format: 'JSONEachRow',
      clickhouse_settings: SAFE_QUERY_SETTINGS,
    });
    const rows = await result.json<InvoiceEntityRow>();

    // Seed from prisma metadata if ClickHouse returns empty
    if (rows.length === 0) {
      return connections.map((c) => {
        const meta =
          c.metadata && typeof c.metadata === 'object'
            ? (c.metadata as Record<string, unknown>)
            : {};
        return {
          orgName:
            (textValue(meta.orgName) ||
              textValue(meta.companyId) ||
              c.externalOrganizationId) ??
            'Unknown',
          provider: c.provider,
          totalRevenue: 0,
          invoiceCount: 0,
          currency: null,
        };
      });
    }

    return rows.map((r) => ({
      orgName: r.org_name || 'Unknown Entity',
      provider: r.provider || 'unknown',
      totalRevenue: numeric(r.total_revenue),
      invoiceCount: Math.floor(numeric(r.invoice_count)),
      currency: r.currency || null,
    }));
  }

  private async fetchStatusBreakdown(
    organizationId: string,
    connectionIds: string[],
    range?: TimeRange | null,
  ) {
    const time = this.timeWhere(range);
    const result = await this.clickhouse.query({
      query: `
        SELECT
          status,
          count()                        AS invoice_count,
          coalesce(sumIf(total_amount, total_amount > 0), 0) AS total_amount
        FROM ${this.analyticsDb}.fact_accounting_invoices
        WHERE tenant_id = {organizationId:String}
          AND connection_id IN ({connectionIds:Array(String)})
          ${time}
        GROUP BY status
        ORDER BY total_amount DESC
        LIMIT 20
      `,
      query_params: { organizationId, connectionIds },
      format: 'JSONEachRow',
      clickhouse_settings: SAFE_QUERY_SETTINGS,
    });
    const rows = await result.json<InvoiceStatusRow>();
    return rows.map((r) => ({
      status: r.status || 'UNKNOWN',
      count: Math.floor(numeric(r.invoice_count)),
      amount: numeric(r.total_amount),
    }));
  }

  private backgroundRefresh(
    cacheKey: string,
    organizationId: string,
    range: TimeRange,
  ) {
    this.fetchFinancialContext(organizationId, range)
      .then((ctx) =>
        this.ctxCache.set(cacheKey, {
          ctx,
          expiresAt: Date.now() + this.CACHE_TTL_MS,
        }),
      )
      .catch(() => {
        /* non-critical */
      });
  }

  private emptyContext(): FinancialContext {
    return {
      source: 'none',
      connectionCount: 0,
      externalOrgIds: [],
      connectionIds: [],
      summary: {
        revenueAvailable: false,
        receivablesAvailable: false,
        invoiceMetricsAvailable: false,
        totalRevenue: 0,
        openAmount: 0,
        overdueAmount: 0,
        overdueCount: 0,
        invoiceCount: 0,
        avgInvoiceValue: 0,
        currency: null,
        mixedCurrencies: false,
        periodCount: 0,
        coverageStart: null,
        coverageEnd: null,
        currencyBreakdown: [],
      },
      monthlyTrend: [],
      entityBreakdown: [],
      invoiceStatusBreakdown: [],
      computedAt: new Date().toISOString(),
      qualityIssues: [],
    };
  }

  private chunk(type: string, payload: Record<string, unknown>): string {
    return JSON.stringify({ type, ...payload }) + '\n';
  }
}
