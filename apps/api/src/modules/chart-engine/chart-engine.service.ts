/**
 * ChartEngineService — the live wiring for the autonomous engine. It runs the
 * introspection + profiling SQL against ClickHouse, builds the SemanticModel,
 * and persists it per org (Dataset + DatasetSemanticModel). See
 * docs/TARGET_ARCHITECTURE.md §4①②③ and §7 (Phases 1–2, live halves).
 *
 * The pure logic lives in the sibling files (data-profiler, semantic-model-builder,
 * schema-introspector, spec-compiler) and is unit-tested there. This service is
 * the thin, live-verifiable seam that only proves out against a running stack.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ClickHouseClient } from '@clickhouse/client';
import type { Prisma, PrismaClient } from '@repo/db';
import {
  CLICKHOUSE_ANALYTICS_TOKEN,
  PRISMA_TOKEN,
} from '../../database/database.module';
import { OrganizationContextService } from '../org-context/org-context.service';
import { profileTable, type ColumnStats } from './data-profiler';
import { buildSemanticModel } from './semantic-model-builder';
import {
  buildColumnStatsQuery,
  buildColumnsQuery,
  buildTableRowsQuery,
  parseSchema,
  type ColumnRow,
  type TableRow,
} from './schema-introspector';
import type {
  ColumnProfile,
  EngineChartSpec,
  PhysicalSchema,
  SemanticModel,
} from './semantic-model.types';
import { planAcrossCubes, type Cube } from './cube-router';
import {
  buildEngineDisplay,
  compileDistributionSql,
  compileNameValueSql,
  compiledMeasureColumn,
  compileRatioComponentsTotal,
  compileSeriesSql,
  compileSpec,
  type EngineDisplay,
} from './spec-compiler';
import { verifyScoped, reconcileForExpr } from './result-verifier';
import { isRowPolicyEnabled, tenantQuerySettings } from './ch-tenant-setting';
import {
  materializeCubes,
  type CubeMaterializerClient,
  type MaterializeResult,
} from './cube-materializer';
import type { CubeBlueprint } from './cube-builder';
import {
  fieldMatchScore,
  planEdit,
  preferDistinctAxisMeasure,
  type LlmCaller,
} from './chart-planner';
import { resolveLlmRuntimeConfig } from '../../common/llm/llm-config';

const NUMERIC_TYPE_RE = /\b(Int|UInt|Float|Decimal)/i;

/** Coherent monthly cubes the engine routes across. Overridable via env. */
const DEFAULT_CUBE_VIEWS = [
  'v_ebpo_revenue_expense_by_client_monthly',
  'v_ebpo_revenue_by_business_unit_monthly',
  'v_ebpo_revenue_by_geography_monthly',
  'v_ebpo_revenue_by_department_monthly',
  'v_ebpo_cfo_ratios_monthly',
];
const CUBE_CACHE_TTL_MS = 15 * 60 * 1000;

export interface EngineScope {
  organizationId: string;
  tenantId: string;
  externalOrgIds: string[];
}

export type EngineAnswer =
  | {
      ok: true;
      routedView: string;
      spec: EngineChartSpec;
      sql: string;
      /** Two-column (name,value) SQL for the dashboard dynamic-widget renderer. */
      nameValueSql: string;
      /** The SQL the widget should actually store — single-series (name,value) for
       * one measure, or multi-series (name + one column per measure) for several. */
      dynamicSql: string;
      title: string;
      /** The spec's requested chart type. */
      chartType: string;
      /** The chart type the WIDGET should render (e.g. 'combo' for a dual-axis mix). */
      widgetChartType: string;
      /** Frontend display hints (valueFormat + optional series/axis assignment). */
      display: EngineDisplay;
      /** How the primary value should be formatted in the UI. */
      valueFormat: 'currency' | 'percent' | 'number';
      /** Whether this answer created a fresh chart or edited an existing one. */
      mode: 'create' | 'edit';
      rows: Array<Record<string, unknown>>;
    }
  | { ok: false; reason: string };

interface StatsRow {
  row_count: number | string;
  distinct_count: number | string;
  null_fraction: number | string;
  min_v: number | string | null;
  max_v: number | string | null;
  samples: Array<string> | null;
}

export interface IntrospectOptions {
  /** Free label for the dataset, e.g. "ebpo". */
  kind: string;
  /** LIKE pattern for tables of interest; default '%' (all). */
  tablePattern?: string;
  /** Safety cap on columns profiled per run. */
  maxColumns?: number;
  /**
   * The analytic cube views the engine should route across for this org at
   * query time. Persisted on the Dataset so cube discovery is registry-driven
   * (no env/code change per dataset). Defaults to the introspected tables.
   */
  cubeViews?: string[];
}

@Injectable()
export class ChartEngineService {
  private readonly logger = new Logger(ChartEngineService.name);
  private readonly analyticsDb: string;
  private readonly cubeViews: string[];
  /** When true, tenant-scoped DATA queries carry the row-policy session setting
   * (Phase B). OFF by default — a pure no-op until the operator rollout. */
  private readonly rowPolicyEnabled: boolean;
  /** In-memory per-(org,view) model cache so we don't re-introspect each request. */
  private readonly cubeCache = new Map<
    string,
    { model: SemanticModel; at: number }
  >();

  constructor(
    @Inject(CLICKHOUSE_ANALYTICS_TOKEN)
    private readonly clickhouse: ClickHouseClient,
    @Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient,
    private readonly config: ConfigService,
    private readonly orgContext: OrganizationContextService,
  ) {
    this.analyticsDb =
      this.config.get<string>('CLICKHOUSE_ANALYTICS_DB') || 'analytics';
    const viewsEnv = (
      this.config.get<string>('CHART_ENGINE_VIEWS') || ''
    ).trim();
    this.cubeViews = viewsEnv
      ? viewsEnv
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : DEFAULT_CUBE_VIEWS;
    this.rowPolicyEnabled = isRowPolicyEnabled(
      this.config.get<string>('CH_ROW_POLICY_ENABLED'),
    );
  }

