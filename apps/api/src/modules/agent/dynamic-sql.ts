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
  // We need at least a stable dimension label and metric for charting.
  // For multi-series, additional numeric columns are fine.
  const hasName = /\bAS\s+name\b/i.test(sql);
  const hasValue = /\bAS\s+value\b/i.test(sql);
  if (!hasName || !hasValue)
    throw new Error('Dynamic SQL must alias columns as "name" and "value"');
}

export function validateDynamicSql(
  rawSql: string,
  options: DynamicSqlValidationOptions,
): string {
  const normalized = normalizeSql(rawSql);
  if (!normalized) throw new Error('Dynamic SQL is empty');

  if (hasMultipleStatements(normalized))
    throw new Error('Dynamic SQL must be a single SELECT statement');

  if (!/^\s*SELECT\b/i.test(normalized))
    throw new Error('Dynamic SQL must start with SELECT');

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

