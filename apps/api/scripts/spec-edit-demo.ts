/**
 * Phase-3 proof: follow-ups as ChartSpec DELTAS through the real
 * AgentService.generateEditPlan (AGENT_SPEC_MODE=1). Creates a spec chart, then
 * applies a chain of follow-ups — each returns an updated spec that recompiles to
 * correct SQL on live ClickHouse. The spec is carried forward between turns
 * (simulating persistence) so edits compound. READ ONLY.
 *
 * Run: cd apps/api && AGENT_SPEC_MODE=1 npx tsx scripts/spec-edit-demo.ts
 */
import 'reflect-metadata';
import path from 'node:path';
import dotenv from 'dotenv';
import { createClient } from '@clickhouse/client';

dotenv.config({ path: path.resolve(__dirname, '../.env'), quiet: true });
process.env.AGENT_SPEC_MODE = '1';

const SCOPE = {
  tenantId: '3c964ac3-7868-48ca-a197-53cf9629175d',
  connectionIds: [],
  externalOrgIds: ['sample_gl_2024'],
};
const ch = createClient({
  url: process.env.CLICKHOUSE_ANALYTICS_URL,
  username: process.env.CLICKHOUSE_ANALYTICS_USER,
  password: process.env.CLICKHOUSE_ANALYTICS_PASSWORD,
  database: process.env.CLICKHOUSE_ANALYTICS_DB || 'analytics',
});

const FOLLOWUPS = [
  'make it quarterly',
  'actually use transaction count instead of spend',
  'now normalize it to 100%',
  'break it down by class instead of department',
  'can you compare that to budget', // → refusal
];

async function runSql(sql: string) {
  const r = await ch.query({ query: sql, query_params: { tenantId: SCOPE.tenantId, externalOrgIds: SCOPE.externalOrgIds }, format: 'JSONEachRow' });
  return r.json() as Promise<any[]>;
}

(async () => {
  const { installLlmFetchInterceptor } = await import('../src/common/llm/llm-fetch-interceptor');
  const { AgentService } = await import('../src/modules/agent/agent.service');
  installLlmFetchInterceptor();
  const svc: any = new AgentService({} as any, ch as any, {} as any);

  console.log('CREATE: "monthly spend by department as a heatmap"');
  const created = await svc.generateSpecPlan('monthly spend by department as a heatmap', SCOPE, '');
  let w = created.plan.dashboard.widgets[0];
  let dash = {
    id: 'd', title: 'T',
    widgets: [{ id: 'w0', title: w.title, chartType: w.type, queryConfig: { metric: 'dynamic', grouping: 'query', dynamicSql: w._sql, spec: w._spec }, displayOrder: 0 }],
  };
  console.log(`  spec: ${JSON.stringify(w._spec)}`);
  let rows = await runSql(w._sql);
  console.log(`  → [${w.type}] ${rows.length} rows, cols: [${Object.keys(rows[0] ?? {}).join(', ')}]\n`);

  for (const fu of FOLLOWUPS) {
    console.log(`FOLLOW-UP: "${fu}"`);
    const plan = await svc.generateEditPlan(dash, fu, SCOPE, undefined, '');
    if (plan?.refusal) { console.log(`  → REFUSED: ${plan.refusal}\n`); continue; }
    const m = (plan?.modify ?? [])[0];
    if (!m?.spec || !m?.dynamicSql) { console.log(`  → (no spec delta) ${JSON.stringify(plan?.modify ?? [])}\n`); continue; }
    rows = await runSql(m.dynamicSql).catch((e) => { console.log('  run error', e?.message); return []; });
    console.log(`  → spec: ${JSON.stringify(m.spec)}`);
    console.log(`  → [${m.type}] ${rows.length} rows, cols: [${Object.keys(rows[0] ?? {}).join(', ')}]  sample: ${JSON.stringify(rows[0] ?? {})}\n`);
    // carry the updated spec + sql forward (simulate persistence)
    dash.widgets[0].chartType = m.type;
    dash.widgets[0].queryConfig = { metric: 'dynamic', grouping: 'query', dynamicSql: m.dynamicSql, spec: m.spec };
  }
  process.exit(0);
})().catch((e) => { console.error('FATAL', e?.message ?? e); process.exit(1); });
