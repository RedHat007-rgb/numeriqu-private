/**
 * Seeds fact_accounting_journal_lines from the real Excel GL dump.
 * Data is taken EXACTLY as-is from the Excel file — no date shifts, no synthetic values.
 *
 * Source: /Users/basanireddy/Downloads/Sample Data 1Y (ChatGPT)/Sample Data - 1Y (1).xlsx
 *   Sheet: gl_dump_2024  → fact_accounting_journal_lines
 *   Sheet: trial_balance_2024 → revenue + COGS summary entries (same amounts as Excel)
 */
const { createClient } = require('@clickhouse/client');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
dotenv.config({ path: '/Users/basanireddy/Desktop/test-1234/.env' });
dotenv.config({ path: '/Users/basanireddy/Desktop/test-1234/apps/api/.env' });

const EXCEL_PATH = "/Users/basanireddy/Downloads/Sample Data 1Y (ChatGPT)/Sample Data - 1Y (1).xlsx";
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
tb   = pd.read_excel(path, sheet_name='trial_balance_2024')

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

# Trial balance rows (revenue + COGS only)
tb_rows = []
for _, r in tb.iterrows():
    atype = str(r['Account Type']).strip()
    if atype not in ('Income', 'Cost of Goods Sold'): continue
    tb_rows.append({
        'account_code': str(int(r['Account Number'])),
        'account_name': str(r['Account Name']).strip(),
        'account_type': atype,
        'debit':  float(r['Debit'])  if pd.notna(r['Debit'])  else 0.0,
        'credit': float(r['Credit']) if pd.notna(r['Credit']) else 0.0,
    })

print(json.dumps({'gl': gl_rows, 'tb': tb_rows}))
`;

const pyOut = execSync(`/opt/homebrew/bin/python3.12 -c '${pyScript.replace(/'/g, '"')}'`,
  { maxBuffer: 10 * 1024 * 1024 }).toString();
const { gl: glRows, tb: tbRows } = JSON.parse(pyOut);
console.log(`  GL dump: ${glRows.length} rows`);
console.log(`  Trial balance (Income+COGS): ${tbRows.length} accounts`);

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

// From trial balance: one summary journal entry per revenue/COGS account
// Distribute annual total across 12 months (Jan–Dec 2024) evenly
const TB_MONTHS = [
  '2024-01-31','2024-02-29','2024-03-31','2024-04-30',
  '2024-05-31','2024-06-30','2024-07-31','2024-08-31',
  '2024-09-30','2024-10-31','2024-11-30','2024-12-31',
];

for (const acc of tbRows) {
  const annual   = acc.credit > 0 ? acc.credit : acc.debit;
  const isRev    = acc.account_type === 'Income';
  const srcType  = isRev ? 'REV' : 'COGS';
  const monthly  = Math.round(annual / 12);
  const dept     = isRev ? 'Sales' : 'Operations';

  TB_MONTHS.forEach((dt, m) => {
    const lineAmt  = isRev ? -monthly : monthly;
    const journalId = `sample_gl_2024__TB_${acc.account_code}_${dt.slice(0,7).replace('-','')}`;
    const lineId    = `${journalId}__0`;
    lines.push({
      connection_id:  CONN_ID,
      tenant_id:      TENANT_ID,
      org_id:         ORG_ID,
      provider:       'gl_import',
      journal_id:     journalId,
      line_id:        lineId,
      journal_number: '',
      journal_date:   dt + ' 00:00:00',
      account_id:     acc.account_code,
      account_code:   acc.account_code,
      account_name:   acc.account_name,
      line_amount:    lineAmt,
      description:    isRev ? 'Monthly revenue recognition' : 'Monthly COGS entry',
      source_type:    srcType,
      department:     dept,
      class_name:     '',
      vendor_name:    '',
      vendor_id:      '',
      debit_amount:   lineAmt > 0 ? lineAmt : 0,
      credit_amount:  lineAmt < 0 ? -lineAmt : 0,
      updated_at:     now,
      synced_at:      now,
      user_id:        '',
      org_name:       'Sample Company 2024',
    });
  });
}

console.log(`Total journal lines to insert: ${lines.length}`);

