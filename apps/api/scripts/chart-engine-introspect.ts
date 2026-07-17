/**
 * Live introspection harness for the autonomous chart engine.
 *
 * Connects straight to ClickHouse (like powerbi-parity.ts), runs the REAL engine
 * code from src/ (schema-introspector → data-profiler → semantic-model-builder),
 * and prints the auto-derived SemanticModel + the columns it deliberately skipped.
 * No hardcoded catalog, no DAX. Proves the derivation against live data.
 *
 * Run:  cd apps/api && npx tsx scripts/chart-engine-introspect.ts [view-or-pattern]
 */
import path from 'node:path';
import dotenv from 'dotenv';
import { createClient } from '@clickhouse/client';
import {
  buildColumnStatsQuery,
  buildColumnsQuery,
  buildTableRowsQuery,
  parseSchema,
  type ColumnRow,
  type TableRow,
} from '../src/modules/chart-engine/schema-introspector';
import { profileTable, type ColumnStats } from '../src/modules/chart-engine/data-profiler';
import { buildSemanticModel } from '../src/modules/chart-engine/semantic-model-builder';
import type { ColumnProfile } from '../src/modules/chart-engine/semantic-model.types';

dotenv.config({ path: path.resolve(__dirname, '../.env'), quiet: true });

const DB = process.env.CLICKHOUSE_ANALYTICS_DB || 'analytics';
const pattern = process.argv[2] || 'v_ebpo_cfo_ratios_monthly';
const NUMERIC = /\b(Int|UInt|Float|Decimal)/i;

const ch = createClient({
  url: process.env.CLICKHOUSE_ANALYTICS_URL,
  username: process.env.CLICKHOUSE_ANALYTICS_USER,
  password: process.env.CLICKHOUSE_ANALYTICS_PASSWORD,
  database: DB,
});
const q = <T>(query: string, query_params: Record<string, unknown>) =>
  ch.query({ query, query_params, format: 'JSONEachRow' }).then((r) => r.json() as Promise<T[]>);

