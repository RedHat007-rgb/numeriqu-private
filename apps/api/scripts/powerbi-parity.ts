/**
 * PowerBI value-parity harness (the test we never had).
 *
 * For each EBPO measure it computes TWO numbers on live ClickHouse and compares them:
 *   • catalog  — exactly how the agent's chart-spec-ebpo compiler aggregates it today
 *                (derived measures = ratio-of-sums; everything else = <agg>(column)).
 *   • dax      — the PowerBI DAX definition, hand-encoded from the model's measure list
 *                (the ground truth a tester compares against).
 *
 * It runs at multiple GRAINS (overall / monthly / one categorical dim) because the
 * avg-of-ratios bug is invisible at the view's native row grain and only shows up when
 * the chart cell is coarser. A row is FAIL when |catalog − dax| exceeds tolerance.
 *
 * This is the missing layer: rows>0 said "OK"; this says "matches PowerBI or not".
 *
 * Run:  cd apps/api && npx tsx scripts/powerbi-parity.ts [--measure id] [--grain overall|month|dim]
 */
import 'reflect-metadata';
import path from 'node:path';
import dotenv from 'dotenv';
import { createClient } from '@clickhouse/client';
import { EBPO_MEASURES, EBPO_VIEWS, EBPO_DIMENSIONS } from '../src/modules/agent/chart-spec-ebpo';

dotenv.config({ path: path.resolve(__dirname, '../.env'), quiet: true });

const SCOPE = {
  tenantId: process.env.HARNESS_TENANT || '7375b5aa-f5bc-4739-88e1-02be1203439b',
  externalOrgIds: [process.env.HARNESS_ORG || 'ebpo_enterprise'],
};
const ch = createClient({
  url: process.env.CLICKHOUSE_ANALYTICS_URL,
  username: process.env.CLICKHOUSE_ANALYTICS_USER,
  password: process.env.CLICKHOUSE_ANALYTICS_PASSWORD,
  database: process.env.CLICKHOUSE_ANALYTICS_DB || 'analytics',
});
const run = (sql: string) =>
  ch
    .query({ query: sql, query_params: SCOPE, format: 'JSONEachRow' })
    .then((x: any) => x.json());
const W = 'tenant_id = {tenantId:String} AND org_id IN ({externalOrgIds:Array(String)})';

// ── DAX oracle ────────────────────────────────────────────────────────────────
// Each entry: which view to read, and the DAX measure as a SQL aggregate over that
// view's columns. Only measures whose DAX is non-trivial (or cross-fact) are listed;
// for a pure SUM/AVERAGE/MAX the catalog already equals the DAX so we assert that too.
type Oracle = {
  view: string;
  dax: string; // SQL aggregate equal to the PowerBI DAX measure
  note?: string;
};
const DAX: Record<string, Oracle> = {
  // ── DIVIDE(SUM, SUM) ratios — the class the catalog computes as avg(precomputed %) ──
  collection_rate_pct: {
    view: 'v_ebpo_ar_aging',
    dax: 'sum(collected_amount_usd)/nullIf(sum(invoice_amount_usd),0)*100',
  },
  payment_rate_pct: {
    view: 'v_ebpo_ap_aging',
    dax: 'sum(paid_amount_usd)/nullIf(sum(invoice_amount_usd),0)*100',
  },
  payroll_to_revenue_pct: {
    view: 'v_ebpo_kpi_monthly',
    dax: 'sum(total_payroll_usd)/nullIf(sum(total_revenue_usd),0)*100',
    note: 'DAX DIVIDE([Total Payroll],[Total Revenue]) — cross-fact in PBI',
  },
  overtime_to_payroll_pct: {
    view: 'v_ebpo_payroll_monthly',
    dax: 'sum(total_overtime_usd)/nullIf(sum(total_payroll_usd),0)*100',
  },
  gross_margin_pct: {
    view: 'v_ebpo_kpi_monthly',
    dax: 'sum(gross_margin_usd)/nullIf(sum(total_revenue_usd),0)*100',
    note: 'already derived in catalog — expect PASS (control)',
  },
  // Catalog-invented CFO ratios (not in the 27-DAX list) — oracle is the intended
  // ratio-of-sums; these were avg(precomputed) and diverge the same way.
  cost_to_income_pct: {
    view: 'v_ebpo_cfo_ratios_monthly',
    dax: 'sum(total_cost_usd)/nullIf(sum(total_revenue_usd),0)*100',
  },
  fcf_margin_pct: {
    view: 'v_ebpo_cfo_ratios_monthly',
    dax: 'sum(free_cash_flow_usd)/nullIf(sum(total_revenue_usd),0)*100',
  },
  operating_cf_to_revenue_pct: {
    view: 'v_ebpo_cfo_ratios_monthly',
    dax: 'sum(operating_cash_flow_usd)/nullIf(sum(total_revenue_usd),0)*100',
  },
  ebitda_style_margin_pct: {
    view: 'v_ebpo_cfo_ratios_monthly',
    dax: '(sum(total_revenue_usd)-sum(total_cost_usd)-sum(total_payroll_usd))/nullIf(sum(total_revenue_usd),0)*100',
  },
  // DSO/DPO = DIVIDE([AR or AP],[Revenue or Cost]/365) = ratio-of-sums × 365.
  dso_days: {
    view: 'v_ebpo_kpi_monthly',
    dax: 'sum(ar_outstanding_usd)/nullIf(sum(total_revenue_usd),0)*365',
  },
  dpo_days: {
    view: 'v_ebpo_kpi_monthly',
    dax: 'sum(ap_outstanding_usd)/nullIf(sum(total_cost_usd),0)*365',
  },
  // ── AVERAGE(fact[col]) — catalog avg(col) should already MATCH (controls) ──
  // Read from the operations view (which exposes delivery_center/region/country dims)
  // rather than v_ebpo_kpi_monthly (dims:[]) so the dim grain actually exercises these
  // — the real "CSAT/SLA/Utilization by delivery center" chart. NOTE: this proves
  // catalog avg(col) == DAX avg(col) over the SAME view at every grain; it does NOT
  // prove the view's per-row grain matches FactOperations (true per-row weighting needs
  // an oracle over the raw fact table — separate, larger task).
  sla_compliance_pct: { view: 'v_ebpo_operations_monthly', dax: 'avg(sla_compliance_pct)' },
  csat_pct: { view: 'v_ebpo_operations_monthly', dax: 'avg(csat_pct)' },
  utilization_pct: { view: 'v_ebpo_operations_monthly', dax: 'avg(utilization_pct)' },
  // ── DAX measure averages a DIMENSION attribute, not a fact (subtle weighting) ──
  avg_monthly_salary: {
    view: 'v_ebpo_salary_by_dept_grade',
    dax: 'avg(avg_monthly_salary_usd)',
    note: 'PBI AVERAGE(DimEmployee[MonthlySalaryUSD]) = per-employee; view col may be pre-averaged → check weighting',
  },
};

