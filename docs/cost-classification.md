# Cost Classification (Admin / Marketing / etc.)

This codebase stores raw journals in ClickHouse and exposes a Gold view that supports consistent “Admin expenses” style queries for Power BI and the Agent.

## What to use (ClickHouse)

- Journal lines (enriched): `analytics.v_fact_accounting_journal_lines_enriched_latest`
- Mapping table (editable): `analytics.map_account_cost_categories`
- Latest mapping view: `analytics.v_map_account_cost_categories_latest`
- Unmapped accounts helper: `analytics.v_unmapped_cost_category_accounts`

## How it works

1) Journal lines land in `analytics.fact_accounting_journal_lines`.
2) You maintain the mapping table `analytics.map_account_cost_categories` keyed by:
   `tenant_id, org_id, provider, account_code`
3) The enriched view joins journal lines to the latest mapping and adds:
   `pnl_group`, `opex_category`, `cost_nature`, `is_admin_cost`.

## Adding / updating categories

Insert a new row into `analytics.map_account_cost_categories` (ClickHouse-friendly upsert pattern).

Example:

```sql
INSERT INTO analytics.map_account_cost_categories
  (tenant_id, org_id, provider, account_code, pnl_group, opex_category, cost_nature, is_admin_cost, notes, updated_at)
VALUES
  ('TENANT_ID', 'ORG_ID', 'xero', '620', 'OPEX', 'Admin', 'Office', 1, 'Office supplies', now());
```

## Auto-mapping (bootstrap)

If you already have journal lines but no categories yet, you can generate a first-pass mapping from GL account names:

```bash
node /Users/basanireddy/Desktop/test-1234/packages/db/scripts/map-cost-categories.cjs --dry-run --allow-remote
node /Users/basanireddy/Desktop/test-1234/packages/db/scripts/map-cost-categories.cjs --write --allow-remote
```

Notes:
- By default it is `--dry-run` (it only prints suggestions). Use `--write` to insert.
- It refuses to connect to non-local ClickHouse unless `--allow-remote` is provided.
- The mapping is conservative: accounts it can’t classify confidently stay unmapped.

## Finding what still needs mapping

```sql
SELECT *
FROM analytics.v_unmapped_cost_category_accounts
WHERE org_id IN ('ORG_ID')
LIMIT 50;
```

## Query examples

Admin expenses by month:

```sql
SELECT
  toStartOfMonth(journal_date) AS month,
  sum(line_amount) AS admin_expense
FROM analytics.v_fact_accounting_journal_lines_enriched_latest
WHERE org_id IN ('ORG_ID')
  AND line_amount > 0
  AND (is_admin_cost = 1 OR lowerUTF8(opex_category) = 'admin')
GROUP BY month
ORDER BY month ASC
LIMIT 36;
```

Admin expense transactions (latest):

```sql
SELECT
  journal_date,
  account_code,
  account_name,
  line_amount,
  description,
  opex_category,
  cost_nature
FROM analytics.v_fact_accounting_journal_lines_enriched_latest
WHERE org_id IN ('ORG_ID')
  AND line_amount > 0
  AND (is_admin_cost = 1 OR lowerUTF8(opex_category) = 'admin')
ORDER BY journal_date DESC
LIMIT 200;
```
