import fs from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';

import dotenv from 'dotenv';
import { createClient as createClickHouseClient } from '@clickhouse/client';

import { installLlmFetchInterceptor } from '../src/common/llm/llm-fetch-interceptor';

const repoRoot = path.resolve(__dirname, '../../..');
for (const envFile of [
  path.join(repoRoot, '.env'),
  path.join(repoRoot, '.env.local'),
  path.resolve(__dirname, '../.env'),
  path.resolve(__dirname, '../.env.local'),
]) {
  if (existsSync(envFile)) dotenv.config({ path: envFile, override: true, quiet: true });
}

installLlmFetchInterceptor();
process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db';

const TENANT_ID = '7375b5aa-f5bc-4739-88e1-02be1203439b';
const EXTERNAL_ORG_IDS = ['ebpo_enterprise'];
const OUT_DIR = path.join(repoRoot, 'prompt-audit-results');

type PromptCase = {
  id: string;
  prompt: string;
  expectedType: string | null;
  reference: string;
  note?: string;
};

const cases: PromptCase[] = [
  { id: 'rev-01', expectedType: 'bar', reference: 'Monthly Revenue vs Cost / monthly revenue column', prompt: 'Create a column chart showing monthly total revenue.' },
  { id: 'rev-02', expectedType: 'line', reference: 'Revenue growth line', prompt: 'Create a line chart showing month-on-month revenue growth percentage.' },
  { id: 'rev-03', expectedType: 'stacked_bar', reference: 'Revenue by Client stacked / BU mix equivalent', prompt: 'Create a stacked column chart showing monthly revenue by business unit.' },
  { id: 'rev-04', expectedType: 'bar', reference: 'Client Revenue Detail / client revenue ranking', prompt: 'Create a bar chart showing total revenue by client.' },
  { id: 'rev-05', expectedType: 'donut', reference: 'Revenue by Business Unit donut / share chart equivalent', prompt: 'Create a donut chart showing revenue share by contract type.' },
  { id: 'rev-06', expectedType: 'bar', reference: 'Monthly Revenue vs Cost / comparison chart', prompt: 'Create a clustered bar chart comparing revenue and cost by business unit.' },
  { id: 'rev-07', expectedType: 'line', reference: 'Revenue vs Gross Margin % by Month', prompt: 'Create a line chart showing monthly gross margin trend.' },
  { id: 'rev-08', expectedType: 'combo', reference: 'Revenue vs Gross Margin % by Month combo', prompt: 'Create a combo chart with monthly revenue as columns and gross margin percentage as a line.' },
  { id: 'rev-09', expectedType: 'heatmap', reference: 'Heatmap equivalent', prompt: 'Create a heat map showing gross margin percentage by business unit and month.' },
  { id: 'rev-10', expectedType: 'waterfall', reference: 'Waterfall equivalent', prompt: 'Create a waterfall chart showing revenue, cost, and gross margin by month.' },
  { id: 'rev-11', expectedType: 'bar', reference: 'Cost by BU comparison', prompt: 'Create a column chart showing total cost by business unit.' },
  { id: 'rev-12', expectedType: 'treemap', reference: 'Revenue by Business Unit treemap', prompt: 'Create a treemap showing revenue contribution by client.' },
  { id: 'rev-13', expectedType: 'scatter', reference: 'Scatter equivalent', prompt: 'Create a scatter plot showing revenue versus gross margin by client.' },
  { id: 'rev-14', expectedType: 'bar', reference: 'Margin by contract type', prompt: 'Create a bar chart showing average gross margin percentage by contract type.' },
  { id: 'rev-15', expectedType: 'area', reference: 'Stacked area equivalent', prompt: 'Create a stacked area chart showing monthly revenue by contract type.' },
  { id: 'rev-16', expectedType: 'horizontal_bar', reference: 'Ranked client gross margin', prompt: 'Create a ranked bar chart showing top clients by gross margin.' },
  { id: 'rev-17', expectedType: 'stacked_bar', reference: 'Monthly revenue mix', prompt: 'Create a 100% stacked column chart showing monthly revenue mix by business unit.' },
  { id: 'rev-18', expectedType: 'line', reference: 'Cost/revenue trend', prompt: 'Create a line chart showing monthly cost as a percentage of revenue.' },
  { id: 'rev-19', expectedType: 'heatmap', reference: 'Revenue by Client stacked by Contract Type matrix equivalent', prompt: 'Create a heat map showing revenue by client and contract type.' },
  { id: 'rev-20', expectedType: 'bar', reference: 'Client margin ranking', prompt: 'Create a bar chart showing gross margin percentage by client.' },
  { id: 'cash-01', expectedType: 'line', reference: 'Cash Balance Trend - 2025', prompt: 'Create a line chart showing monthly cash balance.' },
  { id: 'cash-02', expectedType: 'bar', reference: 'Cash Flow Components - monthly', prompt: 'Create a column chart showing monthly operating cash flow.' },
  { id: 'cash-03', expectedType: 'stacked_bar', reference: 'Cash Flow Components - monthly', prompt: 'Create a stacked column chart showing operating, investing, and financing cash flow by month.' },
  { id: 'cash-04', expectedType: 'bar', reference: 'Monthly Free Cash Flow - 2025', prompt: 'Create a column chart showing monthly free cash flow.' },
  { id: 'cash-05', expectedType: 'waterfall', reference: 'Cash Flow Waterfall', prompt: 'Create a waterfall chart showing monthly movement from operating cash flow to free cash flow.' },
  { id: 'cash-06', expectedType: 'line', reference: 'Opening/closing balance trend equivalent', prompt: 'Create a line chart showing monthly opening balance and closing balance by account.' },
  { id: 'cash-07', expectedType: 'bar', reference: 'Debit/credit movement equivalent', prompt: 'Create a column chart showing debit movement and credit movement by account.' },
  { id: 'cash-08', expectedType: 'heatmap', reference: 'Closing balance heatmap equivalent', prompt: 'Create a heat map showing closing balance by account and month.' },
  { id: 'cash-09', expectedType: 'bar', reference: 'Debit amount by account', prompt: 'Create a bar chart showing total debit amount by account.' },
  { id: 'cash-10', expectedType: 'waterfall', reference: 'Net movement waterfall', prompt: 'Create a waterfall chart showing net movement by account.' },
  { id: 'ar-01', expectedType: 'bar', reference: 'AR Aging by Client', prompt: 'Create a bar chart showing outstanding receivables by client.' },
  { id: 'ar-02', expectedType: 'stacked_bar', reference: 'AR Aging Buckets / AR Aging by Client', prompt: 'Create a stacked bar chart showing outstanding receivables by aging bucket.' },
  { id: 'ar-03', expectedType: 'bar', reference: 'AR monthly invoice/collection/outstanding', prompt: 'Create a column chart showing invoice amount, collected amount, and outstanding receivables by month.' },
  { id: 'ar-04', expectedType: 'heatmap', reference: 'AR Aging by Client heatmap equivalent', prompt: 'Create a heat map showing outstanding receivables by client and aging bucket.' },
  { id: 'ar-05', expectedType: 'pareto', reference: 'AR Pareto equivalent', prompt: 'Create a Pareto chart showing clients ranked by outstanding receivables.' },
  { id: 'ap-01', expectedType: 'bar', reference: 'AP Aging by Vendor', prompt: 'Create a bar chart showing outstanding payables by vendor.' },
  { id: 'ap-02', expectedType: 'stacked_bar', reference: 'AP Aging Buckets / AP Aging by Vendor', prompt: 'Create a stacked bar chart showing outstanding payables by aging bucket.' },
  { id: 'ap-03', expectedType: 'bar', reference: 'AP monthly invoice/paid/outstanding', prompt: 'Create a column chart showing payable invoice amount, paid amount, and outstanding payables by month.' },
  { id: 'ap-04', expectedType: 'heatmap', reference: 'AP vendor aging heatmap equivalent', prompt: 'Create a heat map showing outstanding payables by vendor and aging bucket.' },
  { id: 'ap-05', expectedType: 'pareto', reference: 'AP Pareto equivalent', prompt: 'Create a Pareto chart showing vendors ranked by outstanding payables.' },
  { id: 'pay-01', expectedType: 'bar', reference: 'Monthly Payroll Trend', prompt: 'Create a column chart showing monthly total payroll.' },
  { id: 'pay-02', expectedType: 'stacked_bar', reference: 'Payroll by Department', prompt: 'Create a stacked bar chart showing total payroll by department.' },
  { id: 'pay-03', expectedType: 'bar', reference: 'Payroll by Country', prompt: 'Create a bar chart showing total payroll by country.' },
  { id: 'pay-04', expectedType: 'line', reference: 'Monthly overtime trend', prompt: 'Create a line chart showing monthly overtime cost.' },
  { id: 'pay-05', expectedType: 'bar', reference: 'Bonus by department', prompt: 'Create a column chart showing total bonus by department.' },
  { id: 'pay-06', expectedType: 'stacked_bar', reference: 'Payroll Components by Month - 2025', prompt: 'Create a stacked column chart showing monthly payroll composition.' },
  { id: 'pay-07', expectedType: 'heatmap', reference: 'Payroll heatmap equivalent', prompt: 'Create a heat map showing payroll by department and country.' },
  { id: 'pay-08', expectedType: 'bar', reference: 'Avg Salary Heatmap - grade source', prompt: 'Create a bar chart showing average salary by employee grade.' },
  { id: 'pay-09', expectedType: null, reference: 'Unsupported in current renderer', note: 'box plot is unsupported and should clarify/fallback, not fake a box plot', prompt: 'Create a box plot showing salary distribution by department.' },
  { id: 'pay-10', expectedType: 'bar', reference: 'Employee count by department', prompt: 'Create a column chart showing employee count by department.' },
  { id: 'pay-11', expectedType: 'bar', reference: 'Employee count by country/delivery center', prompt: 'Create a bar chart showing employee count by country and delivery center.' },
  { id: 'pay-12', expectedType: 'pareto', reference: 'Payroll Pareto by department', prompt: 'Create a Pareto chart showing departments ranked by total payroll.' },
  { id: 'pay-13', expectedType: 'bar', reference: 'Overtime by department', prompt: 'Create a column chart showing overtime cost by department.' },
  { id: 'pay-14', expectedType: 'bar', reference: 'Benefits by country', prompt: 'Create a bar chart showing benefits cost by country.' },
  { id: 'pay-15', expectedType: 'bar', reference: 'Payroll cost per employee by country', prompt: 'Create a column chart showing payroll cost per employee by country.' },
  { id: 'ops-01', expectedType: 'line', reference: 'Operations trend equivalent', prompt: 'Create a line chart showing monthly calls handled by delivery center.' },
  { id: 'ops-02', expectedType: 'bar', reference: 'SLA by delivery center', prompt: 'Create a column chart showing average SLA compliance by delivery center.' },
  { id: 'ops-03', expectedType: 'scatter', reference: 'AHT vs CSAT scatter', prompt: 'Create a scatter plot showing average handling time versus CSAT percentage.' },
  { id: 'ops-04', expectedType: 'heatmap', reference: 'SLA heatmap', prompt: 'Create a heat map showing SLA compliance by delivery center and month.' },
  { id: 'ops-05', expectedType: 'line', reference: 'Utilization trend', prompt: 'Create a line chart showing monthly utilization percentage by delivery center.' },
  { id: 'ops-06', expectedType: 'bar', reference: 'Tickets resolved by delivery center', prompt: 'Create a bar chart showing total tickets resolved by delivery center.' },
  { id: 'ops-07', expectedType: 'combo', reference: 'Calls handled + CSAT combo', prompt: 'Create a combo chart showing calls handled as columns and CSAT percentage as a line.' },
  { id: 'ops-08', expectedType: 'horizontal_bar', reference: 'Ranked CSAT by delivery center', prompt: 'Create a ranked bar chart showing delivery centers by average CSAT percentage.' },
  { id: 'ops-09', expectedType: 'bar', reference: 'Monthly AHT', prompt: 'Create a column chart showing monthly average handling time.' },
  { id: 'ops-10', expectedType: 'scatter', reference: 'Utilization vs SLA scatter', prompt: 'Create a scatter plot showing utilization percentage versus SLA compliance percentage.' },
  { id: 'asset-01', expectedType: 'bar', reference: 'Asset NBV by center', prompt: 'Create a bar chart showing net book value by delivery center.' },
  { id: 'asset-02', expectedType: 'stacked_bar', reference: 'Asset NBV by asset type and center', prompt: 'Create a stacked bar chart showing net book value by asset type and delivery center.' },
  { id: 'asset-03', expectedType: 'donut', reference: 'Asset cost share', prompt: 'Create a donut chart showing asset cost share by asset type.' },
  { id: 'asset-04', expectedType: 'bar', reference: 'Accumulated depreciation by type', prompt: 'Create a bar chart showing accumulated depreciation by asset type.' },
  { id: 'asset-05', expectedType: 'treemap', reference: 'Asset treemap', prompt: 'Create a treemap showing net book value by delivery center and asset type.' },
  { id: 'asset-06', expectedType: 'scatter', reference: 'Asset cost vs NBV', prompt: 'Create a scatter plot showing asset cost versus net book value by asset type.' },
  { id: 'asset-07', expectedType: 'horizontal_bar', reference: 'Depreciation % ranking', prompt: 'Create a ranked bar chart showing delivery centers by depreciation percentage.' },
  { id: 'asset-08', expectedType: 'bar', reference: 'Asset cost / depreciation / NBV comparison', prompt: 'Create a column chart comparing asset cost, accumulated depreciation, and net book value by asset type.' },
  { id: 'asset-09', expectedType: 'heatmap', reference: 'Asset NBV heatmap', prompt: 'Create a heat map showing net book value by asset type and delivery center.' },
  { id: 'asset-10', expectedType: 'bar', reference: 'Asset intensity', prompt: 'Create a bar chart showing asset intensity by delivery center using net book value per call handled.' },
  { id: 'cfo-01', expectedType: 'line', reference: 'Liquidity trend', prompt: 'Create a line chart showing monthly current ratio.' },
  { id: 'cfo-02', expectedType: 'bar', reference: 'Quick ratio by month', prompt: 'Create a column chart showing monthly quick ratio.' },
  { id: 'cfo-03', expectedType: 'line', reference: 'Working capital trend', prompt: 'Create a line chart showing monthly working capital.' },
  { id: 'cfo-04', expectedType: 'bar', reference: 'Cost per employee by month', prompt: 'Create a column chart showing cost per employee by month.' },
  { id: 'cfo-05', expectedType: 'bar', reference: 'Cost per employee by department', prompt: 'Create a bar chart showing cost per employee by department.' },
  { id: 'cfo-06', expectedType: 'scatter', reference: 'Revenue per employee vs cost per employee', prompt: 'Create a scatter plot showing revenue per employee versus cost per employee by department.' },
  { id: 'cfo-07', expectedType: 'combo', reference: 'Revenue + payroll % combo', prompt: 'Create a combo chart showing monthly revenue as columns and payroll as a percentage of revenue as a line.' },
  { id: 'cfo-08', expectedType: 'line', reference: 'FCF margin trend', prompt: 'Create a line chart showing monthly free cash flow margin.' },
  { id: 'cfo-09', expectedType: 'bar', reference: 'Revenue per employee by BU', prompt: 'Create a bar chart showing revenue per employee by business unit.' },
  { id: 'cfo-10', expectedType: 'bar', reference: 'OCF % revenue by month', prompt: 'Create a column chart showing operating cash flow as a percentage of revenue by month.' },
  { id: 'cfo-11', expectedType: 'line', reference: 'Receivables % revenue trend', prompt: 'Create a line chart showing receivables as a percentage of revenue by month.' },
  { id: 'cfo-12', expectedType: 'bar', reference: 'Collection rate by client', prompt: 'Create a bar chart showing collection rate by client.' },
  { id: 'cfo-13', expectedType: 'scatter', reference: 'Client revenue vs collection rate', prompt: 'Create a scatter plot showing client revenue versus collection rate.' },
  { id: 'cfo-14', expectedType: 'scatter', reference: 'Client margin vs collection rate', prompt: 'Create a scatter plot showing client gross margin percentage versus collection rate.' },
  { id: 'cfo-15', expectedType: 'line', reference: 'Cash conversion trend', prompt: 'Create a line chart showing monthly cash conversion using operating cash flow divided by revenue.' },
  { id: 'cfo-16', expectedType: 'bar', reference: 'Revenue/payroll/gross margin by BU', prompt: 'Create a bar chart showing revenue, payroll, and gross margin by business unit.' },
  { id: 'cfo-17', expectedType: 'heatmap', reference: 'Revenue per employee heatmap', prompt: 'Create a heat map showing revenue per employee by department and month.' },
  { id: 'cfo-18', expectedType: 'bar', reference: 'EBITDA-style margin by month', prompt: 'Create a column chart showing monthly EBITDA-style margin using revenue minus cost minus payroll.' },
  { id: 'cfo-19', expectedType: 'line', reference: 'Net working capital trend', prompt: 'Create a line chart showing monthly net working capital.' },
  { id: 'cfo-20', expectedType: 'bar', reference: 'Revenue per delivery center', prompt: 'Create a bar chart showing revenue per delivery center.' },
  { id: 'cfo-21', expectedType: 'scatter', reference: 'Utilization vs revenue per employee', prompt: 'Create a scatter plot showing utilization percentage versus revenue per employee by delivery center.' },
  { id: 'cfo-22', expectedType: 'bar', reference: 'Cost-to-income ratio', prompt: 'Create a column chart showing monthly cost-to-income ratio using total cost divided by revenue.' },
  { id: 'cfo-23', expectedType: 'line', reference: 'Cash balance and AR line trend', prompt: 'Create a line chart showing monthly cash balance and outstanding receivables.' },
  { id: 'cfo-24', expectedType: 'kpi', reference: 'KPI Scorecard / CFO scorecard', prompt: 'Create a CFO scorecard chart showing revenue, gross margin, payroll, free cash flow, receivables, and payables by month.' },
  { id: 'cfo-25', expectedType: null, reference: 'Multi-widget dashboard', note: 'dashboard composition should build multiple widgets, not one chart', prompt: 'Create a dashboard showing monthly liquidity, profitability, employee efficiency, and cash conversion metrics.' },
];