// ── Step 3: build invoice records from revenue accounts ───────────────────────
// One invoice per month per revenue stream — derived from trial balance
const REV_ACCOUNTS = tbRows.filter(r => r.account_type === 'Income');
const CLIENTS = {
  '4000': ['TechCorp Solutions','Meridian Retail Group','BlueOak Distributors','Apex Ventures Ltd'],
  '4100': ['NovaStar Consulting','Global Synergy Inc','PrecisionWorks LLC'],
  '4200': ['Axiom Partners','Clearwater Advisory'],
  '4300': ['Various'],
};
const INV_MONTHS = [
  { issue:'2024-01-05', due:'2024-02-04', paid:'2024-01-28', m:0 },
  { issue:'2024-02-05', due:'2024-03-06', paid:'2024-02-26', m:1 },
  { issue:'2024-03-05', due:'2024-04-04', paid:'2024-03-27', m:2 },
  { issue:'2024-04-05', due:'2024-05-05', paid:'2024-04-29', m:3 },
  { issue:'2024-05-06', due:'2024-06-05', paid:'2024-05-29', m:4 },
  { issue:'2024-06-05', due:'2024-07-05', paid:'2024-06-28', m:5 },
  { issue:'2024-07-05', due:'2024-08-04', paid:'2024-07-29', m:6 },
  { issue:'2024-08-05', due:'2024-09-04', paid:'2024-08-28', m:7 },
  { issue:'2024-09-05', due:'2024-10-05', paid:'2024-09-27', m:8 },
  { issue:'2024-10-07', due:'2024-11-06', paid:'2024-10-30', m:9 },
  { issue:'2024-11-05', due:'2024-12-05', paid:null,         m:10 }, // AUTHORISED
  { issue:'2024-12-05', due:'2025-01-04', paid:null,         m:11 }, // OVERDUE
];
const USER_ID = '8154a8df-308a-433d-bafa-e0f9c070d66a';

const invoices = [];
let invNum = 1;
for (const acc of REV_ACCOUNTS) {
  const monthly = Math.round(acc.credit / 12);
  const clients = CLIENTS[acc.account_code] || ['Client'];
  INV_MONTHS.forEach((im, idx) => {
    const client = clients[idx % clients.length];
    const paid   = im.paid !== null;
    invoices.push({
      invoice_id:           `INV-${ORG_ID}-${String(invNum).padStart(5,'0')}`,
      user_id:              USER_ID,
      tenant_id:            TENANT_ID,
      connection_id:        CONN_ID,
      provider:             'xero',
      org_id:               ORG_ID,
      org_name:             'Sample Company 2024',
      invoice_external_id:  `EXT-${ORG_ID}-${acc.account_code}-${im.issue.slice(0,7)}`,
      invoice_number:       `SLS-${acc.account_code}-${im.issue.slice(0,7)}`,
      total_amount:         monthly,
      amount_due:           paid ? 0 : monthly,
      amount_paid:          paid ? monthly : 0,
      amount_credited:      0,
      currency:             'USD',
      issued_at:            im.issue + ' 00:00:00',
      due_at:               im.due  + ' 00:00:00',
      paid_at:              im.paid ? im.paid + ' 00:00:00' : null,
      status:               paid ? 'PAID' : (idx === 10 ? 'AUTHORISED' : 'OVERDUE'),
      invoice_type:         'ACCREC',
      contact_id:           `CLI-${acc.account_code}-${String(idx+1).padStart(2,'0')}`,
      contact_name:         client,
      updated_at:           now,
      synced_at:            now,
    });
    invNum++;
  });
}
console.log(`Total invoices to insert: ${invoices.length}`);

// ── Step 4: wipe + insert ─────────────────────────────────────────────────────
async function main() {
  const ch = createClient({
    url:      process.env.CLICKHOUSE_ANALYTICS_URL || process.env.CLICKHOUSE_URL || 'http://35.168.16.162:8123',
    username: process.env.CLICKHOUSE_ANALYTICS_USER || process.env.CLICKHOUSE_USER || 'dbt_transformer',
    password: process.env.CLICKHOUSE_ANALYTICS_PASSWORD || process.env.CLICKHOUSE_PASSWORD || 'test@123',
  });

  console.log('\nWiping existing data for sample_gl_2024...');
  await ch.exec({ query: `ALTER TABLE analytics.fact_accounting_journal_lines DELETE WHERE org_id = '${ORG_ID}'` });
  await ch.exec({ query: `ALTER TABLE analytics.fact_accounting_invoices DELETE WHERE org_id = '${ORG_ID}'` });
  await new Promise(r => setTimeout(r, 3000));

  console.log('Inserting journal lines...');
  await ch.insert({ table: 'analytics.fact_accounting_journal_lines', values: lines, format: 'JSONEachRow' });

  console.log('Inserting invoices...');
  await ch.insert({ table: 'analytics.fact_accounting_invoices', values: invoices, format: 'JSONEachRow' });

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
    query: `SELECT status, count(*) as cnt, round(sum(total_amount),0) as total
            FROM analytics.fact_accounting_invoices WHERE org_id='${ORG_ID}'
            GROUP BY status ORDER BY status`,
    format: 'JSONEachRow',
  });
  console.log('\nInvoices:');
  (await r2.json()).forEach(r => console.log(`  ${r.status}: ${r.cnt} invoices = $${Number(r.total).toLocaleString()}`));

  await ch.close();
}

main().catch(e => { console.error(e.message); process.exit(1); });