  /**
   * Answer a natural-language question with the autonomous engine:
   * introspect/cache the cubes → route the question to the right cube (OpenAI) →
   * compile tenant-scoped SQL → run it. Returns the spec + rows, or an honest
   * refusal. Never throws for a normal "can't answer" — only for infra failure,
   * so the caller can safely fall back to the legacy engine.
   */
  async answer(scope: EngineScope, question: string): Promise<EngineAnswer> {
    const cubes = await this.getCubes(scope.organizationId);
    if (!cubes.length)
      return { ok: false, reason: 'no cubes available for this dataset' };

    const plan = await planAcrossCubes(question, cubes, this.llmCaller());
    if (!plan.ok)
      return {
        ok: false,
        reason: `no cube could answer: ${plan.reasons.join(' | ')}`,
      };

    return this.shapeAnswer(scope, plan.cube, plan.spec, 'create');
  }

  /**
   * Conversational EDIT: take the CURRENT chart's spec + the routed cube it came
   * from and re-plan it against the user's follow-up ("add gross margin on
   * another axis", "make it a line chart", "break it down by department"). Stays
   * within the SAME cube the chart already uses — if the change needs a measure
   * from a different cube, it returns a refusal so the caller can create fresh.
   */
  async answerEdit(
    scope: EngineScope,
    routedView: string,
    priorSpec: EngineChartSpec,
    instruction: string,
    opts: { wantsSeparateAxis?: boolean } = {},
  ): Promise<EngineAnswer> {
    const cubes = await this.getCubes(scope.organizationId);
    const cube = cubes.find((c) => c.view === routedView);
    if (!cube)
      return {
        ok: false,
        reason: `chart's cube is not available: ${routedView}`,
      };

    const plan = await planEdit(
      instruction,
      priorSpec,
      cube.model,
      this.llmCaller(),
    );
    if (!plan.ok) {
      // The active cube may not contain the newly requested metric even though a
      // purpose-built scorecard cube does. Re-plan the COMPLETE intent across all
      // cubes, preserving the old chart's measures/grouping/type. This prevents a
      // false-success edit (title changes, data does not) and avoids dropping the
      // original measure when the fresh route only sees "add payroll cost".
      const priorMeasureLabels = priorSpec.measureKeys.map(
        (key) =>
          cube.model.measures.find((measure) => measure.key === key)?.label ??
          key.replace(/_/g, ' '),
      );
      const priorDimensionLabel = priorSpec.dimensionKey
        ? (cube.model.dimensions.find(
            (dimension) => dimension.key === priorSpec.dimensionKey,
          )?.label ?? priorSpec.dimensionKey.replace(/_/g, ' '))
        : undefined;
      if (plan.reason.includes('added measure is unavailable')) {
        const requestedMeasureText =
          instruction.split(/\badd\b/i).slice(1).join(' add ') || instruction;
        const compatible = cubes
          .map((candidate) => {
            if (
              priorSpec.timeGrain &&
              (!candidate.model.time ||
                !candidate.model.time.grains.includes(priorSpec.timeGrain))
            )
              return null;
            const reboundPrior = priorMeasureLabels.map((label) =>
              candidate.model.measures
                .map((measure) => ({
                  measure,
                  score: fieldMatchScore(label, measure.key, measure.label),
                }))
                .sort((a, b) => b.score - a.score)[0],
            );
            if (
              reboundPrior.some((match) => !match || match.score < 4)
            )
              return null;
            const priorKeys = new Set(
              reboundPrior.map((match) => match!.measure.key),
            );
            const added = candidate.model.measures
              .filter((measure) => !priorKeys.has(measure.key))
              .map((measure) => ({
                measure,
                score: fieldMatchScore(
                  requestedMeasureText,
                  measure.key,
                  measure.label,
                ),
              }))
              .sort((a, b) => b.score - a.score)[0];
            const dimension = priorDimensionLabel
              ? candidate.model.dimensions
                  .map((item) => ({
                    dimension: item,
                    score: fieldMatchScore(
                      priorDimensionLabel,
                      item.key,
                      item.label,
                    ),
                  }))
                  .sort((a, b) => b.score - a.score)[0]
              : undefined;
            if (
              !added ||
              added.score < 4 ||
              (priorDimensionLabel && (!dimension || dimension.score < 4))
            )
              return null;
            return {
              candidate,
              reboundPrior,
              added,
              dimension,
              score:
                reboundPrior.reduce((sum, match) => sum + match!.score, 0) +
                added.score +
                (dimension?.score ?? 0) +
                (priorSpec.timeGrain ? 4 : 0) -
                candidate.model.measures.length / 1000,
            };
          })
          .filter((item): item is NonNullable<typeof item> => !!item)
          .sort((a, b) => b.score - a.score)[0];
        if (compatible) {
          const measureKeys = [
            ...compatible.reboundPrior.map((match) => match!.measure.key),
            compatible.added.measure.key,
          ];
          const measureLabels = measureKeys.map(
            (key) =>
              compatible.candidate.model.measures.find(
                (measure) => measure.key === key,
              )?.label ?? key.replace(/_/g, ' '),
          );
          const reboundSpec: EngineChartSpec = {
            ...priorSpec,
            measureKeys,
            ...(compatible.dimension
              ? { dimensionKey: compatible.dimension.dimension.key }
              : {}),
            title: `${measureLabels.join(' and ')}${
              compatible.dimension
                ? ` by ${compatible.dimension.dimension.label}`
                : priorSpec.timeGrain
                  ? ` by ${priorSpec.timeGrain}`
                  : ''
            }`,
          };
          return this.shapeAnswer(
            scope,
            compatible.candidate,
            reboundSpec,
            'edit',
          );
        }
      }
      const completeIntent = [
        `Create a ${priorSpec.chartType.replace(/_/g, ' ')} chart showing ${priorMeasureLabels.join(' and ')}`,
        priorSpec.timeGrain ? `${priorSpec.timeGrain}ly` : '',
        priorDimensionLabel ? `by ${priorDimensionLabel}.` : '.',
        instruction,
      ]
        .filter(Boolean)
        .join(' ');
      const rerouted = await planAcrossCubes(
        completeIntent,
        cubes,
        this.llmCaller(),
      );
      if (!rerouted.ok) return { ok: false, reason: plan.reason };
      const plannedReroutedSpec = opts.wantsSeparateAxis
        ? preferDistinctAxisMeasure(
            rerouted.spec,
            priorSpec.measureKeys,
            rerouted.cube.model,
          )
        : rerouted.spec;
      // Cross-cube re-planning rebuilds the data intent, but an additive metric
      // follow-up must not discard an explicitly requested presentation mode.
      // Preserve clustered/grouped columns when the reroute retained the same
      // base chart type; a genuine chart-type change still wins.
      const reroutedSpec: EngineChartSpec = {
        ...plannedReroutedSpec,
        ...(priorSpec.clustered &&
        plannedReroutedSpec.chartType === priorSpec.chartType
          ? { clustered: true }
          : {}),
      };
      return this.shapeAnswer(
        scope,
        rerouted.cube,
        reroutedSpec,
        'edit',
      );
    }

    // If the user explicitly asked for a separate/second axis, guarantee the added
    // measure genuinely warrants one (different unit) — the LLM alone is unreliable here.
    const spec = opts.wantsSeparateAxis
      ? preferDistinctAxisMeasure(plan.spec, priorSpec.measureKeys, cube.model)
      : plan.spec;

    return this.shapeAnswer(scope, cube, spec, 'edit');
  }

