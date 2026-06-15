/**
 * FOLLOW-UP GROUND TRUTH repro — READ ONLY (no DB writes).
 *
 * Drives the REAL create path (generateSmartPlan) for each base question, then
 * the REAL follow-up path (generateEditPlan) for the follow-up, against the
 * configured OpenAI model via the in-process interceptor + live ClickHouse.
 * For each pair it prints what the USER would actually experience:
 *   - REFUSAL (clear "can't do X")
 *   - DATA CHANGED (a verified SQL/display change applied)
 *   - SILENT NO-OP (plan claims success but nothing actually changed = "same output")
 *
 * Run: cd apps/api && npx tsx scripts/followup-truth-repro.ts
 */
import 'reflect-metadata';
import path from 'node:path';
import dotenv from 'dotenv';
import { createClient as createClickHouseClient } from '@clickhouse/client';

dotenv.config({ path: path.resolve(__dirname, '../.env'), quiet: true });

const TENANT = '3c964ac3-7868-48ca-a197-53cf9629175d';
const EXTERNAL_ORG = 'sample_gl_2024';
const SCOPE = { tenantId: TENANT, connectionIds: [], externalOrgIds: [EXTERNAL_ORG] };

const ch = createClickHouseClient({
  url: process.env.CLICKHOUSE_ANALYTICS_URL || process.env.CLICKHOUSE_URL,
  username: process.env.CLICKHOUSE_ANALYTICS_USER || process.env.CLICKHOUSE_USER || 'default',
  password: process.env.CLICKHOUSE_ANALYTICS_PASSWORD || process.env.CLICKHOUSE_PASSWORD || '',
  database: process.env.CLICKHOUSE_ANALYTICS_DB || 'analytics',
});

type Pair = { id: string; kind: 'DOABLE' | 'UNSUPPORTED'; base: string; fu: string };
const PAIRS: Pair[] = [
  // --- genuinely doable transforms (should APPLY a data change) ---
  { id: 'A-Q5  quarterly', kind: 'DOABLE', base: 'Could you do a heatmap where I can see department spending across different classes?', fu: 'can you give the same by quarterly' },
  { id: 'V-Q15 % column', kind: 'DOABLE', base: 'Can I get a simple matrix of asset accounts and their balances?', fu: "Can you add a column showing each account's percentage of total assets?" },
  { id: 'A-Q43 filter+other', kind: 'DOABLE', base: "I'd like a pie chart showing vendor contribution to total spend.", fu: 'Can you filter to only vendors with at least 1% share, then group the rest as Other?' },
  { id: 'A-Q19 top5 by dept', kind: 'DOABLE', base: 'Create a treemap showing spend by Department, then broken down by Vendor.', fu: 'generate treemap for top 5 vendors by department' },
  { id: 'V-Q49 pos/neg', kind: 'DOABLE', base: 'Rank major balance sheet categories in a bar chart.', fu: 'Can you add a horizontal bar chart with positive bars for Assets and negative for Liabilities?' },
  { id: 'A-Q1  pct+decimal', kind: 'DOABLE', base: 'Can you show me a bar chart of total spend by department?', fu: 'Can you show me the same bar chart but as a percentage of total?' },
  // --- genuinely unsupported (should REFUSE clearly, NOT silent no-op) ---
  { id: 'A-Q33 log scale', kind: 'UNSUPPORTED', base: 'Can you show me line chart trends for our major expense accounts over the months?', fu: 'Can you use a log scale on the Y-axis for accounts with very different magnitudes?' },
  { id: 'V-Q14 drill-down', kind: 'UNSUPPORTED', base: 'Build a treemap showing the asset hierarchy from category down to subcategory.', fu: 'Can you add a drill-down so clicking a category shows individual assets?' },
  { id: 'A-Q39 animate', kind: 'UNSUPPORTED', base: 'Can you build a treemap of our largest cost drivers?', fu: 'Can you animate the treemap over the last 6 months to show how boxes shrink and grow?' },
  { id: 'V-Q24 multilevel donut', kind: 'UNSUPPORTED', base: 'Use a donut chart to show revenue contribution by source.', fu: 'Can you make a multi-level donut with source as inner ring and region as outer?' },
  { id: 'A-Q21 budget var', kind: 'UNSUPPORTED', base: 'Show me a bar chart of spend by expense account.', fu: 'Can you split that bar chart into actual vs budget variance for each account?' },
  { id: 'V-Q27 bullet', kind: 'UNSUPPORTED', base: 'A simple bar chart comparing Revenue, Gross Profit, Expenses, and Net Income.', fu: 'Can you add a bullet chart next to each metric showing performance against target?' },
];

