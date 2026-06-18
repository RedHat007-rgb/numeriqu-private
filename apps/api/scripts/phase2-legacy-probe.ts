/**
 * Phase-2 legacy-fallback validation (DB-free).
 *
 * Replicates the query() no_data fallback (agent.service.ts ~line 10031) WITHOUT
 * Prisma/session writes: for each question call generateSmartPlan; if it returns
 * no_data, call the legacy generatePlan and see whether it would have produced a
 * chart. Every LEGACY_RESCUE is a question the spec/LLM path cannot answer but the
 * legacy planner can — i.e. a blocker to deleting metricData. Zero rescues across a
 * battery aimed at the known legacy-only cases = strong evidence it is safe to delete.
 *
 * Run: cd apps/api && HARNESS_TENANT=... HARNESS_ORG=sample_gl_2024 \
 *        npx tsx scripts/phase2-legacy-probe.ts
 */
import 'reflect-metadata';
import path from 'node:path';
import dotenv from 'dotenv';
import { createClient } from '@clickhouse/client';
dotenv.config({ path: path.resolve(__dirname, '../.env'), quiet: true });

const SCOPE = {
  tenantId: process.env.HARNESS_TENANT || '3c964ac3-7868-48ca-a197-53cf9629175d',
  connectionIds: [] as string[],
  externalOrgIds: [process.env.HARNESS_ORG || 'sample_gl_2024'],
};

const ch = createClient({
  url: process.env.CLICKHOUSE_ANALYTICS_URL,
  username: process.env.CLICKHOUSE_ANALYTICS_USER,
  password: process.env.CLICKHOUSE_ANALYTICS_PASSWORD,
  database: process.env.CLICKHOUSE_ANALYTICS_DB || 'analytics',
});

// Questions aimed at the documented legacy-only paths (class breakdown, scatter for
// dept stats) + GL edge cases likely to trip the smart planner into no_data.
const QUESTIONS = [
  'Break down transactions by class.',
  'Show a scatter plot of debit versus credit by department.',
  'What is the spread of transaction amounts across departments?',
  'Distribution of journal entries across classes.',
  'Show debits and credits by account type as grouped bars.',
  'Compare debit vs credit for each journal type.',
  'Scatter of accounts by their debit and credit totals.',
  'Show me a breakdown by class and account type.',
  'Plot the running balance over time.',
  'Department-level revenue versus expense.',
];

async function main() {
  const { installLlmFetchInterceptor } = await import('../src/common/llm/llm-fetch-interceptor');
  const { AgentService } = await import('../src/modules/agent/agent.service');
  installLlmFetchInterceptor();
  const svc: any = new AgentService({} as any, ch as any, {} as any);

  const tally: Record<string, number> = { SMART_OK: 0, LEGACY_RESCUE: 0, HONEST_NODATA: 0, OTHER: 0 };
  const rescues: string[] = [];

  for (const q of QUESTIONS) {
    let line = '';
    try {
      const smart = await svc.generateSmartPlan(q, SCOPE, undefined, '');
      if (smart && smart.kind === 'build') {
        tally.SMART_OK++;
        const w = smart.plan?.dashboard?.widgets?.[0];
        line = `SMART_OK      [${w?.type ?? '?'}] ${q}`;
      } else if (smart && smart.kind === 'no_data') {
        // replicate the fallback: does the legacy planner rescue it?
        const legacy = await svc
          .generatePlan(q, '', null, '', SCOPE, undefined)
          .catch(() => null);
        const widgets = legacy?.dashboard?.widgets?.length ?? 0;
        if (widgets > 0) {
          tally.LEGACY_RESCUE++; rescues.push(q);
          line = `LEGACY_RESCUE [${legacy.dashboard.widgets[0]?.type ?? '?'}] ${q}`;
        } else {
          tally.HONEST_NODATA++;
          line = `HONEST_NODATA ${q}`;
        }
      } else {
        tally.OTHER++;
        line = `OTHER(${smart?.kind ?? 'null'}) ${q}`;
      }
    } catch (e: any) {
      tally.OTHER++;
      line = `ERROR ${String(e?.message ?? e).slice(0, 80)} :: ${q}`;
    }
    console.log(line);
  }

  console.log('\n=== TALLY ===', JSON.stringify(tally));
  console.log('LEGACY_RESCUE count:', tally.LEGACY_RESCUE, rescues.length ? rescues : '(none)');
  console.log(
    tally.LEGACY_RESCUE === 0
      ? 'RESULT: no legacy rescues on this battery → strong evidence the legacy metricData path is safe to delete.'
      : 'RESULT: legacy still rescues some questions → migrate these into the catalog BEFORE deleting metricData.',
  );
  await ch.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
