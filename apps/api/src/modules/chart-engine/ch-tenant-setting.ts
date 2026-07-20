/**
 * ClickHouse row-level-security bridge (API half of Phase B).
 *
 * The row policies created by `packages/db/scripts/apply-ch-row-policies.ts`
 * filter every analytics table with:
 *     USING tenant_id = getSetting('SQL_numeriqu_tenant')
 * so the DATABASE enforces tenant isolation even if the app-layer SQL validator
 * is bypassed. For that to work, the API must set `SQL_numeriqu_tenant` to the
 * caller's verified org UUID on every DATA query.
 *
 * This is deliberately OFF by default and gated by `CH_ROW_POLICY_ENABLED`,
 * because turning it on is a COORDINATED rollout, not a code change:
 *   1. Configure the CH server: `custom_settings_prefixes = 'SQL_'` (else CH
 *      errors "Unknown setting SQL_numeriqu_tenant").
 *   2. Set `CH_ROW_POLICY_ENABLED=1` so the API starts sending the setting
 *      (harmless before policies exist — it's just an unused session setting).
 *   3. Apply the policies with the generator's `--apply`.
 * Until step 2, this returns `{}` and the query path is byte-for-byte unchanged.
 *
 * See apps/api/src/modules/agent/SECURITY_SQL_HARDENING.md and
 * docs/TARGET_ARCHITECTURE.md §5.
 */

/** The custom session setting the row policies read. Must match the generator. */
export const TENANT_SETTING = 'SQL_numeriqu_tenant';

/** Truthy env values that enable the DB-enforced tenant setting. */
export function isRowPolicyEnabled(rawFlag: string | undefined): boolean {
  const v = (rawFlag ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/**
 * The `clickhouse_settings` to merge into a tenant-scoped DATA query. When the
 * flag is off (default) this is `{}` — a pure no-op. When on, it binds the
 * verified org UUID so the DB row policy can filter. Never derive `tenantId`
 * from user/LLM text — only from server-side verified membership (EngineScope).
 */
export function tenantQuerySettings(
  tenantId: string,
  enabled: boolean,
): Record<string, string> {
  if (!enabled) return {};
  if (!tenantId) return {}; // no verified tenant ⇒ don't fabricate a scope
  return { [TENANT_SETTING]: tenantId };
}
