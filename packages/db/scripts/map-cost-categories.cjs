/* eslint-disable no-console */
const path = require("node:path");
const dotenv = require("dotenv");
const { createClient: createClickHouseClient } = require("@clickhouse/client");

// Load local overrides first, then app defaults (same pattern as other scripts).
dotenv.config({ path: path.resolve(__dirname, "../.env.local"), quiet: true });
dotenv.config({ path: path.resolve(__dirname, "../../.env.local"), quiet: true });
dotenv.config({ path: path.resolve(__dirname, "../../../apps/api/.env"), quiet: true });

function getArg(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function toInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.floor(n) : fallback;
}

function isLocalHost(host) {
  const h = host.toLowerCase();
  return h === "localhost" || h === "127.0.0.1";
}

function assertRemoteAllowed(url, allowRemote, label) {
  if (!url) throw new Error(`${label} URL is missing from env.`);
  const parsed = new URL(url);
  if (!isLocalHost(parsed.hostname) && !allowRemote) {
    throw new Error(
      `Refusing to connect to non-local ${label} host (${parsed.hostname}). Re-run with --allow-remote if this is intentional.`,
    );
  }
}

function normalize(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return normalize(value).toLowerCase();
}

function suggestFromAccountName(accountNameRaw) {
  const accountName = lower(accountNameRaw);
  if (!accountName) return null;

  const has = (s) => accountName.includes(s);
  const any = (arr) => arr.some((s) => has(s));

  // Keep these rules conservative. Anything not confidently matched stays unmapped.
  // Admin cost flags are set only when it's clearly "overheads".
  const rules = [
    {
      match: () => any(["rent", "lease"]),
      out: { pnl_group: "OPEX", opex_category: "Admin", cost_nature: "Rent", is_admin_cost: 1, notes: "auto:rent/lease" },
    },
    {
      match: () => any(["electric", "electricity", "water", "utilities", "utility", "power", "gas"]),
      out: { pnl_group: "OPEX", opex_category: "Admin", cost_nature: "Utilities", is_admin_cost: 1, notes: "auto:utilities" },
    },
    {
      match: () => any(["internet", "phone", "mobile", "telecom", "telephone"]),
      out: { pnl_group: "OPEX", opex_category: "Admin", cost_nature: "Telecom", is_admin_cost: 1, notes: "auto:telecom" },
    },
    {
      match: () => any(["insurance"]),
      out: { pnl_group: "OPEX", opex_category: "Admin", cost_nature: "Insurance", is_admin_cost: 1, notes: "auto:insurance" },
    },
    {
      match: () => any(["bank fee", "bank fees", "merchant fee", "merchant fees", "payment fee", "processing fee", "stripe", "razorpay"]),
      out: { pnl_group: "OPEX", opex_category: "Admin", cost_nature: "Bank Fees", is_admin_cost: 1, notes: "auto:fees" },
    },
    {
      match: () => any(["legal", "audit", "accounting", "bookkeeping", "professional fee", "professional fees", "consulting"]),
      out: { pnl_group: "OPEX", opex_category: "Admin", cost_nature: "Professional Fees", is_admin_cost: 1, notes: "auto:professional-fees" },
    },
    {
      match: () => any(["office supplies", "stationery", "stationary", "printing", "postage", "courier"]),
      out: { pnl_group: "OPEX", opex_category: "Admin", cost_nature: "Office", is_admin_cost: 1, notes: "auto:office" },
    },
    {
      match: () => any(["salary", "salaries", "wage", "wages", "payroll", "bonus", "superannuation", "pf", "epf", "esi"]),
      out: { pnl_group: "OPEX", opex_category: "Admin", cost_nature: "Payroll", is_admin_cost: 1, notes: "auto:payroll" },
    },
    {
      match: () => any(["travel", "flight", "hotel", "uber", "taxi", "cab", "meals", "entertainment"]),
      out: { pnl_group: "OPEX", opex_category: "Admin", cost_nature: "Travel", is_admin_cost: 1, notes: "auto:travel" },
    },
    {
      match: () => any(["advert", "ads", "marketing", "google ads", "facebook", "linkedin", "seo", "campaign"]),
      out: { pnl_group: "OPEX", opex_category: "Marketing", cost_nature: "Advertising", is_admin_cost: 0, notes: "auto:marketing" },
    },
    {
      match: () => any(["software", "subscription", "licenses", "licence", "saas", "zoom", "slack", "notion", "atlassian", "github"]),
      out: { pnl_group: "OPEX", opex_category: "Admin", cost_nature: "Software", is_admin_cost: 1, notes: "auto:software" },
    },
    {
      match: () => any(["aws", "amazon web services", "azure", "gcp", "google cloud", "cloud", "hosting", "server"]),
      out: { pnl_group: "OPEX", opex_category: "Tech", cost_nature: "Cloud", is_admin_cost: 0, notes: "auto:cloud" },
    },
    {
      match: () => any(["cogs", "cost of goods", "cost of sales", "direct cost", "materials", "raw material", "subcontract", "production"]),
      out: { pnl_group: "COGS", opex_category: "", cost_nature: "COGS", is_admin_cost: 0, notes: "auto:cogs" },
    },
  ];

  for (const r of rules) {
    try {
      if (r.match()) return r.out;
    } catch {
      // ignore bad rule
    }
  }

  return null;
}

async function tableExists(ch, db, table) {
  const res = await ch.query({
    query: `
      SELECT count() AS cnt
      FROM system.tables
      WHERE database = {db:String} AND name = {table:String}
    `,
    query_params: { db, table },
    format: "JSONEachRow",
  });
  const rows = await res.json();
  return Number(rows[0]?.cnt ?? 0) > 0;
}

