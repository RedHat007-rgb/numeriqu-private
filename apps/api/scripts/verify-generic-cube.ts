/**
 * Live DAX-style parity oracle for the GENERIC cube-builder.
 *
 * For every major fact table it derives a `CubeBlueprint` (per-dataset input =
 * taxonomy read LIVE from the data, never hardcoded), generates the view DDL
 * with the generic `buildCubeViewDdl`, materializes a throwaway shadow view, and
 * asserts each headline figure ties out CENT-EXACT to ground truth recomputed
 * directly from the raw star-schema fact (the DAX-equivalent SQL). Proves the
 * generic builder emits correct SUM / weighted-mean / pivot / join cubes for the
 * whole dataset — not just the P&L cube.
 *
 * Run: cd apps/api && npx tsx scripts/verify-generic-cube.ts
 */
import { createClient } from '@clickhouse/client';
import * as dotenv from 'dotenv';
import * as path from 'node:path';
import { buildCubeViewDdl, type CubeBlueprint } from '../src/modules/chart-engine/cube-builder';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const DB = process.env.CLICKHOUSE_ANALYTICS_DB || 'analytics';
const URL = process.env.CLICKHOUSE_ANALYTICS_URL || process.env.CLICKHOUSE_URL;
const USER = process.env.CLICKHOUSE_ANALYTICS_USER || 'default';
const PASSWORD = process.env.CLICKHOUSE_ANALYTICS_PASSWORD || '';

const client = createClient({ url: URL, username: USER, password: PASSWORD, database: DB });

/** One tie-out: an aggregate over the generated cube vs the raw fact. */
interface Check {
  label: string;
  /** Aggregate expression evaluated over the shadow cube view. */
  cube: string;
  /** The SAME quantity recomputed directly from the raw fact (ground truth). */
  raw: string;
}
interface Case {
  fact: string;
  blueprint: CubeBlueprint;
  checks: Check[];
}

async function scalar(sql: string): Promise<number> {
  const r = await client.query({ query: sql, format: 'JSONEachRow' });
  const [row] = (await r.json()) as Array<Record<string, number>>;
  return Number(row?.v);
}

async function distinct(fact: string, col: string): Promise<string[]> {
  const r = await client.query({
    query: `SELECT DISTINCT ${col} AS v FROM ${DB}.${fact} WHERE ${col} != '' ORDER BY v`,
    format: 'JSONEachRow',
  });
  return ((await r.json()) as Array<{ v: string }>).map((x) => x.v).filter(Boolean);
}

