type ChartTypeHint = string | null | undefined;

export type DynamicSqlValidationOptions = {
  analyticsDb: string;
  chartType?: ChartTypeHint;
  requireNameValue?: boolean;
};

const ORG_PLACEHOLDER_RE =
  /\{externalOrgIds\s*:\s*Array\s*\(\s*String\s*\)\s*\}/i;
const TENANT_PLACEHOLDER_RE = /\{tenantId\s*:\s*String\s*\}/i;

function stripCodeFences(s: string): string {
  return s.replace(/```(?:sql|json)?/gi, '').replace(/```/g, '');
}

function normalizeSql(raw: string): string {
  return stripCodeFences(String(raw ?? ''))
    .trim()
    .replace(/;+$/, '')
    .trim();
}

function hasMultipleStatements(sql: string): boolean {
  // We already stripped trailing semicolons; any remaining semicolon is suspicious.
  return /;/.test(sql);
}

function isTableChart(chartType?: ChartTypeHint): boolean {
  return String(chartType ?? '').toLowerCase() === 'table';
}

function enforceSameDatabase(sql: string, analyticsDb: string) {
  const db = String(analyticsDb || 'analytics').trim();
  const re = /\b(?:FROM|JOIN)\s+([a-zA-Z0-9_]+)\.[a-zA-Z0-9_]+/gi;
  for (const m of sql.matchAll(re)) {
    const usedDb = String(m[1] ?? '').trim();
    if (!usedDb) continue;
    if (usedDb !== db) {
      throw new Error(
        `Dynamic SQL must only read from "${db}.*" (found "${usedDb}.*")`,
      );
    }
  }
}

function enforceScopedPredicates(sql: string) {
  // Require the actual predicates, not just the placeholders somewhere in a string.
  const hasTenantPredicate =
    /\btenant_id\s*=\s*\{tenantId\s*:\s*String\s*\}/i.test(sql) ||
    /\btenant_id\s*=\s*\{tenantId:String\}/i.test(sql);

  const hasOrgPredicate =
    /\borg_id\s+IN\s*\(\s*\{externalOrgIds\s*:\s*Array\s*\(\s*String\s*\)\s*\}\s*\)/i.test(
      sql,
    ) || /\borg_id\s+IN\s*\(\s*\{externalOrgIds:Array\(String\)\}\s*\)/i.test(sql);

  if (!hasTenantPredicate)
    throw new Error('Dynamic SQL missing tenant_id scope predicate');
  if (!hasOrgPredicate)
    throw new Error('Dynamic SQL missing org_id scope predicate');
}

function enforceOutputShape(sql: string) {
  // We need at least a stable dimension label and a metric for charting.
  const hasName = /\bAS\s+name\b/i.test(sql);
  if (!hasName)
    throw new Error('Dynamic SQL must alias the label column as "name"');

  // Single-series charts must alias the metric as "value". Multi-series (WIDE)
  // charts — comparisons, multi-line growth — instead have one column PER SERIES
  // (e.g. AS admin, AS operations) and no "value"; allow those when there are at
  // least two non-"name" output aliases. The frontend infers numeric series keys.
  const hasValue = /\bAS\s+value\b/i.test(sql);
  if (hasValue) return;

  const aliases = Array.from(sql.matchAll(/\bAS\s+([a-zA-Z_][a-zA-Z0-9_]*)/gi))
    .map((m) => m[1]!.toLowerCase())
    .filter((a) => a !== 'name');
  const distinctSeries = new Set(aliases).size;
  if (distinctSeries < 2)
    throw new Error(
      'Dynamic SQL must alias the metric as "value", or provide >=2 named series columns for a multi-series chart',
    );
}

export function validateDynamicSql(
  rawSql: string,
  options: DynamicSqlValidationOptions,
): string {
  const normalized = normalizeSql(rawSql);
  if (!normalized) throw new Error('Dynamic SQL is empty');

  if (hasMultipleStatements(normalized))
    throw new Error('Dynamic SQL must be a single SELECT statement');

  // Read-only queries must start with SELECT or a WITH (CTE) that resolves to a
  // SELECT. CTEs are needed for month-over-month growth, running totals, etc.
  if (!/^\s*(SELECT|WITH)\b/i.test(normalized))
    throw new Error('Dynamic SQL must start with SELECT or WITH');
  if (/^\s*WITH\b/i.test(normalized) && !/\bSELECT\b/i.test(normalized))
    throw new Error('WITH (CTE) query must contain a SELECT');

  if (
    /\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|REPLACE|OPTIMIZE|ATTACH|DETACH)\b/i.test(
      normalized,
    )
  )
    throw new Error('Dynamic SQL must not contain mutation statements');

  if (
    /\bsystem\s*\.\s*\w+/i.test(normalized) ||
    /\binformation_schema\b/i.test(normalized)
  )
    throw new Error('Dynamic SQL must not access system tables');

  if (!/\bLIMIT\s+\d+\b/i.test(normalized))
    throw new Error('Dynamic SQL must include LIMIT clause');

  if (!ORG_PLACEHOLDER_RE.test(normalized))
    throw new Error('Dynamic SQL missing externalOrgIds param placeholder');
  if (!TENANT_PLACEHOLDER_RE.test(normalized))
    throw new Error('Dynamic SQL missing tenantId param placeholder');

  enforceSameDatabase(normalized, options.analyticsDb);
  enforceScopedPredicates(normalized);

  const mustHaveNameValue =
    typeof options.requireNameValue === 'boolean'
      ? options.requireNameValue
      : !isTableChart(options.chartType);
  if (mustHaveNameValue) enforceOutputShape(normalized);

  return normalized;
}

// The planner is instructed to scope every query, but the LLM frequently writes
// only the org_id predicate (most prompt examples show org_id alone). The
// validator requires BOTH tenant_id and org_id predicates, and the tenantId
// param is always supplied at execution — so when the tenant predicate is
// missing we inject it immediately before each org predicate. Without this,
// every planner widget is rejected and the agent silently falls back to generic
// charts.
export function injectTenantScopePredicate(sql: string): string {
  const s = String(sql ?? '');
  // Already has a proper `tenant_id = {tenantId:String}` predicate — leave it.
  if (/\btenant_id\s*=\s*\{tenantId\s*:\s*String\s*\}/i.test(s)) return s;
  return s.replace(
    /\borg_id\s+IN\s*\(\s*\{externalOrgIds\s*:\s*Array\s*\(\s*String\s*\)\s*\}\s*\)/gi,
    'tenant_id = {tenantId:String} AND org_id IN ({externalOrgIds:Array(String)})',
  );
}

export function rewriteRelativeNowToAsOf(sql: string): string {
  // Replace time-relative functions so stale datasets (demo data) don't go empty in 2026+.
  // Use the query param {asOf:String} so we don't bake values into stored SQL.
  let out = String(sql ?? '');
  out = out.replace(/\bnow\s*\(\s*\)/gi, 'toDateTime({asOf:String})');
  out = out.replace(
    /\btoday\s*\(\s*\)/gi,
    'toDate(toDateTime({asOf:String}))',
  );
  return out;
}

export function sqlUsesNowOrToday(sql: string): boolean {
  return /\bnow\s*\(\s*\)|\btoday\s*\(\s*\)/i.test(String(sql ?? ''));
}

