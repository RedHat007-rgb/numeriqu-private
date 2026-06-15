/**
 * Phase-1 proof: drive the ChartSpec compiler against LIVE ClickHouse.
 * Shows create-as-spec, follow-ups-as-spec-deltas, and a catalog refusal —
 * the architecture that makes follow-ups reliable. READ ONLY.
 *
 * Run: cd apps/api && npx tsx scripts/chart-spec-demo.ts
 */
import 'reflect-metadata';
import path from 'node:path';
import dotenv from 'dotenv';
import { createClient } from '@clickhouse/client';
import { compileSpec, type ChartSpec } from '../src/modules/agent/chart-spec';

dotenv.config({ path: path.resolve(__dirname, '../.env'), quiet: true });

const TENANT = '3c964ac3-7868-48ca-a197-53cf9629175d';
const ORG = 'sample_gl_2024';
const DB = process.env.CLICKHOUSE_ANALYTICS_DB || 'analytics';
const ch = createClient({
  url: process.env.CLICKHOUSE_ANALYTICS_URL,
  username: process.env.CLICKHOUSE_ANALYTICS_USER,
  password: process.env.CLICKHOUSE_ANALYTICS_PASSWORD,
  database: DB,
});

// Bind the scope params the compiled SQL expects.
async function run(sql: string): Promise<Array<Record<string, unknown>>> {
  const r = await ch.query({
    query: sql,
    query_params: { tenantId: TENANT, externalOrgIds: [ORG] },
    format: 'JSONEachRow',
  });
  return r.json();
}

async function show(label: string, spec: ChartSpec) {
  const res = await compileSpec(spec, DB, run);
  if (!res.ok) {
    console.log(`\n▶ ${label}\n   REFUSED: ${res.refusal}`);
    return;
  }
  const rows = await run(res.sql);
  const cols = Object.keys(rows[0] ?? {});
  console.log(`\n▶ ${label}`);
  console.log(`   spec: ${JSON.stringify(spec)}`);
  console.log(`   → ${rows.length} rows, cols: [${cols.join(', ')}]`);
  console.log(`   sample: ${JSON.stringify(rows[0] ?? {})}`);
}

(async () => {
  // ── CREATE: "monthly spend by department, as a heatmap" ──
  let spec: ChartSpec = {
    measure: 'spend',
    dimension: 'month',
    breakdown: 'department',
    chartType: 'heatmap',
  };
  await show('CREATE  monthly spend by department (heatmap)', spec);

  // ── FOLLOW-UP 1: "make it quarterly"  → dimension delta ──
  spec = { ...spec, dimension: 'quarter' };
  await show('FOLLOW-UP  "make it quarterly"  (dimension: month→quarter)', spec);

  // ── FOLLOW-UP 2: "show month-over-month growth %" → transform delta ──
  spec = { measure: 'spend', dimension: 'month', breakdown: 'department', chartType: 'heatmap', transforms: [{ kind: 'growth_pct' }] };
  await show('FOLLOW-UP  "show MoM growth %"  (+transform growth_pct)', spec);

  // ── FOLLOW-UP 3: "normalize to 100%" → transform delta ──
  spec = { measure: 'spend', dimension: 'month', breakdown: 'department', chartType: 'stacked_bar', transforms: [{ kind: 'normalize' }] };
  await show('FOLLOW-UP  "normalize to 100%"  (+transform normalize)', spec);

  // ── DIFFERENT CHART: "top 5 vendors by spend, bar" → topN + no breakdown ──
  await show('CREATE  top 5 vendors by spend (bar)', {
    measure: 'spend', dimension: 'vendor', topN: 5, sort: 'value_desc', chartType: 'bar',
  });

  // ── MEASURE SWAP: "transaction count by department" → measure delta ──
  await show('FOLLOW-UP  "use transaction count instead of spend"  (measure delta)', {
    measure: 'txn_count', dimension: 'department', chartType: 'bar', sort: 'value_desc',
  });

  // ── CAPABILITY: "vs budget" → catalog refusal (no hallucinated column) ──
  await show('REFUSE  "compare to budget"  (catalog has no budget)', {
    measure: 'budget' as any, dimension: 'account', chartType: 'bar',
  });

  process.exit(0);
})().catch((e) => { console.error('FATAL', e?.message ?? e); process.exit(1); });
