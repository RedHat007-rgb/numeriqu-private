/**
 * apply-ch-row-policies.ts — generate (and optionally apply) ClickHouse
 * ROW-LEVEL SECURITY so tenant isolation is enforced by the DATABASE, not only
 * by the app-layer SQL validator (`dynamic-sql.ts`). See
 * docs/TARGET_ARCHITECTURE.md §5 and apps/api/src/modules/agent/SECURITY_SQL_HARDENING.md.
 *
 * ── The model ────────────────────────────────────────────────────────────────
 * Every analytics table/view carries `tenant_id` (the Postgres org UUID). We
 * attach a row policy that only exposes rows whose `tenant_id` matches a
 * per-connection SESSION SETTING the API sets on each request. This is
 * defense-in-depth: even a validator regression or a hand-written query can no
 * longer read another tenant's rows, because the engine itself filters them out.
 *
 * ── Two deployment options (pick one; this script supports the first) ─────────
 *  A. Session-setting policy (this script, default):
 *       CREATE ROW POLICY tenant_isolation ON <db>.<table>
 *         USING tenant_id = getSetting('SQL_numeriqu_tenant') TO app_user
 *     The API's ClickHouse client must then set that setting per request, e.g.
 *       client.query({ query, clickhouse_settings: { custom_settings } })
 *     or `SET SQL_numeriqu_tenant = '<org-uuid>'` at the start of the session.
 *     Requires `access_control_improvements.settings_allow_introspection` and a
 *     `custom_settings_prefixes = 'SQL_'` entry in the server config.
 *  B. Per-tenant ClickHouse users (heavier, not scripted here): one CH user per
 *     org with a fixed policy `USING tenant_id = '<uuid>'`. Strongest isolation,
 *     but you provision a user per tenant.
 *
 * ── Usage ─────────────────────────────────────────────────────────────────────
 *   # Print the DDL only (safe default — reviews before you run anything):
 *   cd packages/db && npx tsx scripts/apply-ch-row-policies.ts
 *   # Actually create the policies (needs a CH ADMIN account, not dbt_transformer):
 *   npx tsx scripts/apply-ch-row-policies.ts --apply --allow-remote \
 *     --admin-user default --admin-password ****  --app-user dbt_transformer
 *
 * Idempotent: uses CREATE ROW POLICY IF NOT EXISTS, so re-running is safe.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createClient as createClickHouseClient } from '@clickhouse/client';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../.env.local'), quiet: true });
dotenv.config({ path: path.resolve(__dirname, '../../.env.local'), quiet: true });
dotenv.config({ path: path.resolve(__dirname, '../../../apps/api/.env'), quiet: true });

/** The custom session setting the API must set per request to the org UUID. */
const TENANT_SETTING = 'SQL_numeriqu_tenant';
const POLICY_NAME = 'numeriqu_tenant_isolation';

function getArg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}
function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}
function isLocalHost(host: string) {
  const h = host.toLowerCase();
  return h === 'localhost' || h === '127.0.0.1';
}
function assertRemoteAllowed(url: string | undefined, allowRemote: boolean) {
  if (!url) throw new Error('ClickHouse URL is missing from env.');
  const parsed = new URL(url);
  if (!isLocalHost(parsed.hostname) && !allowRemote) {
    throw new Error(`Refusing to connect to non-local ClickHouse (${parsed.hostname}). Pass --allow-remote if intentional.`);
  }
}

/** Every table/view in the analytics DB that carries a `tenant_id` column. */
async function tenantScopedRelations(
  client: ReturnType<typeof createClickHouseClient>,
  db: string,
): Promise<string[]> {
  const result = await client.query({
    query: `
      SELECT DISTINCT table
      FROM system.columns
      WHERE database = {db:String} AND name = 'tenant_id'
      ORDER BY table`,
    query_params: { db },
    format: 'JSONEachRow',
  });
  const rows = (await result.json()) as Array<{ table: string }>;
  return rows.map((r) => r.table);
}

/**
 * Row policies apply to base TABLES, not views (a view runs with the querying
 * user's rights, so policies on the underlying tables flow through). We still
 * emit for everything with a tenant_id; CH ignores a policy on a view that has
 * no rows of its own. Restricting TO the app user (not ALL) leaves admin
 * unrestricted for seeding/migrations.
 */
function policyDdl(db: string, relation: string, appUser: string): string {
  return (
    `CREATE ROW POLICY IF NOT EXISTS ${POLICY_NAME} ON ${db}.${relation} ` +
    `FOR SELECT USING tenant_id = getSetting('${TENANT_SETTING}') TO ${appUser}`
  );
}

async function main() {
  const apply = hasFlag('--apply');
  const allowRemote = hasFlag('--allow-remote');
  const appUser = getArg('--app-user') || process.env.CLICKHOUSE_ANALYTICS_USER || 'dbt_transformer';
  const db = process.env.CLICKHOUSE_ANALYTICS_DB || 'analytics';
  const url = process.env.CLICKHOUSE_ANALYTICS_URL;
  assertRemoteAllowed(url, allowRemote);

  // For --apply you must pass an ADMIN account; the app user can't create policies.
  const adminUser = getArg('--admin-user') || process.env.CLICKHOUSE_ANALYTICS_USER || 'default';
  const adminPassword = getArg('--admin-password') ?? process.env.CLICKHOUSE_ANALYTICS_PASSWORD ?? '';
  const client = createClickHouseClient({ url, username: adminUser, password: adminPassword, database: db });

  const relations = await tenantScopedRelations(client, db);
  const statements = relations.map((rel) => policyDdl(db, rel, appUser));

  if (!apply) {
    console.log(`-- ${relations.length} tenant-scoped relations in ${db}. Review, then re-run with --apply.`);
    console.log(`-- NOTE: the API must set custom setting ${TENANT_SETTING} = <org uuid> per request.`);
    console.log(statements.map((s) => s + ';').join('\n'));
    return;
  }

  const applied: string[] = [];
  const failed: Array<{ relation: string; error: string }> = [];
  for (let i = 0; i < statements.length; i++) {
    try {
      const r = await client.query({ query: statements[i]! });
      await r.text();
      applied.push(relations[i]!);
    } catch (e) {
      failed.push({ relation: relations[i]!, error: (e as Error).message.split('\n')[0] });
    }
  }
  console.log(JSON.stringify({ ok: failed.length === 0, db, appUser, setting: TENANT_SETTING, applied, failed }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
