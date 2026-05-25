/**
 * Seeds fact_accounting_invoices for org_id=sample_gl_2024
 * Derives amounts from the same revenue+COGS weights used in seed-revenue-entries.cjs
 * so that invoice totals match the GL journal entries (no inconsistency).
 */
const { createClient } = require('@clickhouse/client');
const dotenv = require('dotenv');
dotenv.config({ path: '/Users/basanireddy/Desktop/test-1234/.env' });
dotenv.config({ path: '/Users/basanireddy/Desktop/test-1234/apps/api/.env' });

const ORG_ID      = 'sample_gl_2024';
const ORG_NAME    = 'Sample Company 2024';
const EXT_ORG_ID  = 'sample_gl_2024';
const CONN_ID     = 'd8f7ab35-f218-4b14-8188-bf744c42cb6e';
const TENANT_ID   = '3c964ac3-7868-48ca-a197-53cf9629175d';
const USER_ID     = '8154a8df-308a-433d-bafa-e0f9c070d66a'; // preethampriya8520@gmail.com

// Same weights as seed-revenue-entries.cjs for consistency
const WEIGHTS = [0.07, 0.07, 0.08, 0.08, 0.08, 0.08, 0.08, 0.08, 0.09, 0.09, 0.09, 0.11];

const MONTHS = [
  { issue: '2025-06-05', due: '2025-07-05', paid: '2025-06-28', month: '2025-06' },
  { issue: '2025-07-05', due: '2025-08-04', paid: '2025-07-29', month: '2025-07' },
  { issue: '2025-08-05', due: '2025-09-04', paid: '2025-08-28', month: '2025-08' },
  { issue: '2025-09-05', due: '2025-10-05', paid: '2025-09-27', month: '2025-09' },
  { issue: '2025-10-07', due: '2025-11-06', paid: '2025-10-30', month: '2025-10' },
  { issue: '2025-11-05', due: '2025-12-05', paid: '2025-11-28', month: '2025-11' },
  { issue: '2025-12-05', due: '2026-01-04', paid: '2025-12-29', month: '2025-12' },
  { issue: '2026-01-06', due: '2026-02-05', paid: '2026-01-29', month: '2026-01' },
  { issue: '2026-02-05', due: '2026-03-07', paid: '2026-02-27', month: '2026-02' },
  { issue: '2026-03-05', due: '2026-04-04', paid: '2026-03-28', month: '2026-03' },
  { issue: '2026-04-07', due: '2026-05-07', paid: null, month: '2026-04' },  // AUTHORISED
  { issue: '2026-05-06', due: '2026-06-05', paid: null, month: '2026-05' },  // OVERDUE (past due soon)
];

// Revenue accounts → ACCREC invoices (money coming IN from clients)
const REVENUE_STREAMS = [
  {
    code: '4000',
    name: 'Product Sales',
    annual: 980400,
    clients: ['TechCorp Solutions', 'Meridian Retail Group', 'BlueOak Distributors', 'Apex Ventures Ltd'],
    type: 'ACCREC',
  },
  {
    code: '4100',
    name: 'Service Revenue',
    annual: 215600,
    clients: ['NovaStar Consulting', 'Global Synergy Inc', 'PrecisionWorks LLC'],
    type: 'ACCREC',
  },
  {
    code: '4200',
    name: 'Consulting Revenue',
    annual: 87300,
    clients: ['Axiom Partners', 'Clearwater Advisory'],
    type: 'ACCREC',
  },
  {
    code: '4300',
    name: 'Other Income',
    annual: 12800,
    clients: ['Various'],
    type: 'ACCREC',
  },
];

// COGS/Expense accounts → ACCPAY invoices (money going OUT to vendors)
const EXPENSE_STREAMS = [
  {
    code: '5000',
    name: 'Cost of Goods Sold',
    annual: 428700,
    clients: ['Shanghai Manufacturing Co', 'Pacific Supply Chain', 'GlobalParts Inc'],
    type: 'ACCPAY',
  },
  {
    code: '5100',
    name: 'Direct Labor',
    annual: 98600,
    clients: ['StaffPro Workforce', 'Elite Contractors LLC'],
    type: 'ACCPAY',
  },
  {
    code: '5200',
    name: 'Shipping & Freight',
    annual: 18400,
    clients: ['FastFreight Logistics', 'CrossBorder Shipping'],
    type: 'ACCPAY',
  },
];

function dt(dateStr) {
  return dateStr + ' 00:00:00';
}