async function buildCases(): Promise<Case[]> {
  const [accountType, costCategory, revenueCategory, cashCats] = await Promise.all([
    distinct('sfin_fact_general_ledger', 'account_type'),
    distinct('sfin_fact_general_ledger', 'cost_category'),
    distinct('sfin_fact_general_ledger', 'revenue_category'),
    distinct('sfin_fact_cash_flow', 'cash_flow_category'),
  ]);

  return [
    {
      fact: 'P&L (pivot + derived waterfall)',
      blueprint: {
        view: 'v_gen_pl',
        factTable: 'sfin_fact_general_ledger',
        dateColumn: 'posting_date',
        pivots: [
          { valueColumn: 'pl_amount_usd', categoryColumn: 'account_type', values: accountType, canonical: { Revenue: 'total_revenue_usd', 'Direct Cost (COS)': 'total_cogs_usd' }, aliasSuffix: '_usd' },
          { valueColumn: 'pl_amount_usd', categoryColumn: 'cost_category', values: costCategory, aliasPrefix: 'cc_', aliasSuffix: '_usd' },
          { valueColumn: 'pl_amount_usd', categoryColumn: 'revenue_category', values: revenueCategory, aliasPrefix: 'rc_', aliasSuffix: '_usd' },
        ],
        derived: [{ expr: '(total_revenue_usd - total_cogs_usd)', alias: 'gross_profit_usd' }],
      },
      checks: [
        { label: 'Total Revenue', cube: 'sum(total_revenue_usd)', raw: "sumIf(pl_amount_usd, account_type='Revenue')" },
        { label: 'Total COGS', cube: 'sum(total_cogs_usd)', raw: "sumIf(pl_amount_usd, account_type='Direct Cost (COS)')" },
        { label: 'Gross Profit', cube: 'sum(gross_profit_usd)', raw: "sumIf(pl_amount_usd, account_type='Revenue') - sumIf(pl_amount_usd, account_type='Direct Cost (COS)')" },
      ],
    },
    {
      fact: 'Operations (sum volumes + weighted-mean KPIs)',
      blueprint: {
        view: 'v_gen_ops',
        factTable: 'sfin_fact_operations',
        dateColumn: 'posting_date',
        measures: [
          { column: 'billable_hours', alias: 'billable_hours', agg: 'sum' },
          { column: 'calls_handled', alias: 'calls_handled', agg: 'sum' },
          { column: 'utilization_pct', alias: 'utilization_pct', agg: 'mean' },
          { column: 'sla_compliance_pct', alias: 'sla_compliance_pct', agg: 'mean' },
        ],
      },
      checks: [
        { label: 'Billable Hours', cube: 'sum(billable_hours)', raw: 'sum(billable_hours)' },
        { label: 'Calls Handled', cube: 'sum(calls_handled)', raw: 'sum(calls_handled)' },
        // weighted mean reconstructs exactly: Σsum / Σcount == global avg
        { label: 'Utilization % (weighted mean)', cube: 'sum(utilization_pct)/nullIf(sum(utilization_pct_wt),0)', raw: 'avg(utilization_pct)' },
        { label: 'SLA % (weighted mean)', cube: 'sum(sla_compliance_pct)/nullIf(sum(sla_compliance_pct_wt),0)', raw: 'avg(sla_compliance_pct)' },
      ],
    },
    {
      fact: 'Accounts Receivable (sum + mean DSO)',
      blueprint: {
        view: 'v_gen_ar',
        factTable: 'sfin_fact_accounts_receivable',
        dateColumn: 'invoice_date',
        measures: [
          { column: 'invoice_amount_usd', alias: 'invoice_amount_usd', agg: 'sum' },
          { column: 'outstanding_balance_usd', alias: 'outstanding_balance_usd', agg: 'sum' },
          { column: 'days_sales_outstanding', alias: 'dso', agg: 'mean' },
        ],
      },
      checks: [
        { label: 'Invoice Amount', cube: 'sum(invoice_amount_usd)', raw: 'sum(invoice_amount_usd)' },
        { label: 'Outstanding', cube: 'sum(outstanding_balance_usd)', raw: 'sum(outstanding_balance_usd)' },
        { label: 'Avg DSO (weighted mean)', cube: 'sum(dso)/nullIf(sum(dso_wt),0)', raw: 'avg(days_sales_outstanding)' },
      ],
    },
    {
      fact: 'Accounts Payable (sum + mean DPO)',
      blueprint: {
        view: 'v_gen_ap',
        factTable: 'sfin_fact_accounts_payable',
        dateColumn: 'invoice_date',
        measures: [
          { column: 'invoice_amount_usd', alias: 'invoice_amount_usd', agg: 'sum' },
          { column: 'outstanding_balance_usd', alias: 'outstanding_balance_usd', agg: 'sum' },
          { column: 'days_payable_outstanding', alias: 'dpo', agg: 'mean' },
        ],
      },
      checks: [
        { label: 'Invoice Amount', cube: 'sum(invoice_amount_usd)', raw: 'sum(invoice_amount_usd)' },
        { label: 'Avg DPO (weighted mean)', cube: 'sum(dpo)/nullIf(sum(dpo_wt),0)', raw: 'avg(days_payable_outstanding)' },
      ],
    },
    {
      fact: 'Cash Flow (sum + category pivot, no grain)',
      blueprint: {
        view: 'v_gen_cf',
        factTable: 'sfin_fact_cash_flow',
        measures: [
          { column: 'cash_inflow_usd', alias: 'cash_inflow_usd', agg: 'sum' },
          { column: 'cash_outflow_usd', alias: 'cash_outflow_usd', agg: 'sum' },
          { column: 'net_cash_flow_usd', alias: 'net_cash_flow_usd', agg: 'sum' },
        ],
        pivots: [{ valueColumn: 'cash_outflow_usd', categoryColumn: 'cash_flow_category', values: cashCats, aliasPrefix: 'out_', aliasSuffix: '_usd' }],
      },
      checks: [
        { label: 'Cash Inflow', cube: 'sum(cash_inflow_usd)', raw: 'sum(cash_inflow_usd)' },
        { label: 'Cash Outflow', cube: 'sum(cash_outflow_usd)', raw: 'sum(cash_outflow_usd)' },
        { label: 'Net Cash Flow', cube: 'sum(net_cash_flow_usd)', raw: 'sum(net_cash_flow_usd)' },
      ],
    },
    {
      fact: 'Revenue by Client (LEFT JOIN dim_client)',
      blueprint: {
        view: 'v_gen_rev_client',
        factTable: 'sfin_fact_revenue',
        dateColumn: 'posting_date',
        joins: [{ dimTable: 'sfin_dim_client', factKey: 'client_key', dimKey: 'client_key', selects: [{ column: 'client_name', alias: 'client_name' }] }],
        measures: [
          { column: 'revenue_usd', alias: 'revenue_usd', agg: 'sum' },
          { column: 'billable_hours', alias: 'billable_hours', agg: 'sum' },
        ],
      },
      checks: [
        { label: 'Revenue', cube: 'sum(revenue_usd)', raw: 'sum(revenue_usd)' },
        { label: 'Billable Hours', cube: 'sum(billable_hours)', raw: 'sum(billable_hours)' },
      ],
    },
    {
      fact: 'Payroll (sum, no grain)',
      blueprint: {
        view: 'v_gen_payroll',
        factTable: 'sfin_fact_payroll',
        measures: [{ column: 'total_payroll_usd', alias: 'total_payroll_usd', agg: 'sum' }],
      },
      checks: [{ label: 'Total Payroll', cube: 'sum(total_payroll_usd)', raw: 'sum(total_payroll_usd)' }],
    },
  ];
}

