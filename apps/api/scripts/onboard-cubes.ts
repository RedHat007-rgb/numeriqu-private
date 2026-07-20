/**
 * Generic cube onboarding — the zero-TypeScript path for a NEW dataset.
 *
 * Reads a blueprints JSON (DATA, derivable from the mapping workbook), discovers
 * pivot taxonomy live, materializes the standard cubes with the generic builder,
 * and registers the created view names on the org's `Dataset` registry so the
 * chart engine routes across them. Onboarding a new client shape becomes:
 *   1. load the raw star-schema tables,
 *   2. write/adjust a blueprints JSON (table + column names),
 *   3. run this script.
 * No code change, no redeploy. Idempotent (CREATE OR REPLACE + upsert).
 *
 * Usage:
 *   cd apps/api
 *   # Safe preview — build + verify each view is queryable, then DROP; NO registry write:
 *   npx tsx scripts/onboard-cubes.ts --blueprints scripts/blueprints/star-finance-cubes.json --dry --allow-remote
 *   # Real onboarding — materialize + register for an org:
 *   npx tsx scripts/onboard-cubes.ts --blueprints <file.json> --org <org-uuid> --kind <kind> --allow-remote
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { createClient } from '@clickhouse/client';
import * as dotenv from 'dotenv';

import { materializeCubes, type CubeMaterializerClient } from '../src/modules/chart-engine/cube-materializer';
import type { CubeBlueprint } from '../src/modules/chart-engine/cube-builder';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}
const has = (flag: string) => process.argv.includes(flag);

const DB = process.env.CLICKHOUSE_ANALYTICS_DB || 'analytics';
const CH_URL = process.env.CLICKHOUSE_ANALYTICS_URL || process.env.CLICKHOUSE_URL;
const USER = process.env.CLICKHOUSE_ANALYTICS_USER || 'default';
const PASSWORD = process.env.CLICKHOUSE_ANALYTICS_PASSWORD || '';

function assertRemote(allow: boolean) {
  if (!CH_URL) throw new Error('ClickHouse URL missing from env.');
  const host = new URL(CH_URL).hostname.toLowerCase();
  if (host !== 'localhost' && host !== '127.0.0.1' && !allow) {
    throw new Error(`Refusing non-local ClickHouse (${host}). Pass --allow-remote if intentional.`);
  }
}

async function main() {
  const bpPath = arg('--blueprints');
  if (!bpPath) throw new Error('--blueprints <file.json> is required');
  const dry = has('--dry');
  assertRemote(has('--allow-remote'));

  const parsed = JSON.parse(fs.readFileSync(path.resolve(bpPath), 'utf8')) as {
    database?: string;
    blueprints: CubeBlueprint[];
  };
  const database = parsed.database || DB;
  const blueprints = parsed.blueprints ?? [];
  if (!blueprints.length) throw new Error('no blueprints in file');

  const ch = createClient({ url: CH_URL, username: USER, password: PASSWORD, database });
  const client: CubeMaterializerClient = {
    distinct: async (table, column) => {
      const r = await ch.query({
        query: `SELECT DISTINCT ${column} AS v FROM ${database}.${table} WHERE ${column} != '' ORDER BY v`,
        format: 'JSONEachRow',
      });
      return ((await r.json()) as Array<{ v: string }>).map((x) => x.v).filter(Boolean);
    },
    tableExists: async (name) => {
      const r = await ch.query({
        query: `SELECT count() AS n FROM system.tables WHERE database = {db:String} AND name = {name:String}`,
        query_params: { db: database, name },
        format: 'JSONEachRow',
      });
      const [row] = (await r.json()) as Array<{ n: number }>;
      return Number(row?.n ?? 0) > 0;
    },
    exec: async (ddl) => {
      await ch.command({ query: ddl });
    },
  };

  const result = await materializeCubes(database, blueprints, client);
  console.log('\ncreated:', result.created);
  if (result.skipped.length) console.log('skipped:', JSON.stringify(result.skipped, null, 2));

  if (dry) {
    // Verify each created view is queryable, then remove it — no registry write.
    for (const view of result.created) {
      const r = await ch.query({ query: `SELECT count() AS n FROM ${database}.${view}`, format: 'JSONEachRow' });
      const [row] = (await r.json()) as Array<{ n: number }>;
      console.log(`   ✅ ${view} queryable (rows=${row?.n ?? 0})`);
      await ch.command({ query: `DROP VIEW IF EXISTS ${database}.${view}` });
    }
    console.log('\n[dry] verified + cleaned up. No registry changes made.');
    await ch.close();
    return;
  }

  const org = arg('--org');
  const kind = arg('--kind');
  if (!org || !kind) throw new Error('real onboarding requires --org <uuid> --kind <kind> (or use --dry)');

  // Register the created views on the Dataset registry via Prisma (this repo's
  // client requires the pg adapter — see scripts/chart-engine-introspect.ts).
  const { PrismaClient } = await import('../../../packages/db/generated/prisma/client');
  const { PrismaPg } = await import('@prisma/adapter-pg');
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL!, ssl: { rejectUnauthorized: false } });
  const prisma = new PrismaClient({ adapter } as unknown as ConstructorParameters<typeof PrismaClient>[0]);
  const existing = await prisma.dataset.findUnique({ where: { organizationId_kind: { organizationId: org, kind } } });
  const prevSchema = ((existing?.physicalSchema as Record<string, unknown> | null) ?? {}) as Record<string, unknown>;
  const prevViews = Array.isArray((prevSchema as { cubeViews?: unknown }).cubeViews)
    ? ((prevSchema as { cubeViews?: unknown }).cubeViews as string[])
    : [];
  const cubeViews = [...new Set([...prevViews, ...result.created])];
  await prisma.dataset.upsert({
    where: { organizationId_kind: { organizationId: org, kind } },
    create: { organizationId: org, kind, physicalSchema: { ...prevSchema, cubeViews }, introspectedAt: new Date() },
    update: { physicalSchema: { ...prevSchema, cubeViews }, introspectedAt: new Date() },
  });
  await prisma.$disconnect();
  console.log(`\n✅ registered ${cubeViews.length} cube views on Dataset(org=${org}, kind=${kind}).`);
  await ch.close();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
