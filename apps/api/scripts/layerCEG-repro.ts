/**
 * Layers C/E/G end-to-end repro — READ ONLY.
 * For each prompt: runs the unsupported-ask gate, then (if not gated) the real
 * generateSmartPlan, printing the resulting widget types — to confirm the
 * planner honors heatmap/matrix routing and refuses unsupported/no-data asks.
 *
 * Run: cd apps/api && npx tsx scripts/layerCEG-repro.ts
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

const PROMPTS: { id: string; q: string; expect: string }[] = [
  { id: 'C — Aakash Q13 heatmap dept×class', q: 'Can you do a heatmap showing spending by department and class together?', expect: 'heatmap' },
  { id: 'C — Aakash Q34 heatmap account×dept', q: "I'd like a heatmap showing account spend across different departments.", expect: 'heatmap' },
  { id: 'C — Velan Q8 matrix months×vendors', q: 'Give me a matrix where rows are months, columns are vendors, and cells show spend.', expect: 'matrix' },
  { id: 'C — Aakash Q49 matrix vendor×dept', q: 'Create a matrix with Vendor as rows, Department as columns, and Spend as values.', expect: 'matrix' },
  { id: 'E — budget variance (no budget data)', q: 'Show me a bar chart of actual vs budget variance for each expense account.', expect: 'REFUSE (budget)' },
  { id: 'E — sunburst (unsupported)', q: 'Create a sunburst chart of spend by class then account.', expect: 'REFUSE (sunburst)' },
  { id: 'G — CFO exec dashboard', q: 'Build a CFO-level overview dashboard that highlights financial performance and operational expenses.', expect: 'multi-widget (>=5)' },
];

(async () => {
  ({ installLlmFetchInterceptor } = await import('../src/common/llm/llm-fetch-interceptor'));
  ({ AgentService } = await import('../src/modules/agent/agent.service'));
  installLlmFetchInterceptor();
  svc = new AgentService({} as any, ch as any, {} as any);

  for (const p of PROMPTS) {
    console.log('═'.repeat(95));
    console.log(`CASE: ${p.id}`);
    console.log(`  prompt: "${p.q}"  | expect: ${p.expect}`);

    let gate: any = null;
    try {
      gate = svc.detectUnsupportedOrAmbiguousAsk(p.q, false);
    } catch (e: any) {
      console.log('  gate threw:', e?.message ?? e);
    }
    if (gate) {
      console.log(`  >>> GATED: reason=${gate.reason} | ${String(gate.message ?? gate.question ?? '').slice(0, 130)}`);
      continue;
    }

    let res: any;
    try {
      res = await svc.generateSmartPlan(p.q, SCOPE, undefined, '');
    } catch (e: any) {
      console.log('  generateSmartPlan threw:', e?.message ?? e);
      continue;
    }
    if (!res) { console.log('  >>> planner null'); continue; }
    if (res.kind === 'no_data') { console.log(`  >>> NO_DATA: ${String(res.message).slice(0, 120)}`); continue; }
    if (res.kind === 'clarify') { console.log(`  >>> CLARIFY: ${String(res.clarification?.question).slice(0, 120)}`); continue; }
    const widgets = res.plan?.dashboard?.widgets ?? [];
    console.log(`  build: ${widgets.length} widget(s): ${widgets.map((w: any) => `${w.type}/${w.metric}/${w.grouping}`).join(' | ')}`);
  }
  console.log('═'.repeat(95));
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
