/**
 * Layer D (follow-up "same output") root-cause repro — READ ONLY.
 *
 * Instantiates the REAL AgentService and uses its real internals
 * (introspectLiveSchema / validateAndScopeDynamicSql / executeDynamicSqlChecked /
 * detectBadChartShape) plus the REAL SMART_SQL_EDITOR_SYSTEM prompt (extracted
 * verbatim from source) against the configured OpenAI model via the in-process
 * fetch interceptor. For each representative follow-up it captures what the model
 * proposes and whether that proposal survives the editor's verifySql gate — then
 * classifies which failure mechanism fires. No DB writes.
 *
 * Run: cd apps/api && npx tsx scripts/layerD-edit-repro.ts
 */
import 'reflect-metadata';
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { createClient as createClickHouseClient } from '@clickhouse/client';

dotenv.config({ path: path.resolve(__dirname, '../.env'), quiet: true });

// Heavy imports are dynamic so dotenv runs BEFORE packages/db (which requires
// DATABASE_URL at import time). Static ESM imports would hoist above dotenv.
let installLlmFetchInterceptor: () => void;
let AgentService: any;

const TENANT = '3c964ac3-7868-48ca-a197-53cf9629175d';
const EXTERNAL_ORG = 'sample_gl_2024';
const SCOPE = { tenantId: TENANT, connectionIds: [], externalOrgIds: [EXTERNAL_ORG] };

const SCOPE_WHERE =
  'WHERE tenant_id = {tenantId:String} AND org_id IN ({externalOrgIds:Array(String)})';

// Extract SMART_SQL_EDITOR_SYSTEM verbatim from source (no drift).
const SRC = fs.readFileSync(
  path.resolve(__dirname, '../src/modules/agent/agent.service.ts'),
  'utf8',
);
const m = SRC.match(/const SMART_SQL_EDITOR_SYSTEM = `([\s\S]*?)`;/);
if (!m) throw new Error('Could not extract SMART_SQL_EDITOR_SYSTEM');
const SMART_SQL_EDITOR_SYSTEM = m[1];

const ch = createClickHouseClient({
  url: process.env.CLICKHOUSE_ANALYTICS_URL || process.env.CLICKHOUSE_URL,
  username:
    process.env.CLICKHOUSE_ANALYTICS_USER || process.env.CLICKHOUSE_USER || 'default',
  password:
    process.env.CLICKHOUSE_ANALYTICS_PASSWORD || process.env.CLICKHOUSE_PASSWORD || '',
  database: process.env.CLICKHOUSE_ANALYTICS_DB || 'analytics',
});

let svc: any;

type Case = {
  id: string;
  baseType: string;
  baseTitle: string;
  baseSql: string;
  followUp: string;
};

const dept = (col: string) =>
  `round(sumIf(toFloat64(debit), department='${col}'),0) AS ${col}`;