  /**
   * The single place a validated spec becomes a runnable, widget-ready answer:
   * compile the analytic SQL (for the headline rows), pick single- vs multi-series
   * dynamic SQL, derive display/axis hints, and run the query. Shared by both
   * create and edit so the two paths can never drift.
   */
  private async shapeAnswer(
    scope: EngineScope,
    cube: Cube,
    spec: EngineChartSpec,
    mode: 'create' | 'edit',
  ): Promise<EngineAnswer> {
    const ctx = {
      analyticsDb: this.analyticsDb,
      tenantId: scope.tenantId,
      externalOrgIds: scope.externalOrgIds,
    };
    const compiled = compileSpec(spec, cube.model, ctx);
    if (!compiled.ok) return { ok: false, reason: compiled.reason };

    const multi = spec.measureKeys.length > 1;
    const hasSeriesBreakdown =
      !!spec.breakdownKey ||
      (!!spec.timeGrain && !!spec.dimensionKey) ||
      spec.comparison === 'previous_year' ||
      spec.comparison === 'yoy_growth_pct';
    const dyn =
      spec.chartType === 'box_plot' || spec.chartType === 'histogram'
        ? compileDistributionSql(spec, cube.model, ctx)
        : multi || hasSeriesBreakdown
          ? compileSeriesSql(spec, cube.model, ctx)
          : compileNameValueSql(spec, cube.model, ctx);
    if (!dyn.ok) return { ok: false, reason: dyn.reason };

    // Safety net #1 (always, zero-cost): never execute an unscoped query. Both
    // the analytic SQL and the widget's stored SQL must carry the tenant scope.
    for (const sql of [compiled.sql, dyn.sql]) {
      const scopeCheck = verifyScoped(sql);
      if (!scopeCheck.ok) {
        this.logger.error(`engine refusing unscoped SQL: ${scopeCheck.reason}`);
        return {
          ok: false,
          reason: 'internal: query failed tenant-scope verification',
        };
      }
    }

    const rawRows = await this.queryJson<Record<string, unknown>>(
      compiled.sql,
      compiled.params as Record<string, unknown>,
      this.tenantSettings(scope),
    );
    const rows = this.normalizeCompiledRows(rawRows, spec);

    // Safety net #2 (guarded): reconcile the headline against an independent
    // recomputation. ADDITIVE measures tie sum(parts) to an independent grand
    // total (catches join fan-out / duplication). RATIO measures tie the charted
    // ratio to SUM(num)/SUM(den) from raw components (the avg-of-ratios tripwire).
    // Only when meaningful (single measure, no top-N, not truncated); refuse
    // rather than chart a number that doesn't tie out.
    const reconFailed = await this.reconcileHeadline(scope, cube, spec, rows);
    if (reconFailed) {
      this.logger.warn(
        `engine reconciliation failed for "${spec.title}": ${reconFailed}; refusing`,
      );
      return {
        ok: false,
        reason: 'figure failed reconciliation against the source total',
      };
    }

    let display = buildEngineDisplay(spec, cube.model);
    const changeHighlights = this.highlightNamesByMeasureChange(spec, rows);
    const weakPerformanceHighlights = this.highlightNamesByWeakPerformance(spec, rows);
    const costWithoutRevenueHighlights = this.highlightNamesByCostWithoutRevenue(spec, rows);
    const lowPerformanceHighlights = this.highlightNamesByLowPerformance(spec, rows);
    const extremeHighlights = this.highlightNamesByExtremes(spec, rows);
    const derivedHighlights = [
      ...changeHighlights,
      ...weakPerformanceHighlights,
      ...costWithoutRevenueHighlights,
      ...lowPerformanceHighlights,
      ...extremeHighlights,
    ];
    if (derivedHighlights.length) {
      display = {
        ...display,
        highlightNames: Array.from(
          new Set([...(display.highlightNames ?? []), ...derivedHighlights]),
        ),
      };
    }
    let answerRows = rows;

    // The analytic/headline query deliberately uses the raw base measure so its
    // source-total reconciliation remains independent. A YoY chart, however,
    // speaks in derived percentages. Feed narration the actual compiled chart
    // rows; otherwise a raw revenue total is formatted as a percentage (for
    // example 325499206.0%) even though the plotted value is 9.5%.
    if (spec.comparison === 'yoy_growth_pct') {
      const growthRows = await this.queryJson<Record<string, unknown>>(
        dyn.sql,
        dyn.params as Record<string, unknown>,
        this.tenantSettings(scope),
      );
      const measureKey = spec.measureKeys[0]!;
      answerRows = growthRows.map((row) => ({
        ...(spec.timeGrain ? { period: row.name } : {}),
        ...(spec.dimensionKey ? { [spec.dimensionKey]: row.series } : {}),
        [measureKey]: row.value,
      }));
    }
    return {
      ok: true,
      routedView: cube.view,
      spec,
      sql: compiled.sql,
      nameValueSql: dyn.sql,
      dynamicSql: dyn.sql,
      title: spec.title,
      chartType: spec.chartType,
      widgetChartType: display.chartType,
      display,
      valueFormat: display.valueFormat,
      mode,
      rows: answerRows,
    };
  }

