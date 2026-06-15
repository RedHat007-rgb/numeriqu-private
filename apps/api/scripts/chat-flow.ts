import 'reflect-metadata';
import path from 'node:path'; import dotenv from 'dotenv';
import { createClient } from '@clickhouse/client';
dotenv.config({ path: path.resolve(__dirname, '../.env'), quiet: true });
process.env.AGENT_SPEC_MODE = '1';
const SCOPE = { tenantId: '3c964ac3-7868-48ca-a197-53cf9629175d', connectionIds: [], externalOrgIds: ['sample_gl_2024'] };
const ch = createClient({ url: process.env.CLICKHOUSE_ANALYTICS_URL, username: process.env.CLICKHOUSE_ANALYTICS_USER, password: process.env.CLICKHOUSE_ANALYTICS_PASSWORD, database: 'analytics' });
const runSql = (sql:string) => ch.query({ query: sql, query_params: { tenantId: SCOPE.tenantId, externalOrgIds: SCOPE.externalOrgIds }, format:'JSONEachRow' }).then((x:any)=>x.json());

// what the user would actually SEE for a pie caption (mirrors the frontend fix)
function pieCaption(rows:any[]) {
  const pos = rows.filter(r => (Number(r.value)||0) > 0);
  const total = pos.reduce((s,r)=>s+(Number(r.value)||0),0);
  if (!pos.length || !total) return '(no positive slices)';
  const top = pos.reduce((a,b)=> Number(a.value)>=Number(b.value)?a:b, pos[0]);
  const pct = Math.min(100,(Number(top.value)/total)*100).toFixed(0);
  return `${top.name} leads at ${pct}%`;
}

(async () => {
  const { installLlmFetchInterceptor } = await import('../src/common/llm/llm-fetch-interceptor');
  const { AgentService } = await import('../src/modules/agent/agent.service');
  installLlmFetchInterceptor();
  const svc:any = new AgentService({} as any, ch as any, {} as any);

  // ── TURN 1: CREATE ──
  console.log('═'.repeat(80));
  console.log('USER ▸ Rank liabilities by balance in a bar chart');
  const created = await svc.generateSmartPlan('Rank liabilities by balance in a bar chart', SCOPE, undefined, '');
  let w:any = created?.plan?.dashboard?.widgets?.[0];
  let dash:any = { id:'d', title: created?.plan?.dashboard?.title ?? 'T', widgets:[{ id:'w0', title:w.title, chartType:w.type, queryConfig:{ metric:'dynamic', grouping:'query', dynamicSql:w._sql, spec:w._spec }, displayOrder:0 }] };
  let rows = w._sql ? await runSql(w._sql) : [];
  console.log(`AGENT ▸ [${w.type}] "${w.title}"  spec=${JSON.stringify(w._spec)}`);
  console.log(`        rows: ${JSON.stringify(rows)}`);

  // ── helper to apply a follow-up turn, carrying state forward ──
  async function turn(msg:string, history:string) {
    console.log('═'.repeat(80));
    console.log(`USER ▸ ${msg}`);
    const plan = await svc.generateEditPlan(dash, msg, SCOPE, undefined, history);
    if (plan?.refusal) { console.log(`AGENT ▸ REFUSED: ${plan.refusal}`); return; }
    const m = (plan?.modify ?? [])[0];
    if (!m) { console.log(`AGENT ▸ (no change) summary="${plan?.summary}"`); return; }
    const cfg:any = dash.widgets[0].queryConfig;
    const newSql = m.dynamicSql ?? cfg.dynamicSql;
    const newType = m.type ?? dash.widgets[0].chartType;
    const newDisplay = m.display ?? cfg.display;
    dash.widgets[0].chartType = newType;
    dash.widgets[0].queryConfig = { ...cfg, dynamicSql: newSql, spec: m.spec ?? cfg.spec, display: newDisplay };
    rows = await runSql(newSql);
    console.log(`AGENT ▸ [${newType}] summary="${plan.summary}"  display=${JSON.stringify(newDisplay)}`);
    if (newType==='pie'||newType==='donut') console.log(`        CAPTION the user sees: "${pieCaption(rows)}"  | labelMode=${newDisplay?.labelMode ?? 'percent(default)'}`);
    console.log(`        rows: ${JSON.stringify(rows).slice(0,260)}`);
  }

  await turn('switch to pie chart', 'User: Rank liabilities by balance in a bar chart');
  await turn('change the percentage to values', 'User: Rank liabilities by balance\nUser: switch to pie chart');
  console.log('═'.repeat(80));
  process.exit(0);
})().catch(e=>{console.error('FATAL',e?.message??e);process.exit(1);});
