/**
 * FLAGGED FOLLOW-UP AUDIT — READ ONLY (no DB writes).
 *
 * For every question testers flagged "Generated Incorrectly" / "Generated but
 * Error", run the REAL create path (main question) FIRST, verify the main chart
 * is healthy, THEN run the REAL follow-up and classify the outcome. Writes
 * incremental JSONL to scripts/flagged-audit.out.jsonl so progress is visible.
 *
 * Run: cd apps/api && npx tsx scripts/flagged-audit.ts
 */
import 'reflect-metadata';
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { createClient } from '@clickhouse/client';

dotenv.config({ path: path.resolve(__dirname, '../.env'), quiet: true });

const SCOPE = { tenantId: '3c964ac3-7868-48ca-a197-53cf9629175d', connectionIds: [], externalOrgIds: ['sample_gl_2024'] };
const OUT = path.resolve(__dirname, 'flagged-audit.out.jsonl');

const flagged: Array<{ sheet: string; q: string; base: string; fu: string; fu_status: string }> =
  JSON.parse(fs.readFileSync('/tmp/flagged.json', 'utf8'));

const ch = createClient({
  url: process.env.CLICKHOUSE_ANALYTICS_URL, username: process.env.CLICKHOUSE_ANALYTICS_USER,
  password: process.env.CLICKHOUSE_ANALYTICS_PASSWORD, database: 'analytics',
});

let svc: any;

async function classifyMain(base: string) {
  const created = await svc.generateSmartPlan(base, SCOPE, undefined, '').catch((e: any) => ({ _err: e?.message }));
  if (!created || created._err) return { state: 'CREATE_ERROR', detail: created?._err ?? 'null', widget: null };
  if (created.kind === 'clarify') return { state: 'MAIN_CLARIFY', detail: created.clarification?.question?.slice(0, 80), widget: null };
  if (created.kind === 'no_data') return { state: 'MAIN_NO_DATA', detail: String(created.message).slice(0, 80), widget: null };
  const w = created.plan.dashboard.widgets[0] as any;
  const sql = String(w?._sql ?? '');
  if (!sql.trim()) return { state: 'MAIN_NO_SQL(vocab)', detail: `[${w?.type}] ${w?.title}`, widget: { title: w?.title, type: w?.type, sql: '', metric: w?.metric, grouping: w?.grouping } };
  // verify it executes + good shape
  let scoped: string;
  try { scoped = svc.validateAndScopeDynamicSql(sql.replace(/;+$/, ''), SCOPE, { chartType: w.type }); }
  catch (e: any) { return { state: 'MAIN_SQL_INVALID', detail: String(e?.message).slice(0, 90), widget: { title: w.title, type: w.type, sql } }; }
  const r = await svc.executeDynamicSqlChecked(scoped, SCOPE, { chartType: w.type }).catch((e: any) => ({ error: e?.message, rows: [] }));
  if (r.error) return { state: 'MAIN_SQL_ERROR', detail: String(r.error).slice(0, 90), widget: { title: w.title, type: w.type, sql } };
  if (!r.rows?.length) return { state: 'MAIN_ZERO_ROWS', detail: '', widget: { title: w.title, type: w.type, sql } };
  const bad = svc.detectBadChartShape(r.rows, w.type);
  if (bad) return { state: 'MAIN_BAD_SHAPE', detail: String(bad).slice(0, 90), widget: { title: w.title, type: w.type, sql: scoped } };
  return { state: 'MAIN_OK', detail: `${r.rows.length} rows`, widget: { title: w.title, type: w.type, sql: scoped } };
}

async function classifyFollowUp(widget: any, base: string, fu: string) {
  // Faithfully reproduce the stored widget: SQL-backed charts carry dynamicSql;
  // vocab charts carry their real metric/grouping (NO dynamicSql) so the edit
  // pipeline's backfill/reconstruction runs exactly as in production.
  const qc = widget.sql
    ? { metric: 'dynamic', grouping: 'query', dynamicSql: widget.sql }
    : { metric: widget.metric, grouping: widget.grouping };
  const ad = { id: 'd', title: 'T', widgets: [{ id: 'w0', title: widget.title, chartType: widget.type, queryConfig: qc, displayOrder: 0 }] };
  const plan = await svc.generateEditPlan(ad, fu, SCOPE, undefined, `User: ${base}\nAssistant: built ${widget.title}`).catch((e: any) => ({ _err: e?.message }));
  if (plan?._err) return { state: 'FU_ERROR', detail: plan._err };
  if (plan?.refusal) return { state: 'FU_REFUSED', detail: String(plan.refusal).slice(0, 100) };
  const mods = plan?.modify ?? []; const adds = plan?.add ?? []; const rem = plan?.remove_indices ?? [];
  let changed = false;
  for (const m of mods) {
    if (typeof m?.dynamicSql === 'string' && m.dynamicSql.trim() && m.dynamicSql.trim() !== String(widget.sql).trim()) changed = true;
    if (m?.display) changed = true;
    if (m?.type && m.type !== widget.type) changed = true;
    if (m?.title || m?.xAxisLabel || m?.yAxisLabel) changed = true;
  }
  if (adds.length || rem.length) changed = true;
  if (changed) return { state: 'FU_CHANGED', detail: String(plan.summary).slice(0, 90) };
  return { state: 'FU_SILENT_NOOP', detail: String(plan.summary).slice(0, 90) };
}

(async () => {
  const { installLlmFetchInterceptor } = await import('../src/common/llm/llm-fetch-interceptor');
  const { AgentService } = await import('../src/modules/agent/agent.service');
  installLlmFetchInterceptor();
  svc = new AgentService({} as any, ch as any, {} as any);
  fs.writeFileSync(OUT, '');

  for (let i = 0; i < flagged.length; i++) {
    const f = flagged[i];
    const id = `${f.sheet} Q${f.q}`;
    let rec: any = { id, fu_status: f.fu_status, base: f.base, fu: f.fu };
    try {
      const main = await classifyMain(f.base);
      rec.main = main.state; rec.mainDetail = main.detail;
      if (main.widget && (main.state === 'MAIN_OK' || main.state === 'MAIN_NO_SQL(vocab)')) {
        const fu = await classifyFollowUp(main.widget, f.base, f.fu);
        rec.fu = fu.state; rec.fuDetail = fu.detail;
      } else {
        rec.fu = 'SKIPPED(main-broken)';
      }
    } catch (e: any) { rec.error = e?.message; }
    fs.appendFileSync(OUT, JSON.stringify(rec) + '\n');
    console.log(`[${i + 1}/${flagged.length}] ${id.padEnd(12)} main=${(rec.main ?? '?').padEnd(20)} fu=${rec.fu ?? '?'}`);
  }
  console.log('DONE ->', OUT);
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
