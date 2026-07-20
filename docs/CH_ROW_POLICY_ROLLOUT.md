# ClickHouse Row-Level Security — Rollout Runbook (Phase B)

**Status:** API bridge built + unit-tested, **OFF by default**. Not yet enabled on any environment.
**Goal:** make tenant isolation DB-enforced, so a bypass of the app-layer SQL validator
(`agent/dynamic-sql.ts`) still cannot cross tenants. See `docs/TARGET_ARCHITECTURE.md` §5 and
`apps/api/src/modules/agent/SECURITY_SQL_HARDENING.md`.

## The mechanism

Row policies filter every `tenant_id`-bearing analytics relation with
`USING tenant_id = getSetting('SQL_numeriqu_tenant')`. The API sets that session setting to the
caller's **server-verified** org UUID (from `EngineScope`, never from user/LLM text) on each data
query. The policy + the setting together enforce isolation in the engine itself.

- Generator: `packages/db/scripts/apply-ch-row-policies.ts` (idempotent `CREATE ROW POLICY IF NOT EXISTS`).
- API bridge: `apps/api/src/modules/chart-engine/ch-tenant-setting.ts` (pure, gated by `CH_ROW_POLICY_ENABLED`).

## Why it is OFF by default (do NOT flip blind)

1. Applying policies **before** the API sends the setting ⇒ `getSetting()` returns empty ⇒
   `tenant_id = ''` matches no rows ⇒ **every query returns 0 rows → app-wide outage.**
2. Sending the setting **before** the CH server allows it ⇒ CH errors `Unknown setting SQL_numeriqu_tenant`.

So this is a **coordinated, ordered rollout**, not a code toggle.

## Rollout order (each step reversible)

1. **CH server config** — allow the custom prefix, on every CH node:
   ```xml
   <clickhouse><custom_settings_prefixes>SQL_</custom_settings_prefixes></clickhouse>
   ```
   Restart / reload. Verify: `SELECT getSetting('SQL_numeriqu_tenant')` returns `''` (not an error).
2. **Enable the API bridge** — set `CH_ROW_POLICY_ENABLED=1`. The API now sends the setting on
   tenant-scoped reads. **Harmless before policies exist** — it's just an unused session setting.
   Verify normal behaviour is unchanged (no policies yet ⇒ no filtering).
3. **Apply the policies** with a CH **admin** account (the app user cannot create policies):
   ```bash
   cd packages/db && npx tsx scripts/apply-ch-row-policies.ts        # print DDL, review
   npx tsx scripts/apply-ch-row-policies.ts --apply --allow-remote \
     --admin-user <admin> --admin-password <pw> --app-user dbt_transformer
   ```
   Verify: as the app user, a query with the setting returns only that org's rows; without the
   setting returns 0 rows.
4. **Rollback** (if needed): `DROP ROW POLICY numeriqu_tenant_isolation ON <db>.<table>` per relation,
   or set `CH_ROW_POLICY_ENABLED=0`. Both independently restore prior behaviour.

## Coverage status — READ THIS

The API bridge is wired into the **new chart-engine's own reads** (`chart-engine.service.ts`
`queryJson` on the headline, additive-total, and ratio-component queries). Row policies protect
**all** relations regardless of caller, but for the app to keep working with policies ON, **every
execution path that reads tenant data must send the setting.** Still TODO before step 3 in prod:

- [ ] `apps/api/src/financial-data/financial-data.service.ts` — merge `tenantQuerySettings(...)` into
      the spread `SAFE_QUERY_SETTINGS` (per-request, so pass tenant through).
- [ ] `apps/api/src/intelligence/financial-data.service.ts` — same.
- [ ] `apps/api/src/modules/agent/agent.service.ts` — the legacy `metricData`/dynamic-SQL executor
      and the stored-widget (`dynamicSql`) render path (the chart data the user actually sees is
      fetched here, not in chart-engine).
- [ ] Any dashboard/widget refresh path that runs a widget's persisted SQL.

Until every reader sends the setting, enabling policies would break the paths that don't. Treat the
checklist above as the gate for step 3.
