/**
 * ChartSpec + Semantic Catalog + deterministic spec→SQL compiler.
 *
 * This is the "missing layer". Instead of asking an LLM to hand-write ClickHouse
 * SQL on every turn, a chart is represented as a small STRUCTURED spec built only
 * from a known catalog of measures/dimensions. SQL is GENERATED from the spec
 * deterministically, so:
 *   - the model can never reference a column that doesn't exist (no hallucination),
 *   - a follow-up is just a delta on the spec (no SQL rewriting),
 *   - "is this doable?" is a catalog lookup (honest refusals, no guessing).
 *
 * Phase-1 foundation: pure + self-contained (no dependency on AgentService), so it
 * can be unit-tested and adopted incrementally behind the existing engine.
 */

export type SpecSource = 'gl' | 'trial_balance';

// ─── Catalog: MEASURES (the numbers you can plot) ───────────────────────────
export interface MeasureDef {
  id: string;
  label: string;
  source: SpecSource;
  format: 'currency' | 'number' | 'percent';
  // Plain aggregate (single series) and the conditional form used for WIDE pivots.
  value: string;
  condAgg: (cond: string) => string;
}

const MEASURES: Record<string, MeasureDef> = {
  spend: {
    id: 'spend',
    label: 'Total spend',
    source: 'gl',
    format: 'currency',
    value: 'round(sum(toFloat64(debit)), 0)',
    condAgg: (c) => `round(sumIf(toFloat64(debit), ${c}), 0)`,
  },
  credits: {
    id: 'credits',
    label: 'Total credits',
    source: 'gl',
    format: 'currency',
    value: 'round(sum(toFloat64(credit)), 0)',
    condAgg: (c) => `round(sumIf(toFloat64(credit), ${c}), 0)`,
  },
  txn_count: {
    id: 'txn_count',
    label: 'Transaction count',
    source: 'gl',
    format: 'number',
    value: 'count()',
    condAgg: (c) => `countIf(${c})`,
  },
  avg_txn: {
    id: 'avg_txn',
    label: 'Average transaction value',
    source: 'gl',
    format: 'currency',
    value: 'round(avg(toFloat64(debit)), 2)',
    condAgg: (c) => `round(avgIf(toFloat64(debit), ${c}), 2)`,
  },
  balance: {
    id: 'balance',
    label: 'Balance',
    source: 'trial_balance',
    format: 'currency',
    // Magnitude, not signed: liabilities/income carry negative net_balance, which
    // would make bars point down and pies empty (no positive slices). Ranking and
    // share-of-total only make sense on absolute balance.
    value: 'round(abs(sum(toFloat64(net_balance))), 0)',
    condAgg: (c) => `round(abs(sumIf(toFloat64(net_balance), ${c})), 0)`,
  },
};

// ─── Catalog: DIMENSIONS (the axes you can group by) ────────────────────────
export interface DimensionDef {
  id: string;
  label: string;
  source: SpecSource;
  // labelExpr is the human label (x-axis); groupExpr is what we GROUP BY / order by.
  labelExpr: string;
  groupExpr: string;
  notEmpty?: string;
  isTime?: boolean;
}