function makeRows() {
  const rows = [];
  let invNum = 1;

  const addStream = (stream) => {
    MONTHS.forEach((m, idx) => {
      const monthly = Math.round(stream.annual * WEIGHTS[idx]);
      const clientName = stream.clients[idx % stream.clients.length];
      const clientId = `CLI-${stream.code}-${String(idx + 1).padStart(2, '0')}`;
      const invoiceId = `INV-${EXT_ORG_ID}-${String(invNum).padStart(5, '0')}`;
      const extId     = `EXT-${EXT_ORG_ID}-${stream.code}-${m.month}`;
      const invNumber = `${stream.type === 'ACCREC' ? 'SLS' : 'PUR'}-${stream.code}-${m.month}`;

      let status, amountDue, amountPaid, paidAt;
      if (m.paid) {
        status = 'PAID';
        amountDue = 0;
        amountPaid = monthly;
        paidAt = dt(m.paid);
      } else if (m.month === '2024-11') {
        status = 'AUTHORISED';
        amountDue = monthly;
        amountPaid = 0;
        paidAt = null;
      } else {
        // Dec 2024 — OVERDUE (past due date)
        status = 'OVERDUE';
        amountDue = monthly;
        amountPaid = 0;
        paidAt = null;
      }

      rows.push({
        invoice_id:         invoiceId,
        user_id:            USER_ID,
        tenant_id:          TENANT_ID,
        connection_id:      CONN_ID,
        provider:           'xero',
        org_id:             ORG_ID,
        org_name:           ORG_NAME,
        invoice_external_id: extId,
        invoice_number:     invNumber,
        total_amount:       monthly,
        amount_due:         amountDue,
        amount_paid:        amountPaid,
        amount_credited:    0,
        currency:           'USD',
        issued_at:          dt(m.issue),
        due_at:             dt(m.due),
        paid_at:            paidAt,
        status:             status,
        invoice_type:       stream.type,
        contact_id:         clientId,
        contact_name:       clientName,
        updated_at:         dt('2026-05-24'),
        synced_at:          dt('2026-05-24'),
      });

      invNum++;
    });
  };

  REVENUE_STREAMS.forEach(addStream);
  EXPENSE_STREAMS.forEach(addStream);

  return rows;
}

async function main() {
  const wipe = process.argv.includes('--wipe');

  const ch = createClient({
    url:      process.env.CLICKHOUSE_ANALYTICS_URL || process.env.CLICKHOUSE_URL || 'http://35.168.16.162:8123',
    username: process.env.CLICKHOUSE_ANALYTICS_USER || process.env.CLICKHOUSE_USER || 'dbt_transformer',
    password: process.env.CLICKHOUSE_ANALYTICS_PASSWORD || process.env.CLICKHOUSE_PASSWORD || 'test@123',
  });

  if (wipe) {
    console.log('Wiping existing invoice rows for sample_gl_2024...');
    await ch.exec({ query: `ALTER TABLE analytics.fact_accounting_invoices DELETE WHERE org_id = 'sample_gl_2024'` });
    // Small wait for mutation
    await new Promise(r => setTimeout(r, 2000));
  }

  const rows = makeRows();
  console.log(`Inserting ${rows.length} invoice rows (${REVENUE_STREAMS.length} revenue + ${EXPENSE_STREAMS.length} expense streams × 12 months)...`);

  await ch.insert({
    table: 'analytics.fact_accounting_invoices',
    values: rows,
    format: 'JSONEachRow',
  });

  console.log('Done!');

  // Verify
  const result = await ch.query({
    query: `
      SELECT status, invoice_type, count(*) as cnt, round(sum(total_amount), 0) AS total
      FROM analytics.fact_accounting_invoices
      WHERE org_id = '${ORG_ID}'
      GROUP BY status, invoice_type
      ORDER BY invoice_type, status
    `,
    format: 'JSONEachRow',
  });
  const verifyRows = await result.json();
  console.log('\nInvoice summary:');
  verifyRows.forEach(r => console.log(`  [${r.invoice_type}] ${r.status}: ${r.cnt} invoices = $${r.total.toLocaleString()}`));

  const rev = await ch.query({
    query: `SELECT round(sum(total_amount), 0) as revenue FROM analytics.fact_accounting_invoices WHERE org_id = '${ORG_ID}' AND invoice_type = 'ACCREC' AND status IN ('PAID','AUTHORISED','NotSet','NeedToSend')`,
    format: 'JSONEachRow',
  });
  const revRows = await rev.json();
  console.log(`\nTotal addressable revenue: $${revRows[0]?.revenue?.toLocaleString() ?? 0}`);

  await ch.close();
}

main().catch(e => { console.error(e.message); process.exit(1); });
