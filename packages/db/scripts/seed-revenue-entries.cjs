/**
 * Inserts synthetic monthly revenue + COGS + OpEx journal entries
 * derived from the trial balance into fact_accounting_journal_lines.
 * Distributes annual totals evenly across 12 months (Jun 2025 – May 2026).
 *
 * Departments are assigned so department-breakdown charts have real data:
 *   Sales       → revenue accounts (4000-4300)
 *   Operations  → COGS accounts (5000-5200) + R&D (6500)
 *   Admin       → G&A / facilities / IT (6000, 6200, 6400)
 *   Finance     → payroll overhead / other G&A (6600)
 */
const { createClient } = require('@clickhouse/client');
const dotenv = require('dotenv');
dotenv.config({ path: '/Users/basanireddy/Desktop/test-1234/.env' });
dotenv.config({ path: '/Users/basanireddy/Desktop/test-1234/apps/api/.env' });

const ORG_ID      = 'sample_gl_2024';
const EXT_ORG_ID  = 'sample_gl_2024';
const CONN_ID     = 'd8f7ab35-f218-4b14-8188-bf744c42cb6e';
const TENANT_ID   = '3c964ac3-7868-48ca-a197-53cf9629175d';

// Revenue accounts (credits → line_amount < 0)
const REVENUE_ACCOUNTS = [
  { code: '4000', name: 'Product Sales',      annual: 980400, dept: 'Sales'      },
  { code: '4100', name: 'Service Revenue',    annual: 215600, dept: 'Sales'      },
  { code: '4200', name: 'Consulting Revenue', annual: 87300,  dept: 'Sales'      },
  { code: '4300', name: 'Other Income',       annual: 12800,  dept: 'Admin'      },
];

// COGS accounts (debits → line_amount > 0)
const COGS_ACCOUNTS = [
  { code: '5000', name: 'Cost of Goods Sold',       annual: 428700, dept: 'Operations' },
  { code: '5100', name: 'Direct Labor',              annual: 98600,  dept: 'Operations' },
  { code: '5200', name: 'Shipping & Freight - COGS', annual: 18400,  dept: 'Operations' },
];

// Operating expense accounts (debits → line_amount > 0)
const OPEX_ACCOUNTS = [
  { code: '6000', name: 'Salaries - Admin',        annual: 156000, dept: 'Admin'      },
  { code: '6100', name: 'Salaries - Sales',        annual: 98000,  dept: 'Sales'      },
  { code: '6200', name: 'Rent & Facilities',       annual: 48000,  dept: 'Admin'      },
  { code: '6300', name: 'Marketing & Advertising', annual: 62000,  dept: 'Sales'      },
  { code: '6400', name: 'Software & IT',           annual: 36000,  dept: 'Admin'      },
  { code: '6500', name: 'Research & Development',  annual: 85000,  dept: 'Operations' },
  { code: '6600', name: 'Finance & Accounting',    annual: 42000,  dept: 'Finance'    },
  { code: '6700', name: 'Legal & Compliance',      annual: 28000,  dept: 'Finance'    },
];

const MONTHS = [
  '2025-06-30','2025-07-31','2025-08-31','2025-09-30',
  '2025-10-31','2025-11-30','2025-12-31','2026-01-31',
  '2026-02-28','2026-03-31','2026-04-30','2026-05-24',
];

// Slight seasonal variation weights (Q4 heavier)
const WEIGHTS = [0.07, 0.07, 0.08, 0.08, 0.08, 0.08, 0.08, 0.08, 0.09, 0.09, 0.09, 0.11];

// Per-department vendor names so vendor charts are meaningful
const DEPT_VENDORS = {
  'Sales':       ['CRM Solutions Inc', 'MediaBuys Agency', 'SalesPro Tools'],
  'Operations':  ['Shanghai Manufacturing Co', 'Pacific Supply Chain', 'FastFreight Logistics'],
  'Admin':       ['Office Central Ltd', 'CloudWork SaaS', 'BuildingMgmt Co'],
  'Finance':     ['LexAdvise LLP', 'AuditPartners LLC', 'FinanceStack Inc'],
};

