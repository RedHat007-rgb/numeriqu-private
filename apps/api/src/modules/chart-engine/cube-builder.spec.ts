import { buildCubeViewDdl, buildCubeViewDdls, snake, type CubeBlueprint } from './cube-builder';

describe('cube-builder — snake', () => {
  it.each([
    ['Direct Cost (COS)', 'direct_cost_cos'],
    ['SG&A', 'sg_a'],
    ['  Trailing  ', 'trailing'],
    ['123abc', 'v_123abc'],
    ['', 'value'],
    ['!!!', 'value'],
  ])('snakes %p → %p', (input, expected) => {
    expect(snake(input)).toBe(expected);
  });
});

describe('cube-builder — tenant header (always)', () => {
  it('every cube carries tenant_id/org_id/org_name and groups by tenant', () => {
    const bp: CubeBlueprint = { view: 'v_x', factTable: 'fact_x', measures: [{ column: 'amount', alias: 'total', agg: 'sum' }] };
    const sql = buildCubeViewDdl('analytics', bp);
    expect(sql).toContain('f.tenant_id AS tenant_id');
    expect(sql).toContain('f.org_id AS org_id');
    expect(sql).toContain('any(f.org_name) AS org_name');
    expect(sql).toMatch(/GROUP BY f\.tenant_id, f\.org_id/);
    expect(sql.startsWith('CREATE OR REPLACE VIEW analytics.v_x AS')).toBe(true);
  });
});

describe('cube-builder — aggregation semantics (the accuracy contract)', () => {
  it('sum → sum(col)', () => {
    const sql = buildCubeViewDdl('analytics', { view: 'v', factTable: 'f', measures: [{ column: 'revenue_usd', alias: 'revenue', agg: 'sum' }] });
    expect(sql).toContain('sum(f.revenue_usd) AS revenue');
  });

  it('stock → argMax(col, orderBy), NEVER summed', () => {
    const sql = buildCubeViewDdl('analytics', {
      view: 'v',
      factTable: 'f',
      dateColumn: 'posting_date',
      measures: [{ column: 'cash_usd', alias: 'cash_balance', agg: 'stock', orderBy: 'posting_date' }],
    });
    expect(sql).toContain('argMax(f.cash_usd, f.posting_date) AS cash_balance');
    expect(sql).not.toContain('sum(f.cash_usd)');
  });

  it('stock without orderBy is a build error (never silently summed)', () => {
    expect(() =>
      buildCubeViewDdl('analytics', { view: 'v', factTable: 'f', measures: [{ column: 'cash_usd', alias: 'cash', agg: 'stock' }] }),
    ).toThrow(/orderBy/);
  });

  it('mean → sum(col) + count() weight so the engine does SUM/SUM (not avg-of-avg)', () => {
    const sql = buildCubeViewDdl('analytics', { view: 'v', factTable: 'f', measures: [{ column: 'sla_pct', alias: 'sla', agg: 'mean' }] });
    expect(sql).toContain('sum(f.sla_pct) AS sla');
    expect(sql).toContain('count() AS sla_wt');
    expect(sql).not.toContain('avg(');
  });

  it('mean honors a custom weight alias', () => {
    const sql = buildCubeViewDdl('analytics', {
      view: 'v',
      factTable: 'f',
      measures: [{ column: 'dso_days', alias: 'dso', agg: 'mean', weightAlias: 'dso_rows' }],
    });
    expect(sql).toContain('count() AS dso_rows');
  });

  it('count_distinct → uniqExact', () => {
    const sql = buildCubeViewDdl('analytics', { view: 'v', factTable: 'f', measures: [{ column: 'employee_id', alias: 'headcount', agg: 'count_distinct' }] });
    expect(sql).toContain('uniqExact(f.employee_id) AS headcount');
  });
});

describe('cube-builder — pivots (taxonomy from data, not code)', () => {
  it('emits a sumIf per discovered value with canonical + snake fallback and prefix/suffix', () => {
    const sql = buildCubeViewDdl('analytics', {
      view: 'v_pl',
      factTable: 'fact_gl',
      dateColumn: 'posting_date',
      pivots: [
        {
          valueColumn: 'pl_amount_usd',
          categoryColumn: 'account_type',
          values: ['Revenue', 'Direct Cost (COS)'],
          canonical: { Revenue: 'total_revenue_usd' },
        },
        {
          valueColumn: 'pl_amount_usd',
          categoryColumn: 'cost_category',
          values: ['Cloud Hosting'],
          aliasPrefix: 'cc_',
          aliasSuffix: '_usd',
        },
      ],
    });
    expect(sql).toContain("sumIf(f.pl_amount_usd, f.account_type = 'Revenue') AS total_revenue_usd");
    expect(sql).toContain("sumIf(f.pl_amount_usd, f.account_type = 'Direct Cost (COS)') AS direct_cost_cos");
    expect(sql).toContain("sumIf(f.pl_amount_usd, f.cost_category = 'Cloud Hosting') AS cc_cloud_hosting_usd");
  });

  it('de-duplicates colliding aliases so ClickHouse never sees a repeat', () => {
    const sql = buildCubeViewDdl('analytics', {
      view: 'v',
      factTable: 'f',
      pivots: [
        {
          valueColumn: 'amt',
          categoryColumn: 'cat',
          // "Ops" and "OPS" both snake to "ops" — second must get _2.
          values: ['Ops', 'OPS'],
        },
      ],
    });
    expect(sql).toContain('AS ops');
    expect(sql).toContain('AS ops_2');
  });

  it('escapes single quotes in category values (injection-safe)', () => {
    const sql = buildCubeViewDdl('analytics', {
      view: 'v',
      factTable: 'f',
      pivots: [{ valueColumn: 'amt', categoryColumn: 'cat', values: ["O'Brien"] }],
    });
    expect(sql).toContain("f.cat = 'O''Brien'");
  });
});