const DIMENSIONS: Record<string, DimensionDef> = {
  month: {
    id: 'month',
    label: 'Month',
    source: 'gl',
    labelExpr: `formatDateTime(toStartOfMonth(date), '%b %Y')`,
    groupExpr: `toStartOfMonth(date)`,
    notEmpty: `date IS NOT NULL`,
    isTime: true,
  },
  quarter: {
    id: 'quarter',
    label: 'Quarter',
    source: 'gl',
    // Label must be a function of the GROUP BY key (toStartOfQuarter(date)),
    // so derive the quarter/year from that key, not from the raw date column.
    labelExpr: `concat('Q', toString(toQuarter(toStartOfQuarter(date))), ' ', toString(toYear(toStartOfQuarter(date))))`,
    groupExpr: `toStartOfQuarter(date)`,
    notEmpty: `date IS NOT NULL`,
    isTime: true,
  },
  department: {
    id: 'department',
    label: 'Department',
    source: 'gl',
    labelExpr: `COALESCE(NULLIF(department, ''), 'Unassigned')`,
    groupExpr: `COALESCE(NULLIF(department, ''), 'Unassigned')`,
    notEmpty: `department != ''`,
  },
  class: {
    id: 'class',
    label: 'Class',
    source: 'gl',
    labelExpr: `COALESCE(NULLIF(class, ''), 'Unassigned')`,
    groupExpr: `COALESCE(NULLIF(class, ''), 'Unassigned')`,
    notEmpty: `class != ''`,
  },
  vendor: {
    id: 'vendor',
    label: 'Vendor',
    source: 'gl',
    labelExpr: `COALESCE(NULLIF(vendor_customer, ''), 'Unassigned')`,
    groupExpr: `COALESCE(NULLIF(vendor_customer, ''), 'Unassigned')`,
    notEmpty: `vendor_customer != ''`,
  },
  account: {
    id: 'account',
    label: 'Account',
    source: 'gl',
    labelExpr: `COALESCE(NULLIF(account_name, ''), 'Unassigned')`,
    groupExpr: `COALESCE(NULLIF(account_name, ''), 'Unassigned')`,
    notEmpty: `account_name != ''`,
  },
  account_type: {
    id: 'account_type',
    label: 'Account type',
    source: 'trial_balance',
    labelExpr: `account_type`,
    groupExpr: `account_type`,
    notEmpty: `account_type != ''`,
  },
};

// ─── Catalog: what is NOT in the data (deterministic, honest refusals) ───────
const UNAVAILABLE: Record<string, string> = {
  budget: 'budget / plan figures',
  forecast: 'forecast / projection data',
  target: 'target or goal figures',
  region: 'region / geography',
  segment: 'customer or market segment',
  headcount: 'headcount / employee data',
  cash_flow: 'a cash-flow statement',
  prior_year: 'an earlier year to compare against (single year only)',
};

export type SpecTransform =
  | { kind: 'normalize' }
  | { kind: 'growth_pct' }
  | { kind: 'moving_average'; window: number }
  | { kind: 'reference_line' };

export interface SpecFilter {
  dimension: string;
  op: 'in' | 'not_in';
  values: string[];
}

export interface SpecThreshold {
  op: 'gt' | 'lt' | 'gte' | 'lte';
  value: number;
}

export interface ChartSpec {
  measure: string;
  // Optional multi-measure series for combo / dual-axis / "compare X and Y" /
  // "add Z as a comparison line". When set with >1 entry, the EBPO compiler plots
  // every measure against `dimension` (or as KPI cards when no dimension). The GL
  // compiler ignores this field. The first entry should match `measure`.
  measures?: string[] | null;
  dimension: string;
  breakdown?: string | null;
  filters?: SpecFilter[];
  // Keep only rows/series whose MEASURE meets a numeric threshold (a HAVING clause)
  // — e.g. "vendors above $50k", "accounts with more than 100 transactions".
  having?: SpecThreshold | null;
  sort?: 'value_desc' | 'value_asc' | 'name_asc' | 'time_asc' | null;
  topN?: number | null;
  chartType: string;
  transforms?: SpecTransform[];
}

export interface CompileResult {
  ok: true;
  sql: string;
  measure: MeasureDef;
}
export interface CompileRefusal {
  ok: false;
  refusal: string;
}

const SCOPE_WHERE =
  'tenant_id = {tenantId:String} AND org_id IN ({externalOrgIds:Array(String)})';

const quoteLit = (v: string) => `'${String(v).replace(/'/g, "''")}'`;
const quoteIdent = (v: string) => `"${String(v).replace(/"/g, '""')}"`;

