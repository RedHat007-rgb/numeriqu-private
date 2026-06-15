/**
 * FULL-SUITE VALIDATOR — the regression gate. Runs every question (create) and
 * follow-up (edit) through the REAL agent, executes the resulting SQL on live
 * ClickHouse, and runs a battery of correctness checks that encode every bug
 * class we've seen. Output: a categorized failure list so bugs are found here,
 * not by users. READ ONLY (no DB writes).
 *
 * Run: cd apps/api && AGENT_SPEC_MODE=1 npx tsx scripts/validate-suite.ts
 * Writes scripts/validate-suite.out.jsonl (one record per question).
 */
import 'reflect-metadata';
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { createClient } from '@clickhouse/client';

dotenv.config({ path: path.resolve(__dirname, '../.env'), quiet: true });
process.env.AGENT_SPEC_MODE = process.env.AGENT_SPEC_MODE ?? '1';

const SCOPE = { tenantId: '3c964ac3-7868-48ca-a197-53cf9629175d', connectionIds: [], externalOrgIds: ['sample_gl_2024'] };
const OUT = path.resolve(__dirname, 'validate-suite.out.jsonl');
const QS: Array<{ id: string; base: string; fu: string }> = JSON.parse(fs.readFileSync('/tmp/suite.json', 'utf8'));
const ch = createClient({ url: process.env.CLICKHOUSE_ANALYTICS_URL, username: process.env.CLICKHOUSE_ANALYTICS_USER, password: process.env.CLICKHOUSE_ANALYTICS_PASSWORD, database: process.env.CLICKHOUSE_ANALYTICS_DB || 'analytics' });

let svc: any;
const runSql = (sql: string) =>
  ch.query({ query: sql, query_params: { tenantId: SCOPE.tenantId, externalOrgIds: SCOPE.externalOrgIds }, format: 'JSONEachRow' }).then((x) => x.json() as Promise<any[]>);

// The correctness battery — each returns an issue code or null.
function checkRows(rows: any[], chartType: string, normalized: boolean): string[] {
  const issues: string[] = [];
  const t = String(chartType).toLowerCase();
  if (!rows || rows.length === 0) return ['EMPTY'];
  if (['kpi', 'metric', 'gauge'].includes(t)) return issues;
  const keys = Object.keys(rows[0] ?? {});
  if (!keys.includes('name')) issues.push('NO_NAME_COL');
  const names = rows.map((r) => String(r.name ?? ''));
  if (new Set(names).size < names.length) issues.push('DUP_AXIS_LABELS');
  const numKeys = keys.filter((k) => k !== 'name' && rows.some((r) => r[k] !== null && r[k] !== '' && Number.isFinite(Number(r[k]))));
  if (numKeys.length === 0) issues.push('NO_NUMERIC_SERIES');
  // all-null series (sumIf matched nothing → blank chart)
  for (const k of numKeys) if (rows.every((r) => r[k] === null || r[k] === '' || Number(r[k]) === 0)) issues.push(`ZERO_SERIES:${k}`);
  // pie/donut can't mix signs (the 488% class)
  if (['pie', 'donut'].includes(t)) {
    const vals = rows.map((r) => Number(r[numKeys[0] ?? 'value']) || 0);
    if (vals.some((v) => v > 0) && vals.some((v) => v < 0)) issues.push('PIE_MIXED_SIGN');
  }
  // normalized charts must be 0..100 and sum≈100 per row
  if (normalized) {
    for (const r of rows) {
      const sum = numKeys.reduce((s, k) => s + (Number(r[k]) || 0), 0);
      if (numKeys.some((k) => Number(r[k]) > 101 || Number(r[k]) < -1)) { issues.push('PCT_OUT_OF_RANGE'); break; }
      if (Math.abs(sum - 100) > 2 && numKeys.length > 1) { issues.push('PCT_NOT_100'); break; }
    }
  }
  return Array.from(new Set(issues));
}

