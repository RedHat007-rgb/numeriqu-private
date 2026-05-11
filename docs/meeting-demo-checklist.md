# Meeting Demo Checklist (Agent + Charts)

Use these prompts in the Astra Console to sanity-check entity scoping, client breakdowns, and “no canned charts”.

## Entity scoping (must not mix)

1. `give me revenue of Arvion Services Sdn Bhd`
   - Expect: single-entity output (no QuickBooks Sandbox labels).

2. `can you give revenue of each client in Arvion Services Sdn Bhd`
   - Expect: bar chart grouped by client (not “Unknown Client” only).

3. `which clients have the highest outstanding and overdue balances, and how does their total revenue compare in Arvion Services Sdn Bhd`
   - Expect: client-level rankings scoped to Arvion entity.

## Top-N over time (grouped bars)

4. `give me month wise revenue for top 2 clients for last 6 months as a bar chart for Arvion Services Sdn Bhd`
   - Expect: one bar chart, month on X, two client series.

## Cross-entity compare (ADMIN only)

5. `compare revenue across all my connected entities`
   - Expect: entity comparison chart(s) across Xero + QuickBooks.

6. `compare revenue performance across all my connected entities. Which is most profitable and why?`
   - Expect: proceeds without blocking; uses revenue + collections/AR as proxies (no “unsupported metric” clarification loop).

## If something looks wrong

- If client names are missing: run a sync/resync once so `contact_id/contact_name` populate (older ClickHouse schemas may have been missing these columns before the latest migration).