// Validate a spec against the catalog. Returns a clear refusal if it references a
// measure/dimension that does not exist — this is the "can I do this?" lookup that
// replaces hallucinated SQL.
export function validateSpec(spec: ChartSpec): CompileRefusal | null {
  const tail =
    " This dataset has one year of general-ledger transactions and a trial balance — I left the chart unchanged.";
  for (const key of Object.keys(UNAVAILABLE)) {
    if (spec.measure === key || spec.dimension === key || spec.breakdown === key)
      return { ok: false, refusal: `I can't use ${UNAVAILABLE[key]} — it isn't in this dataset.${tail}` };
  }
  if (!MEASURES[spec.measure])
    return { ok: false, refusal: `I don't have a "${spec.measure}" measure to plot.${tail}` };
  if (!DIMENSIONS[spec.dimension])
    return { ok: false, refusal: `I can't break data down by "${spec.dimension}".${tail}` };
  if (spec.breakdown && !DIMENSIONS[spec.breakdown])
    return { ok: false, refusal: `I can't break data down by "${spec.breakdown}".${tail}` };
  return null;
}

const tableFor = (source: SpecSource, db: string) =>
  source === 'gl' ? `${db}.sample_gl_dump` : `${db}.sample_trial_balance`;

const buildWhere = (
  dims: DimensionDef[],
  filters: SpecFilter[] | undefined,
  measure: MeasureDef,
): string => {
  const parts = [SCOPE_WHERE];
  if (measure.id === 'spend') parts.push('toFloat64(debit) > 0');
  for (const d of dims) if (d.notEmpty) parts.push(d.notEmpty);
  for (const f of filters ?? []) {
    const dim = DIMENSIONS[f.dimension];
    if (!dim || f.values.length === 0) continue;
    const list = f.values.map(quoteLit).join(', ');
    parts.push(`${dim.labelExpr} ${f.op === 'not_in' ? 'NOT IN' : 'IN'} (${list})`);
  }
  return parts.join(' AND ');
};

const orderClause = (spec: ChartSpec, dim: DimensionDef): string => {
  if (dim.isTime || spec.sort === 'time_asc') return `${dim.groupExpr} ASC`;
  if (spec.sort === 'value_asc') return 'value ASC';
  if (spec.sort === 'name_asc') return `${dim.groupExpr} ASC`;
  return 'value DESC';
};

