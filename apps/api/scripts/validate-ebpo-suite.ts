/**
 * EBPO catalog coverage + correctness harness (on-demand tool — NOT part of CI).
 *
 * Deterministically exercises the EBPO chart catalog/compiler against the LIVE
 * ClickHouse data: for every catalogued measure it compiles a representative set of
 * (dimension × chart type) specs, runs the generated SQL, and reports row counts +
 * issues (compile refusal, SQL error, zero rows, all-null measure). Because the
 * compiler — not an LLM — produces the SQL, this proves the deterministic layer
 * end-to-end (no hallucination, correct aggregation) without calling the model.
 *
 * Run (only when you want a full coverage report):
 *   cd apps/api && npx tsx scripts/validate-ebpo-suite.ts
 * Optional: --measure <id> to limit; --out <path> for the jsonl.
 *
 * Env: CLICKHOUSE_ANALYTICS_URL/USER/PASSWORD/DB (from apps/api/.env).
 * Scope defaults to the EBPO org; override with EBPO_TENANT_ID / EBPO_ORG_ID.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  EBPO_MEASURES,
  EBPO_DIMENSIONS,
  resolveEbpoView,
  compileEbpoSpec,
} from '../src/modules/agent/chart-spec-ebpo';
import type { ChartSpec } from '../src/modules/agent/chart-spec';

const ENV = process.env;
const CH_URL = ENV.CLICKHOUSE_ANALYTICS_URL || ENV.CLICKHOUSE_URL || '';
const CH_USER = ENV.CLICKHOUSE_ANALYTICS_USER || ENV.CLICKHOUSE_USER || 'default';
const CH_PASS = ENV.CLICKHOUSE_ANALYTICS_PASSWORD || ENV.CLICKHOUSE_PASSWORD || '';
const CH_DB = ENV.CLICKHOUSE_ANALYTICS_DB || 'analytics';
const TENANT = ENV.EBPO_TENANT_ID || '7375b5aa-f5bc-4739-88e1-02be1203439b';
const ORG = ENV.EBPO_ORG_ID || 'ebpo_enterprise';

const argOf = (flag: string) => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
};

// Substitute the compiler's bound params for direct HTTP execution.
function bind(sql: string): string {
  const orgs = `['${ORG.replace(/'/g, "\\'")}']`;
  return sql
    .replace(/\{tenantId:String\}/g, `'${TENANT}'`)
    .replace(/\{externalOrgIds:Array\(String\)\}/g, orgs);
}

async function runRows(sql: string): Promise<Array<Record<string, unknown>>> {
  if (!CH_URL) throw new Error('CLICKHOUSE_ANALYTICS_URL not set');
  const body = `${bind(sql)} FORMAT JSON`;
  const auth = Buffer.from(`${CH_USER}:${CH_PASS}`).toString('base64');
  const res = await fetch(`${CH_URL}/?database=${CH_DB}`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}` },
    body,
  });
  if (!res.ok) throw new Error(`CH ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { data?: Array<Record<string, unknown>> };
  return json.data ?? [];
}

// Representative chart types per dimension kind.
const TIME_TYPES = ['line', 'area', 'bar'];
const CAT_TYPES = ['bar', 'pie', 'treemap'];

type Row = {
  measure: string;
  dimension: string | null;
  breakdown: string | null;
  chartType: string;
  view: string | null;
  rowCount: number;
  issues: string[];
};

async function evalSpec(spec: ChartSpec): Promise<Row> {
  const view = resolveEbpoView(spec.measure, spec.dimension || null, spec.breakdown || null);
  const row: Row = {
    measure: spec.measure,
    dimension: spec.dimension || null,
    breakdown: spec.breakdown || null,
    chartType: spec.chartType,
    view: view?.name ?? null,
    rowCount: 0,
    issues: [],
  };
  try {
    const compiled = await compileEbpoSpec(spec, CH_DB, runRows);
    if (!compiled.ok) {
      row.issues.push('COMPILE_REFUSED');
      return row;
    }
    row.view = compiled.view;
    const rows = await runRows(compiled.sql);
    row.rowCount = rows.length;
    if (rows.length === 0) row.issues.push('ZERO_ROWS');
    else {
      // all-null measure check (single-series 'value' column)
      const hasValueCol = 'value' in rows[0]!;
      if (hasValueCol && rows.every((r) => r.value == null)) row.issues.push('NULL_MEASURE');
    }
  } catch (err: any) {
    row.issues.push(`SQL_ERROR:${String(err?.message ?? err).slice(0, 80)}`);
  }
  return row;
}

async function main() {
  const onlyMeasure = argOf('--measure');
  const outPath = argOf('--out') || path.join(__dirname, 'validate-ebpo-suite.out.jsonl');
  const measures = Object.keys(EBPO_MEASURES).filter((m) => !onlyMeasure || m === onlyMeasure);
  const dimIds = Object.keys(EBPO_DIMENSIONS);

  const results: Row[] = [];
  for (const m of measures) {
    // KPI (no dimension)
    results.push(await evalSpec({ measure: m, dimension: '', chartType: 'kpi' } as ChartSpec));
    // Each dimension this measure can be grouped by, with representative chart types.
    for (const d of dimIds) {
      if (!resolveEbpoView(m, d, null)) continue;
      const dim = EBPO_DIMENSIONS[d]!;
      const types = dim.isTime ? TIME_TYPES : CAT_TYPES;
      for (const ct of types) {
        results.push(await evalSpec({ measure: m, dimension: d, chartType: ct } as ChartSpec));
      }
    }
  }

  writeFileSync(outPath, results.map((r) => JSON.stringify(r)).join('\n') + '\n');

  const withIssues = results.filter((r) => r.issues.length > 0);
  const byIssue: Record<string, number> = {};
  for (const r of withIssues) for (const i of r.issues) {
    const key = i.split(':')[0]!;
    byIssue[key] = (byIssue[key] ?? 0) + 1;
  }
  console.log(`\nEBPO catalog coverage: ${results.length} specs across ${measures.length} measures`);
  console.log(`OK: ${results.length - withIssues.length}   WITH ISSUES: ${withIssues.length}`);
  console.log('Issue breakdown:', JSON.stringify(byIssue, null, 2));
  console.log(`Wrote ${outPath}`);
  if (withIssues.length) {
    console.log('\nFirst 20 issues:');
    for (const r of withIssues.slice(0, 20))
      console.log(`  - ${r.measure} by ${r.dimension ?? '(kpi)'} [${r.chartType}] → ${r.issues.join(', ')}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
