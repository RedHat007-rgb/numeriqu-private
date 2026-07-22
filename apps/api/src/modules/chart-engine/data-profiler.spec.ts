import { classifyColumn, deriveRatioComponents, profileTable, type ColumnStats } from './data-profiler';

const stats = (over: Partial<ColumnStats> & Pick<ColumnStats, 'column' | 'type'>): ColumnStats => ({
  table: 'fact',
  distinctCount: 100,
  nullFraction: 0,
  sampleValues: [],
  rowCount: 1000,
  ...over,
});

describe('DataProfiler.classifyColumn', () => {
  const opts = { siblingColumns: [] as string[] };

  it('classifies a revenue/amount column as additive', () => {
    const p = classifyColumn(stats({ column: 'total_revenue_usd', type: 'Decimal(18, 2)' }), opts);
    expect(p.agg).toBe('additive');
  });

  it('classifies a FINANCIAL percentage/rate column as ratio (never averaged)', () => {
    // Financial ratios must resolve $ components or refuse — never become a mean.
    expect(classifyColumn(stats({ column: 'gross_margin_pct', type: 'Float64' }), opts).agg).toBe('ratio');
    expect(classifyColumn(stats({ column: 'payroll_to_revenue_rate', type: 'Float64' }), opts).agg).toBe('ratio');
  });

  it('classifies OPERATIONAL averages/durations as mean when allowMean is on (not summed, not refused)', () => {
    // utilization/SLA/CSAT/occupancy % and DSO/DPO days are genuine averages in
    // the source model (DAX AVERAGE(...)); they must be a mean, never summed.
    const meanOpts = { siblingColumns: [] as string[], allowMean: true };
    expect(classifyColumn(stats({ column: 'utilization_pct', type: 'Float64' }), meanOpts).agg).toBe('mean');
    expect(classifyColumn(stats({ column: 'sla_compliance_pct', type: 'Float64' }), meanOpts).agg).toBe('mean');
    expect(classifyColumn(stats({ column: 'csat_pct', type: 'Float64' }), meanOpts).agg).toBe('mean');
    expect(classifyColumn(stats({ column: 'occupancy_pct', type: 'Float64' }), meanOpts).agg).toBe('mean');
    expect(classifyColumn(stats({ column: 'days_sales_outstanding', type: 'Float64' }), meanOpts).agg).toBe('mean');
    expect(classifyColumn(stats({ column: 'dpo_days', type: 'Float64' }), meanOpts).agg).toBe('mean');
    // A duration must NOT be summed: dso_days used to fall through to additive.
    expect(classifyColumn(stats({ column: 'dso_days', type: 'Float64' }), meanOpts).agg).not.toBe('additive');
    // Attendance day/hour totals are flows, not row-level averages.
    expect(classifyColumn(stats({ column: 'present_days', type: 'Float64' }), meanOpts).agg).toBe('additive');
    expect(classifyColumn(stats({ column: 'overtime_hours', type: 'Float64' }), meanOpts).agg).toBe('additive');
  });

  it('does NOT classify mean when allowMean is off — frozen behavior for existing datasets', () => {
    // The gate that keeps older orgs (EBPO on the env cube list) byte-for-byte:
    // without allowMean, an operational % is never a `mean`.
    expect(classifyColumn(stats({ column: 'utilization_pct', type: 'Float64' }), opts).agg).not.toBe('mean');
    expect(classifyColumn(stats({ column: 'sla_compliance_pct', type: 'Float64' }), opts).agg).not.toBe('mean');
  });

  it('resolves a weighted mean when a paired <metric>_wt sibling exists', () => {
    const p = classifyColumn(stats({ column: 'sla_compliance_pct', type: 'Float64' }), {
      siblingColumns: ['sla_compliance_pct', 'sla_compliance_pct_wt'],
      allowMean: true,
    });
    expect(p.agg).toBe('mean');
    expect(p.meanWeight).toBe('sla_compliance_pct_wt');
  });

  it('classifies a 0..1 ranged numeric with no flow name as ratio', () => {
    const p = classifyColumn(stats({ column: 'score', type: 'Float64', min: 0, max: 0.98 }), opts);
    expect(p.agg).toBe('ratio');
  });

  it('does NOT misclassify a 0..100 flow (e.g. units) as ratio when name says flow', () => {
    const p = classifyColumn(stats({ column: 'units_sold', type: 'UInt32', min: 0, max: 80 }), opts);
    expect(p.agg).toBe('additive');
  });

  it('classifies cash balance / headcount as semi_additive (stock, not summed)', () => {
    expect(classifyColumn(stats({ column: 'cash_balance', type: 'Decimal(18, 2)' }), opts).agg).toBe('semi_additive');
    expect(classifyColumn(stats({ column: 'headcount', type: 'UInt32' }), opts).agg).toBe('semi_additive');
    expect(classifyColumn(stats({ column: 'ar_outstanding', type: 'Decimal(18, 2)' }), opts).agg).toBe('semi_additive');
  });

  it('classifies trial-balance movements as additive flows', () => {
    expect(
      classifyColumn(
        stats({ column: 'trial_balance_debit_movement_usd', type: 'Float64' }),
        opts,
      ).agg,
    ).toBe('additive');
    expect(
      classifyColumn(
        stats({ column: 'trial_balance_credit_movement_usd', type: 'Float64' }),
        opts,
      ).agg,
    ).toBe('additive');
  });

  it('classifies id/key columns as count_distinct', () => {
    expect(classifyColumn(stats({ column: 'client_id', type: 'UInt64' }), opts).agg).toBe('count_distinct');
    expect(classifyColumn(stats({ column: 'invoice_number', type: 'String' }), opts).agg).toBe('attribute'); // non-numeric wins → attribute
    expect(classifyColumn(stats({ column: 'employee_id', type: 'UInt64' }), opts).agg).toBe('count_distinct');
  });

  it('classifies non-numeric columns as attributes', () => {
    expect(classifyColumn(stats({ column: 'client_name', type: 'String' }), opts).agg).toBe('attribute');
    expect(classifyColumn(stats({ column: 'period_date', type: 'Date' }), opts).agg).toBe('attribute');
  });

  it('treats a dollar amount as additive even if its name contains "margin" (gross_margin_usd)', () => {
    // Regression: live EBPO run wrongly skipped gross_margin_usd as a ratio.
    const p = classifyColumn(stats({ column: 'gross_margin_usd', type: 'Float64' }), opts);
    expect(p.agg).toBe('additive');
  });

  it('treats integer calendar-part columns (year/quarter/month) as attributes, not measures', () => {
    // Regression: live EBPO run made "year" a SUM measure and quarter/month ratios.
    expect(classifyColumn(stats({ column: 'year', type: 'UInt16' }), opts).agg).toBe('attribute');
    expect(classifyColumn(stats({ column: 'quarter', type: 'UInt8', min: 1, max: 4 }), opts).agg).toBe('attribute');
    expect(classifyColumn(stats({ column: 'month', type: 'UInt8', min: 1, max: 12 }), opts).agg).toBe('attribute');
  });

  it('does NOT mis-wire fcf_margin_pct/ebitda_style_margin_pct to gross-margin components', () => {
    // Regression: /margin/ hint was greedy and produced a SILENT WRONG ratio.
    const sibs = ['fcf_margin_pct', 'ebitda_style_margin_pct', 'gross_margin_usd', 'total_revenue_usd'];
    expect(deriveRatioComponents('fcf_margin_pct', sibs)).toBeUndefined();
    expect(deriveRatioComponents('ebitda_style_margin_pct', sibs)).toBeUndefined();
  });

  it('flags a ratio with UNRESOLVED components at lower confidence (so caller can refuse)', () => {
    const p = classifyColumn(stats({ column: 'gross_margin_pct', type: 'Float64' }), { siblingColumns: ['gross_margin_pct'] });
    expect(p.agg).toBe('ratio');
    expect(p.ratioComponents).toBeUndefined();
    expect(p.confidence).toBeLessThan(0.8);
  });
});

