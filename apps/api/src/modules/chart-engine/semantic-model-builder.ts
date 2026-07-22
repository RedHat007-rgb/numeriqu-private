/**
 * SemanticModelBuilder — assembles a SemanticModel from a PhysicalSchema +
 * ColumnProfiles. Deterministic core (this file); an LLM labelling pass can
 * refine labels/entities later without changing the correctness-bearing exprs.
 * See docs/TARGET_ARCHITECTURE.md §4③.
 *
 * The MeasureExpr for each measure is DERIVED from its AggSemantics — this is
 * where the profiler's classification becomes the compiler's guarantee:
 *   additive       → sum
 *   semi_additive  → last_value(orderBy=time) if a time column exists, else max
 *   ratio          → ratio_of_sums  (ONLY if components resolved; else skipped)
 *   count_distinct → count_distinct
 *   attribute      → dimension / entity / time, never a measure
 */

import type {
  ColumnProfile,
  MeasureExpr,
  PhysicalSchema,
  SemanticDimension,
  SemanticEntity,
  SemanticMeasure,
  SemanticModel,
  SemanticTimeGrain,
} from './semantic-model.types';

export interface BuildResult {
  model: SemanticModel;
  /** Columns we deliberately excluded, with why (audit trail / review UI). */
  skipped: Array<{ table: string; column: string; reason: string }>;
}

/** Deterministic label: "total_revenue_usd" → "Total Revenue". */
export function prettifyLabel(column: string): string {
  const label = column
    .replace(/_usd$/i, '')
    .replace(/_pct$/i, ' %')
    .replace(/_key$/i, '')
    .replace(/_/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bPct\b/i, '%');
  const financialAcronyms: Record<string, string> = {
    Ebitda: 'EBITDA',
    Ebit: 'EBIT',
    Cogs: 'COGS',
    Sga: 'SG&A',
    Sla: 'SLA',
    Qa: 'QA',
    Csat: 'CSAT',
    Nps: 'NPS',
    Ar: 'AR',
    Ap: 'AP',
    Dso: 'DSO',
    Dpo: 'DPO',
    Aht: 'AHT',
  };
  return label.replace(
    /\b(?:Ebitda|Ebit|Cogs|Sga|Sla|Qa|Csat|Nps|Ar|Ap|Dso|Dpo|Aht)\b/g,
    (word) => financialAcronyms[word] ?? word,
  );
}

function unitFor(profile: ColumnProfile): string {
  if (profile.agg === 'ratio') return '%';
  if (profile.agg === 'mean') {
    const n = profile.column.toLowerCase();
    if (/salary|billing_rate|payroll_cost|employee_cost|_usd$/.test(n)) return 'USD';
    if (/_pct|percent|utili[sz]ation|occupancy|sla|csat|\bqa\b|productive/.test(n)) return '%';
    if (/_days\b|\bdso\b|\bdpo\b|days_(sales|payable|past)/.test(n)) return 'days';
    if (/\baht\b|minutes|handle_time|response_time/.test(n)) return 'min';
    return '';
  }
  if (profile.agg === 'count_distinct') return 'count';
  if (/_usd$|amount|revenue|cost|cash|payroll|price/i.test(profile.column)) return 'USD';
  return '';
}

const NAME_COL_RE = /(^name$|_name$|_label$|_title$)/i;
/** Internal multi-tenant scope columns — never user-facing dimensions. */
const SCOPE_COL_RE = /^(tenant_id|org_id)$/i;
/**
 * Calendar-part columns (integer month/quarter/year, month_name, …). These are
 * NOT grouping dimensions — the time grain already covers "by month/quarter/year"
 * chronologically. Exposing them as dimensions makes the planner group by
 * "month number" (1..12) and sort by value, producing a non-chronological axis.
 */
const CALENDAR_PART_RE =
  /^(year|quarter|month|month_name|day|day_of_week|week|iso_week|fiscal_year|fiscal_quarter|period|period_index)$/i;
/**
 * Internal cube helper columns — the row-count / weight columns a cube carries
 * so `mean` measures can be weighted (`<metric>_wt`, `row_count`). They are
 * plumbing, never a user-facing measure.
 */
