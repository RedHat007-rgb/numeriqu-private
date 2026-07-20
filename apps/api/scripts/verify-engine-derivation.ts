/**
 * End-to-end engine correctness proof on live data.
 *
 * Runs the REAL engine path — schema-introspector → data-profiler →
 * semantic-model-builder → spec-compiler — against a view the engine actually
 * serves for the sfin org, then EXECUTES the compiled, tenant-scoped SQL and
 * ties the headline figures to DAX ground truth recomputed from the raw star
 * schema. Proves "Astra gives correct results" through the engine's own code,
 * not just that the cubes are correct.
 *
 * Run: cd apps/api && npx tsx scripts/verify-engine-derivation.ts [view]
 */
import path from 'node:path';
import dotenv from 'dotenv';
import { createClient } from '@clickhouse/client';
import {
  buildColumnStatsQuery,
  buildColumnsQuery,
  buildTableRowsQuery,
  parseSchema,
  type ColumnRow,
  type TableRow,
} from '../src/modules/chart-engine/schema-introspector';
import { profileTable, type ColumnStats } from '../src/modules/chart-engine/data-profiler';
import { buildSemanticModel } from '../src/modules/chart-engine/semantic-model-builder';
import { compileSpec } from '../src/modules/chart-engine/spec-compiler';
import type { ColumnProfile, EngineChartSpec } from '../src/modules/chart-engine/semantic-model.types';

dotenv.config({ path: path.resolve(__dirname, '../.env'), quiet: true });

const DB = process.env.CLICKHOUSE_ANALYTICS_DB || 'analytics';
const VIEW = process.argv[2] || 'v_sfin_gl_semantic';
const NUMERIC = /\b(Int|UInt|Float|Decimal)/i;

const ch = createClient({
  url: process.env.CLICKHOUSE_ANALYTICS_URL,
  username: process.env.CLICKHOUSE_ANALYTICS_USER,
  password: process.env.CLICKHOUSE_ANALYTICS_PASSWORD,
  database: DB,
});
const q = <T>(query: string, query_params: Record<string, unknown> = {}) =>
  ch.query({ query, query_params, format: 'JSONEachRow' }).then((r) => r.json() as Promise<T[]>);

async function scalar(query: string, params: Record<string, unknown> = {}): Promise<number> {
  const [row] = await q<{ v: number }>(query, params);
  return Number(row?.v);
}

(async () => {
  // 1) Introspect + profile + derive the model (the real engine code).
  const columnRows = await q<ColumnRow>(buildColumnsQuery(), { db: DB, pattern: VIEW });
  const tableRows = await q<TableRow>(buildTableRowsQuery(), { db: DB }).catch(() => [] as TableRow[]);
  const schema = parseSchema('sfin', columnRows, tableRows, new Date().toISOString());
  const profilesByTable: Record<string, ColumnProfile[]> = {};
  for (const t of schema.tables) {
    const stats: ColumnStats[] = [];
    for (const c of t.columns) {
      try {
        const [row] = await q<any>(buildColumnStatsQuery(DB, t.name, c.name, NUMERIC.test(c.type)));
        stats.push({
          table: t.name, column: c.name, type: c.type,
          distinctCount: Number(row?.distinct_count) || 0,
          nullFraction: Number(row?.null_fraction) || 0,
          min: row?.min_v != null ? Number(row.min_v) : undefined,
          max: row?.max_v != null ? Number(row.max_v) : undefined,
          sampleValues: (row?.samples ?? []).slice(0, 5),
          rowCount: Number(row?.row_count) || 0,
        });
      } catch { /* skip unreadable column */ }
    }
    profilesByTable[t.name] = profileTable(stats, { allowMean: true });
  }
  const { model } = buildSemanticModel({ schema, profilesByTable });
  console.log(`Engine derived ${model.measures.length} measures from ${VIEW}\n`);

  // 2) Real tenant scope for the sfin org (from the data, as the engine would).
  const [scope] = await q<{ tenant_id: string; org_id: string }>(
    `SELECT tenant_id, org_id FROM ${DB}.${VIEW} LIMIT 1`,
  );
  const ctx = { analyticsDb: DB, tenantId: scope.tenant_id, externalOrgIds: [scope.org_id] };

  // 3) DAX ground truth from the RAW star schema (independent of the engine).
  const daxRevenue = await scalar(
    `SELECT round(sumIf(pl_amount_usd, account_type='Revenue'), 2) AS v FROM ${DB}.sfin_fact_general_ledger`,
  );
  const daxCogs = await scalar(
    `SELECT round(sumIf(pl_amount_usd, account_type='Direct Cost (COS)'), 2) AS v FROM ${DB}.sfin_fact_general_ledger`,
  );
  const truth: Record<string, number> = {
    total_revenue_usd: daxRevenue,
    total_cogs_usd: daxCogs,
    gross_profit_usd: Math.round((daxRevenue - daxCogs) * 100) / 100,
  };

  // 4) For each measure with a DAX truth, COMPILE via the engine + RUN it scoped.
  let pass = 0, fail = 0;
  console.log('=== ENGINE-COMPILED vs DAX (cent-exact expected) ===');
  for (const [column, want] of Object.entries(truth)) {
    const measure = model.measures.find((m) => m.expr.kind === 'sum' && (m.expr as { column: string }).column === column);
    if (!measure) { console.log(`   ⚠️  no engine measure for ${column} (derived model missing it)`); fail++; continue; }
    const spec: EngineChartSpec = { chartType: 'kpi', measureKeys: [measure.key], title: measure.label };
    const compiled = compileSpec(spec, model, ctx);
    if (!compiled.ok) { console.log(`   ❌ compile failed for ${measure.key}: ${compiled.reason}`); fail++; continue; }
    const [row] = await q<Record<string, number>>(compiled.sql, compiled.params as Record<string, unknown>);
    const got = Math.round(Number(Object.values(row ?? {})[0]) * 100) / 100;
    const ok = Math.abs(got - want) < 0.01;
    ok ? pass++ : fail++;
    console.log(`   ${ok ? '✅' : '❌'} ${measure.key.padEnd(24)} engine=${got}  dax=${want}  Δ=${Math.abs(got - want).toFixed(2)}`);
  }

  await ch.close();
  console.log(`\n${fail === 0 ? '✅ ENGINE CORRECT' : '❌ MISMATCH'} — ${pass} measures tied out to DAX, ${fail} failed.`);
  process.exitCode = fail === 0 ? 0 : 1;
})().catch((e) => { console.error('FATAL', e); process.exitCode = 1; });