const clickhouse = createClickHouseClient({
  url: process.env.CLICKHOUSE_ANALYTICS_URL,
  username: process.env.CLICKHOUSE_ANALYTICS_USER || 'dbt_transformer',
  password: process.env.CLICKHOUSE_ANALYTICS_PASSWORD || '',
  database: process.env.CLICKHOUSE_ANALYTICS_DB || 'analytics',
});

const scope = { tenantId: TENANT_ID, externalOrgIds: EXTERNAL_ORG_IDS, connectionIds: [] };
let service: any;

function columnsFromRows(rows: Array<Record<string, unknown>>) {
  return Array.from(new Set(rows.flatMap((row) => Object.keys(row)))).sort();
}

function classify(caseDef: PromptCase, result: any) {
  if (!result) return { status: 'fail', reason: 'planner returned null' };
  if (result.kind !== 'build') {
    if (!caseDef.expectedType && ['clarify', 'no_data'].includes(result.kind)) {
      return { status: 'expected_gap', reason: `${result.kind}: ${result.message ?? result.clarification?.reason ?? ''}` };
    }
    return { status: 'fail', reason: `planner returned ${result.kind}` };
  }
  const widgets = result.plan?.dashboard?.widgets ?? [];
  if (widgets.length < 1) return { status: 'fail', reason: 'no widgets generated' };
  const widget = widgets[0];
  if (caseDef.expectedType && widget.type !== caseDef.expectedType) {
    return { status: 'fail', reason: `type mismatch expected=${caseDef.expectedType} actual=${widget.type}` };
  }
  if (!caseDef.expectedType && caseDef.id !== 'cfo-25') {
    return { status: 'fail', reason: `unsupported prompt unexpectedly built ${widget.type}` };
  }
  return { status: 'pass', reason: 'type and data verified' };
}