async function viewExists(ch, db, viewName) {
  return tableExists(ch, db, viewName);
}

async function fetchUnmappedAccounts(ch, db, limit) {
  // Prefer the helper view if present.
  if (await viewExists(ch, db, "v_unmapped_cost_category_accounts")) {
    const res = await ch.query({
      query: `
        SELECT tenant_id, org_id, provider, account_code, account_name, total_spend
        FROM ${db}.v_unmapped_cost_category_accounts
        ORDER BY total_spend DESC
        LIMIT {limit:UInt32}
      `,
      query_params: { limit },
      format: "JSONEachRow",
    });
    return res.json();
  }

  // Fallback: compute from fact table + mapping.
  const res = await ch.query({
    query: `
      SELECT
        j.tenant_id,
        j.org_id,
        j.provider,
        j.account_code,
        argMax(j.account_name, j.updated_at) AS account_name,
        round(sumIf(j.line_amount, j.line_amount > 0), 0) AS total_spend
      FROM ${db}.fact_accounting_journal_lines AS j
      LEFT JOIN ${db}.map_account_cost_categories AS m
        ON m.tenant_id = j.tenant_id
       AND m.org_id    = j.org_id
       AND m.provider  = j.provider
       AND m.account_code = j.account_code
      WHERE j.account_code != ''
        AND j.journal_date IS NOT NULL
        AND j.line_amount > 0
        AND (m.account_code = '' OR m.account_code IS NULL)
      GROUP BY j.tenant_id, j.org_id, j.provider, j.account_code
      ORDER BY total_spend DESC
      LIMIT {limit:UInt32}
    `,
    query_params: { limit },
    format: "JSONEachRow",
  });
  return res.json();
}

async function insertMappings(ch, db, rows, dryRun) {
  if (rows.length === 0) return { inserted: 0 };
  if (dryRun) {
    console.log(`[dry-run] Would insert ${rows.length} mappings into ${db}.map_account_cost_categories`);
    return { inserted: 0 };
  }

  // Use JSONEachRow insert for simplicity.
  const payload = rows.map((r) => ({
    tenant_id: r.tenant_id,
    org_id: r.org_id,
    provider: r.provider,
    account_code: r.account_code,
    pnl_group: r.pnl_group,
    opex_category: r.opex_category,
    cost_nature: r.cost_nature,
    is_admin_cost: r.is_admin_cost,
    notes: r.notes,
    updated_at: new Date().toISOString().replace("T", " ").slice(0, 19),
  }));

  await ch.insert({
    table: `${db}.map_account_cost_categories`,
    values: payload,
    format: "JSONEachRow",
  });

  return { inserted: rows.length };
}

async function main() {
  const allowRemote = hasFlag("--allow-remote");
  const dryRun = hasFlag("--dry-run") || !hasFlag("--write");
  const limit = Math.max(1, Math.min(5000, toInt(getArg("--limit"), 500)));

  const url =
    process.env.CLICKHOUSE_ANALYTICS_URL ||
    process.env.CLICKHOUSE_URL ||
    "";
  const username =
    process.env.CLICKHOUSE_ANALYTICS_USER ||
    process.env.CLICKHOUSE_USER ||
    "default";
  const password =
    process.env.CLICKHOUSE_ANALYTICS_PASSWORD ||
    process.env.CLICKHOUSE_PASSWORD ||
    "";
  const db = process.env.CLICKHOUSE_ANALYTICS_DB || "analytics";

  assertRemoteAllowed(url, allowRemote, "ClickHouse Analytics");

  const ch = createClickHouseClient({
    url,
    username,
    password,
    database: db,
    applicationName: "map-cost-categories",
  });

  // Ensure mapping table exists.
  const hasMapTable = await tableExists(ch, db, "map_account_cost_categories");
  if (!hasMapTable) {
    throw new Error(
      `Missing ${db}.map_account_cost_categories. Start the API once (bootstrap) or create the table via SyncService bootstrap.`,
    );
  }

  const unmapped = await fetchUnmappedAccounts(ch, db, limit);
  const candidates = [];
  let skipped = 0;

  for (const row of unmapped) {
    const tenant_id = normalize(row.tenant_id);
    const org_id = normalize(row.org_id);
    const provider = lower(row.provider) || "xero";
    const account_code = normalize(row.account_code);
    const account_name = normalize(row.account_name);

    const suggestion = suggestFromAccountName(account_name);
    if (!suggestion) {
      skipped += 1;
      continue;
    }

    candidates.push({
      tenant_id,
      org_id,
      provider,
      account_code,
      ...suggestion,
    });
  }

  // De-duplicate by key (tenant/org/provider/account_code)
  const key = (r) => `${r.tenant_id}||${r.org_id}||${r.provider}||${r.account_code}`;
  const unique = new Map();
  for (const r of candidates) unique.set(key(r), r);

  const rows = [...unique.values()];
  rows.sort((a, b) => key(a).localeCompare(key(b)));

  console.log(
    `${dryRun ? "[dry-run]" : "[write]"} Unmapped scanned: ${unmapped.length}, suggestions: ${rows.length}, skipped(no-match): ${skipped}`,
  );

  // Print a small preview
  for (const r of rows.slice(0, 20)) {
    console.log(
      `- ${r.provider}/${r.org_id} acct ${r.account_code}: ${r.opex_category || r.pnl_group} / ${r.cost_nature} (admin=${r.is_admin_cost})`,
    );
  }
  if (rows.length > 20) console.log(`... +${rows.length - 20} more`);

  const { inserted } = await insertMappings(ch, db, rows, dryRun);
  if (!dryRun) console.log(`Inserted: ${inserted}`);
  if (dryRun) console.log("Re-run with --write to insert these mappings.");
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});

