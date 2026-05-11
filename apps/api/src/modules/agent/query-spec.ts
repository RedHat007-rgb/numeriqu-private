export type TimeRange =
  | { kind: 'ALL_TIME' }
  | { kind: 'MTD' }
  | { kind: 'QTD' }
  | { kind: 'YTD' }
  | { kind: 'SINCE_DATE'; start: string } // YYYY-MM-DD
  | { kind: 'BETWEEN_DATES'; start: string; end: string } // YYYY-MM-DD
  | { kind: 'LAST_N_DAYS'; days: number }
  | { kind: 'LAST_N_WEEKS'; weeks: number }
  | { kind: 'LAST_N_MONTHS'; months: number }
  | { kind: 'LAST_N_QUARTERS'; quarters: number }
  | { kind: 'LAST_N_YEARS'; years: number };

export type DashboardFocus =
  | 'REVENUE'
  | 'AR_RISK'
  | 'COLLECTIONS'
  | 'VENTURE'
  | 'AUDIT';

export type TopDefinition =
  | 'REVENUE_COLLECTED'
  | 'TOTAL_INVOICED'
  | 'OUTSTANDING'
  | 'OVERDUE';

export type QuerySpec = {
  focus: DashboardFocus;
  wantsTopClients: boolean;
  topBy?: TopDefinition;
  topN?: number;
  wantsTrend: boolean;
  wantsQuarterly: boolean;
  timeRange?: TimeRange;
  providerHint?: 'xero' | 'quickbooks';
  clientFilter?: { name: string; nameLower: string };
  entityFilter?: { orgId: string; orgName: string; orgNameLower: string };
  paymentDaysIntent?: 'LIST' | 'TREND' | 'DISTRIBUTION';
  raw: string;
};

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

function parseNumber(s: string): number | null {
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return n;
}

function parseNumberWord(s: string): number | null {
  const w = s.trim().toLowerCase();
  const map: Record<string, number> = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
  };
  return map[w] ?? null;
}

function toIsoDate(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function parseMonthName(raw: string): number | null {
  const m = raw.trim().toLowerCase();
  const map: Record<string, number> = {
    jan: 1, january: 1,
    feb: 2, february: 2,
    mar: 3, march: 3,
    apr: 4, april: 4,
    may: 5,
    jun: 6, june: 6,
    jul: 7, july: 7,
    aug: 8, august: 8,
    sep: 9, sept: 9, september: 9,
    oct: 10, october: 10,
    nov: 11, november: 11,
    dec: 12, december: 12,
  };
  return map[m] ?? null;
}

function parseLooseDate(raw: string): Date | null {
  const s = raw.trim();
  if (!s) return null;

  const lower = s.toLowerCase();
  if (lower === 'now' || lower === 'today') return new Date();

  // ISO yyyy-mm-dd
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const d = new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])));
    return Number.isNaN(d.valueOf()) ? null : d;
  }

  // "Dec 2024" / "December 2024" → first day of month (UTC)
  const monthYear = s.match(/^([A-Za-z]{3,9})\s+(\d{4})$/);
  if (monthYear) {
    const month = parseMonthName(monthYear[1] ?? '');
    const year = Number(monthYear[2]);
    if (!month || !Number.isFinite(year)) return null;
    return new Date(Date.UTC(year, month - 1, 1));
  }

  // "Dec 15 2024" / "15 Dec 2024"
  const mdy = s.match(/^([A-Za-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?[,]?\s+(\d{4})$/);
  if (mdy) {
    const month = parseMonthName(mdy[1] ?? '');
    const day = Number(mdy[2]);
    const year = Number(mdy[3]);
    if (!month || !Number.isFinite(day) || !Number.isFinite(year)) return null;
    return new Date(Date.UTC(year, month - 1, day));
  }
  const dmy = s.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})[,]?\s+(\d{4})$/);
  if (dmy) {
    const day = Number(dmy[1]);
    const month = parseMonthName(dmy[2] ?? '');
    const year = Number(dmy[3]);
    if (!month || !Number.isFinite(day) || !Number.isFinite(year)) return null;
    return new Date(Date.UTC(year, month - 1, day));
  }

  // Last resort: Date.parse (locale-dependent). Use only if it parses.
  const parsed = new Date(s);
  if (!Number.isNaN(parsed.valueOf())) return parsed;
  return null;
}

