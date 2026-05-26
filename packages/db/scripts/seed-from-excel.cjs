/**
 * Seeds fact_accounting_journal_lines from the real Excel GL dump.
 * Data is taken EXACTLY as-is from the Excel file — no date shifts, no synthetic values.
 *
 * Source: /Users/basanireddy/Downloads/Sample Data - 1Y.xlsx
 *   Sheet: gl_dump_2024  → fact_accounting_journal_lines
 */
const { createClient } = require('@clickhouse/client');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
dotenv.config({ path: '/Users/basanireddy/Desktop/test-1234/.env' });
dotenv.config({ path: '/Users/basanireddy/Desktop/test-1234/apps/api/.env' });

const DEFAULT_EXCEL_PATH = "/Users/basanireddy/Downloads/Sample Data - 1Y.xlsx";
const EXCEL_PATH = process.env.EXCEL_PATH || DEFAULT_EXCEL_PATH;
const JSON_TMP   = '/tmp/gl_excel_data.json';

const ORG_ID    = 'sample_gl_2024';
const CONN_ID   = 'd8f7ab35-f218-4b14-8188-bf744c42cb6e';
const TENANT_ID = '3c964ac3-7868-48ca-a197-53cf9629175d';

// ── Step 1: extract Excel data to JSON via Python ─────────────────────────────
console.log('Reading Excel file...');
const pyScript = `
import json, pandas as pd
from datetime import datetime

path = "${EXCEL_PATH}"
gl   = pd.read_excel(path, sheet_name='gl_dump_2024')

def fmt_dt(v):
    if pd.isna(v): return None
    if isinstance(v, (datetime,)): return v.strftime('%Y-%m-%d %H:%M:%S')
    return str(v)

# GL rows
gl_rows = []
for _, r in gl.iterrows():
    gl_rows.append({
        'date':        fmt_dt(r['Date']),
        'txn_id':      str(r['Transaction ID']).strip(),
        'journal_type':str(r['Journal Type']).strip() if pd.notna(r['Journal Type']) else '',
        'account_code':str(int(r['Account Number'])) if pd.notna(r['Account Number']) else '',
        'account_name':str(r['Account Name']).strip() if pd.notna(r['Account Name']) else '',
        'vendor':      str(r['Vendor/Customer']).strip() if pd.notna(r['Vendor/Customer']) else '',
        'description': str(r['Description']).strip() if pd.notna(r['Description']) else '',
        'debit':       float(r['Debit'])  if pd.notna(r['Debit'])  else 0.0,
        'credit':      float(r['Credit']) if pd.notna(r['Credit']) else 0.0,
        'department':  str(r['Department']).strip() if pd.notna(r['Department']) else '',
        'class_name':  str(r['Class']).strip() if pd.notna(r['Class']) else '',
    })

print(json.dumps({'gl': gl_rows}))
`;

const pyOut = execSync(`/opt/homebrew/bin/python3.12 -c '${pyScript.replace(/'/g, '"')}'`,
  { maxBuffer: 10 * 1024 * 1024 }).toString();
const { gl: glRows } = JSON.parse(pyOut);
console.log(`  GL dump: ${glRows.length} rows`);

// ── Step 2: build journal line records ────────────────────────────────────────
function makeLineId(txnId, accountCode, date) {
  return `sample_gl_2024__${txnId}_${accountCode}_${(date||'').slice(0,10).replace(/-/g,'')}`;
}

const now = new Date().toISOString().replace('T',' ').replace(/\..+/,'');
const lines = [];

