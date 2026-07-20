/**
 * Generic, declarative cube builder (Phase C1 deterministic core).
 *
 * The whole point of the autonomous engine is that onboarding a new dataset is
 * DATA, not code (docs/TARGET_ARCHITECTURE.md §8). Today two dataset-specific
 * files hand-write the star-schema cube SQL (`sfin-semantic-cubes.ts`, and the
 * bespoke half of `seed-star-schema-clickhouse.ts`) — so a dataset #3 means
 * writing another ~800-line file. That is the exact axis-C hardcoding the audit
 * flagged, one layer up.
 *
 * This module removes that: a cube is described by a `CubeBlueprint` (which the
 * mapping workbook / introspection produces per dataset), and `buildCubeViewDdl`
 * turns ANY blueprint into a `CREATE OR REPLACE VIEW`. No dataset literals live
 * here. The accuracy discipline from the semantic layer is carried into the
 * cube shape so the downstream profiler/compiler stays honest:
 *   - stocks  → argMax(col, timeCol)         (never summed across periods)
 *   - means   → sum(col) + count() weight     (engine does SUM/SUM, not avg-of-avg)
 *   - ratios  → carry raw numerator/denominator components, never a baked ratio
 *   - pivots  → sumIf per discovered enum value (taxonomy read from data, not code)
 *   - every row carries the tenant header so row policies + scope predicates work
 */

/** How a fact column is rolled up into a cube measure column. */
export type CubeAgg =
  /** Flow: revenue, cost, hours. → sum(col). */
  | 'sum'
  /** Stock/level: cash balance, headcount. → argMax(col, orderBy) within the grain. */
  | 'stock'
  /**
   * Row-level average/duration (SLA %, utilization, DSO). Emits BOTH `sum(col) AS
   * alias` and `count() AS <weightAlias>` so the engine computes a weighted mean
   * (SUM/SUM) instead of an avg-of-averages. `weightAlias` defaults to `<alias>_wt`.
   */
  | 'mean'
  /** Distinct identifier: distinct employees/clients. → uniqExact(col). */
  | 'count_distinct';

export interface CubeMeasureSpec {
  /** Raw column on the fact table. */
  column: string;
  /** Output column in the cube. */
  alias: string;
  agg: CubeAgg;
  /** Required for `stock`: the time column argMax orders by. */
  orderBy?: string;
  /** For `mean`: the emitted count/weight column (default `<alias>_wt`). */
  weightAlias?: string;
}

/** A sumIf pivot: one output column per discovered category value. */
export interface CubePivotSpec {
  /** The numeric column being pivoted (e.g. pl_amount_usd). */
  valueColumn: string;
  /** The categorical column whose values become columns (e.g. account_type). */
  categoryColumn: string;
  /**
   * Category values — enumerated FROM THE DATA, never hardcoded. Optional in the
   * authored blueprint: set `discover: true` and the materializer fills this by
   * querying DISTINCT before the DDL is built. Defaults to [] (no pivot columns)
   * if neither is provided.
   */
  values?: string[];
  /** Ask the materializer to populate `values` from `SELECT DISTINCT` at runtime. */
  discover?: boolean;
  /** Prefix for generated aliases (e.g. "cc_"). */
  aliasPrefix?: string;
  /** Suffix for generated aliases (e.g. "_usd"). */
  aliasSuffix?: string;
  /** Clean names for known values; unknown values fall back to snake(value). */
  canonical?: Record<string, string>;
}

/** A LEFT JOIN of the fact to one dimension table, tenant-safe. */
export interface CubeJoinSpec {
  dimTable: string;
  /** Fact-side join column. */
  factKey: string;
  /** Dim-side join column. */
  dimKey: string;
  /** Dimension columns to expose (grouped by). */
  selects: Array<{ column: string; alias: string }>;
}