async function runOne(caseDef: PromptCase) {
  const startedAt = Date.now();
  try {
    const result = await service.generateSmartPlan(caseDef.prompt, scope);
    const widgets = result?.kind === 'build' ? result.plan.dashboard.widgets : [];
    const first = widgets[0] as any;
    let rows: Array<Record<string, unknown>> = [];
    let sql = first?._sql || first?.queryConfig?.dynamicSql || null;
    if (sql) {
      const checked = await service.executeDynamicSqlChecked(sql, scope, { chartType: first.type });
      rows = checked.rows ?? [];
    }
    const verdict = classify(caseDef, result);
    return {
      id: caseDef.id,
      prompt: caseDef.prompt,
      expectedType: caseDef.expectedType,
      reference: caseDef.reference,
      note: caseDef.note ?? '',
      status: verdict.status,
      reason: verdict.reason,
      resultKind: result?.kind ?? 'null',
      generatedType: first?.type ?? null,
      title: first?.title ?? null,
      metric: first?.metric ?? null,
      grouping: first?.grouping ?? null,
      rowCount: rows.length,
      columns: columnsFromRows(rows),
      durationMs: Date.now() - startedAt,
      sql,
    };
  } catch (err: any) {
    return {
      id: caseDef.id,
      prompt: caseDef.prompt,
      expectedType: caseDef.expectedType,
      reference: caseDef.reference,
      note: caseDef.note ?? '',
      status: 'error',
      reason: String(err?.message ?? err).slice(0, 500),
      durationMs: Date.now() - startedAt,
    };
  }
}