let svc: any;

async function rowsChanged(beforeSql: string, afterSql: string, chartType: string): Promise<boolean> {
  if (!afterSql || beforeSql.trim() === afterSql.trim()) return false;
  return true;
}

(async () => {
  const { installLlmFetchInterceptor } = await import('../src/common/llm/llm-fetch-interceptor');
  const { AgentService } = await import('../src/modules/agent/agent.service');
  installLlmFetchInterceptor();
  svc = new AgentService({} as any, ch as any, {} as any);

  const tally: Record<string, number> = {};
  for (const p of PAIRS) {
    console.log('═'.repeat(95));
    console.log(`CASE ${p.id}  [expected: ${p.kind === 'DOABLE' ? 'DATA CHANGED' : 'CLEAR REFUSAL'}]`);
    console.log(`  base: "${p.base}"`);
    console.log(`  f-up: "${p.fu}"`);

    // 1) REAL create
    const created = await svc.generateSmartPlan(p.base, SCOPE, undefined, '').catch((e: any) => ({ _err: e?.message }));
    if (!created || created._err || created.kind !== 'build') {
      console.log(`  CREATE -> ${created?.kind ?? created?._err ?? 'null'} (cannot test follow-up)`);
      tally['CREATE_FAILED'] = (tally['CREATE_FAILED'] ?? 0) + 1;
      continue;
    }
    const w = created.plan.dashboard.widgets[0] as any;
    const baseSql = String(w._sql ?? '');
    const baseType = String(w.type ?? 'bar');
    console.log(`  CREATE -> [${baseType}] "${w.title}"  (${baseSql ? baseSql.length + ' chars sql' : 'NO SQL'})`);

    const activeDashboard = {
      id: 'd', title: created.plan.dashboard.title,
      widgets: [{ id: 'w0', title: w.title, chartType: baseType, queryConfig: { metric: 'dynamic', grouping: 'query', dynamicSql: baseSql }, displayOrder: 0 }],
    };

    // 2) REAL follow-up
    const plan = await svc.generateEditPlan(activeDashboard, p.fu, SCOPE, undefined, `User: ${p.base}\nAssistant: built ${w.title}`).catch((e: any) => ({ _err: e?.message }));
    if (plan?._err) { console.log(`  EDIT -> ERROR ${plan._err}`); tally['EDIT_ERROR'] = (tally['EDIT_ERROR'] ?? 0) + 1; continue; }

    if (plan?.refusal) {
      console.log(`  RESULT: CLEAR REFUSAL -> "${String(plan.refusal).slice(0, 110)}"`);
      tally[p.kind === 'UNSUPPORTED' ? 'REFUSED(correct)' : 'REFUSED(wrong-was-doable)'] = (tally[p.kind === 'UNSUPPORTED' ? 'REFUSED(correct)' : 'REFUSED(wrong-was-doable)'] ?? 0) + 1;
      continue;
    }

    const mods = Array.isArray(plan?.modify) ? plan.modify : [];
    const adds = Array.isArray(plan?.add) ? plan.add : [];
    let dataChanged = false;
    for (const m of mods) {
      if (typeof m?.dynamicSql === 'string' && await rowsChanged(baseSql, m.dynamicSql, m?.type ?? baseType)) dataChanged = true;
      if (m?.display) dataChanged = true; // normalized / labelMode / referenceSeries etc.
      if (m?.type && m.type !== baseType) dataChanged = true;
    }
    if (adds.length > 0) dataChanged = true;

    if (dataChanged) {
      console.log(`  RESULT: DATA CHANGED  (summary: "${String(plan.summary).slice(0, 80)}")  mods=${mods.length} adds=${adds.length}`);
      tally[p.kind === 'DOABLE' ? 'CHANGED(correct)' : 'CHANGED(but-was-unsupported)'] = (tally[p.kind === 'DOABLE' ? 'CHANGED(correct)' : 'CHANGED(but-was-unsupported)'] ?? 0) + 1;
    } else {
      console.log(`  RESULT: ⚠️  SILENT NO-OP -> claims "${String(plan.summary).slice(0, 70)}" but NOTHING changed = "same output"`);
      tally['SILENT_NOOP'] = (tally['SILENT_NOOP'] ?? 0) + 1;
    }
  }
  console.log('═'.repeat(95));
  console.log('TALLY:', JSON.stringify(tally, null, 0));
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