describe('DataProfiler.deriveRatioComponents', () => {
  it('resolves gross margin to profit / revenue', () => {
    const c = deriveRatioComponents('gross_margin_pct', ['gross_margin_pct', 'gross_profit_usd', 'total_revenue_usd']);
    expect(c).toEqual({ numerator: 'gross_profit_usd', denominator: 'total_revenue_usd' });
  });

  it('resolves revenue-per-employee to revenue / headcount', () => {
    const c = deriveRatioComponents('revenue_per_employee', ['revenue_per_employee', 'total_revenue', 'headcount']);
    expect(c).toEqual({ numerator: 'total_revenue', denominator: 'headcount' });
  });

  it('resolves productive-hours percentage to productive hours / paid hours', () => {
    const c = deriveRatioComponents('productive_hours_percentage', [
      'productive_hours_percentage',
      'productive_hours',
      'paid_hours',
    ]);
    expect(c).toEqual({
      numerator: 'productive_hours',
      denominator: 'paid_hours',
    });
  });

  it('resolves collection efficiency to collected amount / invoice amount', () => {
    const c = deriveRatioComponents('collection_efficiency_pct', [
      'collection_efficiency_pct',
      'collected_amount_usd',
      'invoice_amount_usd',
    ]);
    expect(c).toEqual({
      numerator: 'collected_amount_usd',
      denominator: 'invoice_amount_usd',
    });
  });

  it('resolves bad-debt percentage to write-off amount / invoice amount', () => {
    const c = deriveRatioComponents('bad_debt_pct', [
      'bad_debt_pct',
      'write_off_amount_usd',
      'invoice_amount_usd',
    ]);
    expect(c).toEqual({
      numerator: 'write_off_amount_usd',
      denominator: 'invoice_amount_usd',
    });
  });

  it('returns undefined when components are absent (forces refusal, not a guessed average)', () => {
    expect(deriveRatioComponents('gross_margin_pct', ['gross_margin_pct'])).toBeUndefined();
  });
});

describe('DataProfiler.profileTable', () => {
  it('resolves ratio components using sibling columns', () => {
    const profiles = profileTable([
      stats({ column: 'gross_margin_pct', type: 'Float64' }),
      stats({ column: 'gross_profit_usd', type: 'Decimal(18, 2)' }),
      stats({ column: 'total_revenue_usd', type: 'Decimal(18, 2)' }),
    ]);
    const margin = profiles.find((p) => p.column === 'gross_margin_pct')!;
    expect(margin.agg).toBe('ratio');
    expect(margin.ratioComponents).toEqual({ numerator: 'gross_profit_usd', denominator: 'total_revenue_usd' });
    expect(margin.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('never chooses a text dimension as a ratio component', () => {
    const profiles = profileTable([
      stats({ column: 'gross_margin_pct', type: 'Float64' }),
      stats({ column: 'gross_profit_usd', type: 'Decimal(18, 2)' }),
      stats({ column: 'revenue_category', type: 'String' }),
      stats({ column: 'total_revenue_usd', type: 'Decimal(18, 2)' }),
    ]);
    const margin = profiles.find((p) => p.column === 'gross_margin_pct')!;
    expect(margin.ratioComponents).toEqual({
      numerator: 'gross_profit_usd',
      denominator: 'total_revenue_usd',
    });
  });
});