// Deterministically compile a validated spec to scoped ClickHouse SQL. WIDE
// (breakdown) charts need the concrete column set, so a small pre-query fetches
// the top breakdown values via `runRows`.
export async function compileSpec(
  spec: ChartSpec,
  db: string,
  runRows: (sql: string) => Promise<Array<Record<string, unknown>>>,
  maxBreakdownCols = 40,
): Promise<CompileResult | CompileRefusal> {
  const refusal = validateSpec(spec);
  if (refusal) return refusal;

  const measure = MEASURES[spec.measure]!;
  const dim = DIMENSIONS[spec.dimension]!;
  const bd = spec.breakdown ? DIMENSIONS[spec.breakdown] : null;
  const tbl = tableFor(measure.source, db);
  const topN = spec.topN && spec.topN > 0 ? Math.floor(spec.topN) : 50;

  const opSql = (op: SpecThreshold['op']) =>
    op === 'gt' ? '>' : op === 'lt' ? '<' : op === 'gte' ? '>=' : '<=';
  const havingExpr = spec.having
    ? `${measure.value} ${opSql(spec.having.op)} ${Number(spec.having.value) || 0}`
    : null;

  let baseSql: string;

  if (!bd) {
    const where = buildWhere([dim], spec.filters, measure);
    const having = havingExpr ? ` HAVING ${havingExpr}` : '';
    baseSql =
      `SELECT ${dim.labelExpr} AS name, ${measure.value} AS value ` +
      `FROM ${tbl} WHERE ${where} ` +
      `GROUP BY ${dim.groupExpr}${having} ORDER BY ${orderClause(spec, dim)} LIMIT ${topN}`;
  } else {
    const where = buildWhere([dim, bd], spec.filters, measure);
    // HAVING m > 0 keeps out empty/hallucinated breakdown values; a numeric
    // threshold (e.g. "vendors above $50k") narrows which series qualify.
    const having = havingExpr ? `m > 0 AND ${havingExpr.replace(measure.value, 'm')}` : 'm > 0';
    const colRows = await runRows(
      `SELECT ${bd.labelExpr} AS v, ${measure.value} AS m FROM ${tbl} WHERE ${where} ` +
        `GROUP BY ${bd.groupExpr} HAVING ${having} ORDER BY m DESC LIMIT ${maxBreakdownCols}`,
    );
    const cols = colRows
      .map((r) => String((r as any).v ?? ''))
      .filter((v) => v.length > 0);
    if (cols.length === 0) return { ok: false, refusal: 'No data matches that breakdown.' };
    const series = cols
      .map((v) => `${measure.condAgg(`${bd.labelExpr} = ${quoteLit(v)}`)} AS ${quoteIdent(v)}`)
      .join(', ');
    baseSql =
      `SELECT ${dim.labelExpr} AS name, ${series} ` +
      `FROM ${tbl} WHERE ${where} ` +
      `GROUP BY ${dim.groupExpr} ORDER BY ${dim.isTime ? `${dim.groupExpr} ASC` : 'name ASC'} LIMIT ${topN}`;
  }

  const sql = applyTransforms(baseSql, normalizeTransforms(spec.transforms), !bd);
  return { ok: true, sql, measure };
}

// Tolerate the model's shape variance: a transform may arrive as the object form
// ({kind:'normalize'}) or a bare string ('normalize', 'moving_average'). Coerce
// both to the canonical SpecTransform so the compiler always applies them.
function normalizeTransforms(input: ChartSpec['transforms']): SpecTransform[] {
  const out: SpecTransform[] = [];
  for (const t of input ?? []) {
    const kind = typeof t === 'string' ? t : (t as any)?.kind;
    if (kind === 'normalize' || kind === 'growth_pct' || kind === 'reference_line')
      out.push({ kind });
    else if (kind === 'moving_average') {
      const window = typeof (t as any)?.window === 'number' ? (t as any).window : 3;
      out.push({ kind: 'moving_average', window });
    }
  }
  return out;
}