  private highlightNamesByMeasureChange(
    spec: EngineChartSpec,
    rows: Array<Record<string, unknown>>,
  ): string[] {
    if (
      !spec.dimensionKey ||
      !spec.highlightTopN ||
      !spec.highlightChangeFromMeasureKey ||
      !spec.highlightChangeToMeasureKey
    ) {
      return [];
    }
    const byName = new Map<string, number>();
    for (const row of rows) {
      const name = row[spec.dimensionKey];
      if (name == null) continue;
      const from = Number(row[spec.highlightChangeFromMeasureKey]);
      const to = Number(row[spec.highlightChangeToMeasureKey]);
      if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
      const magnitude = Math.abs(to - from);
      const key = String(name);
      byName.set(key, Math.max(byName.get(key) ?? 0, magnitude));
    }
    return [...byName.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, spec.highlightTopN)
      .map(([name]) => name);
  }

  private highlightNamesByWeakPerformance(
    spec: EngineChartSpec,
    rows: Array<Record<string, unknown>>,
  ): string[] {
    if (!spec.dimensionKey || !spec.highlightWeakPerformance || rows.length < 2)
      return [];

    const revenueKey = spec.measureKeys.find((key) => /revenue/i.test(key));
    if (!revenueKey) return [];
    const metricKeys = spec.measureKeys.filter(
      (key) =>
        key !== revenueKey &&
        /growth|margin|sla|csat|collection|efficiency|dso|days_sales_outstanding/i.test(
          key,
        ),
    );
    if (!metricKeys.length) return [];

    const numericRows = rows
      .map((row) => ({
        name: row[spec.dimensionKey!],
        revenue: Number(row[revenueKey]),
        row,
      }))
      .filter(
        (item) =>
          item.name != null &&
          Number.isFinite(item.revenue) &&
          item.revenue > 0,
      );
    if (numericRows.length < 2) return [];

    const median = (values: number[]): number | undefined => {
      const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
      if (!sorted.length) return undefined;
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2
        ? sorted[mid]
        : (sorted[mid - 1]! + sorted[mid]!) / 2;
    };

    const revenueCutoff = median(numericRows.map((item) => item.revenue));
    if (revenueCutoff == null) return [];
    const metricMedians = new Map<string, number>();
    for (const key of metricKeys) {
      const value = median(rows.map((row) => Number(row[key])));
      if (value != null) metricMedians.set(key, value);
    }
    if (!metricMedians.size) return [];

    return numericRows
      .filter((item) => item.revenue >= revenueCutoff)
      .map((item) => {
        const weakScore = [...metricMedians.entries()].reduce(
          (score, [key, med]) => {
            const value = Number(item.row[key]);
            if (!Number.isFinite(value)) return score;
            const lowerIsWeak =
              /growth|margin|sla|csat|collection|efficiency/i.test(key) &&
              !/dso|days_sales_outstanding/i.test(key);
            const higherIsWeak = /dso|days_sales_outstanding/i.test(key);
            if (lowerIsWeak && value < med) return score + 1;
            if (higherIsWeak && value > med) return score + 1;
            return score;
          },
          0,
        );
        return { name: String(item.name), revenue: item.revenue, weakScore };
      })
      .filter((item) => item.weakScore > 0)
      .sort((a, b) => b.weakScore - a.weakScore || b.revenue - a.revenue)
      .slice(0, Math.min(5, Math.max(1, Math.ceil(numericRows.length / 4))))
      .map((item) => item.name);
  }

  private highlightNamesByCostWithoutRevenue(
    spec: EngineChartSpec,
    rows: Array<Record<string, unknown>>,
  ): string[] {
    if (!spec.dimensionKey || !spec.highlightCostWithoutRevenue) return [];
    const revenueKey = spec.measureKeys.find((key) => /revenue/i.test(key));
    const costKey = spec.measureKeys.find((key) => /payroll|cost/i.test(key));
    if (!revenueKey || !costKey) return [];
    return rows
      .filter((row) => {
        const revenue = Number(row[revenueKey]);
        const cost = Number(row[costKey]);
        return Number.isFinite(revenue) && Number.isFinite(cost) && Math.abs(revenue) <= 0.000001 && cost > 0;
      })
      .map((row) => row[spec.dimensionKey!])
      .filter((name): name is string | number => name != null)
      .map(String);
  }

  private highlightNamesByLowPerformance(
    spec: EngineChartSpec,
    rows: Array<Record<string, unknown>>,
  ): string[] {
    if (!spec.dimensionKey || !spec.highlightLowPerformance || rows.length < 2)
      return [];
    const qualityKeys = spec.measureKeys.filter((key) => /sla|csat|quality/i.test(key));
    if (!qualityKeys.length) return [];
    const medians = new Map<string, number>();
    for (const key of qualityKeys) {
      const values = rows.map((row) => Number(row[key])).filter(Number.isFinite).sort((a, b) => a - b);
      if (!values.length) continue;
      const mid = Math.floor(values.length / 2);
      medians.set(key, values.length % 2 ? values[mid]! : (values[mid - 1]! + values[mid]!) / 2);
    }
    return rows
      .map((row) => ({
        name: row[spec.dimensionKey!],
        score: [...medians].reduce((score, [key, median]) => {
          const value = Number(row[key]);
          return score + (Number.isFinite(value) && value < median ? 1 : 0);
        }, 0),
      }))
      .filter((item) => item.name != null && item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.min(5, Math.max(1, Math.ceil(rows.length / 4))))
      .map((item) => String(item.name));
  }

