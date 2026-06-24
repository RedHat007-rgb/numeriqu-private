/**
 * Dataset grounding boundary.
 *
 * WHY THIS EXISTS: every recurring "wrong data" bug (the agent offering GL demo
 * clients — Apex Ventures, BlueOak — for the EBPO org; counting years from the GL
 * `sample_gl_dump` for EBPO; refusing EBPO measures because a GL side-path ran first)
 * has ONE root cause: GL/demo table names were hardcoded all over a 21k-line service
 * with no boundary stopping EBPO code from touching GL tables.
 *
 * A `DatasetProfile` is resolved ONCE per request from the org scope. Every
 * entity/year resolver reads its source table FROM THE PROFILE instead of hardcoding
 * one, and a runtime grounding guard (assertGrounded / checkGrounding) makes it
 * IMPOSSIBLE for a chart query to reference a table outside the active dataset:
 * it throws in dev/test and returns an honest refusal in prod.
 *
 * Rule of thumb: EBPO data lives in tables whose name contains "ebpo" (v_ebpo_*,
 * ebpo_*). GL/sample data is everything else (sample_gl_dump, dim_clients,
 * v_dim_clients_latest, …). The guard is intentionally name-based and conservative.
 */

export type DatasetKind = 'ebpo' | 'gl';

export interface DatasetProfile {
  kind: DatasetKind;
  /** View + columns the entity (client) resolver must read from. */
  client: {
    view: string;
    nameCol: string;
    /** Aggregate that ranks clients ("largest client") within this dataset. */
    weightExpr: string;
  };
  /** Source for "how many distinct years of data exist" (prior-year/YoY availability). */
  yearSource: { view: string; dateCol: string };
  /**
   * True iff a query in this dataset is allowed to reference `table` (bare name,
   * no db prefix). Used by the grounding guard.
   */
  isTableAllowed(table: string): boolean;
}

const isEbpoTable = (table: string): boolean => /ebpo/i.test(table);

/** A few infra tables any dataset may touch (rarely appear in chart SQL). */
const isNeutralTable = (table: string): boolean =>
  /^(numbers|one|system)$/i.test(table);

export const EBPO_PROFILE: DatasetProfile = {
  kind: 'ebpo',
  client: {
    view: 'v_ebpo_revenue_by_client',
    nameCol: 'client_name',
    weightExpr: 'sum(total_revenue_usd)',
  },
  yearSource: { view: 'v_ebpo_revenue_monthly', dateCol: 'period_date' },
  isTableAllowed: (table) => isEbpoTable(table) || isNeutralTable(table),
};

export const GL_PROFILE: DatasetProfile = {
  kind: 'gl',
  client: {
    view: 'v_dim_clients_latest',
    nameCol: 'client_name',
    weightExpr: 'sum(total_invoiced)',
  },
  yearSource: { view: 'sample_gl_dump', dateCol: 'date' },
  // A GL org must never read EBPO tables (the mirror of the bug we're killing).
  isTableAllowed: (table) => !isEbpoTable(table),
};

export function resolveDatasetProfile(kind: DatasetKind): DatasetProfile {
  return kind === 'ebpo' ? EBPO_PROFILE : GL_PROFILE;
}

/**
 * Extract DB-qualified table references (`db.table`) from a SQL string. We only look
 * at db-qualified names because every real table reference in this codebase is written
 * as `${analyticsDb}.<table>`; CTE names and column/table aliases are NOT db-qualified,
 * so this avoids false positives on `WITH x AS (...)` / `FROM sub s`.
 */
export function referencedTables(sql: string): string[] {
  const out = new Set<string>();
  // Only count db-qualified tables that appear right after FROM/JOIN. This deliberately
  // ignores `alias.column` refs elsewhere (e.g. `e.tenant_id`, `g.city` from a joined
  // subquery) — matching those as "tables" caused false-positive grounding throws and
  // broke legitimate joins (revenue-by-city joins ebpo_dim_geography with e./g. aliases).
  const re = /\b(?:from|join)\s+([a-zA-Z_][\w]*)\.([a-zA-Z_][\w]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    if (m[2]) out.add(m[2]); // the table name (group 2); group 1 is the database
  }
  return [...out];
}

export type GroundingResult =
  | { ok: true }
  | { ok: false; offending: string[]; profile: DatasetKind };

/** Pure check: does this SQL only touch tables allowed by the profile? */
export function checkGrounding(
  sql: string,
  profile: DatasetProfile,
): GroundingResult {
  const offending = referencedTables(sql).filter(
    (t) => !profile.isTableAllowed(t),
  );
  return offending.length
    ? { ok: false, offending, profile: profile.kind }
    : { ok: true };
}

/** Human-readable message for logs / dev throws. */
export function groundingMessage(r: Extract<GroundingResult, { ok: false }>): string {
  return (
    `[grounding] a ${r.profile} query referenced table(s) outside its dataset: ` +
    `${r.offending.join(', ')}. This is a data-grounding leak — the query must only ` +
    `read ${r.profile === 'ebpo' ? 'v_ebpo_*/ebpo_*' : 'non-EBPO'} tables.`
  );
}