const HELPER_COL_RE = /(_wt$|^row_count$|_row_count$)/i;

/**
 * Derive the compilable expression from a column's classification.
 * Returns null when the column cannot be a measure (attribute) or cannot be
 * made accurate (ratio without resolvable components → refuse, don't average).
 */
export function measureExprFor(
  profile: ColumnProfile,
  timeColumn: string | undefined,
): { expr: MeasureExpr } | { skip: string } {
  if (
    timeColumn &&
    /growth/i.test(profile.column) &&
    /(?:_pct|percent|percentage)/i.test(profile.column)
  ) {
    return {
      expr: { kind: 'last_value', column: profile.column, orderBy: timeColumn },
    };
  }
  switch (profile.agg) {
    case 'additive':
      return { expr: { kind: 'sum', column: profile.column } };
    case 'count_distinct':
      return { expr: { kind: 'count_distinct', column: profile.column } };
    case 'semi_additive':
      return timeColumn
        ? { expr: { kind: 'last_value', column: profile.column, orderBy: timeColumn } }
        : { expr: { kind: 'max', column: profile.column } };
    case 'mean':
      // Weighted mean when the cube carries a paired weight/count column
      // (`<metric>_wt`), else an unweighted avg over the grouped rows.
      return {
        expr: profile.meanWeight
          ? { kind: 'mean', column: profile.column, weight: profile.meanWeight }
          : { kind: 'mean', column: profile.column },
      };
    case 'ratio':
      if (!profile.ratioComponents) {
        return { skip: 'ratio measure without resolvable numerator/denominator (refusing to average a ratio)' };
      }
      return {
        expr: {
          kind: 'ratio_of_sums',
          numerator: profile.ratioComponents.numerator,
          denominator: profile.ratioComponents.denominator,
        },
      };
    case 'attribute':
      return { skip: 'attribute column is a dimension/entity/time, not a measure' };
  }
}

export interface BuildInput {
  schema: PhysicalSchema;
  /** Profiles keyed by table name. */
  profilesByTable: Record<string, ColumnProfile[]>;
  /** Which table is the primary fact table (most measures). Optional override. */
  primaryTable?: string;
}

function pickTimeColumn(profiles: ColumnProfile[]): SemanticTimeGrain | undefined {
  const dateCols = profiles.filter((p) => /\b(Date|DateTime)/i.test(p.type));
  if (!dateCols.length) return undefined;
  // Prefer the most-populated date column.
  const best = [...dateCols].sort((a, b) => a.nullFraction - b.nullFraction)[0]!;
  const isDateTime = /DateTime/i.test(best.type);
  return {
    table: best.table,
    column: best.column,
    grains: isDateTime ? ['day', 'month', 'quarter', 'year'] : ['month', 'quarter', 'year'],
  };
}

