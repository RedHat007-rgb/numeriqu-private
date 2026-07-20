/**
 * Autonomous Chart Engine — semantic model contracts.
 *
 * See docs/TARGET_ARCHITECTURE.md. The whole point of these types is that the
 * agent DERIVES a per-client model from schema introspection + data profiling
 * instead of us hand-writing a catalog (chart-spec-ebpo.ts) or hardcoding DAX.
 *
 * The accuracy guarantee lives in ONE place: `AggSemantics`. Every measure the
 * engine ever compiles carries its aggregation semantics, and the compiler is
 * structurally incapable of, say, averaging a ratio — because a `ratio` measure
 * can only be emitted as DIVIDE(SUM(num), SUM(den)). This encodes the hard-won
 * lessons (avg-of-ratios → wrong %, SUM-of-stocks → wrong cash) as data, not code.
 */

/** How a numeric column must be aggregated. This is the correctness contract. */
export type AggSemantics =
  /** Flows that add across time and entities: revenue, cost, units. → SUM */
  | 'additive'
  /**
   * Stocks / balances that are a point-in-time level and MUST NOT be summed
   * across periods: cash balance, headcount, AR outstanding. → last/max within grain.
   */
  | 'semi_additive'
  /**
   * Rates / percentages / per-X ratios. NEVER averaged (avg-of-ratios is the
   * classic wrong-number bug). → DIVIDE(SUM(numerator), SUM(denominator)).
   */
  | 'ratio'
  /**
   * Row-level averages and durations that ARE genuinely a mean in the source
   * model: operational KPIs (utilization %, SLA %, CSAT, occupancy, NPS) and
   * duration days (DSO, DPO, AHT). These are averaged (optionally weighted by a
   * count/weight column) — NEVER summed. Unlike `ratio`, a `mean` percent is
   * already in percent-points (0..100), so it is not scaled ×100.
   */
  | 'mean'
  /** Identifiers to be counted uniquely: distinct clients, distinct employees. */
  | 'count_distinct'
  /** A dimension / non-aggregatable attribute (text, category, date). */
  | 'attribute';

/** The physical schema, discovered — never assumed. Output of SchemaIntrospector. */
export interface PhysicalColumn {
  name: string;
  /** Raw ClickHouse type, e.g. "Decimal(18, 2)", "String", "Date". */
  type: string;
  nullable: boolean;
}

export interface PhysicalTable {
  name: string;
  columns: PhysicalColumn[];
  /** Estimated row count from system.parts (may be 0 if unknown). */
  rowCountEstimate: number;
}

export interface PhysicalSchema {
  datasetId: string;
  tables: PhysicalTable[];
  /** Inferred shared-key relationships between tables (for joins). */
  relationships: Array<{ from: string; to: string; on: string }>;
  introspectedAt: string; // ISO
}

/** Per-column statistics + classification. Output of DataProfiler. */
export interface ColumnProfile {
  table: string;
  column: string;
  type: string;
  distinctCount: number;
  nullFraction: number;
  min?: number | string;
  max?: number | string;
  sampleValues: Array<string | number>;
  /** The classification that drives aggregation. */
  agg: AggSemantics;
  /**
   * For `ratio` measures: the discovered numerator/denominator columns so the
   * compiler can emit DIVIDE(SUM(num), SUM(den)). Absent ⇒ ratio degrades to a
   * refusal rather than a guessed average.
   */
  ratioComponents?: { numerator: string; denominator: string };
  /**
   * For `mean` measures: an optional sibling weight/count column (`<metric>_wt`)
   * so the compiler emits a weighted average sum(col)/sum(weight) instead of a
   * plain avg — used when a cube pre-sums the metric per group (DAX-faithful).
   */
  meanWeight?: string;
  /** Confidence 0..1 in the `agg` classification (drives review flags). */
  confidence: number;
  /** Human-readable reason for the classification (audit trail). */
  rationale: string;
}

