/**
 * Layer B (data-correctness on the CREATE path) repro — READ ONLY.
 * Drives the REAL generateSmartPlan for the old sample_gl_2024 dataset and prints
 * the generated SQL + executes it, exposing: 3-month truncation, vendor caps,
 * count-vs-amount, and 0.00 balance-sheet (wrong table). No DB writes.
 *
 * Run: cd apps/api && npx tsx scripts/layerB-create-repro.ts
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
  username:
    process.env.CLICKHOUSE_ANALYTICS_USER || process.env.CLICKHOUSE_USER || 'default',
  password:
    process.env.CLICKHOUSE_ANALYTICS_PASSWORD || process.env.CLICKHOUSE_PASSWORD || '',
  database: process.env.CLICKHOUSE_ANALYTICS_DB || 'analytics',
});

let svc: any;

const PROMPTS: { id: string; q: string; probe: string }[] = [
  {
    id: 'B1 — Aakash Q4 — monthly spend by department (stacked)',
    q: "I'd like a stacked bar chart that shows monthly spend by department.",
    probe: 'months present?',
  },
  {
    id: 'B1 — Aakash Q5 — dept spend across months (heatmap)',
    q: 'Could you do a heatmap where I can see department spending across different months?',
    probe: 'months present?',
  },
  {
    id: 'B2 — Aakash Q9 — matrix Department by Vendor, spend',
    q: 'A matrix showing Department by Vendor, with Spend inside.',
    probe: 'how many vendors? (24 exist)',
  },
  {
    id: 'B2 — Aakash Q19 — treemap spend by Department then Vendor',
    q: 'Create a treemap showing spend by Department, then broken down by Vendor.',
    probe: 'how many vendors? (24 exist)',
  },
  {
    id: 'B3 — Aakash Q15 — monthly transaction volume by department',
    q: 'Can you create a line chart of monthly transaction volume, broken down by department?',
    probe: 'COUNT vs SUM(amount)?',
  },
  {
    id: 'B4 — Velan Q15 — matrix of asset accounts and balances',
    q: 'Can I get a simple matrix of asset accounts and their balances?',
    probe: 'trial_balance? non-zero?',
  },
  {
    id: 'B4 — Velan Q48 — matrix of key financial balances by account type',
    q: 'Give me a matrix that summarizes key financial balances grouped by account type.',
    probe: 'trial_balance? non-zero?',
  },
];

async function run(sql: string) {
  try {
    const r = await svc.executeDynamicSqlChecked(sql, SCOPE, {});
    if (r.error) return { err: r.error };
    return { rows: r.rows };
  } catch (e: any) {
    return { err: e?.message ?? String(e) };
  }
}

(async () => {
  ({ installLlmFetchInterceptor } = await import(
    '../src/common/llm/llm-fetch-interceptor'
  ));
  ({ AgentService } = await import('../src/modules/agent/agent.service'));
  installLlmFetchInterceptor();
  svc = new AgentService({} as any, ch as any, {} as any);

  for (const p of PROMPTS) {
    console.log('═'.repeat(95));
    console.log(`CASE: ${p.id}`);
    console.log(`  prompt: "${p.q}"  | check: ${p.probe}`);
    let res: any;
    try {
      res = await svc.generateSmartPlan(p.q, SCOPE, undefined, '');
    } catch (e: any) {
      console.log('  generateSmartPlan THREW:', e?.message ?? e);
      continue;
    }
    if (!res) {
      console.log('  >>> planner returned null (offline?)');
      continue;
    }
    if (res.kind === 'clarify') {
      console.log('  >>> CLARIFY:', res.clarification?.question);
      continue;
    }
    if (res.kind === 'no_data') {
      console.log('  >>> NO_DATA:', res.message?.slice(0, 140));
      continue;
    }
    const widgets = res.plan?.dashboard?.widgets ?? [];
    console.log(`  build: ${widgets.length} widget(s)`);
    for (const w of widgets) {
      const sql = (w as any)._sql || (w as any).dynamicSql || (w as any).queryConfig?.dynamicSql;
      console.log(`  • [${w.type}] ${w.title}`);
      if (!sql) {
        console.log(`      (no SQL — metric=${(w as any).metric}/${(w as any).grouping})`);
        continue;
      }
      console.log(`      SQL: ${String(sql).replace(/\s+/g, ' ').trim().slice(0, 360)}`);
      const out = await run(String(sql));
      if (out.err) {
        console.log(`      RESULT: ERROR ${String(out.err).slice(0, 120)}`);
        continue;
      }
      const rows = out.rows as any[];
      const cols = rows.length ? Object.keys(rows[0]) : [];
      console.log(`      RESULT: ${rows.length} rows, cols: ${cols.join(',')}`);
      // distinct name sample (first 6 + count)
      if (cols.includes('name')) {
        const names = rows.map((r) => String(r.name));
        console.log(`      names (${names.length}): ${names.slice(0, 14).join(' | ')}${names.length > 14 ? ' …' : ''}`);
      }
    }
  }
  console.log('═'.repeat(95));
  process.exit(0);
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