async function verifyWidget(w: any): Promise<{ checked: boolean; issues: string[] }> {
  const sql = w?._sql ?? (w?.queryConfig as any)?.dynamicSql;
  if (!sql) return { checked: false, issues: [] }; // vocab widget — not SQL-checkable here
  const normalized = Boolean((w?._spec?.transforms ?? []).some((t: any) => (typeof t === 'string' ? t : t?.kind) === 'normalize'));
  try {
    const rows = await runSql(sql);
    return { checked: true, issues: checkRows(rows, w.type ?? w.chartType, normalized) };
  } catch (e: any) {
    return { checked: true, issues: ['SQL_ERROR:' + String(e?.message).slice(0, 40)] };
  }
}

(async () => {
  const { installLlmFetchInterceptor } = await import('../src/common/llm/llm-fetch-interceptor');
  const { AgentService } = await import('../src/modules/agent/agent.service');
  installLlmFetchInterceptor();
  svc = new AgentService({} as any, ch as any, {} as any);
  fs.writeFileSync(OUT, '');

  for (let i = 0; i < QS.length; i++) {
    const q = QS[i];
    const rec: any = { id: q.id, base: q.base, fu: q.fu, createIssues: [], fuState: '', fuIssues: [] };
    try {
      const created = await svc.generateSmartPlan(q.base, SCOPE, undefined, '').catch((e: any) => ({ _err: e?.message }));
      if (!created || created._err) rec.create = 'ERROR:' + (created?._err ?? 'null');
      else if (created.kind !== 'build') rec.create = created.kind.toUpperCase();
      else {
        rec.create = 'BUILD';
        const widgets = created.plan.dashboard.widgets;
        for (const w of widgets) {
          const v = await verifyWidget(w);
          if (v.issues.length) rec.createIssues.push(`${w.type}:${v.issues.join(',')}`);
        }
        // follow-up — run on the FIRST widget whether it's SQL-backed or vocab
        // (carry metric/grouping so the real edit path's backfill handles vocab).
        const fw: any = widgets[0];
        if (q.fu && fw) {
          const qc: any = fw._sql
            ? { metric: 'dynamic', grouping: 'query', dynamicSql: fw._sql, spec: fw._spec }
            : { metric: fw.metric, grouping: fw.grouping };
          const ad = { id: 'd', title: created.plan.dashboard.title, widgets: [{ id: 'w0', title: fw.title, chartType: fw.type, queryConfig: qc, displayOrder: 0 }] };
          const beforeSql = String(fw._sql ?? '');
          const plan = await svc.generateEditPlan(ad, q.fu, SCOPE, undefined, `User: ${q.base}`).catch((e: any) => ({ _err: e?.message }));
          if (plan?._err) rec.fuState = 'ERROR';
          else if (plan?.refusal) rec.fuState = 'REFUSED';
          else {
            const m = (plan?.modify ?? [])[0];
            const changed = (plan?.modify ?? []).some((x: any) => (x.dynamicSql && x.dynamicSql !== beforeSql) || x.display || x.type) || (plan?.add ?? []).length;
            rec.fuState = changed ? 'CHANGED' : 'SILENT_NOOP';
            if (m?.dynamicSql) {
              const norm = Boolean((m?.spec?.transforms ?? []).some((t: any) => (typeof t === 'string' ? t : t?.kind) === 'normalize'));
              try { rec.fuIssues = checkRows(await runSql(m.dynamicSql), m.type ?? fw.type, norm); }
              catch (e: any) { rec.fuIssues = ['SQL_ERROR:' + String(e?.message).slice(0, 40)]; }
            }
          }
        }
      }
    } catch (e: any) { rec.fatal = e?.message; }
    fs.appendFileSync(OUT, JSON.stringify(rec) + '\n');
    const flag = rec.createIssues.length || rec.fuState === 'SILENT_NOOP' || rec.fuIssues.length ? '  ⚠️' : '';
    console.log(`[${i + 1}/100] ${rec.id.padEnd(12)} create=${(rec.create ?? '?').padEnd(8)} fu=${rec.fuState.padEnd(11)}${flag}`);
  }
  console.log('DONE ->', OUT);
  process.exit(0);
})().catch((e) => { console.error('FATAL', e?.message ?? e); process.exit(1); });
