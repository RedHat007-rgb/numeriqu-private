-- ============================================================
-- Numeriqu ClickHouse Schema v2.0
-- Run against your ClickHouse instance to apply.
-- ============================================================
-- KEY CHANGE: All raw tables now use ReplacingMergeTree(synced_at)
-- This deduplicates records on the same source_id from incremental syncs.
-- If tables already exist with MergeTree, drop and recreate (re-sync required).
-- ============================================================

-- ─── BRONZE: Xero Raw ────────────────────────────────────────────────────────

CREATE DATABASE IF NOT EXISTS xero_raw_db;

-- Drop old table if it was created with MergeTree (re-sync will refill it)
-- DROP TABLE IF EXISTS xero_raw_db.xero_raw;

CREATE TABLE IF NOT EXISTS xero_raw_db.xero_raw (
  tenant_id     String,
  user_id       String,
  connection_id String,
  provider      String DEFAULT 'xero',
  org_id        String,
  org_name      String DEFAULT '',
  resource      String,       -- 'Invoices' | 'Accounts' | 'Contacts' | 'Payments' | ...
  source_id     String,       -- provider primary key for this record
  raw_data      String,       -- JSON blob (camelCase keys from xero-node SDK)
  updated_at    DateTime,
  synced_at     DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(synced_at)
ORDER BY (tenant_id, org_id, resource, source_id)
PARTITION BY toYYYYMM(synced_at)
SETTINGS index_granularity = 8192;

-- ─── BRONZE: QuickBooks Raw ──────────────────────────────────────────────────

CREATE DATABASE IF NOT EXISTS quickbooks_db;

-- DROP TABLE IF EXISTS quickbooks_db.quickbooks_raw;

CREATE TABLE IF NOT EXISTS quickbooks_db.quickbooks_raw (
  tenant_id     String,
  user_id       String,
  connection_id String,
  provider      String DEFAULT 'quickbooks',
  org_id        String,       -- QB realm ID
  org_name      String DEFAULT '',
  resource      String,       -- 'Invoice' | 'Account' | 'Customer' | 'Bill' | ...
  source_id     String,
  raw_data      String,       -- JSON blob (PascalCase keys from QBO REST API)
  updated_at    DateTime,
  synced_at     DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(synced_at)
ORDER BY (tenant_id, org_id, resource, source_id)
PARTITION BY toYYYYMM(synced_at)
SETTINGS index_granularity = 8192;

-- ─── GOLD: Analytics Database ────────────────────────────────────────────────

CREATE DATABASE IF NOT EXISTS analytics;

-- FACT: Normalized invoices from all providers
CREATE TABLE IF NOT EXISTS analytics.fact_accounting_invoices (
  invoice_id           String,
  tenant_id            String,
  user_id              String,
  connection_id        String,
  provider             String,      -- 'xero' | 'quickbooks'
  org_id               String,
  org_name             String,
  invoice_external_id  String,
  invoice_number       String,
  total_amount         Float64,
  currency             String DEFAULT 'USD',
  issued_at            Nullable(DateTime),
  due_at               Nullable(DateTime),
  status               String,
  updated_at           DateTime,
  synced_at            DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(synced_at)
ORDER BY (tenant_id, org_id, provider, invoice_id)
PARTITION BY toYYYYMM(issued_at)
SETTINGS index_granularity = 8192;

-- DIMENSION: Chart of Accounts
CREATE TABLE IF NOT EXISTS analytics.dim_accounting_accounts (
  account_id      String,
  account_name    String,
  account_type    String,      -- 'REVENUE' | 'EXPENSE' | 'ASSET' | 'LIABILITY' | 'EQUITY'
  classification  String,
  provider        String,
  tenant_id       String,
  org_id          String,
  org_name        String,
  is_active       Bool DEFAULT true,
  synced_at       DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(synced_at)
ORDER BY (tenant_id, org_id, provider, account_id)
SETTINGS index_granularity = 8192;

-- MATERIALIZED: Monthly revenue rollup (fast reads for dashboards)
CREATE TABLE IF NOT EXISTS analytics.revenue_by_month (
  month          Date,
  total_amount   Float64,
  invoice_count  UInt64,
  currency       String,
  provider       String,
  tenant_id      String,
  org_id         String,
  org_name       String,
  updated_at     DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (tenant_id, org_id, provider, month)
SETTINGS index_granularity = 8192;

-- RAG CONTEXT: Text corpus per tenant + org for retrieval-augmented generation.
-- NOT ReplacingMergeTree — different versions preserved for richer context.
CREATE TABLE IF NOT EXISTS analytics.rag_context_documents (
  id             String,
  tenant_id      String,
  org_id         String,
  org_name       String,
  provider       String,
  source_id      String,
  resource       String,      -- entity type: 'Invoices' | 'Contacts' | etc.
  text_content   String,      -- human-readable text (built by transform service)
  synced_at      DateTime DEFAULT now()
)
ENGINE = MergeTree()
ORDER BY (tenant_id, org_id, resource, source_id)
PARTITION BY toYYYYMM(synced_at)
SETTINGS index_granularity = 8192;

-- ─── COMPATIBILITY: Keep old table names pointing at new ones ─────────────────
-- The existing code still references xero_custom.xero_raw in some places.
-- Create the old database and a view so nothing breaks during migration.

CREATE DATABASE IF NOT EXISTS xero_custom;

CREATE TABLE IF NOT EXISTS xero_custom.xero_raw AS xero_raw_db.xero_raw
ENGINE = ReplacingMergeTree(synced_at)
ORDER BY (tenant_id, org_id, resource, source_id)
PARTITION BY toYYYYMM(synced_at);