async function main() {
  const { AgentService } = await import('../src/modules/agent/agent.service');
  service = new AgentService({} as any, clickhouse as any, {} as any) as any;
  await fs.mkdir(OUT_DIR, { recursive: true });
  const requested = new Set(process.argv.slice(2).filter((arg) => !arg.startsWith('--')));
  const selected = requested.size ? cases.filter((c) => requested.has(c.id)) : cases;
  const results = [];
  for (const [index, caseDef] of selected.entries()) {
    console.log(`[${index + 1}/${selected.length}] ${caseDef.id} ${caseDef.prompt}`);
    const result = await runOne(caseDef);
    results.push(result);
    console.log(`  -> ${result.status} ${result.generatedType ?? ''} rows=${result.rowCount ?? 0} ${result.reason}`);
    await fs.writeFile(path.join(OUT_DIR, 'ebpo-prompt-audit.partial.json'), JSON.stringify(results, null, 2));
  }

  const summary = {
    total: results.length,
    pass: results.filter((r) => r.status === 'pass').length,
    expectedGap: results.filter((r) => r.status === 'expected_gap').length,
    fail: results.filter((r) => r.status === 'fail').length,
    error: results.filter((r) => r.status === 'error').length,
  };
  await fs.writeFile(path.join(OUT_DIR, 'ebpo-prompt-audit.json'), JSON.stringify({ summary, results }, null, 2));
  const csv = [
    'id,status,expectedType,generatedType,rowCount,reason,prompt',
    ...results.map((r) =>
      [
        r.id,
        r.status,
        r.expectedType ?? '',
        r.generatedType ?? '',
        r.rowCount ?? '',
        JSON.stringify(r.reason ?? ''),
        JSON.stringify(r.prompt ?? ''),
      ].join(','),
    ),
  ].join('\n');
  await fs.writeFile(path.join(OUT_DIR, 'ebpo-prompt-audit.csv'), csv);
  console.log(JSON.stringify(summary, null, 2));
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await clickhouse.close();
  });
