/**
 * Faithful batch test of the EBPO agent over the 100 main+follow-up prompts in
 * scripts/ebpo-questions.json. Drives the REAL agent methods in-process (same path
 * as chat-flow.ts): generateSmartPlan for create, generateEditPlan for the
 * follow-up, then EXECUTES the produced SQL on live ClickHouse. Classifies each
 * outcome so we can see exactly where the agent goes wrong.
 *
 * Production-like: does NOT set AGENT_SPEC_MODE — relies on the EBPO catalog gating
 * (hasEbpo) for create and spec-presence for edits, exactly as a real EBPO org runs.
 *
 * Run:  cd apps/api && npx tsx scripts/test-ebpo-questions.ts [--from N] [--to N]
 * Out:  scripts/ebpo-questions.out.jsonl  +  scripts/ebpo-questions.report.md
 */
import 'reflect-metadata';
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { createClient } from '@clickhouse/client';

dotenv.config({ path: path.resolve(__dirname, '../.env'), quiet: true });

const SCOPE = {
  tenantId: '7375b5aa-f5bc-4739-88e1-02be1203439b',
  connectionIds: [] as string[],
  externalOrgIds: ['ebpo_enterprise'],
};

const ch = createClient({
  url: process.env.CLICKHOUSE_ANALYTICS_URL,
  username: process.env.CLICKHOUSE_ANALYTICS_USER,
  password: process.env.CLICKHOUSE_ANALYTICS_PASSWORD,
  database: process.env.CLICKHOUSE_ANALYTICS_DB || 'analytics',
});
const runSql = (sql: string) =>
  ch
    .query({
      query: sql,
      query_params: { tenantId: SCOPE.tenantId, externalOrgIds: SCOPE.externalOrgIds },
      format: 'JSONEachRow',
    })
    .then((x: any) => x.json());

const argN = (flag: string, def: number) => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? def : Number(process.argv[i + 1]);
};

// Best-effort: what chart type did the prompt ASK for?
function requestedType(prompt: string): string {
  const q = prompt.toLowerCase();
  if (/100%\s*stacked|stacked\s*(column|bar|area)/.test(q)) return q.includes('area') ? 'stacked_area' : 'stacked_bar';
  if (/waterfall/.test(q)) return 'waterfall';
  if (/combo/.test(q)) return 'combo';
  if (/scatter|bubble/.test(q)) return 'scatter';
  if (/heat\s*map|heatmap/.test(q)) return 'heatmap';
  if (/treemap/.test(q)) return 'treemap';
  if (/donut/.test(q)) return 'donut';
  if (/\bpie\b/.test(q)) return 'pie';
  if (/box\s*plot/.test(q)) return 'box_plot';
  if (/pareto/.test(q)) return 'pareto';
  if (/dashboard|scorecard/.test(q)) return 'dashboard';
  if (/area\s*chart/.test(q)) return 'area';
  if (/line\s*chart|line\s+for|line\b/.test(q)) return 'line';
  if (/column\s*chart|clustered|grouped|\bbar\s*chart|ranked\s*bar/.test(q)) return 'bar';
  return '?';
}

// Value sanity: a percent/ratio measure should never be a huge number. Catches
// "deterministic but financially wrong" charts (e.g. a 52x current ratio) that a
// rows>0 check would happily mark OK.
function valueSanity(spec: any, rows: Array<Record<string, unknown>>): string {
  if (!spec?.measure || !rows?.length || !('value' in rows[0])) return '';
  // lazy require so the harness still runs if the import path changes
  const { EBPO_MEASURES } = require('../src/modules/agent/chart-spec-ebpo');
  const m = EBPO_MEASURES[spec.measure];
  if (!m || m.format !== 'percent') return '';
  const bad = rows.find((r) => Math.abs(Number(r.value) || 0) > 250);
  return bad ? `pct value ${bad.value} out of sane range` : '';
}

type QRow = { id: number; section: string; main: string; followup: string };