// Transforms wrap the compiled base SQL — identical to how a mature tool layers a
// derived calculation on top of a query, expressed as part of the spec.
function applyTransforms(baseSql: string, transforms: SpecTransform[], singleSeries: boolean): string {
  let sql = baseSql;
  for (const t of transforms) {
    const numericCols = singleSeries ? ['value'] : null; // WIDE handled generically below
    const id = (c: string) => '`' + c.replace(/`/g, '') + '`';
    // Reference CTE columns as _b.`col` so reusing the same OUTPUT alias name
    // (… AS `col`) never resolves back to the alias being defined.
    const ref = (c: string) => '_b.' + id(c);
    const wrap = (proj: string) => `WITH _b AS (\n${sql}\n)\nSELECT ${proj}\nFROM _b\nLIMIT 1000`;
    const seriesCols = () =>
      numericCols ??
      // derive series columns from the SELECT list of the inner query (non-name aliases)
      Array.from(sql.matchAll(/\bAS\s+(?:"([^"]+)"|`([^`]+)`|([a-zA-Z_]\w*))/g))
        .map((m) => m[1] ?? m[2] ?? m[3]!)
        .filter((a) => a && a.toLowerCase() !== 'name');

    if (t.kind === 'normalize') {
      const cols = seriesCols();
      if (cols.length === 1) {
        // Single series: each row as a % of the GRAND total (rows sum to 100).
        const c = cols[0]!;
        sql = wrap(`_b.name AS name, round(${ref(c)} / nullIf(sum(${ref(c)}) OVER (), 0) * 100, 1) AS ${id(c)}`);
      } else {
        // WIDE: each cell as a % of its ROW total (series sum to 100 per row).
        const total = cols.map(ref).join(' + ');
        sql = wrap(['_b.name AS name', ...cols.map((c) => `round(${ref(c)} / nullIf(${total}, 0) * 100, 1) AS ${id(c)}`)].join(', '));
      }
    } else if (t.kind === 'growth_pct') {
      const cols = seriesCols();
      const pct = (c: string) => {
        const prev = `anyOrNull(${ref(c)}) OVER (ROWS BETWEEN 1 PRECEDING AND 1 PRECEDING)`;
        return `round((${ref(c)} - ${prev}) / nullIf(${prev}, 0) * 100, 1) AS ${id(c)}`;
      };
      sql = wrap(['_b.name AS name', ...cols.map(pct)].join(', '));
    } else if (t.kind === 'moving_average') {
      const n = Math.max(2, Math.min(12, t.window || 3));
      const cols = seriesCols();
      const ma = cols.map((c) => `round(avg(${ref(c)}) OVER (ROWS BETWEEN ${n - 1} PRECEDING AND CURRENT ROW), 2) AS ${id(c + `_MA${n}`)}`);
      sql = wrap(['_b.name AS name', ...cols.map((c) => `${ref(c)} AS ${id(c)}`), ...ma].join(', '));
    } else if (t.kind === 'reference_line') {
      const cols = seriesCols();
      const rowTotal = cols.length >= 2 ? `(${cols.map(ref).join(' + ')})` : ref(cols[0]!);
      sql = wrap(['_b.name AS name', ...cols.map((c) => `${ref(c)} AS ${id(c)}`), `round((SELECT avg(${rowTotal}) FROM _b), 2) AS company_average`].join(', '));
    }
  }
  return sql;
}

export const CATALOG = { MEASURES, DIMENSIONS, UNAVAILABLE };

// Human-readable catalog for the planner prompt — generated from the catalog so
// it can never drift from what compileSpec actually supports.
export function catalogPromptText(): string {
  const measures = Object.values(MEASURES)
    .map((m) => `  - ${m.id} (${m.label}, ${m.format})`)
    .join('\n');
  const dims = Object.values(DIMENSIONS)
    .map((d) => `  - ${d.id} (${d.label}${d.isTime ? ', time' : ''})`)
    .join('\n');
  const unavailable = Object.values(UNAVAILABLE).join(', ');
  return [
    'MEASURES (pick exactly one as "measure"):',
    measures,
    'DIMENSIONS (pick one as "dimension"; optionally one as "breakdown" for a series split):',
    dims,
    `NOT AVAILABLE (if the request needs any of these, return a refusal): ${unavailable}.`,
    'ACCOUNT-TYPE GROUPS — when the user names a balance-sheet/P&L group, set dimension="account_type" AND a filter {dimension:"account_type", op:"in", values:[...exact values...]}:',
    '  - assets: Bank, Accounts Receivable, Other Current Asset, Fixed Asset, Other Asset',
    '  - liabilities: Accounts Payable, Long Term Liability, Other Current Liability',
    '  - equity: Equity',
    '  - income: Income',
    '  - expenses: Expense, Cost of Goods Sold',
    'THRESHOLD (optional): to keep only rows/series whose measure passes a number ("above $50k", "more than 100 transactions", "under $1k"), set having:{op:"gt"|"lt"|"gte"|"lte", value:<number>}.',
    'TRANSFORMS (optional): normalize, growth_pct, moving_average(window), reference_line.',
    'CHART TYPES: bar, horizontal_bar, line, area, pie, donut, scatter, treemap, heatmap, matrix, stacked_bar, stacked_area, waterfall, kpi.',
  ].join('\n');
}