  private highlightNamesByExtremes(
    spec: EngineChartSpec,
    rows: Array<Record<string, unknown>>,
  ): string[] {
    if (!spec.dimensionKey || !spec.highlightExtremes || !spec.measureKeys[0])
      return [];
    const measureKey = spec.measureKeys[0];
    const values = rows
      .map((row) => ({
        name: row[spec.dimensionKey!],
        value: Number(row[measureKey]),
      }))
      .filter(
        (item) => item.name != null && Number.isFinite(item.value),
      );
    if (values.length < 2) return [];
    const names: string[] = [];
    if (spec.highlightExtremes === 'max' || spec.highlightExtremes === 'both') {
      const max = values.reduce((best, item) =>
        item.value > best.value ? item : best,
      );
      names.push(String(max.name));
    }
    if (spec.highlightExtremes === 'min' || spec.highlightExtremes === 'both') {
      const min = values.reduce((best, item) =>
        item.value < best.value ? item : best,
      );
      names.push(String(min.name));
    }
    return Array.from(new Set(names));
  }

  /**
   * Reconcile the headline before charting. Dispatches by the measure's
   * aggregation semantics through the single `reconcileForExpr` policy: additive
   * measures tie sum(parts) to an independent grand total; ratio measures tie the
   * charted ratio to SUM(num)/SUM(den) from raw components. Returns a failure
   * reason (caller refuses) or null when it passes / doesn't apply. Deliberately
   * narrow to avoid false refusals.
   */
  private async reconcileHeadline(
    scope: EngineScope,
    cube: Cube,
    spec: EngineChartSpec,
    rows: Array<Record<string, unknown>>,
  ): Promise<string | null> {
    if (spec.chartType === 'box_plot' || spec.chartType === 'histogram')
      return null;
    if (spec.measureKeys.length !== 1 || spec.topN) return null;
    const measure = cube.model.measures.find(
      (m) => m.key === spec.measureKeys[0],
    );
    if (!measure) return null;
    if (measure.expr.kind === 'ratio_of_sums') {
      return this.reconcileRatioHeadline(scope, cube, measure, rows);
    }
    // Only additive (sum) headlines are part-reconcilable against a grand total;
    // stocks/means/distinct-counts are levels, not sums (see reconcileForExpr).
    if (measure.expr.kind !== 'sum') return null;
    const hasGrouping = !!spec.dimensionKey || !!spec.timeGrain;
    if (!hasGrouping || !rows.length) return null;
    // If the result may be truncated by the row cap, the parts are incomplete —
    // reconciliation would false-fail, so skip.
    if (rows.length >= 5000) return null;

    const parts = rows
      .map((r) => Number(r[measure.key]))
      .filter((n) => Number.isFinite(n));
    if (parts.length !== rows.length) return null; // non-numeric rows ⇒ don't judge

    // Independent grand total: same measure, no grouping / top-N.
    const ctx = {
      analyticsDb: this.analyticsDb,
      tenantId: scope.tenantId,
      externalOrgIds: scope.externalOrgIds,
    };
    const totalSpec: EngineChartSpec = {
      chartType: 'kpi',
      measureKeys: [measure.key],
      title: 'total',
    };
    const totalCompiled = compileSpec(totalSpec, cube.model, ctx);
    if (!totalCompiled.ok) return null;
    let total: number;
    try {
      const [rawRow] = await this.queryJson<Record<string, unknown>>(
        totalCompiled.sql,
        totalCompiled.params as Record<string, unknown>,
        this.tenantSettings(scope),
      );
      const [row] = this.normalizeCompiledRows(
        rawRow ? [rawRow] : [],
        totalSpec,
      );
      total = Number(row?.[measure.key]);
    } catch {
      return null; // can't get an independent total ⇒ don't block on it
    }
    if (!Number.isFinite(total)) return null;

    const partsTotal = parts.reduce((sum, value) => sum + value, 0);
    // Currency is stored and displayed to cent precision. Signed ledgers can
    // cancel to zero while Float64 aggregation leaves a few millionths of a
    // dollar; that is not a financial mismatch and must not block the chart.
    if (measure.unit === 'USD' && Math.abs(partsTotal - total) <= 0.01)
      return null;
    // Balanced signed ledgers legitimately reconcile to floating-point dust.
    // Relative error around zero is meaningless; an absolute sub-micro-unit
    // difference is already materially exact.
    if (Math.abs(total) < 0.000001 && Math.abs(partsTotal) < 0.000001)
      return null;
    const recon = reconcileForExpr(measure.expr, { parts, charted: total });
    if ('skipped' in recon) return null;
    return recon.ok
      ? null
      : `sum(parts)=${recon.recomputed} vs total=${recon.charted} (relΔ=${recon.relDelta.toFixed(4)})`;
  }

  /**
   * Reconcile a RATIO headline: the charted grand-total ratio must equal
   * SUM(numerator)/SUM(denominator) recomputed independently from the raw
   * components (never the average of per-row ratios). The two are computed by
   * different SQL paths — the compiled analytic query vs. a bare component
   * re-sum — so a divergence signals real drift (mis-wired components, a scaling
   * regression, normalization corruption). Conservative: any query/error or
   * absent components ⇒ skip rather than false-refuse.
   */
  private async reconcileRatioHeadline(
    scope: EngineScope,
    cube: Cube,
    measure: Cube['model']['measures'][number],
    rows: Array<Record<string, unknown>>,
  ): Promise<string | null> {
    if (measure.expr.kind !== 'ratio_of_sums') return null;
    if (!rows.length) return null;
    const ctx = {
      analyticsDb: this.analyticsDb,
      tenantId: scope.tenantId,
      externalOrgIds: scope.externalOrgIds,
    };

    // The charted grand-total ratio (ungrouped) — what the headline asserts.
    const totalSpec: EngineChartSpec = {
      chartType: 'kpi',
      measureKeys: [measure.key],
      title: 'total',
    };
    const totalCompiled = compileSpec(totalSpec, cube.model, ctx);
    if (!totalCompiled.ok) return null;

    // Independent raw re-sum of the numerator/denominator columns.
    const components = compileRatioComponentsTotal(measure, ctx);
    if (!components.ok) return null;

    let charted: number;
    let sumNumerator: number;
    let sumDenominator: number;
    try {
      const settings = this.tenantSettings(scope);
      const [rawTotal] = await this.queryJson<Record<string, unknown>>(
        totalCompiled.sql,
        totalCompiled.params as Record<string, unknown>,
        settings,
      );
      const [normTotal] = this.normalizeCompiledRows(
        rawTotal ? [rawTotal] : [],
        totalSpec,
      );
      charted = Number(normTotal?.[measure.key]);
      const [comp] = await this.queryJson<Record<string, unknown>>(
        components.sql,
        components.params as Record<string, unknown>,
        settings,
      );
      sumNumerator = Number(comp?.num);
      sumDenominator = Number(comp?.den);
    } catch {
      return null; // can't recompute independently ⇒ don't block on it
    }
    if (
      ![charted, sumNumerator, sumDenominator].every((n) => Number.isFinite(n))
    )
      return null;
    // A near-zero denominator makes the ratio undefined/unstable — not a mismatch.
    if (Math.abs(sumDenominator) < 0.000001) return null;

    const recon = reconcileForExpr(measure.expr, {
      sumNumerator,
      sumDenominator,
      charted,
    });
    if ('skipped' in recon) return null;
    return recon.ok
      ? null
      : `ratio=${recon.charted} vs sum(num)/sum(den)=${recon.recomputed} (relΔ=${recon.relDelta.toFixed(4)})`;
  }