async function main() {
  const cases = await buildCases();
  const shadowViews: string[] = [];
  let pass = 0;
  let fail = 0;

  for (const c of cases) {
    const view = `${DB}.${c.blueprint.view}`;
    shadowViews.push(view);
    await client.command({ query: buildCubeViewDdl(DB, c.blueprint) });
    console.log(`\n■ ${c.fact}  →  ${c.blueprint.view}`);
    for (const chk of c.checks) {
      const [cubeVal, rawVal] = await Promise.all([
        scalar(`SELECT round(${chk.cube}, 2) AS v FROM ${view}`),
        scalar(`SELECT round(${chk.raw}, 2) AS v FROM ${DB}.${c.blueprint.factTable}`),
      ]);
      const delta = Math.abs(cubeVal - rawVal);
      const ok = delta < 0.01;
      if (ok) pass++;
      else fail++;
      console.log(
        `   ${ok ? '✅' : '❌'} ${chk.label.padEnd(34)} cube=${cubeVal}  raw=${rawVal}  Δ=${delta.toFixed(2)}`,
      );
    }
  }

  // Clean up every shadow view — leave no residue in the analytics DB.
  for (const v of shadowViews) await client.command({ query: `DROP VIEW IF EXISTS ${v}` });
  await client.close();

  console.log(`\n${fail === 0 ? '✅ ALL GREEN' : '❌ FAILURES'} — ${pass} checks passed, ${fail} failed across ${cases.length} generic cubes.`);
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