// Catalog computation as the compiler would emit it for a coarse cell.
const catalogExpr = (id: string, view: (typeof EBPO_VIEWS)[number]): string | null => {
  const m = EBPO_MEASURES[id];
  if (!m) return null;
  if (m.derived) {
    const num = m.derived.num as string | { add: string[]; sub?: string[] };
    const terms =
      typeof num === 'string' ? { add: [num], sub: [] } : { add: num.add, sub: num.sub ?? [] };
    const d = view.measures[m.derived.den];
    const cols = [...terms.add, ...terms.sub].map((id) => view.measures[id]);
    if (!d || cols.some((c) => !c)) return null;
    const numExpr =
      terms.add.map((id) => `sum(${view.measures[id]})`).join('+') +
      terms.sub.map((id) => `-sum(${view.measures[id]})`).join('');
    return `(${numExpr})/nullIf(sum(${d}),0)*${m.derived.scale ?? 100}`;
  }
  const col = view.measures[id];
  if (!col) return null;
  return `${m.agg}(${col})`;
};

const argStr = (flag: string) => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
};

const TOL_REL = 0.005; // 0.5% relative
const TOL_ABS = 0.05; // or 0.05 absolute (pts / units)
const off = (a: number, b: number) =>
  Math.abs(a - b) > TOL_ABS && Math.abs(a - b) / (Math.abs(b) || 1) > TOL_REL;

async function compare(id: string, grainArg?: string) {
  const oracle = DAX[id];
  const view = EBPO_VIEWS.find((v) => v.name === oracle.view)!;
  const cat = catalogExpr(id, view);
  if (!cat) return console.log(`#${id}: no catalog expr in ${oracle.view}`);

  const grains: Array<[string, string]> = [['overall', '']];
  if (view.hasTime && grainArg !== 'dim' && grainArg !== 'overall')
    grains.push(['by-month', 'GROUP BY toStartOfMonth(period_date)']);
  const firstDim = view.dims[0];
  if (firstDim && grainArg !== 'month' && grainArg !== 'overall') {
    // The dim's group expr mirrors the compiler's catExpr (COALESCE/NULLIF over the
    // physical .column). The old code read a non-existent `.groupExpr` → col was always
    // undefined → the dim grain silently never ran and every measure printed only
    // `overall` as "pass". This is the grain where avg(precomputed_%) diverges most from
    // DIVIDE(SUM,SUM), so a no-op here defeated the harness's whole purpose.
    const col = EBPO_DIMENSIONS[firstDim]?.column;
    if (col) grains.push([`by-${firstDim}`, `GROUP BY COALESCE(NULLIF(${col}, ''), 'Unassigned')`]);
  }

  for (const [label, groupBy] of grains) {
    // Worst-case divergence across cells (the number a tester would see in one cell).
    const sql = `SELECT
        round(max(abs(c - d)), 3) AS max_abs_gap,
        round(argMax(c, abs(c - d)), 3) AS catalog_at_worst,
        round(argMax(d, abs(c - d)), 3) AS dax_at_worst
      FROM ( SELECT ${cat} AS c, ${oracle.dax} AS d
             FROM analytics.${oracle.view} WHERE ${W} ${groupBy} )`;
    try {
      const r: any = await run(sql);
      const { catalog_at_worst: c, dax_at_worst: d } = r[0];
      const fail = off(Number(c), Number(d));
      console.log(
        `${fail ? 'FAIL' : 'pass'}  ${id.padEnd(26)} ${label.padEnd(14)} ` +
          `catalog=${String(c).padStart(12)}  dax=${String(d).padStart(12)}  Δ=${r[0].max_abs_gap}`,
      );
    } catch (e: any) {
      console.log(`ERR   ${id.padEnd(26)} ${label.padEnd(14)} ${e.message?.slice(0, 70)}`);
    }
  }
}

(async () => {
  const only = argStr('--measure');
  const grain = argStr('--grain');
  const ids = only ? [only] : Object.keys(DAX);
  console.log(
    `PowerBI parity — tenant ${SCOPE.tenantId} org ${SCOPE.externalOrgIds[0]}  (tol ${TOL_REL * 100}% / ${TOL_ABS})\n`,
  );
  for (const id of ids) await compare(id, grain);
  console.log('\n— FAIL = agent value diverges from the PowerBI DAX definition —');
  process.exit(0);
})().catch((e) => {
  console.error('FATAL', e.message);
  process.exit(1);
});
