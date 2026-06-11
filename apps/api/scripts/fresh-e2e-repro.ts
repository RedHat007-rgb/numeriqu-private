/**
 * Fresh end-to-end generalization test — READ ONLY.
 * Brand-new prompts (NOT in the Aakash/Velan test set), each with a follow-up.
 * Mirrors production: turn-1 = gate + generateSmartPlan (+ same dynamicSql backfill
 * as the create path); turn-2 = gate + generateEditPlan on the turn-1 chart.
 *
 * Run: cd apps/api && npx tsx scripts/fresh-e2e-repro.ts
 */
import 'reflect-metadata';
import path from 'node:path';
import dotenv from 'dotenv';
import { createClient as createClickHouseClient } from '@clickhouse/client';

dotenv.config({ path: path.resolve(__dirname, '../.env'), quiet: true });

let installLlmFetchInterceptor: () => void;
let AgentService: any;

const SCOPE = {
  tenantId: '3c964ac3-7868-48ca-a197-53cf9629175d',
  connectionIds: [],
  externalOrgIds: ['sample_gl_2024'],
};

const ch = createClickHouseClient({
  url: process.env.CLICKHOUSE_ANALYTICS_URL || process.env.CLICKHOUSE_URL,
  username: process.env.CLICKHOUSE_ANALYTICS_USER || process.env.CLICKHOUSE_USER || 'default',
  password: process.env.CLICKHOUSE_ANALYTICS_PASSWORD || process.env.CLICKHOUSE_PASSWORD || '',
  database: process.env.CLICKHOUSE_ANALYTICS_DB || 'analytics',
});

let svc: any;

// Fresh prompts — deliberately different wording from the test set.
const CASES: { id: string; q: string; followUp: string }[] = [
  { id: 'F1 class bar → normalize', q: 'Show me total spend by class as a bar chart.', followUp: 'Now show each class as a percentage of the total instead.' },
  { id: 'F2 account bar → reference line', q: 'Which expense accounts cost us the most? A bar chart please.', followUp: 'Add a line marking the average across all accounts.' },
  { id: 'F3 monthly line → moving average', q: 'Plot our overall monthly spending as a line chart.', followUp: 'Smooth it with a 4-month moving average.' },
  { id: 'F4 vendor bar → second axis count', q: 'Rank our vendors by how much we spend with them.', followUp: 'Also show the number of transactions for each vendor.' },
  { id: 'F5 pie dept → values', q: 'Give me a pie chart of how spend splits across departments.', followUp: 'Label it with dollar amounts rather than percentages.' },
  { id: 'F6 account bar → YoY (impossible)', q: 'Bar chart of spending grouped by account, biggest first.', followUp: 'Add the year-over-year growth for each one.' },
  { id: 'F7 dept×month heatmap → variance (snapshot? )', q: 'Heatmap of how each department spends month to month.', followUp: 'Add a column with the change from the previous month.' },
  { id: 'F8 treemap → 3D (unsupported)', q: 'Treemap of spend broken down by vendor.', followUp: 'Make it a 3D rotating treemap.' },
];

async function genDynamicSqlFor(w: any): Promise<string | null> {
  let sql: string | null = w._sql ?? null;
  if (!sql && w.metric === 'dynamic') {
    sql = await svc
      .generateDynamicSql(w._dynamicIntent ?? `${w.title} chart`, w.title, SCOPE, undefined)
      .catch(() => null);
  }
  return sql;
}

(async () => {
  ({ installLlmFetchInterceptor } = await import('../src/common/llm/llm-fetch-interceptor'));
  ({ AgentService } = await import('../src/modules/agent/agent.service'));
  installLlmFetchInterceptor();
  svc = new AgentService({} as any, ch as any, {} as any);

  for (const c of CASES) {
    console.log('═'.repeat(95));
    console.log(`CASE ${c.id}`);
    console.log(`  Q1: "${c.q}"`);

    // ── Turn 1: create ──
    const g1 = svc.detectUnsupportedOrAmbiguousAsk(c.q, false);
    if (g1) { console.log(`  T1 GATED: ${g1.reason}`); }
    let plan1: any = null;
    if (!g1) plan1 = await svc.generateSmartPlan(c.q, SCOPE, undefined, '').catch((e: any) => ({ _err: e?.message }));
    if (!plan1 || plan1._err || plan1.kind !== 'build') {
      console.log(`  T1 result: ${plan1?._err ? 'ERR ' + plan1._err : plan1?.kind ?? 'null'}`);
      continue;
    }
    const w = plan1.plan.dashboard.widgets[0];
    const sql = await genDynamicSqlFor(w);
    const backedBy = sql ? 'dynamicSql' : `VOCAB (metric=${w.metric}/${w.grouping}, NO sql)`;
    console.log(`  T1 chart: [${w.type}] "${w.title}" — ${backedBy}`);

    const queryConfig: any = sql
      ? { metric: 'dynamic', grouping: 'query', dynamicSql: sql }
      : { metric: w.metric, grouping: w.grouping };
    const activeDashboard = {
      id: 'd', title: 'Dash',
      widgets: [{ id: 'w0', title: w.title, chartType: w.type, queryConfig, displayOrder: 0 }],
    };

    // ── Turn 2: follow-up ──
    console.log(`  Q2 (follow-up): "${c.followUp}"`);
    const g2 = svc.detectUnsupportedOrAmbiguousAsk(c.followUp, true);
    if (g2) { console.log(`  T2 >>> GATED: ${g2.reason}`); continue; }
    const edit = await svc.generateEditPlan(activeDashboard, c.followUp, SCOPE, undefined, `User: ${c.q}`).catch((e: any) => ({ _err: e?.message }));
    if (edit?._err) { console.log(`  T2 ERR: ${edit._err}`); continue; }
    if (edit?.refusal) { console.log(`  T2 >>> REFUSAL: ${edit.refusal.slice(0, 120)}`); continue; }
    const mods = edit?.modify ?? [];
    const adds = edit?.add ?? [];
    const dataChanged = mods.some((m: any) => m.dynamicSql) || adds.some((a: any) => a.dynamicSql);
    const onlyDisplay = mods.some((m: any) => m.display && !m.dynamicSql);
    console.log(`  T2 result: ${mods.length} modify, ${adds.length} add | summary="${edit?.summary ?? ''}"`);
    if (dataChanged) console.log(`  T2 >>> DATA CHANGED ✓ ${mods.filter((m:any)=>m.dynamicSql).map((m:any)=>JSON.stringify(m.display ?? {})).join(' ')}`);
    else if (onlyDisplay) console.log(`  T2 >>> display-only change (labelMode etc.)`);
    else console.log(`  T2 >>> NO-OP (likely SAME OUTPUT) — base backed by ${backedBy}`);
  }
  console.log('═'.repeat(95));
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