/** A compilable measure expression, resolved from a measure's AggSemantics. */
export type MeasureExpr =
  | { kind: 'sum'; column: string }
  | {
      kind: 'sum_if';
      column: string;
      conditionColumn: string;
      gt?: number;
      lte?: number;
    }
  | { kind: 'count_distinct'; column: string }
  /** Point-in-time level: last value by the time column within the grain. */
  | { kind: 'last_value'; column: string; orderBy: string }
  | { kind: 'max'; column: string }
  /** Ratio of sums — the ONLY way a percentage/rate is ever produced. */
  | { kind: 'ratio_of_sums'; numerator: string; denominator: string }
  /**
   * Mean of a row-level average/duration. Unweighted → avg(column); weighted →
   * sum(column)/sum(weight) (use when the cube pre-sums the metric and carries a
   * row-count/weight column, giving a DAX-faithful weighted average). Not scaled.
   */
  | { kind: 'mean'; column: string; weight?: string };

export interface SemanticMeasure {
  key: string;
  label: string;
  /** e.g. "USD", "%", "count", "days". Drives axis/formatting, not computation. */
  unit: string;
  sourceTable: string;
  expr: MeasureExpr;
}

export interface SemanticDimension {
  key: string;
  label: string;
  table: string;
  column: string;
  /** Small, auto-profiled vocabulary sample used for intent matching. */
  sampleValues?: Array<string | number>;
}

export interface SemanticEntity {
  key: string;
  label: string;
  table: string;
  nameColumn: string;
}

export interface SemanticTimeGrain {
  table: string;
  column: string;
  grains: Array<'day' | 'month' | 'quarter' | 'year'>;
}

/** The client's own model — auto-built at onboarding, persisted per org. */
export interface SemanticModel {
  datasetId: string;
  version: number;
  entities: SemanticEntity[];
  measures: SemanticMeasure[];
  dimensions: SemanticDimension[];
  time?: SemanticTimeGrain;
  /** What ONE row of the primary fact table represents. Drives correct agg. */
  factGrain: string;
  builtBy: 'auto' | 'auto+review';
}

/** The planner's structured output — chart intent expressed in model terms. */
export interface EngineChartSpec {
  chartType:
    | 'bar'
    | 'horizontal_bar'
    | 'stacked_bar'
    | 'line'
    | 'area'
    | 'stacked_area'
    | 'combo'
    | 'pie'
    | 'donut'
    | 'treemap'
    | 'scatter'
    | 'bubble'
    | 'waterfall'
    | 'histogram'
    | 'box_plot'
    | 'radar'
    | 'funnel'
    | 'sankey'
    | 'heatmap'
    | 'matrix'
    | 'table'
    | 'kpi';
  /** Preserve an explicit clustered/grouped-column request across follow-ups. */
  clustered?: boolean;
  /** Measure keys, resolved against SemanticModel.measures. */
  measureKeys: string[];
  /** Optional grouping dimension key (categorical) — resolved against dimensions. */
  dimensionKey?: string;
  /** Optional second categorical dimension used as the series/color breakdown. */
  breakdownKey?: string;
  /** Optional time grain when the user wants a trend. */
  timeGrain?: 'day' | 'month' | 'quarter' | 'year';
  /** Optional aligned comparison series derived from the same measure. */
  comparison?: 'previous_year' | 'yoy_growth_pct';
  /**
   * Render each series as its PERCENTAGE CONTRIBUTION to the per-axis total
   * (100%-stacked): value → 100 * value / sum(value) over the same axis bucket.
   * For "each category's % contribution", "share of total", "% of revenue by X".
   * Only meaningful with a breakdown/series; forces a percent value format.
   */
  normalize?: boolean;
  /** Optional top-N over the first measure. */
  topN?: number;
  /** Sort direction for top-N / ranking. */
  sort?: 'asc' | 'desc';
  /** Optional category labels to emphasize visually (derived from user text). */
  highlightNames?: string[];
  /** Preserve all categories while emphasizing the highest N values. */
  highlightTopN?: number;
  /** The measures are additive components requested as a stacked composition. */
  componentMode?: boolean;
  /** A queried total used only as the stack label, never as another segment. */
  labelMeasureKey?: string;
  /** Emphasize values below zero and render a zero reference line. */
  highlightNegative?: boolean;
  title: string;
}
