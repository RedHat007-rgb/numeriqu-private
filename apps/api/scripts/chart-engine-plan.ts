/**
 * Live END-TO-END harness for the autonomous chart engine:
 *   typed question → OpenAI plans it → compile to SQL → run on ClickHouse → rows.
 *
 * Uses the REAL engine code from src/ and REAL OpenAI (forces provider=openai).
 * Rebuilds the semantic model live from a client-level view so ranking questions
 * have a client dimension to work with.
 *
 * Run: cd apps/api && npx tsx scripts/chart-engine-plan.ts "top 5 clients by revenue" [view]
 */
import path from 'node:path';
import dotenv from 'dotenv';
import { createClient } from '@clickhouse/client';
import {
  buildColumnStatsQuery, buildColumnsQuery, buildTableRowsQuery, parseSchema,
  type ColumnRow, type TableRow,
} from '../src/modules/chart-engine/schema-introspector';
import { profileTable, type ColumnStats } from '../src/modules/chart-engine/data-profiler';
import { buildSemanticModel } from '../src/modules/chart-engine/semantic-model-builder';
import { type LlmCaller } from '../src/modules/chart-engine/chart-planner';
import { planAcrossCubes, type Cube } from '../src/modules/chart-engine/cube-router';
import { compileSpec } from '../src/modules/chart-engine/spec-compiler';
import type { ColumnProfile } from '../src/modules/chart-engine/semantic-model.types';

// The set of coherent monthly cubes the engine can route across ("all views").
const CUBE_VIEWS = [
  'v_ebpo_revenue_expense_by_client_monthly',
  'v_ebpo_revenue_by_business_unit_monthly',
  'v_ebpo_revenue_by_geography_monthly',
  'v_ebpo_revenue_by_department_monthly',
  'v_ebpo_cfo_ratios_monthly',
];

dotenv.config({ path: path.resolve(__dirname, '../.env'), quiet: true });

const DB = process.env.CLICKHOUSE_ANALYTICS_DB || 'analytics';
const NUMERIC = /\b(Int|UInt|Float|Decimal)/i;
const question = process.argv[2] || 'top 5 clients by revenue';
const view = process.argv[3] || 'v_ebpo_revenue_expense_by_client_monthly';
const SCOPE = {
  tenantId: process.env.HARNESS_TENANT || '7375b5aa-f5bc-4739-88e1-02be1203439b',
  externalOrgIds: [process.env.HARNESS_ORG || 'ebpo_enterprise'],
};

const ch = createClient({
  url: process.env.CLICKHOUSE_ANALYTICS_URL,
  username: process.env.CLICKHOUSE_ANALYTICS_USER,
  password: process.env.CLICKHOUSE_ANALYTICS_PASSWORD,
  database: DB,
});
const q = <T>(query: string, query_params: Record<string, unknown>) =>
  ch.query({ query, query_params, format: 'JSONEachRow' }).then((r) => r.json() as Promise<T[]>);

// Real OpenAI caller (chat completions, JSON mode).
const OPENAI_MODEL = process.env.OPENAI_MODEL?.trim() || 'gpt-5.4-mini';
const openai: LlmCaller = async (system, user) => {
  const res = await fetch(`${process.env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1'}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      response_format: { type: 'json_object' },
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data: any = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
};

async function buildModelForView(v: string) {
  const cols = await q<ColumnRow>(buildColumnsQuery(), { db: DB, pattern: v });
  const tRows = await q<TableRow>(buildTableRowsQuery(), { db: DB }).catch(() => [] as TableRow[]);
  const schema = parseSchema('ebpo', cols, tRows, new Date().toISOString());
  const profilesByTable: Record<string, ColumnProfile[]> = {};
  for (const t of schema.tables) {
    const stats: ColumnStats[] = [];
    for (const c of t.columns) {
      try {
        const [row] = await q<any>(buildColumnStatsQuery(DB, t.name, c.name, NUMERIC.test(c.type)), {});
        stats.push({ table: t.name, column: c.name, type: c.type, distinctCount: Number(row?.distinct_count) || 0, nullFraction: Number(row?.null_fraction) || 0, min: row?.min_v != null ? Number(row.min_v) : undefined, max: row?.max_v != null ? Number(row.max_v) : undefined, sampleValues: (row?.samples ?? []).slice(0, 5), rowCount: Number(row?.row_count) || 0 });
      } catch { /* skip */ }
    }
    profilesByTable[t.name] = profileTable(stats);
  }
  return buildSemanticModel({ schema, profilesByTable }).model;
}

(async () => {
  // Single view via CLI arg, or route across all coherent cubes (default).
  const views = process.argv[3] ? [process.argv[3]] : CUBE_VIEWS;
  console.log(`Q: "${question}"\nrouting across ${views.length} cube(s) · OpenAI ${OPENAI_MODEL}\n`);
  const cubes: Cube[] = [];
  for (const v of views) cubes.push({ view: v, model: await buildModelForView(v) });

  const plan = await planAcrossCubes(question, cubes, openai);
  if (!plan.ok) {
    console.log(`PLAN → no cube could answer:`);
    for (const r of plan.reasons) console.log('  - ' + r);
    await ch.close();
    return;
  }
  console.log(`ROUTED → cube ${plan.cube.view}`);
  console.log('PLAN (from OpenAI):', JSON.stringify(plan.spec));

  const compiled = compileSpec(plan.spec, plan.cube.model, { analyticsDb: DB, tenantId: SCOPE.tenantId, externalOrgIds: SCOPE.externalOrgIds });
  if (!compiled.ok) { console.log(`COMPILE → refused: ${compiled.reason}`); await ch.close(); return; }
  console.log('\nSQL:\n' + compiled.sql + '\n');

  const rows = await q<Record<string, unknown>>(compiled.sql, compiled.params);
  console.log(`RESULT (${rows.length} rows):`);
  for (const r of rows.slice(0, 15)) console.log('  ' + JSON.stringify(r));
  await ch.close();
})().catch((e) => { console.error('FATAL', e.message || e); process.exit(1); });