(async () => {
  const columnRows = await q<ColumnRow>(buildColumnsQuery(), { db: DB, pattern });
  // Row-count estimate is best-effort: restricted analytics users may lack
  // SELECT on system.parts. Absence just means rowCountEstimate = 0.
  const tableRows = await q<TableRow>(buildTableRowsQuery(), { db: DB }).catch((e) => {
    console.warn(`  (row-count estimate unavailable: ${(e as Error).message.split('\n')[0].slice(0, 60)})`);
    return [] as TableRow[];
  });
  const schema = parseSchema('ebpo', columnRows, tableRows, new Date().toISOString());
  console.log(`Introspected ${schema.tables.length} table(s) matching "${pattern}"\n`);

  const profilesByTable: Record<string, ColumnProfile[]> = {};
  for (const t of schema.tables) {
    const stats: ColumnStats[] = [];
    for (const c of t.columns) {
      const numeric = NUMERIC.test(c.type);
      try {
        const [row] = await q<any>(buildColumnStatsQuery(DB, t.name, c.name, numeric), {});
        stats.push({
          table: t.name, column: c.name, type: c.type,
          distinctCount: Number(row?.distinct_count) || 0,
          nullFraction: Number(row?.null_fraction) || 0,
          min: row?.min_v != null ? Number(row.min_v) : undefined,
          max: row?.max_v != null ? Number(row.max_v) : undefined,
          sampleValues: (row?.samples ?? []).slice(0, 5),
          rowCount: Number(row?.row_count) || 0,
        });
      } catch (e) {
        console.warn(`  ! stats failed ${t.name}.${c.name}: ${(e as Error).message.split('\n')[0]}`);
      }
    }
    profilesByTable[t.name] = profileTable(stats);
  }

  const { model, skipped } = buildSemanticModel({ schema, profilesByTable });

  console.log(`=== DERIVED SEMANTIC MODEL (${model.datasetId}) ===`);
  console.log(`fact grain: ${model.factGrain}`);
  console.log(`time: ${model.time ? `${model.time.column} @ ${model.time.grains.join('/')}` : '(none)'}`);
  console.log(`\nMEASURES (${model.measures.length}):`);
  for (const m of model.measures) {
    const e: any = m.expr;
    const detail =
      e.kind === 'ratio_of_sums' ? `SUM(${e.numerator})/SUM(${e.denominator})`
      : e.kind === 'last_value' ? `argMax(${e.column}, ${e.orderBy})`
      : `${e.kind}(${e.column})`;
    console.log(`  • ${m.key.padEnd(32)} ${m.expr.kind.padEnd(14)} ${detail}`);
  }
  console.log(`\nDIMENSIONS (${model.dimensions.length}): ${model.dimensions.map((d) => d.key).join(', ')}`);
  console.log(`ENTITIES: ${model.entities.map((e) => e.nameColumn).join(', ') || '(none)'}`);
  console.log(`\nSKIPPED (${skipped.length}):`);
  for (const s of skipped) console.log(`  – ${s.column.padEnd(32)} ${s.reason}`);

  // Cross-check the DAX ratios we care about.
  const expect: Record<string, string> = {
    gross_margin_pct: 'gross_margin_usd/total_revenue_usd',
    payroll_to_revenue_pct: 'total_payroll_usd/total_revenue_usd',
    cost_to_income_pct: 'total_cost_usd/total_revenue_usd',
  };
  console.log(`\n=== DAX RATIO CHECK ===`);
  for (const [key, want] of Object.entries(expect)) {
    const m = model.measures.find((x) => x.key === key);
    const e: any = m?.expr;
    const got = e?.kind === 'ratio_of_sums' ? `${e.numerator}/${e.denominator}` : `(skipped/${e?.kind ?? 'missing'})`;
    console.log(`  ${got === want ? 'OK ' : 'XX '} ${key}: got ${got}  want ${want}`);
  }
  await ch.close();

  // Optional: persist the derived model into the dataset registry tables (mirrors
  // ChartEngineService.persistModel). Guarded so the read-only proof stays default.
  //   PERSIST=1 ORG_ID=<uuid> KIND=ebpo npx tsx scripts/chart-engine-introspect.ts <view>
  if (process.env.PERSIST === '1') {
    const orgId = process.env.ORG_ID;
    const kind = process.env.KIND || 'ebpo';
    if (!orgId) { console.error('\nPERSIST=1 requires ORG_ID'); process.exit(1); }
    const { PrismaClient } = await import('../../../packages/db/generated/prisma/client');
    const { PrismaPg } = await import('@prisma/adapter-pg');
    const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL!, ssl: { rejectUnauthorized: false } });
    const prisma = new PrismaClient({ adapter } as any);
    const dataset = await prisma.dataset.upsert({
      where: { organizationId_kind: { organizationId: orgId, kind } },
      create: { organizationId: orgId, kind, physicalSchema: schema as any, introspectedAt: new Date() },
      update: { physicalSchema: schema as any, introspectedAt: new Date() },
    });
    const latest = await prisma.datasetSemanticModel.findFirst({ where: { datasetId: dataset.id }, orderBy: { version: 'desc' } });
    const nextVersion = (latest?.version ?? 0) + 1;
    await prisma.datasetSemanticModel.updateMany({ where: { datasetId: dataset.id, isActive: true }, data: { isActive: false } });
    const saved = await prisma.datasetSemanticModel.create({
      data: { datasetId: dataset.id, version: nextVersion, model: { ...model, version: nextVersion } as any, isActive: true, builtBy: 'auto' },
    });
    console.log(`\n=== PERSISTED ===\n  dataset ${dataset.id} (org=${orgId}, kind=${kind})\n  semantic model v${saved.version} active, ${model.measures.length} measures`);
    await prisma.$disconnect();
  }
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