// From actual GL dump
for (const r of glRows) {
  const isDebit  = r.debit  > 0;
  const isCredit = r.credit > 0;
  const amount   = isDebit ? r.debit : -r.credit;
  const lineId   = makeLineId(r.txn_id, r.account_code, r.date);
  const journalId = `sample_gl_2024__${r.txn_id}_${r.account_code}`;

  // infer source_type
  const code = parseInt(r.account_code) || 0;
  let srcType = 'GL';
  if (code >= 4000 && code < 5000) srcType = 'REV';
  else if (code >= 5000 && code < 6000) srcType = 'COGS';
  else if (code >= 6000 && code < 7000) srcType = 'OPEX';

  lines.push({
    connection_id:  CONN_ID,
    tenant_id:      TENANT_ID,
    org_id:         ORG_ID,
    provider:       'gl_import',
    journal_id:     journalId,
    line_id:        lineId,
    journal_number: '',
    journal_date:   r.date || '2024-01-01 00:00:00',
    account_id:     r.account_code,
    account_code:   r.account_code,
    account_name:   r.account_name,
    line_amount:    amount,
    description:    r.description,
    source_type:    srcType,
    department:     r.department,
    class_name:     r.class_name,
    vendor_name:    r.vendor,
    vendor_id:      r.vendor ? `VND-${r.account_code}` : '',
    debit_amount:   r.debit,
    credit_amount:  r.credit,
    updated_at:     now,
    synced_at:      now,
    user_id:        '',
    org_name:       'Sample Company 2024',
  });
}

console.log(`Total journal lines to insert: ${lines.length}`);

// ── Step 3: wipe + insert ─────────────────────────────────────────────────────
async function main() {
  const ch = createClient({
    url:      process.env.CLICKHOUSE_ANALYTICS_URL || process.env.CLICKHOUSE_URL || 'http://35.168.16.162:8123',
    username: process.env.CLICKHOUSE_ANALYTICS_USER || process.env.CLICKHOUSE_USER || 'dbt_transformer',
    password: process.env.CLICKHOUSE_ANALYTICS_PASSWORD || process.env.CLICKHOUSE_PASSWORD || 'test@123',
  });

  console.log('\nWiping existing data for sample_gl_2024...');
  await ch.command({ query: `ALTER TABLE analytics.fact_accounting_journal_lines DELETE WHERE org_id = '${ORG_ID}'` });
  // IMPORTANT: remove any previously-seeded synthetic invoices/clients for this org.
  await ch.command({ query: `ALTER TABLE analytics.fact_accounting_invoices DELETE WHERE org_id = '${ORG_ID}'` });
  // IMPORTANT: remove any previously-seeded client dimension rows for this org (drives client suggestions).
  await ch.command({ query: `ALTER TABLE analytics.dim_clients DELETE WHERE org_id = '${ORG_ID}'` });
  await new Promise(r => setTimeout(r, 3000));

  console.log('Inserting journal lines...');
  await ch.insert({ table: 'analytics.fact_accounting_journal_lines', values: lines, format: 'JSONEachRow' });

  console.log('\nDone! Verifying...');

  const r1 = await ch.query({
    query: `SELECT department, count(*) as rows, round(sumIf(line_amount, line_amount>0),0) as spend
            FROM analytics.fact_accounting_journal_lines WHERE org_id='${ORG_ID}'
            GROUP BY department ORDER BY spend DESC`,
    format: 'JSONEachRow',
  });
  console.log('\nJournal lines by department:');
  (await r1.json()).forEach(r => console.log(`  [${r.department||'—'}] ${r.rows} rows, spend=$${Number(r.spend).toLocaleString()}`));

  const r2 = await ch.query({
    query: `SELECT count(*) as cnt FROM analytics.fact_accounting_invoices WHERE org_id='${ORG_ID}'`,
    format: 'JSONEachRow',
  });
  const invCount = (await r2.json())[0]?.cnt ?? 0;
  console.log(`\nInvoices (should be 0 for Excel-only seed): ${invCount}`);

  const r3 = await ch.query({
    query: `SELECT count(*) as cnt FROM analytics.dim_clients WHERE org_id='${ORG_ID}'`,
    format: 'JSONEachRow',
  });
  const dimClientCount = (await r3.json())[0]?.cnt ?? 0;
  console.log(`Dim clients (should be 0 for Excel-only seed): ${dimClientCount}`);

  await ch.close();
}

main().catch(e => { console.error(e.message); process.exit(1); });
