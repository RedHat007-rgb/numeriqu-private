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
import type { PrismaClient } from '@repo/db';
import { CLICKHOUSE_ANALYTICS_TOKEN, PRISMA_TOKEN } from '../../database/database.module';
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
import type { ColumnProfile, PhysicalSchema, SemanticModel } from './semantic-model.types';
import { planAcrossCubes, type Cube } from './cube-router';
import {
  buildEngineDisplay,
  compileDistributionSql,
  compileNameValueSql,
  compiledMeasureColumn,
  compileSeriesSql,
  compileSpec,
  type EngineDisplay,
} from './spec-compiler';
import { verifyScoped, reconcileAdditive } from './result-verifier';
import { planEdit, preferDistinctAxisMeasure, type LlmCaller } from './chart-planner';
import type { EngineChartSpec } from './semantic-model.types';
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
  /** In-memory per-(org,view) model cache so we don't re-introspect each request. */
  private readonly cubeCache = new Map<string, { model: SemanticModel; at: number }>();

  constructor(
    @Inject(CLICKHOUSE_ANALYTICS_TOKEN) private readonly clickhouse: ClickHouseClient,
    @Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient,
    private readonly config: ConfigService,
    private readonly orgContext: OrganizationContextService,
  ) {
    this.analyticsDb = this.config.get<string>('CLICKHOUSE_ANALYTICS_DB') || 'analytics';
    const viewsEnv = (this.config.get<string>('CHART_ENGINE_VIEWS') || '').trim();
    this.cubeViews = viewsEnv ? viewsEnv.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_CUBE_VIEWS;
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
    if (!cubes.length) return { ok: false, reason: 'no cubes available for this dataset' };

    const plan = await planAcrossCubes(question, cubes, this.llmCaller());
    if (!plan.ok) return { ok: false, reason: `no cube could answer: ${plan.reasons.join(' | ')}` };

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
    if (!cube) return { ok: false, reason: `chart's cube is not available: ${routedView}` };

    const plan = await planEdit(instruction, priorSpec, cube.model, this.llmCaller());
    if (!plan.ok) return { ok: false, reason: plan.reason };

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
    const ctx = { analyticsDb: this.analyticsDb, tenantId: scope.tenantId, externalOrgIds: scope.externalOrgIds };
    const compiled = compileSpec(spec, cube.model, ctx);
    if (!compiled.ok) return { ok: false, reason: compiled.reason };

    const multi = spec.measureKeys.length > 1;
    const hasSeriesBreakdown =
      !!spec.breakdownKey ||
      (!!spec.timeGrain && !!spec.dimensionKey) ||
      spec.comparison === 'previous_year';
    const dyn = spec.chartType === 'box_plot' || spec.chartType === 'histogram'
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
        return { ok: false, reason: 'internal: query failed tenant-scope verification' };
      }
    }

    const rawRows = await this.queryJson<Record<string, unknown>>(
      compiled.sql,
      compiled.params as Record<string, unknown>,
    );
    const rows = this.normalizeCompiledRows(rawRows, spec);

    // Safety net #2 (guarded): reconcile an ADDITIVE headline against an
    // independent grand total. Catches join fan-out / duplication that silently
    // inflates a sum. Only when it's meaningful: a single additive measure, the
    // full partition (no top-N, not truncated). Refuse rather than chart a
    // number that doesn't tie out.
    const reconFailed = await this.reconcileAdditiveHeadline(scope, cube, spec, rows);
    if (reconFailed) {
      this.logger.warn(`engine reconciliation failed for "${spec.title}": ${reconFailed}; refusing`);
      return { ok: false, reason: 'figure failed reconciliation against the source total' };
    }

    const display = buildEngineDisplay(spec, cube.model);
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
      rows,
    };
  }

  /**
   * Reconcile an additive headline against an independent grand total. Returns a
   * failure reason string when the parts don't tie out to the total (so the
   * caller refuses), or null when it passes / doesn't apply. Deliberately narrow
   * to avoid false refusals: single additive measure, a grouping present, no
   * top-N, and the full (non-truncated) partition.
   */
  private async reconcileAdditiveHeadline(
    scope: EngineScope,
    cube: Cube,
    spec: EngineChartSpec,
    rows: Array<Record<string, unknown>>,
  ): Promise<string | null> {
    if (spec.chartType === 'box_plot' || spec.chartType === 'histogram') return null;
    if (spec.measureKeys.length !== 1 || spec.topN) return null;
    const hasGrouping = !!spec.dimensionKey || !!spec.timeGrain;
    if (!hasGrouping || !rows.length) return null;
    const measure = cube.model.measures.find((m) => m.key === spec.measureKeys[0]);
    if (!measure || measure.expr.kind !== 'sum') return null;
    // If the result may be truncated by the row cap, the parts are incomplete —
    // reconciliation would false-fail, so skip.
    if (rows.length >= 5000) return null;

    const parts = rows.map((r) => Number(r[measure.key])).filter((n) => Number.isFinite(n));
    if (parts.length !== rows.length) return null; // non-numeric rows ⇒ don't judge

    // Independent grand total: same measure, no grouping / top-N.
    const ctx = { analyticsDb: this.analyticsDb, tenantId: scope.tenantId, externalOrgIds: scope.externalOrgIds };
    const totalSpec: EngineChartSpec = { chartType: 'kpi', measureKeys: [measure.key], title: 'total' };
    const totalCompiled = compileSpec(totalSpec, cube.model, ctx);
    if (!totalCompiled.ok) return null;
    let total: number;
    try {
      const [rawRow] = await this.queryJson<Record<string, unknown>>(
        totalCompiled.sql,
        totalCompiled.params as Record<string, unknown>,
      );
      const [row] = this.normalizeCompiledRows(rawRow ? [rawRow] : [], totalSpec);
      total = Number(row?.[measure.key]);
    } catch {
      return null; // can't get an independent total ⇒ don't block on it
    }
    if (!Number.isFinite(total)) return null;

    const partsTotal = parts.reduce((sum, value) => sum + value, 0);
    // Balanced signed ledgers legitimately reconcile to floating-point dust.
    // Relative error around zero is meaningless; an absolute sub-micro-unit
    // difference is already materially exact.
    if (Math.abs(total) < 0.000001 && Math.abs(partsTotal) < 0.000001) return null;
    const recon = reconcileAdditive(parts, total);
    return recon.ok ? null : `sum(parts)=${recon.recomputed} vs total=${recon.charted} (relΔ=${recon.relDelta.toFixed(4)})`;
  }

  /**
   * The cube views to route across for this org. Preference order:
   *   1. Views registered in the Dataset registry for the org (per-dataset,
   *      set at onboarding) — this is what makes a NEW dataset shape work with
   *      zero code/env changes.
   *   2. The env/default list (EBPO back-compat).
   * A short cache avoids a registry round-trip on every request.
   */
  private readonly cubeViewCache = new Map<string, { views: string[]; at: number }>();

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
  private async registeredCubeViews(organizationId: string): Promise<string[] | null> {
    try {
      const datasets = await this.prisma.dataset.findMany({ where: { organizationId } });
      const views = datasets.flatMap((d) => {
        const schema = d.physicalSchema as { cubeViews?: unknown } | null;
        return Array.isArray(schema?.cubeViews) ? (schema!.cubeViews as unknown[]).filter((v): v is string => typeof v === 'string') : [];
      });
      return views.length ? [...new Set(views)] : null;
    } catch (e) {
      this.logger.warn(`registry cube-view lookup failed for ${organizationId}: ${(e as Error).message}`);
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
        this.logger.warn(`cube build failed for ${view}: ${(e as Error).message}`);
      }
    }
    return cubes;
  }

  /** Introspect a single view into a SemanticModel (no persistence). */
  private async introspectViewModel(view: string, allowMean = false): Promise<SemanticModel> {
    const columnRows = await this.queryJson<ColumnRow>(buildColumnsQuery(), { db: this.analyticsDb, pattern: view });
    const schema = parseSchema(`view:${view}`, columnRows, [], new Date(this.nowMs()).toISOString());
    const profilesByTable: Record<string, ColumnProfile[]> = {};
    for (const t of schema.tables) {
      // Profile columns concurrently — a view can have 30+ columns and serial
      // per-column round-trips dominate model-build latency.
      const statsList = (
        await Promise.all(
          t.columns.map(async (c) => {
            try {
              const [row] = await this.queryJson<StatsRow>(
                buildColumnStatsQuery(this.analyticsDb, t.name, c.name, NUMERIC_TYPE_RE.test(c.type)),
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
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
          body: JSON.stringify({
            model: cfg.model,
            messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
            response_format: { type: 'json_object' },
          }),
        });
        if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 200)}`);
        const data: any = await res.json();
        return data.choices?.[0]?.message?.content ?? '';
      }
      // Ollama-shaped (interceptor rewrites for the active provider).
      const res = await fetch(`${cfg.url}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: cfg.model,
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
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
  ): Promise<{ model: SemanticModel; skipped: Array<{ table: string; column: string; reason: string }> }> {
    await this.orgContext.assertOrganizationMember(organizationId, userId);
    const pattern = opts.tablePattern ?? '%';

    const columnRows = await this.queryJson<ColumnRow>(buildColumnsQuery(), { db: this.analyticsDb, pattern });
    // Row-count estimate is best-effort: restricted analytics users (e.g. a
    // dbt role) may lack SELECT on system.parts. Absence ⇒ rowCountEstimate = 0.
    const tableRows = await this.queryJson<TableRow>(buildTableRowsQuery(), { db: this.analyticsDb }).catch(
      (e: unknown) => {
        this.logger.warn(`row-count estimate unavailable: ${(e as Error).message.split('\n')[0]}`);
        return [] as TableRow[];
      },
    );
    const datasetId = `${organizationId}:${opts.kind}`;
    const schema = parseSchema(datasetId, columnRows, tableRows, new Date().toISOString());

    // Profile each column by gathering stats. Capped for safety on wide schemas;
    // stats run concurrently since they are independent read-only queries.
    const maxColumns = opts.maxColumns ?? 400;
    const targets = schema.tables
      .flatMap((table) => table.columns.map((c) => ({ table: table.name, name: c.name, type: c.type })))
      .slice(0, maxColumns);
    const profiledCols = await Promise.all(
      targets.map(async (c) => {
        try {
          const [row] = await this.queryJson<StatsRow>(
            buildColumnStatsQuery(this.analyticsDb, c.table, c.name, NUMERIC_TYPE_RE.test(c.type)),
            {},
          );
          return this.toColumnStats(c.table, c.name, c.type, row);
        } catch (e) {
          this.logger.warn(`stats query failed for ${c.table}.${c.name}: ${(e as Error).message}`);
          return null;
        }
      }),
    );
    // A dataset being registered with its own cube views is a NEW registry-driven
    // dataset → it opts into `mean` measures; a bare re-introspect does not.
    const allowMean = !!(opts.cubeViews && opts.cubeViews.length);
    const profilesByTable: Record<string, ColumnProfile[]> = {};
    for (const table of schema.tables) {
      const statsList = profiledCols.filter((s): s is ColumnStats => s !== null && s.table === table.name);
      profilesByTable[table.name] = profileTable(statsList, { allowMean });
    }

    const { model, skipped } = buildSemanticModel({ schema, profilesByTable });
    await this.persistModel(organizationId, opts.kind, schema, model, opts.cubeViews);
    this.logger.log(
      `built semantic model for org=${organizationId} kind=${opts.kind}: ` +
        `${model.measures.length} measures, ${model.dimensions.length} dims, ${skipped.length} skipped`,
    );
    return { model, skipped };
  }

  /** Read the active persisted model for an org+kind, or null. */
  async getActiveModel(organizationId: string, kind: string): Promise<SemanticModel | null> {
    const dataset = await this.prisma.dataset.findUnique({
      where: { organizationId_kind: { organizationId, kind } },
      include: { semanticModels: { where: { isActive: true }, orderBy: { version: 'desc' }, take: 1 } },
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
    const views = cubeViews && cubeViews.length ? cubeViews : schema.tables.map((t) => t.name);
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

  private async queryJson<T>(query: string, query_params: Record<string, unknown>): Promise<T[]> {
    const result = await this.clickhouse.query({ query, query_params, format: 'JSONEachRow' });
    return (await result.json()) as T[];
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