/** A cube, described declaratively. Produced per-dataset from data/mapping. */
export interface CubeBlueprint {
  /** Output view name (already dataset-prefixed by the caller). */
  view: string;
  /** Raw fact table (already dataset-prefixed by the caller). */
  factTable: string;
  /** Time column on the fact; enables the month/quarter/year calendar + grain. */
  dateColumn?: string;
  /** Fact-local categorical columns to group by (no join needed). */
  dimensions?: Array<{ column: string; alias: string }>;
  /** Dimension joins. */
  joins?: CubeJoinSpec[];
  /** Aggregated measures. */
  measures?: CubeMeasureSpec[];
  /** sumIf pivots over discovered taxonomy. */
  pivots?: CubePivotSpec[];
  /**
   * Outer derived columns computed from the aggregated/pivoted columns (e.g. a
   * P&L waterfall). Referenced by alias; wrapped in an outer SELECT. Keep these
   * to arithmetic on already-emitted columns — the engine re-derives ratios.
   */
  derived?: Array<{ expr: string; alias: string }>;
}

/** ClickHouse identifier guard — blueprint identifiers come from introspection,
 * never user text, but we hard-reject anything non-identifier-shaped as defense. */
function ident(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`unsafe identifier: ${JSON.stringify(name)}`);
  }
  return name;
}

/** Safe single-quoted string literal for a pivot category value. */
function sqlLiteral(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

/** lower_snake_case an arbitrary label into an identifier-safe token. */
export function snake(value: string): string {
  const base = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!base) return 'value';
  return /^[0-9]/.test(base) ? `v_${base}` : base;
}

/** Monotonic alias de-duplicator: first writer wins, later collisions get _2, _3… */
function aliasDeduper(): (base: string) => string {
  const seen = new Set<string>();
  return (base: string) => {
    let a = base;
    for (let i = 2; seen.has(a); i++) a = `${base}_${i}`;
    seen.add(a);
    return a;
  };
}

function calendarSelect(dateColQualified: string): string {
  return (
    `toStartOfMonth(${dateColQualified}) AS period_date, ` +
    `toYear(${dateColQualified}) AS year, ` +
    `toQuarter(${dateColQualified}) AS quarter, ` +
    `toMonth(${dateColQualified}) AS month`
  );
}

function calendarGroup(dateColQualified: string): string[] {
  return [
    `toStartOfMonth(${dateColQualified})`,
    `toYear(${dateColQualified})`,
    `toQuarter(${dateColQualified})`,
    `toMonth(${dateColQualified})`,
  ];
}

/**
 * Compile ONE blueprint to a `CREATE OR REPLACE VIEW` statement. Pure and
 * deterministic — the same blueprint always yields the same SQL, so it's fully
 * unit-testable without a live ClickHouse. `database` and every identifier are
 * validated; category values are safely quoted.
 */
