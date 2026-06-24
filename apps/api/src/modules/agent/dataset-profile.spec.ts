import {
  EBPO_PROFILE,
  GL_PROFILE,
  resolveDatasetProfile,
  referencedTables,
  checkGrounding,
} from './dataset-profile';

describe('dataset-profile — grounding boundary', () => {
  test('EBPO profile points client/year resolution at EBPO tables', () => {
    expect(EBPO_PROFILE.client.view).toBe('v_ebpo_revenue_by_client');
    expect(EBPO_PROFILE.client.weightExpr).toMatch(/total_revenue_usd/);
    expect(EBPO_PROFILE.yearSource.view).toBe('v_ebpo_revenue_monthly');
    expect(EBPO_PROFILE.yearSource.dateCol).toBe('period_date');
  });

  test('GL profile points at GL/sample tables', () => {
    expect(GL_PROFILE.client.view).toBe('v_dim_clients_latest');
    expect(GL_PROFILE.yearSource.view).toBe('sample_gl_dump');
  });

  test('resolveDatasetProfile maps kind → profile', () => {
    expect(resolveDatasetProfile('ebpo')).toBe(EBPO_PROFILE);
    expect(resolveDatasetProfile('gl')).toBe(GL_PROFILE);
  });

  test('referencedTables extracts only db-qualified tables, ignoring CTEs/aliases', () => {
    const sql =
      'WITH t AS (SELECT 1) SELECT * FROM analytics.v_ebpo_revenue_by_client c ' +
      'JOIN analytics.v_ebpo_kpi_monthly k ON 1=1, t';
    const tables = referencedTables(sql).sort();
    expect(tables).toEqual(['v_ebpo_kpi_monthly', 'v_ebpo_revenue_by_client']);
  });

  test('THE BUG: an EBPO query touching the GL client table is BLOCKED', () => {
    const leak =
      'SELECT client_name FROM analytics.v_dim_clients_latest WHERE org_id IN (?)';
    const r = checkGrounding(leak, EBPO_PROFILE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.offending).toContain('v_dim_clients_latest');
  });

  test('THE BUG: an EBPO query counting years from sample_gl_dump is BLOCKED', () => {
    const leak = 'SELECT uniqExact(toYear(date)) FROM analytics.sample_gl_dump';
    expect(checkGrounding(leak, EBPO_PROFILE).ok).toBe(false);
  });

  test('a correctly-grounded EBPO query passes', () => {
    const good =
      'SELECT client_name, sum(total_revenue_usd) FROM analytics.v_ebpo_revenue_by_client GROUP BY client_name';
    expect(checkGrounding(good, EBPO_PROFILE).ok).toBe(true);
  });

  test('a GL org is blocked from reading EBPO tables (mirror protection)', () => {
    const leak = 'SELECT * FROM analytics.v_ebpo_revenue_by_client';
    expect(checkGrounding(leak, GL_PROFILE).ok).toBe(false);
  });

  test('neutral infra tables (numbers/system) are allowed in any dataset', () => {
    expect(checkGrounding('SELECT * FROM system.numbers', EBPO_PROFILE).ok).toBe(
      true,
    );
  });
});