async function main() {
  const { installLlmFetchInterceptor } = await import('../src/common/llm/llm-fetch-interceptor');
  const { AgentService } = await import('../src/modules/agent/agent.service');
  installLlmFetchInterceptor();
  const svc: any = new AgentService({} as any, ch as any, {} as any);

  const questions: QRow[] = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, 'ebpo-questions.json'), 'utf8'),
  );
  const from = argN('--from', 1);
  const to = argN('--to', 100);
  const idsArg = process.argv.indexOf('--ids');
  const ids = idsArg !== -1 ? new Set(process.argv[idsArg + 1].split(',').map(Number)) : null;
  const subset = questions.filter((q) => (ids ? ids.has(q.id) : q.id >= from && q.id <= to));

  const outArg = process.argv.indexOf('--out');
  const outPath = outArg !== -1 ? path.resolve(process.argv[outArg + 1]) : path.resolve(__dirname, 'ebpo-questions.out.jsonl');
  const results: any[] = [];

  for (const q of subset) {
    const rec: any = {
      id: q.id,
      section: q.section,
      main: q.main,
      followup: q.followup,
      reqType: requestedType(q.main),
    };
    // ── CREATE ──
    try {
      const plan = await svc.generateSmartPlan(q.main, SCOPE, undefined, '');
      if (!plan) {
        rec.create = { status: 'NULL' };
      } else if (plan.kind === 'no_data') {
        rec.create = { status: 'NO_DATA', msg: (plan.message || '').slice(0, 120) };
      } else if (plan.kind === 'clarify') {
        rec.create = { status: 'CLARIFY', msg: (plan.message || plan.clarify || '').toString().slice(0, 120) };
      } else {
        const w = plan?.plan?.dashboard?.widgets?.[0];
        const wcount = plan?.plan?.dashboard?.widgets?.length ?? 0;
        const source = w?._spec ? 'catalog' : 'llm';
        let rows = -1;
        let err = '';
        let suspect = '';
        if (w?._sql) {
          try {
            const data = await runSql(w._sql);
            rows = data.length;
            suspect = valueSanity(w?._spec, data);
          } catch (e: any) { err = String(e?.message ?? e).slice(0, 90); }
        }
        rec.create = {
          status: err ? 'SQL_ERROR' : rows < 0 ? 'UNVERIFIED' : rows === 0 ? 'ZERO_ROWS' : suspect ? 'SUSPECT_VALUE' : 'OK',
          source, type: w?.type, widgets: wcount, rows, err, suspect: suspect || undefined,
          typeMatch: rec.reqType === '?' ? null : rec.reqType === String(w?.type),
          spec: w?._spec ?? null,
        };
        // carry the built dashboard into the follow-up
        rec._dash = {
          id: 'd', title: plan?.plan?.dashboard?.title ?? 'T',
          widgets: [{ id: 'w0', title: w?.title ?? 'c', chartType: w?.type,
            queryConfig: { metric: 'dynamic', grouping: 'query', dynamicSql: w?._sql, spec: w?._spec },
            displayOrder: 0 }],
        };
      }
    } catch (e: any) {
      rec.create = { status: 'EXCEPTION', err: String(e?.message ?? e).slice(0, 120) };
    }

    // ── FOLLOW-UP ── (only if create produced a chart)
    if (rec._dash && q.followup) {
      try {
        const plan = await svc.generateEditPlan(rec._dash, q.followup, SCOPE, undefined, `User: ${q.main}`);
        if (plan?.refusal) {
          rec.fu = { status: 'REFUSED', msg: String(plan.refusal).slice(0, 120) };
        } else {
          const m = (plan?.modify ?? [])[0];
          if (!m) {
            rec.fu = { status: 'NOOP', summary: (plan?.summary || '').slice(0, 80) };
          } else {
            const source = m.spec ? 'catalog' : 'llm';
            let rows = -1; let err = '';
            const sql = m.dynamicSql;
            if (sql) { try { rows = (await runSql(sql)).length; } catch (e: any) { err = String(e?.message ?? e).slice(0, 90); } }
            rec.fu = {
              status: err ? 'SQL_ERROR' : rows < 0 ? 'UNVERIFIED' : rows === 0 ? 'ZERO_ROWS' : 'OK',
              source, type: m.type, rows, err, summary: (plan?.summary || '').slice(0, 80),
            };
          }
        }
      } catch (e: any) {
        rec.fu = { status: 'EXCEPTION', err: String(e?.message ?? e).slice(0, 120) };
      }
    } else if (q.followup) {
      rec.fu = { status: 'SKIPPED_NO_CREATE' };
    }

    delete rec._dash;
    results.push(rec);
    fs.writeFileSync(outPath, results.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const c = rec.create, f = rec.fu;
    console.log(
      `#${String(q.id).padStart(3)} [${rec.reqType}] CREATE=${c?.status}/${c?.source ?? '-'}/${c?.type ?? '-'}/${c?.rows ?? '-'}r` +
      `  FU=${f?.status ?? '-'}/${f?.source ?? '-'}/${f?.rows ?? '-'}r`,
    );
  }

  // ── summary report ──
  const tally = (key: 'create' | 'fu') => {
    const m: Record<string, number> = {};
    for (const r of results) { const s = r[key]?.status ?? 'NONE'; m[s] = (m[s] ?? 0) + 1; }
    return m;
  };
  const srcTally = (key: 'create' | 'fu') => {
    const m: Record<string, number> = {};
    for (const r of results) { if (r[key]?.status === 'OK') { const s = r[key]?.source ?? '?'; m[s] = (m[s] ?? 0) + 1; } }
    return m;
  };
  const lines: string[] = [];
  lines.push(`# EBPO 100-question test — ${new Date().toISOString()}`);
  lines.push(`\nRan ${results.length} questions (id ${from}–${to}) against EBPO org, production-like (no AGENT_SPEC_MODE).`);
  lines.push(`\n## CREATE outcomes\n\`\`\`\n${JSON.stringify(tally('create'), null, 2)}\n\`\`\``);
  lines.push(`OK source split: \`${JSON.stringify(srcTally('create'))}\``);
  lines.push(`\n## FOLLOW-UP outcomes\n\`\`\`\n${JSON.stringify(tally('fu'), null, 2)}\n\`\`\``);
  lines.push(`OK source split: \`${JSON.stringify(srcTally('fu'))}\``);
  const bad = results.filter(
    (r) => !['OK'].includes(r.create?.status) || (r.fu && !['OK'].includes(r.fu?.status)),
  );
  lines.push(`\n## Problems (${bad.length})\n`);
  lines.push('| # | reqType | CREATE | type/src | FU | note |');
  lines.push('|---|---|---|---|---|---|');
  for (const r of bad) {
    const note = [r.create?.err, r.create?.msg, r.fu?.err, r.fu?.msg].filter(Boolean).join(' / ').slice(0, 80);
    lines.push(`| ${r.id} | ${r.reqType} | ${r.create?.status} | ${r.create?.type ?? '-'}/${r.create?.source ?? '-'} | ${r.fu?.status ?? '-'} | ${note} |`);
  }
  fs.writeFileSync(path.resolve(__dirname, 'ebpo-questions.report.md'), lines.join('\n') + '\n');
  console.log('\n=== CREATE ===', JSON.stringify(tally('create')));
  console.log('=== FU     ===', JSON.stringify(tally('fu')));
  console.log(`Wrote ${outPath} + ebpo-questions.report.md`);
  process.exit(0);
}

main().catch((e) => { console.error('FATAL', e?.message ?? e); process.exit(1); });