export function buildCubeViewDdl(database: string, bp: CubeBlueprint): string {
  const db = ident(database);
  const fact = ident(bp.factTable);
  const view = ident(bp.view);
  const joins = bp.joins ?? [];
  // ALWAYS alias the fact as `f` and qualify its columns. This is not just for
  // join disambiguation: ClickHouse expands SELECT aliases inside expressions, so
  // an unqualified `sumIf(cash_outflow_usd, …)` next to `sum(cash_outflow_usd) AS
  // cash_outflow_usd` becomes the illegal nested `sumIf(sum(cash_outflow_usd),…)`.
  // Qualifying (`f.cash_outflow_usd`) refers to the raw column, never the alias.
  const f = (col: string) => `f.${ident(col)}`;

  const dedup = aliasDeduper();
  const selectParts: string[] = [];
  const groupParts: string[] = [];

  // Tenant header — every cube row is tenant-attributable (scope + row policy).
  selectParts.push(`${f('tenant_id')} AS tenant_id`);
  selectParts.push(`${f('org_id')} AS org_id`);
  selectParts.push(`any(${f('org_name')}) AS org_name`);
  groupParts.push(f('tenant_id'), f('org_id'));
  dedup('tenant_id');
  dedup('org_id');
  dedup('org_name');

  // Calendar / time grain.
  if (bp.dateColumn) {
    const dq = f(bp.dateColumn);
    selectParts.push(calendarSelect(dq));
    groupParts.push(...calendarGroup(dq));
    ['period_date', 'year', 'quarter', 'month'].forEach(dedup);
  }

  // Fact-local dimensions.
  for (const dim of bp.dimensions ?? []) {
    const alias = dedup(ident(dim.alias));
    selectParts.push(`${f(dim.column)} AS ${alias}`);
    groupParts.push(f(dim.column));
  }

  // Joined dimension columns.
  joins.forEach((join, i) => {
    const d = `d${i}`;
    for (const sel of join.selects) {
      const alias = dedup(ident(sel.alias));
      selectParts.push(`${d}.${ident(sel.column)} AS ${alias}`);
      groupParts.push(`${d}.${ident(sel.column)}`);
    }
  });

  // Measures.
  for (const m of bp.measures ?? []) {
    const alias = dedup(ident(m.alias));
    switch (m.agg) {
      case 'sum':
        selectParts.push(`sum(${f(m.column)}) AS ${alias}`);
        break;
      case 'count_distinct':
        selectParts.push(`uniqExact(${f(m.column)}) AS ${alias}`);
        break;
      case 'stock': {
        if (!m.orderBy) throw new Error(`stock measure ${m.alias} needs orderBy`);
        selectParts.push(`argMax(${f(m.column)}, ${f(m.orderBy)}) AS ${alias}`);
        break;
      }
      case 'mean': {
        // sum + count so the engine computes SUM/SUM (weighted mean).
        const weight = dedup(ident(m.weightAlias ?? `${m.alias}_wt`));
        selectParts.push(`sum(${f(m.column)}) AS ${alias}`);
        selectParts.push(`count() AS ${weight}`);
        break;
      }
      default: {
        const _exhaustive: never = m.agg;
        throw new Error(`unhandled cube agg: ${String(_exhaustive)}`);
      }
    }
  }

  // Pivots (sumIf per discovered category value).
  for (const pivot of bp.pivots ?? []) {
    const valueCol = f(pivot.valueColumn);
    const catCol = f(pivot.categoryColumn);
    for (const raw of [...new Set((pivot.values ?? []).map((v) => v.trim()).filter(Boolean))]) {
      const clean = pivot.canonical?.[raw] ?? `${pivot.aliasPrefix ?? ''}${snake(raw)}${pivot.aliasSuffix ?? ''}`;
      const alias = dedup(ident(clean));
      selectParts.push(`sumIf(${valueCol}, ${catCol} = ${sqlLiteral(raw)}) AS ${alias}`);
    }
  }

  // FROM + JOINs (tenant-safe: every join is scoped by tenant_id + org_id).
  let from = `FROM ${db}.${fact} f`;
  joins.forEach((join, i) => {
    const d = `d${i}`;
    from +=
      `\nLEFT JOIN ${db}.${ident(join.dimTable)} ${d}` +
      ` ON ${d}.tenant_id = f.tenant_id AND ${d}.org_id = f.org_id` +
      ` AND ${d}.${ident(join.dimKey)} = f.${ident(join.factKey)}`;
  });

  const inner =
    `SELECT ${selectParts.join(', ')}\n` +
    `${from}\n` +
    `GROUP BY ${groupParts.join(', ')}`;

  // Outer derived layer only when needed.
  const derived = bp.derived ?? [];
  if (!derived.length) {
    return `CREATE OR REPLACE VIEW ${db}.${view} AS\n${inner}`;
  }
  const derivedSelect = ['*', ...derived.map((d) => `${d.expr} AS ${ident(d.alias)}`)].join(', ');
  return `CREATE OR REPLACE VIEW ${db}.${view} AS\nSELECT ${derivedSelect}\nFROM (\n${inner}\n)`;
}

/** Build many cubes at once; blueprints for absent facts should be filtered by
 * the caller (which knows which raw tables were actually loaded). */
export function buildCubeViewDdls(database: string, blueprints: CubeBlueprint[]): string[] {
  return blueprints.map((bp) => buildCubeViewDdl(database, bp));
}