function makeRows() {
  const rows = [];

  const addAccount = (acc, isRevenue, isOpEx) => {
    MONTHS.forEach((dt, m) => {
      const monthlyAmt = Math.round(acc.annual * WEIGHTS[m]);
      const lineAmount = isRevenue ? -monthlyAmt : monthlyAmt;
      const journalId  = `${EXT_ORG_ID}__TB_${acc.code}_${dt.slice(0,7).replace('-','')}`;
      const lineId     = `${journalId}__0`;
      const vendors    = DEPT_VENDORS[acc.dept] ?? ['General Vendor'];
      const vendor     = isRevenue ? '' : vendors[m % vendors.length];

      rows.push({
        connection_id:  CONN_ID,
        tenant_id:      TENANT_ID,
        org_id:         ORG_ID,
        provider:       'gl_import',
        journal_id:     journalId,
        line_id:        lineId,
        journal_number: '',
        journal_date:   dt + ' 00:00:00',
        account_id:     acc.code,
        account_code:   acc.code,
        account_name:   acc.name,
        line_amount:    lineAmount,
        description:    isRevenue ? 'Monthly revenue recognition'
                        : isOpEx  ? 'Monthly operating expense'
                        :           'Monthly COGS entry',
        source_type:    isRevenue ? 'REV' : isOpEx ? 'OPEX' : 'COGS',
        department:     acc.dept,
        class_name:     '',
        vendor_name:    vendor,
        vendor_id:      vendor ? `VND-${acc.code}` : '',
        debit_amount:   lineAmount > 0 ? lineAmount : 0,
        credit_amount:  lineAmount < 0 ? -lineAmount : 0,
        updated_at:     new Date().toISOString().replace('T',' ').replace(/\..+/,''),
      });
    });
  };

  REVENUE_ACCOUNTS.forEach(a => addAccount(a, true,  false));
  COGS_ACCOUNTS.forEach(a   => addAccount(a, false, false));
  OPEX_ACCOUNTS.forEach(a   => addAccount(a, false, true));
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
    console.log('Wiping existing GL journal rows for sample_gl_2024...');
    await ch.exec({
      query: `ALTER TABLE analytics.fact_accounting_journal_lines DELETE WHERE org_id = '${ORG_ID}'`
    });
    await new Promise(r => setTimeout(r, 3000));
  }

  const rows = makeRows();
  const accountGroups = `${REVENUE_ACCOUNTS.length} revenue + ${COGS_ACCOUNTS.length} COGS + ${OPEX_ACCOUNTS.length} OpEx`;
  console.log(`Inserting ${rows.length} rows (${accountGroups} accounts × 12 months)...`);

  await ch.insert({
    table: 'analytics.fact_accounting_journal_lines',
    values: rows,
    format: 'JSONEachRow',
  });

  console.log('Done!');

  // Verify by department
  const result = await ch.query({
    query: `
      SELECT department,
             round(sumIf(line_amount,  line_amount > 0), 0) AS total_spend,
             round(sumIf(-line_amount, line_amount < 0), 0) AS total_revenue,
             count(*) AS rows
      FROM analytics.fact_accounting_journal_lines
      WHERE org_id = '${ORG_ID}'
      GROUP BY department
      ORDER BY total_spend DESC
    `,
    format: 'JSONEachRow',
  });
  const summary = await result.json();
  console.log('\nDepartment summary:');
  summary.forEach(r => console.log(`  [${r.department || 'Other'}]  spend=$${Number(r.total_spend).toLocaleString()}  revenue=$${Number(r.total_revenue).toLocaleString()}  rows=${r.rows}`));

  await ch.close();
}

main().catch(e => { console.error(e.message); process.exit(1); });
