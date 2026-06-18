# Agent SQL — Security Hardening

The agent runs LLM-generated ClickHouse SQL. The only application-layer guardrail is
`dynamic-sql.ts → validateDynamicSql`. This note records the audit findings and the fixes.

## Fixed in code (verified, `dynamic-sql.spec.ts`)

1. **CRITICAL — comment-based tenant-scope bypass (was exploitable).**
   `WHERE 1=1 /* AND tenant_id = {tenantId:String} AND org_id IN ({externalOrgIds:Array(String)}) */`
   satisfied the text-based scope check, but ClickHouse ignores comments and ran the query
   **unfiltered across all tenants** (proven live: scoped count 276 == comment-bypass count 276).
   **Fix:** `validateDynamicSql` now rejects any SQL containing `--` or `/* */`.

2. **LOW (defense-in-depth) — external table/source functions.**
   `url()`, `remote()`, `s3()`, `file()`, etc. enable SSRF / cross-source exfiltration. Currently
   also blocked by ClickHouse grants (the `dbt_transformer` user lacks `URL`, etc.), but the
   validator no longer relies on grant config — it rejects these function calls outright.

3. **HIGH — unscoped subquery / JOIN (`enforceEveryTableScoped`).** The predicate check only
   confirms a scope predicate *exists*, not that *every* table is scoped — a subquery like
   `… x IN (SELECT y FROM analytics.t)` with no filter would leak other tenants. The validator now
   requires **one `org_id` scope predicate per db-qualified analytics table reference**. The agent
   generates single-table SQL in practice (0 multi-table queries in the real corpus), so legitimate
   queries are unaffected and a rare miss degrades gracefully to no-data. Tests cover the leak case
   and a correctly-scoped subquery.

## Still recommended — DATABASE-layer defense (operator action; NOT auto-applied)

The three checks above are **textual** and remain best-effort. The robust, shape-independent
boundary is **ClickHouse row-level security**, so even a malformed/bypassed query cannot cross
tenants regardless of how it's written.

Recommended (run against the analytics CH; adjust table list + the session-setting mechanism your
app uses to pass the caller's tenant_id):

```sql
-- 1) Pass the authenticated tenant as a per-query SETTING from the API (NOT from the SQL),
--    e.g. add `SETTINGS … , custom_tenant_id = '<tenantId>'` server-side at execution time,
--    or use a session/profile bound to the request. The value must come from the verified
--    membership context, never from the LLM/user text.

-- 2) Enforce it with a row policy on every multi-tenant analytics table:
CREATE ROW POLICY IF NOT EXISTS tenant_isolation ON analytics.sample_gl_dump
  FOR SELECT USING tenant_id = getSetting('custom_tenant_id')
  TO dbt_transformer;
-- repeat for v_ebpo_*, v_fact_* and every table/view exposed to the agent.

-- 3) Keep the agent's CH user least-privileged: SELECT only, no URL/REMOTE/S3/FILE/FILE grants,
--    no access to system.* beyond what's required.
```

With row policies in place, the application-layer regex becomes a convenience, not the security
boundary — which is where a multi-tenant boundary belongs.

## Already verified clean

- **Auth/IDOR:** `org-context.service.ts` checks membership on `userId + organizationId`; a forged
  `x-organization-id` header is rejected (`FORBIDDEN`).
- Mutations / multi-statement / `system.*` / `information_schema` are blocked; `LIMIT` required;
  `max_execution_time`/memory capped.