  /**
   * The cube views to route across for this org. Preference order:
   *   1. Views registered in the Dataset registry for the org (per-dataset,
   *      set at onboarding) — this is what makes a NEW dataset shape work with
   *      zero code/env changes.
   *   2. The env/default list (EBPO back-compat).
   * A short cache avoids a registry round-trip on every request.
   */
  private readonly cubeViewCache = new Map<
    string,
    { views: string[]; at: number }
  >();

  private async resolveCubeViews(organizationId: string): Promise<string[]> {
    const hit = this.cubeViewCache.get(organizationId);
    if (hit && this.nowMs() - hit.at < CUBE_CACHE_TTL_MS) return hit.views;
    const registered = await this.registeredCubeViews(organizationId);
    const views = registered ?? this.cubeViews;
    this.cubeViewCache.set(organizationId, { views, at: this.nowMs() });
    return views;
  }

  /**
   * Cube-view names registered for the org in the Dataset registry, or null if
   * none. Stored on `Dataset.physicalSchema.cubeViews` at onboarding so adding a
   * dataset is data, not code.
   */
  private async registeredCubeViews(
    organizationId: string,
  ): Promise<string[] | null> {
    try {
      const datasets = await this.prisma.dataset.findMany({
        where: { organizationId },
      });
      const views = datasets.flatMap((d) => {
        const schema = d.physicalSchema as { cubeViews?: unknown } | null;
        return Array.isArray(schema?.cubeViews)
          ? (schema!.cubeViews as unknown[]).filter(
              (v): v is string => typeof v === 'string',
            )
          : [];
      });
      return views.length ? [...new Set(views)] : null;
    } catch (e) {
      this.logger.warn(
        `registry cube-view lookup failed for ${organizationId}: ${(e as Error).message}`,
      );
      return null;
    }
  }

  /**
   * True when this org is served SOLELY by the new engine (a dataset registered
   * in the registry). The agent uses this to keep a new-engine refusal HONEST
   * instead of falling through to the legacy ebpo/gl path, which has no data for
   * a registry-only dataset and would answer nonsense.
   */
  async isEngineOnlyOrg(organizationId: string): Promise<boolean> {
    return (await this.registeredCubeViews(organizationId)) !== null;
  }