describe('cube-builder — joins (tenant-safe)', () => {
  it('LEFT JOINs the dim scoped by tenant_id + org_id + keys, qualifies fact cols', () => {
    const sql = buildCubeViewDdl('analytics', {
      view: 'v_rev_by_client',
      factTable: 'fact_revenue',
      dateColumn: 'posting_date',
      joins: [
        {
          dimTable: 'dim_client',
          factKey: 'client_key',
          dimKey: 'client_key',
          selects: [{ column: 'client_name', alias: 'client_name' }],
        },
      ],
      measures: [{ column: 'revenue_usd', alias: 'revenue', agg: 'sum' }],
    });
    expect(sql).toContain('FROM analytics.fact_revenue f');
    expect(sql).toContain('LEFT JOIN analytics.dim_client d0 ON d0.tenant_id = f.tenant_id AND d0.org_id = f.org_id AND d0.client_key = f.client_key');
    expect(sql).toContain('d0.client_name AS client_name');
    expect(sql).toContain('sum(f.revenue_usd) AS revenue');
    // fact tenant columns are qualified when joined
    expect(sql).toContain('f.tenant_id AS tenant_id');
  });

  it('ALWAYS aliases the fact as f and qualifies columns (prevents alias↔column collision)', () => {
    // Alias == source column would otherwise make ClickHouse expand
    // sumIf(col,…) into sumIf(sum(col),…) — a nested-aggregate error. Qualifying
    // the raw column with f. refers to the column, never the SELECT alias.
    const sql = buildCubeViewDdl('analytics', {
      view: 'v',
      factTable: 'ft',
      measures: [{ column: 'cash_outflow_usd', alias: 'cash_outflow_usd', agg: 'sum' }],
      pivots: [{ valueColumn: 'cash_outflow_usd', categoryColumn: 'cat', values: ['A'] }],
    });
    expect(sql).toContain('FROM analytics.ft f');
    expect(sql).toContain('sum(f.cash_outflow_usd) AS cash_outflow_usd');
    expect(sql).toContain("sumIf(f.cash_outflow_usd, f.cat = 'A')");
    // the dangerous unqualified form must NOT appear
    expect(sql).not.toContain('sumIf(cash_outflow_usd,');
  });
});

describe('cube-builder — derived (outer layer)', () => {
  it('wraps the aggregate in an outer SELECT that computes derived columns', () => {
    const sql = buildCubeViewDdl('analytics', {
      view: 'v_pl',
      factTable: 'fact_gl',
      pivots: [
        {
          valueColumn: 'pl_amount_usd',
          categoryColumn: 'account_type',
          values: ['Revenue', 'Direct Cost (COS)'],
          canonical: { Revenue: 'total_revenue_usd', 'Direct Cost (COS)': 'total_cogs_usd' },
        },
      ],
      derived: [{ expr: '(total_revenue_usd - total_cogs_usd)', alias: 'gross_profit_usd' }],
    });
    expect(sql).toMatch(/SELECT \*, \(total_revenue_usd - total_cogs_usd\) AS gross_profit_usd\nFROM \(/);
  });
});

describe('cube-builder — identifier safety', () => {
  it('rejects an unsafe database name', () => {
    expect(() => buildCubeViewDdl('analytics; DROP TABLE x', { view: 'v', factTable: 'f' })).toThrow(/unsafe identifier/);
  });

  it('rejects an unsafe column identifier', () => {
    expect(() =>
      buildCubeViewDdl('analytics', { view: 'v', factTable: 'f', measures: [{ column: 'a);DROP', alias: 'x', agg: 'sum' }] }),
    ).toThrow(/unsafe identifier/);
  });
});

describe('cube-builder — dataset-agnostic (no domain literals)', () => {
  it('builds a valid cube for a NON-finance schema the code has never seen', () => {
    // A logistics dataset — proves the builder carries zero finance assumptions.
    const bp: CubeBlueprint = {
      view: 'v_ship_shipments_monthly',
      factTable: 'fact_shipment',
      dateColumn: 'shipped_at',
      dimensions: [{ column: 'carrier', alias: 'carrier' }],
      measures: [
        { column: 'parcels', alias: 'parcels', agg: 'sum' },
        { column: 'on_time_flag', alias: 'on_time', agg: 'mean' },
        { column: 'warehouse_stock', alias: 'stock_level', agg: 'stock', orderBy: 'shipped_at' },
      ],
    };
    const sql = buildCubeViewDdl('analytics', bp);
    expect(sql).toContain('CREATE OR REPLACE VIEW analytics.v_ship_shipments_monthly AS');
    expect(sql).toContain('sum(f.parcels) AS parcels');
    expect(sql).toContain('count() AS on_time_wt');
    expect(sql).toContain('argMax(f.warehouse_stock, f.shipped_at) AS stock_level');
    expect(sql).toContain('f.carrier AS carrier');
  });

  it('buildCubeViewDdls maps many blueprints deterministically', () => {
    const out = buildCubeViewDdls('analytics', [
      { view: 'v_a', factTable: 'fa', measures: [{ column: 'x', alias: 'x', agg: 'sum' }] },
      { view: 'v_b', factTable: 'fb', measures: [{ column: 'y', alias: 'y', agg: 'sum' }] },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toContain('analytics.v_a');
    expect(out[1]).toContain('analytics.v_b');
    // deterministic: same input → identical output
    expect(buildCubeViewDdl('analytics', { view: 'v_a', factTable: 'fa', measures: [{ column: 'x', alias: 'x', agg: 'sum' }] })).toBe(out[0]);
  });
});