const CASES: Case[] = [
  {
    id: 'Aakash Q4-f / Velan Q2-f — normalize stacked to 100%',
    baseType: 'stacked_bar',
    baseTitle: 'Monthly Spend by Department',
    baseSql: `SELECT formatDateTime(toStartOfMonth(date),'%b %Y') AS name, ${dept('Admin')}, ${dept('Operations')}, ${dept('Sales')} FROM analytics.sample_gl_dump ${SCOPE_WHERE} GROUP BY toStartOfMonth(date) ORDER BY toStartOfMonth(date) LIMIT 24`,
    followUp:
      "Can you normalize that chart to 100% so I can see each department's monthly share of total spend?",
  },
  {
    id: 'Aakash Q3-f — overlay company-wide average line',
    baseType: 'line',
    baseTitle: 'Monthly Spend by Department',
    baseSql: `SELECT formatDateTime(toStartOfMonth(date),'%b %Y') AS name, ${dept('Admin')}, ${dept('Operations')}, ${dept('Sales')} FROM analytics.sample_gl_dump ${SCOPE_WHERE} GROUP BY toStartOfMonth(date) ORDER BY toStartOfMonth(date) LIMIT 24`,
    followUp:
      'Can you overlay a company-wide average line so I can see which departments are consistently above or below average?',
  },
  {
    id: 'Velan Q3-f — 3-month moving average per vendor',
    baseType: 'line',
    baseTitle: 'Monthly Spend — Top Vendors',
    baseSql: `SELECT formatDateTime(toStartOfMonth(date),'%b %Y') AS name, round(sumIf(toFloat64(debit), vendor_customer='Payroll'),0) AS Payroll, round(sumIf(toFloat64(debit), vendor_customer='AT&T'),0) AS ATT, round(sumIf(toFloat64(debit), vendor_customer='WeWork'),0) AS WeWork FROM analytics.sample_gl_dump ${SCOPE_WHERE} GROUP BY toStartOfMonth(date) ORDER BY toStartOfMonth(date) LIMIT 24`,
    followUp: 'Can you add a 3-month moving average line for each vendor?',
  },
  {
    id: 'Velan Q1-f — YoY growth % (no 2023 = impossible)',
    baseType: 'bar',
    baseTitle: 'Top 10 Vendors by Spend',
    baseSql: `SELECT vendor_customer AS name, round(sum(toFloat64(debit)),0) AS value FROM analytics.sample_gl_dump ${SCOPE_WHERE} GROUP BY vendor_customer ORDER BY value DESC LIMIT 10`,
    followUp:
      'Can you show me the same bar chart but with year-over-year growth % for each vendor?',
  },
  {
    id: 'Velan Q16-f — add prior-year bar (no 2023 = impossible)',
    baseType: 'bar',
    baseTitle: 'Current vs Fixed Assets',
    baseSql: `SELECT account_type AS name, round(sum(toFloat64(net_balance)),0) AS value FROM analytics.sample_trial_balance ${SCOPE_WHERE} AND account_type IN ('Other Current Asset','Fixed Asset') GROUP BY account_type ORDER BY value DESC LIMIT 10`,
    followUp: 'Can you add a second bar for prior year comparison?',
  },
  {
    id: 'Aakash Q42-f — add second axis (invoices per vendor)',
    baseType: 'bar',
    baseTitle: 'Vendor Spend',
    baseSql: `SELECT vendor_customer AS name, round(sum(toFloat64(debit)),0) AS value FROM analytics.sample_gl_dump ${SCOPE_WHERE} GROUP BY vendor_customer ORDER BY value DESC LIMIT 15`,
    followUp:
      'Can you add a second axis showing number of invoices per vendor?',
  },
  {
    id: 'Velan Q9-f — add company-wide average reference line',
    baseType: 'bar',
    baseTitle: 'Average Spend per Vendor',
    baseSql: `SELECT vendor_customer AS name, round(avg(toFloat64(debit)),0) AS value FROM analytics.sample_gl_dump ${SCOPE_WHERE} GROUP BY vendor_customer ORDER BY value DESC LIMIT 15`,
    followUp: 'Can you add a reference line showing the company-wide average?',
  },
  {
    id: 'Velan Q5-f — second bar: total spend per vendor (base=count)',
    baseType: 'bar',
    baseTitle: 'Transaction Count per Vendor',
    baseSql: `SELECT vendor_customer AS name, count() AS value FROM analytics.sample_gl_dump ${SCOPE_WHERE} GROUP BY vendor_customer ORDER BY value DESC LIMIT 15`,
    followUp: 'Can you add a second bar showing total spend per vendor for comparison?',
  },
  {
    id: 'Aakash Q14-f — line for avg transaction value (base=count by dept)',
    baseType: 'bar',
    baseTitle: 'Transaction Count by Department',
    baseSql: `SELECT department AS name, count() AS value FROM analytics.sample_gl_dump ${SCOPE_WHERE} AND department!='' GROUP BY department ORDER BY value DESC LIMIT 15`,
    followUp: 'Can you add a line for average transaction value along with the original for comparison?',
  },
  {
    id: 'Velan Q48-f — variance column on trial-balance matrix (impossible → refuse)',
    baseType: 'matrix',
    baseTitle: 'Financial Balances by Account Type',
    baseSql: `SELECT account_type AS name, round(sum(toFloat64(net_balance)),0) AS value FROM analytics.sample_trial_balance ${SCOPE_WHERE} GROUP BY account_type ORDER BY name ASC LIMIT 100`,
    followUp: 'Can you add a variance column showing dollar change from previous period?',
  },
  {
    id: 'Variance — monthly spend (time-series → applies MoM)',
    baseType: 'bar',
    baseTitle: 'Monthly Total Spend',
    baseSql: `SELECT formatDateTime(toStartOfMonth(date),'%b %Y') AS name, round(sum(toFloat64(debit)),0) AS value FROM analytics.sample_gl_dump ${SCOPE_WHERE} GROUP BY toStartOfMonth(date) ORDER BY toStartOfMonth(date) ASC LIMIT 24`,
    followUp: 'Add a variance column showing the change from the previous period.',
  },
];