export function buildSemanticModel(input: BuildInput): BuildResult {
  const { schema, profilesByTable } = input;
  const allProfiles = Object.values(profilesByTable).flat();

  // Primary fact table = the one with the most additive/ratio measures.
  const measureCount = (t: string) =>
    (profilesByTable[t] ?? []).filter((p) => p.agg === 'additive' || p.agg === 'ratio' || p.agg === 'semi_additive').length;
  const primaryTable =
    input.primaryTable ??
    [...new Set(allProfiles.map((p) => p.table))].sort((a, b) => measureCount(b) - measureCount(a))[0];

  const time = primaryTable ? pickTimeColumn(profilesByTable[primaryTable] ?? []) : undefined;

  const measures: SemanticMeasure[] = [];
  const dimensions: SemanticDimension[] = [];
  const entities: SemanticEntity[] = [];
  const skipped: BuildResult['skipped'] = [];

  for (const [table, profiles] of Object.entries(profilesByTable)) {
    for (const p of profiles) {
      if (p.agg === 'attribute') {
        // Date columns are handled by the time grain; skip as dimensions.
        if (/\b(Date|DateTime)/i.test(p.type)) {
          skipped.push({ table, column: p.column, reason: 'time column (used as grain)' });
          continue;
        }
        // Internal tenant-scope columns are not dimensions.
        if (SCOPE_COL_RE.test(p.column)) {
          skipped.push({ table, column: p.column, reason: 'internal tenant-scope column' });
          continue;
        }
        // Calendar-part columns are covered by the time grain, not dimensions.
        if (CALENDAR_PART_RE.test(p.column)) {
          skipped.push({ table, column: p.column, reason: 'calendar-part column (use time grain)' });
          continue;
        }
        const dim: SemanticDimension = {
          key: p.column,
          label: prettifyLabel(p.column),
          table,
          column: p.column,
          sampleValues: p.sampleValues,
        };
        dimensions.push(dim);
        if (NAME_COL_RE.test(p.column)) {
          entities.push({ key: p.column.replace(/_name$/i, '') || p.column, label: prettifyLabel(p.column), table, nameColumn: p.column });
        }
        continue;
      }
      // Internal weight/count helpers back `mean` measures; never expose them.
      if (HELPER_COL_RE.test(p.column)) {
        skipped.push({ table, column: p.column, reason: 'internal cube weight/count helper' });
        continue;
      }
      const derived = measureExprFor(p, time?.column);
      if ('skip' in derived) {
        skipped.push({ table, column: p.column, reason: derived.skip });
        continue;
      }
      measures.push({
        key: p.column,
        label: prettifyLabel(p.column),
        unit: unitFor(p),
        sourceTable: table,
        expr: derived.expr,
      });
    }

    // Accounts-receivable aging bands are conditional additive measures, not
    // separate physical amount columns. Derive them from the catalog whenever
    // the source exposes both outstanding balance and days past due. This keeps
    // the definitions reusable and auditable while avoiding query-specific SQL.
    const columns = new Set(profiles.map((profile) => profile.column));
    const outstandingColumn = columns.has('outstanding_receivable_usd')
      ? 'outstanding_receivable_usd'
      : columns.has('outstanding_balance_usd')
        ? 'outstanding_balance_usd'
        : null;
    if (outstandingColumn && columns.has('days_past_due')) {
      const agingMeasures: SemanticMeasure[] = [
        {
          key: 'ar_over_30_days_usd',
          label: 'AR Over 30 Days',
          unit: 'USD',
          sourceTable: table,
          expr: {
            kind: 'sum_if',
            column: outstandingColumn,
            conditionColumn: 'days_past_due',
            gt: 30,
            lte: 60,
          },
        },
        {
          key: 'ar_over_60_days_usd',
          label: 'AR Over 60 Days',
          unit: 'USD',
          sourceTable: table,
          expr: {
            kind: 'sum_if',
            column: outstandingColumn,
            conditionColumn: 'days_past_due',
            gt: 60,
            lte: 90,
          },
        },
        {
          key: 'ar_over_90_days_usd',
          label: 'AR Over 90 Days',
          unit: 'USD',
          sourceTable: table,
          expr: {
            kind: 'sum_if',
            column: outstandingColumn,
            conditionColumn: 'days_past_due',
            gt: 90,
          },
        },
        {
          key: 'total_overdue_balance_usd',
          label: 'Total Overdue Balance',
          unit: 'USD',
          sourceTable: table,
          expr: {
            kind: 'sum_if',
            column: outstandingColumn,
            conditionColumn: 'days_past_due',
            gt: 30,
          },
        },
      ];
      for (const measure of agingMeasures) {
        if (!measures.some((existing) => existing.key === measure.key))
          measures.push(measure);
      }
    }
    if (columns.has('pl_amount_usd') && columns.has('total_revenue_usd')) {
      const measure: SemanticMeasure = {
        key: 'pl_amount_pct_of_revenue',
        label: 'P&L Amount % of Revenue',
        unit: '%',
        sourceTable: table,
        expr: {
          kind: 'ratio_of_sums',
          numerator: 'pl_amount_usd',
          denominator: 'total_revenue_usd',
        },
      };
      if (!measures.some((existing) => existing.key === measure.key))
        measures.push(measure);
    }
  }

  const model: SemanticModel = {
    datasetId: schema.datasetId,
    version: 1,
    builtBy: 'auto',
    factGrain: primaryTable ? `one row of ${primaryTable}` : 'unknown',
    entities,
    measures,
    dimensions,
    ...(time ? { time } : {}),
  };

  return { model, skipped };
}