export function parseTimeRange(raw: string): TimeRange | null {
  const q = raw.trim().toLowerCase();
  if (!q) return null;

  // Explicit ranges: "from X to Y" / "between X and Y"
  const between = raw.match(/\b(?:from|between)\s+(.+?)\s+(?:to|and)\s+(.+?)(?:[.?!\n]|$)/i);
  if (between?.[1] && between?.[2]) {
    const start = parseLooseDate(between[1]);
    const end = parseLooseDate(between[2]);
    if (start && end) {
      const s = start <= end ? start : end;
      const e = start <= end ? end : start;
      return { kind: 'BETWEEN_DATES', start: toIsoDate(s), end: toIsoDate(e) };
    }
  }

  // "since X"
  const since = raw.match(/\bsince\s+(.+?)(?:[.?!\n]|$)/i);
  if (since?.[1]) {
    const start = parseLooseDate(since[1]);
    if (start) return { kind: 'SINCE_DATE', start: toIsoDate(start) };
  }

  if (/\b(all time|lifetime|overall|since inception)\b/.test(q)) return { kind: 'ALL_TIME' };
  if (/\b(mtd)\b/.test(q)) return { kind: 'MTD' };
  if (/\b(qtd)\b/.test(q)) return { kind: 'QTD' };
  if (/\b(ytd)\b/.test(q)) return { kind: 'YTD' };

  const lastNDays = q.match(/\b(last|past)\s+(\d+)\s+days?\b/);
  if (lastNDays) {
    const days = parseNumber(lastNDays[2] ?? '');
    if (days) return { kind: 'LAST_N_DAYS', days: clamp(days, 1, 3650) };
  }

  const lastNWeeks = q.match(/\b(last|past)\s+(\d+)\s+weeks?\b/);
  if (lastNWeeks) {
    const weeks = parseNumber(lastNWeeks[2] ?? '');
    if (weeks) return { kind: 'LAST_N_WEEKS', weeks: clamp(weeks, 1, 520) };
  }

  const lastNMonths = q.match(/\b(last|past)\s+(\d+)\s+months?\b/);
  if (lastNMonths) {
    const months = parseNumber(lastNMonths[2] ?? '');
    if (months) return { kind: 'LAST_N_MONTHS', months: clamp(months, 1, 240) };
  }

  // "for 6 months" / "in 6 months" / "6 months" / "six months"
  // In analytics queries, if "next" is not present, default to "last N months".
  const anyMonths =
    q.match(/\b(?:for|in)?\s*(\d+)\s+months?\b/) ??
    q.match(
      /\b(?:for|in)?\s*(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+months?\b/,
    );
  if (anyMonths && !/\bnext\b/.test(q)) {
    const rawN = anyMonths[1] ?? '';
    const n = /^\d+$/.test(rawN) ? parseNumber(rawN) : parseNumberWord(rawN);
    if (n) return { kind: 'LAST_N_MONTHS', months: clamp(n, 1, 240) };
  }

  const lastNQuarters = q.match(/\b(last|past)\s+(\d+)\s+quarters?\b/);
  if (lastNQuarters) {
    const quarters = parseNumber(lastNQuarters[2] ?? '');
    if (quarters) return { kind: 'LAST_N_QUARTERS', quarters: clamp(quarters, 1, 80) };
  }

  const lastNYears = q.match(/\b(last|past)\s+(\d+)\s+years?\b/);
  if (lastNYears) {
    const years = parseNumber(lastNYears[2] ?? '');
    if (years) return { kind: 'LAST_N_YEARS', years: clamp(years, 1, 30) };
  }

  // Common vague phrases we intentionally refuse to guess.
  if (/\b(recent|lately|this month|this quarter|this year)\b/.test(q)) return null;

  return null;
}

export function parseQuerySpec(raw: string): QuerySpec {
  const q = raw.trim().toLowerCase();

  const wantsAudit = /\b(audit|list|ledger|detail|transaction|invoice\s+list|recent\s+invoice)\b/.test(q);
  const wantsVenture = /\b(runway|burn|cash|venture|investor|fundraise)\b/.test(q);

  const wantsOverdue = /\b(overdue|aging|ar\b|receivable|past.?due)\b/.test(q);
  const wantsCollections = /\b(collection|collections|collect|efficien)\b/.test(q);
  const wantsRevenue = /\b(revenue|growth|sales|momentum)\b/.test(q);

  // Top-N clients intent (supports digits and number-words).
  const topNMatch =
    q.match(/\btop\s+(\d+)\s+(clients|customers|contacts)\b/) ??
    q.match(
      /\btop\s+(one|two|three|four|five|six|seven|eight|nine|ten)\s+(clients|customers|contacts)\b/,
    ) ??
    // "top clients" (no N) is still top-clients intent
    q.match(/\b(top|best|biggest)\s+(clients|customers|contacts)\b/);
  const wantsTopClients = !!topNMatch;
  const parsedTopN = (() => {
    const rawN = topNMatch?.[1] ?? null;
    if (!rawN) return undefined;
    const n = /^\d+$/.test(rawN) ? Number(rawN) : parseNumberWord(rawN);
    if (!n || !Number.isFinite(n)) return undefined;
    return clamp(Math.floor(n), 1, 10);
  })();
  const wantsTrend =
    /\b(trend|growth|momentum|mom\b|yoy|month|monthly|over\s+time)\b/.test(q) ||
    /\bline\s+chart\b|\bline\s+graph\b/.test(q);
  const wantsQuarterly = /\b(quarter|q[1-4]\b|qoq|quarterly)\b/.test(q);
  const mentionsPaymentDays =
    /\b(days?\s+(to\s+pay|after)|payment\s+days|paid\s+after|dso)\b/.test(q) ||
    /\bissue[sd]?\s*(?:→|to)\s*paid\b/.test(q) ||
    /\bissued\b.*\bpaid\b/.test(q) ||
    /\bconvert\b.*\bissued\b.*\bpaid\b/.test(q);

  const paymentDaysIntent: QuerySpec['paymentDaysIntent'] = (() => {
    if (!mentionsPaymentDays) return undefined;
    if (/\b(distribution|histogram|bucket|buckets)\b/.test(q))
      return 'DISTRIBUTION';
    if (
      /\b(each\s+invoice|per\s+invoice|invoice\s+by\s+invoice|list)\b/.test(q) ||
      /\btable\b/.test(q)
    )
      return 'LIST';
    if (wantsTrend) return 'TREND';
    // Default: if they asked about time-to-pay but didn't say trend or list, trend is the safest.
    return 'TREND';
  })();

  let focus: DashboardFocus = 'REVENUE';
  if (wantsAudit) focus = 'AUDIT';
  else if (wantsVenture) focus = 'VENTURE';
  else if (wantsOverdue) focus = 'AR_RISK';
  else if (wantsCollections) focus = 'COLLECTIONS';
  else if (wantsRevenue) focus = 'REVENUE';

  const parsedRange = parseTimeRange(raw) ?? undefined;
  const spec: QuerySpec = {
    raw,
    focus,
    wantsTopClients,
    // If a specific time window is requested (e.g., "last 6 months"), treat as a trend intent.
    wantsTrend: wantsTrend || (!!parsedRange && parsedRange.kind !== 'ALL_TIME'),
    wantsQuarterly,
    timeRange: parsedRange,
    paymentDaysIntent,
  };
  if (typeof parsedTopN === 'number') spec.topN = parsedTopN;

  if (/\bxero\b/.test(q)) spec.providerHint = 'xero';
  else if (/\bquickbooks\b|\bqb\b/.test(q)) spec.providerHint = 'quickbooks';

  if (wantsTopClients) {
    if (/\bby\s+(overdue|past.?due)\b/.test(q) || /\boverdue\b/.test(q)) spec.topBy = 'OVERDUE';
    else if (/\bby\s+outstanding\b/.test(q) || /\boutstanding\b/.test(q)) spec.topBy = 'OUTSTANDING';
    else if (/\bby\s+(invoiced|billed)\b/.test(q) || /\b(invoiced|billed)\b/.test(q)) spec.topBy = 'TOTAL_INVOICED';
    else if (/\bby\s+(revenue|paid|collected)\b/.test(q) || /\b(paid|collected)\b/.test(q)) spec.topBy = 'REVENUE_COLLECTED';
  }

  return spec;
}
