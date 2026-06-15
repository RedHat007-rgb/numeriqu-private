/**
 * Phase-2 proof: the REAL AgentService.generateSpecPlan turns NATURAL LANGUAGE
 * into a ChartSpec (via OpenAI), compiles it to SQL, and runs it on live
 * ClickHouse. This is the spec-first create path (AGENT_SPEC_MODE=1). READ ONLY.
 *
 * Run: cd apps/api && npx tsx scripts/spec-plan-demo.ts
 */
import 'reflect-metadata';
import path from 'node:path';
import dotenv from 'dotenv';
import { createClient } from '@clickhouse/client';

dotenv.config({ path: path.resolve(__dirname, '../.env'), quiet: true });

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

const PROMPTS = [
  'show me monthly spend by department as a heatmap',
  'top 10 vendors by spend',
  'give me a pie of spend share by class',
  'transaction count per department',
  'monthly spend trend, normalized to 100% by department',
  'how does our spend compare to budget this year', // → refusal (no budget)
  'break spend down by region', // → refusal (no region)
];

(async () => {
  const { installLlmFetchInterceptor } = await import('../src/common/llm/llm-fetch-interceptor');
  const { AgentService } = await import('../src/modules/agent/agent.service');
  installLlmFetchInterceptor();
  const svc: any = new AgentService({} as any, ch as any, {} as any);

  for (const prompt of PROMPTS) {
    console.log('─'.repeat(92));
    console.log(`PROMPT: "${prompt}"`);
    const res = await svc.generateSpecPlan(prompt, SCOPE, '').catch((e: any) => ({ _err: e?.message }));
    if (!res || res._err) {
      console.log(`  → (no spec plan) ${res?._err ?? 'null'}`);
      continue;
    }
    if (res.kind === 'no_data') {
      console.log(`  → REFUSED: ${res.message}`);
      continue;
    }
    const w = res.plan.dashboard.widgets[0];
    console.log(`  → SPEC: ${JSON.stringify(w._spec)}`);
    const r = await ch
      .query({ query: w._sql, query_params: { tenantId: SCOPE.tenantId, externalOrgIds: SCOPE.externalOrgIds }, format: 'JSONEachRow' })
      .then((x) => x.json() as Promise<any[]>)
      .catch((e) => { console.log('   run error', e?.message); return []; });
    const cols = Object.keys(r[0] ?? {});
    console.log(`  → [${w.type}] "${w.title}" — ${r.length} rows, cols: [${cols.join(', ')}]`);
    console.log(`     sample: ${JSON.stringify(r[0] ?? {})}`);
  }
  console.log('─'.repeat(92));
  process.exit(0);
})().catch((e) => { console.error('FATAL', e?.message ?? e); process.exit(1); });