  /** Identifier guard for names that flow into DDL/DISTINCT from blueprints. */
  private chIdent(name: string): string {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`unsafe identifier: ${JSON.stringify(name)}`);
    }
    return name;
  }

  /** A CH client surface for the generic cube materializer (see cube-materializer.ts). */
  private cubeMaterializerClient(): CubeMaterializerClient {
    return {
      distinct: async (table, column) => {
        const t = this.chIdent(table);
        const c = this.chIdent(column);
        const rows = await this.queryJson<{ v: string }>(
          `SELECT DISTINCT ${c} AS v FROM ${this.chIdent(this.analyticsDb)}.${t} WHERE ${c} != '' ORDER BY v`,
          {},
        );
        return rows
          .map((r) => r.v)
          .filter((v): v is string => typeof v === 'string' && v.length > 0);
      },
      tableExists: async (name) => {
        const rows = await this.queryJson<{ n: number }>(
          `SELECT count() AS n FROM system.tables WHERE database = {db:String} AND name = {name:String}`,
          {
            db: this.analyticsDb,
            name,
          },
        );
        return Number(rows[0]?.n ?? 0) > 0;
      },
      exec: async (ddl) => {
        await this.clickhouse.command({ query: ddl });
      },
    };
  }

  /**
   * Data-driven onboarding (Phase C1, option A): materialize a new dataset's
   * standard cubes from declarative blueprints and register the created views on
   * the Dataset registry — ZERO per-dataset TypeScript. Idempotent (CREATE OR
   * REPLACE + upsert). Existing datasets are untouched; this only adds/refreshes
   * the given org's cube views. Returns which cubes were created vs skipped.
   */
  async materializeAndRegisterCubes(
    organizationId: string,
    kind: string,
    blueprints: CubeBlueprint[],
  ): Promise<MaterializeResult> {
    const result = await materializeCubes(
      this.analyticsDb,
      blueprints,
      this.cubeMaterializerClient(),
    );

    if (result.created.length) {
      const existing = await this.prisma.dataset.findUnique({
        where: { organizationId_kind: { organizationId, kind } },
      });
      const prevSchema =
        (existing?.physicalSchema as Record<string, unknown> | null) ?? {};
      const prevViews = Array.isArray(
        (prevSchema as { cubeViews?: unknown }).cubeViews,
      )
        ? (
            (prevSchema as { cubeViews?: unknown }).cubeViews as unknown[]
          ).filter((v): v is string => typeof v === 'string')
        : [];
      const cubeViews = [...new Set([...prevViews, ...result.created])];
      const physicalSchema = {
        ...prevSchema,
        cubeViews,
      } as Prisma.InputJsonValue;

      await this.prisma.dataset.upsert({
        where: { organizationId_kind: { organizationId, kind } },
        create: {
          organizationId,
          kind,
          physicalSchema,
          introspectedAt: new Date(this.nowMs()),
        },
        update: { physicalSchema, introspectedAt: new Date(this.nowMs()) },
      });
      // The org's cube list changed — drop the short cache so it's picked up now.
      this.cubeViewCache.delete(organizationId);
    }

    this.logger.log(
      `[onboard] org=${organizationId} kind=${kind} created=${result.created.length} skipped=${result.skipped.length}`,
    );
    return result;
  }

  /** Build (and cache) a cube model per configured view for this org. */
  private async getCubes(organizationId: string): Promise<Cube[]> {
    const now = this.nowMs();
    const cubes: Cube[] = [];
    const views = await this.resolveCubeViews(organizationId);
    // Registry-only datasets opt into `mean` measures; legacy/env orgs (EBPO)
    // keep their exact prior behavior. See data-profiler ProfileOptions.allowMean.
    const allowMean = await this.isEngineOnlyOrg(organizationId);
    for (const view of views) {
      const key = `${organizationId}:${view}`;
      const hit = this.cubeCache.get(key);
      if (hit && now - hit.at < CUBE_CACHE_TTL_MS) {
        cubes.push({ view, model: hit.model });
        continue;
      }
      try {
        const model = await this.introspectViewModel(view, allowMean);
        this.cubeCache.set(key, { model, at: now });
        cubes.push({ view, model });
      } catch (e) {
        this.logger.warn(
          `cube build failed for ${view}: ${(e as Error).message}`,
        );
      }
    }
    return cubes;
  }

  /** Introspect a single view into a SemanticModel (no persistence). */
  private async introspectViewModel(
    view: string,
    allowMean = false,
  ): Promise<SemanticModel> {
    const columnRows = await this.queryJson<ColumnRow>(buildColumnsQuery(), {
      db: this.analyticsDb,
      pattern: view,
    });
    const schema = parseSchema(
      `view:${view}`,
      columnRows,
      [],
      new Date(this.nowMs()).toISOString(),
    );
    const profilesByTable: Record<string, ColumnProfile[]> = {};
    for (const t of schema.tables) {
      // Profile columns concurrently — a view can have 30+ columns and serial
      // per-column round-trips dominate model-build latency.
      const statsList = (
        await Promise.all(
          t.columns.map(async (c) => {
            try {
              const [row] = await this.queryJson<StatsRow>(
                buildColumnStatsQuery(
                  this.analyticsDb,
                  t.name,
                  c.name,
                  NUMERIC_TYPE_RE.test(c.type),
                ),
                {},
              );
              return this.toColumnStats(t.name, c.name, c.type, row);
            } catch {
              return null; // skip a column we can't stat
            }
          }),
        )
      ).filter((s): s is ColumnStats => s !== null);
      profilesByTable[t.name] = profileTable(statsList, { allowMean });
    }
    return buildSemanticModel({ schema, profilesByTable }).model;
  }

  /**
   * LLM caller for the planner. Uses the configured provider. For OpenAI it
   * calls chat/completions with the API key in JSON mode; otherwise it POSTs the
   * Ollama chat shape (translated by the global LLM fetch interceptor).
   */
  private llmCaller(): LlmCaller {
    const cfg = resolveLlmRuntimeConfig('llama3:latest');
    return async (system: string, user: string): Promise<string> => {
      if (cfg.provider === 'openai') {
        const res = await fetch(`${cfg.url}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          },
          body: JSON.stringify({
            model: cfg.model,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
            response_format: { type: 'json_object' },
          }),
        });
        if (!res.ok)
          throw new Error(
            `OpenAI ${res.status}: ${(await res.text()).slice(0, 200)}`,
          );
        const data: any = await res.json();
        return data.choices?.[0]?.message?.content ?? '';
      }
      // Ollama-shaped (interceptor rewrites for the active provider).
      const res = await fetch(`${cfg.url}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: cfg.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          stream: false,
          format: 'json',
          options: { temperature: 0 },
        }),
      });
      if (!res.ok) throw new Error(`LLM ${res.status}`);
      const data: any = await res.json();
      return data.message?.content ?? '';
    };
  }

  /**
   * One-shot JSON-mode chat via the configured provider. Used to let the LLM
   * write the conversational reply from a grounded fact sheet — the caller
   * supplies the exact figures, so the model phrases but never computes.
   */
  async chat(system: string, user: string): Promise<string> {
    return this.llmCaller()(system, user);
  }

  /** Wall-clock helper (kept in one place for testability). */
  private nowMs(): number {
    return Date.now();
  }

  /**
   * Introspect the client's schema, profile every column, build a SemanticModel,
   * and persist it. Returns the model + the columns we deliberately skipped.
   */
  async introspectAndBuildModel(
    organizationId: string,
    userId: string,
    opts: IntrospectOptions,
  ): Promise<{
    model: SemanticModel;
    skipped: Array<{ table: string; column: string; reason: string }>;
  }> {
    await this.orgContext.assertOrganizationMember(organizationId, userId);
    const pattern = opts.tablePattern ?? '%';

    const columnRows = await this.queryJson<ColumnRow>(buildColumnsQuery(), {
      db: this.analyticsDb,
      pattern,
    });
    // Row-count estimate is best-effort: restricted analytics users (e.g. a
    // dbt role) may lack SELECT on system.parts. Absence ⇒ rowCountEstimate = 0.
    const tableRows = await this.queryJson<TableRow>(buildTableRowsQuery(), {
      db: this.analyticsDb,
    }).catch((e: unknown) => {
      this.logger.warn(
        `row-count estimate unavailable: ${(e as Error).message.split('\n')[0]}`,
      );
      return [] as TableRow[];
    });
    const datasetId = `${organizationId}:${opts.kind}`;
    const schema = parseSchema(
      datasetId,
      columnRows,
      tableRows,
      new Date().toISOString(),
    );

    // Profile each column by gathering stats. Capped for safety on wide schemas;
    // stats run concurrently since they are independent read-only queries.
    const maxColumns = opts.maxColumns ?? 400;
    const targets = schema.tables
      .flatMap((table) =>
        table.columns.map((c) => ({
          table: table.name,
          name: c.name,
          type: c.type,
        })),
      )
      .slice(0, maxColumns);
    const profiledCols = await Promise.all(
      targets.map(async (c) => {
        try {
          const [row] = await this.queryJson<StatsRow>(
            buildColumnStatsQuery(
              this.analyticsDb,
              c.table,
              c.name,
              NUMERIC_TYPE_RE.test(c.type),
            ),
            {},
          );
          return this.toColumnStats(c.table, c.name, c.type, row);
        } catch (e) {
          this.logger.warn(
            `stats query failed for ${c.table}.${c.name}: ${(e as Error).message}`,
          );
          return null;
        }
      }),
    );
    // A dataset being registered with its own cube views is a NEW registry-driven
    // dataset → it opts into `mean` measures; a bare re-introspect does not.
    const allowMean = !!(opts.cubeViews && opts.cubeViews.length);
    const profilesByTable: Record<string, ColumnProfile[]> = {};
    for (const table of schema.tables) {
      const statsList = profiledCols.filter(
        (s): s is ColumnStats => s !== null && s.table === table.name,
      );
      profilesByTable[table.name] = profileTable(statsList, { allowMean });
    }

    const { model, skipped } = buildSemanticModel({ schema, profilesByTable });
    await this.persistModel(
      organizationId,
      opts.kind,
      schema,
      model,
      opts.cubeViews,
    );
    this.logger.log(
      `built semantic model for org=${organizationId} kind=${opts.kind}: ` +
        `${model.measures.length} measures, ${model.dimensions.length} dims, ${skipped.length} skipped`,
    );
    return { model, skipped };
  }

  /** Read the active persisted model for an org+kind, or null. */
  async getActiveModel(
    organizationId: string,
    kind: string,
  ): Promise<SemanticModel | null> {
    const dataset = await this.prisma.dataset.findUnique({
      where: { organizationId_kind: { organizationId, kind } },
      include: {
        semanticModels: {
          where: { isActive: true },
          orderBy: { version: 'desc' },
          take: 1,
        },
      },
    });
    const persisted = dataset?.semanticModels[0];
    return persisted ? (persisted.model as unknown as SemanticModel) : null;
  }

  private async persistModel(
    organizationId: string,
    kind: string,
    schema: PhysicalSchema,
    model: SemanticModel,
    cubeViews?: string[],
  ): Promise<void> {
    // Record the query-time cube views on the schema JSON so cube discovery is
    // registry-driven (getCubes → registeredCubeViews). Defaults to the
    // introspected table/view names when the caller doesn't specify.
    const views =
      cubeViews && cubeViews.length
        ? cubeViews
        : schema.tables.map((t) => t.name);
    const physicalSchema = { ...schema, cubeViews: views } as unknown as object;
    const dataset = await this.prisma.dataset.upsert({
      where: { organizationId_kind: { organizationId, kind } },
      create: {
        organizationId,
        kind,
        physicalSchema,
        introspectedAt: new Date(),
      },
      update: { physicalSchema, introspectedAt: new Date() },
    });

    const latest = await this.prisma.datasetSemanticModel.findFirst({
      where: { datasetId: dataset.id },
      orderBy: { version: 'desc' },
    });
    const nextVersion = (latest?.version ?? 0) + 1;

    // New version becomes the single active model.
    await this.prisma.datasetSemanticModel.updateMany({
      where: { datasetId: dataset.id, isActive: true },
      data: { isActive: false },
    });
    await this.prisma.datasetSemanticModel.create({
      data: {
        datasetId: dataset.id,
        version: nextVersion,
        model: { ...model, version: nextVersion } as unknown as object,
        isActive: true,
        builtBy: model.builtBy,
      },
    });
  }

  private toColumnStats(
    table: string,
    column: string,
    type: string,
    row: StatsRow | undefined,
  ): ColumnStats {
    const num = (v: number | string | null | undefined): number | undefined => {
      if (v === null || v === undefined) return undefined;
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    };
    return {
      table,
      column,
      type,
      distinctCount: num(row?.distinct_count) ?? 0,
      nullFraction: num(row?.null_fraction) ?? 0,
      min: num(row?.min_v),
      max: num(row?.max_v),
      sampleValues: (row?.samples ?? []).slice(0, 10),
      rowCount: num(row?.row_count) ?? 0,
    };
  }

  private async queryJson<T>(
    query: string,
    query_params: Record<string, unknown>,
    /** Extra ClickHouse session settings — used to carry the row-policy tenant
     * setting on DATA queries. Omitted for schema/introspection reads (no policy
     * applies to system tables). Empty when the feature flag is off. */
    clickhouse_settings?: Record<string, string>,
  ): Promise<T[]> {
    const result = await this.clickhouse.query({
      query,
      query_params,
      format: 'JSONEachRow',
      ...(clickhouse_settings && Object.keys(clickhouse_settings).length
        ? { clickhouse_settings }
        : {}),
    });
    return (await result.json()) as T[];
  }

  /** The row-policy session setting for a tenant-scoped DATA query (or {} when
   * the flag is off). Only ever derived from the verified EngineScope. */
  private tenantSettings(scope: EngineScope): Record<string, string> {
    return tenantQuerySettings(scope.tenantId, this.rowPolicyEnabled);
  }

  /** Restore the semantic measure keys expected by reconciliation and grounded
   * response writing after the SQL compiler used collision-proof aliases. */
  private normalizeCompiledRows(
    rows: Array<Record<string, unknown>>,
    spec: EngineChartSpec,
  ): Array<Record<string, unknown>> {
    return rows.map((row) => {
      const normalized = { ...row };
      spec.measureKeys.forEach((key, index) => {
        const internal = compiledMeasureColumn(index);
        normalized[key] = row[internal];
        delete normalized[internal];
      });
      return normalized;
    });
  }
}