async function callEditorModel(userMsg: string): Promise<any> {
  const url = `${svc.OLLAMA_URL}/api/chat`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: svc.OLLAMA_MODEL,
      messages: [
        { role: 'system', content: SMART_SQL_EDITOR_SYSTEM },
        { role: 'user', content: userMsg },
      ],
      stream: false,
      options: { temperature: 0.05, num_predict: 4000, num_ctx: 16384 },
    }),
  });
  if (!resp.ok) return { _httpError: resp.status };
  const body: any = await resp.json();
  const rawText = String(body?.message?.content ?? '')
    .replace(/```json|```/g, '')
    .trim();
  try {
    return JSON.parse(rawText);
  } catch {
    const mm = rawText.match(/\{[\s\S]*\}/);
    return mm ? JSON.parse(mm[0]) : { _parseError: rawText.slice(0, 200) };
  }
}

async function verify(sql: string, chartType: string) {
  let scoped: string;
  try {
    scoped = svc.validateAndScopeDynamicSql(String(sql).trim().replace(/;+$/, ''), SCOPE, {
      chartType,
    });
  } catch (e: any) {
    return { ok: false, reason: 'SCOPE/VALIDATE_THREW', detail: e?.message ?? String(e) };
  }
  let r: any;
  try {
    r = await svc.executeDynamicSqlChecked(scoped, SCOPE, { chartType });
  } catch (e: any) {
    return { ok: false, reason: 'EXECUTE_THREW', detail: e?.message ?? String(e) };
  }
  if (r.error) return { ok: false, reason: 'SQL_ERROR', detail: String(r.error).slice(0, 160) };
  if (!r.rows || r.rows.length === 0) return { ok: false, reason: 'ZERO_ROWS', detail: '' };
  const shape = svc.detectBadChartShape(r.rows, chartType);
  if (shape) return { ok: false, reason: 'BAD_SHAPE', detail: shape.slice(0, 160) };
  return { ok: true, reason: 'WOULD_APPLY', detail: `${r.rows.length} rows, cols: ${Object.keys(r.rows[0]).join(',')}` };
}

(async () => {
  ({ installLlmFetchInterceptor } = await import(
    '../src/common/llm/llm-fetch-interceptor'
  ));
  ({ AgentService } = await import('../src/modules/agent/agent.service'));
  installLlmFetchInterceptor();
  svc = new AgentService({} as any, ch as any, {} as any);

  console.log('Extracting live schema context (one introspection, reused)...');
  const liveContext: string = await svc.introspectLiveSchema(SCOPE);
  console.log(`liveContext length: ${liveContext.length}\n`);

  for (const c of CASES) {
    console.log('═'.repeat(90));
    console.log(`CASE: ${c.id}`);
    console.log(`  base chart: [${c.baseType}] ${c.baseTitle}`);
    console.log(`  follow-up : "${c.followUp}"`);

    const activeDashboard = {
      id: 'test-dash',
      title: 'Test Dashboard',
      widgets: [
        {
          id: 'w0',
          title: c.baseTitle,
          chartType: c.baseType,
          queryConfig: { metric: 'dynamic', grouping: 'query', dynamicSql: c.baseSql },
          displayOrder: 0,
        },
      ],
    };

    // Drive the REAL editor (deterministic transform path + refusal channel).
    const plan = await svc.generateEditPlan(activeDashboard, c.followUp, SCOPE, undefined, '');

    if (plan?.refusal) {
      console.log(`  >>> REFUSAL: ${plan.refusal}`);
      console.log(`  VERDICT: REFUSED CLEARLY (no silent same-output)`);
      continue;
    }

    const mods = Array.isArray(plan?.modify) ? plan.modify : [];
    const adds = Array.isArray(plan?.add) ? plan.add : [];
    console.log(`  summary: ${plan?.summary ?? '(none)'}`);
    console.log(`  plan: ${mods.length} modify, ${adds.length} add`);

    let anyApplied = false;
    for (const mod of mods) {
      if (typeof mod?.dynamicSql === 'string' && mod.dynamicSql.trim()) {
        const v = await verify(mod.dynamicSql, mod?.type ?? c.baseType);
        anyApplied = anyApplied || v.ok;
        const disp = mod.display ? ` display=${JSON.stringify(mod.display)}` : '';
        console.log(`    modify[${mod.index}] new SQL -> ${v.reason} | ${v.detail}${disp}`);
      } else {
        const disp = mod.display ? ` display=${JSON.stringify(mod.display)}` : '';
        console.log(`    modify[${mod.index}] type/label only${disp}`);
      }
    }

    let verdict: string;
    if (mods.length === 0 && adds.length === 0)
      verdict = 'EMPTY PLAN -> SAME OUTPUT (not fixed)';
    else if (!anyApplied) verdict = 'PLAN PRESENT BUT SQL FAILED VERIFY -> SAME OUTPUT (not fixed)';
    else verdict = 'APPLIED a real data change ✓';
    console.log(`  VERDICT: ${verdict}`);
  }
  console.log('═'.repeat(90));
  process.exit(0);
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
