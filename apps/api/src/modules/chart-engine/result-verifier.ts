/**
 * ResultVerifier — the grounding safety net. After the compiler's SQL runs, we
 * (a) confirm the query was tenant-scoped and (b) reconcile the charted headline
 * against a recomputation from the returned rows, refusing to chart a number
 * that doesn't tie out. See docs/TARGET_ARCHITECTURE.md §4⑦ and §5.
 *
 * Pure & deterministic — the live executor calls these with real rows.
 */

import { SCOPE_WHERE } from './spec-compiler';
import type { MeasureExpr } from './semantic-model.types';

export interface Reconciliation {
  ok: boolean;
  recomputed: number;
  charted: number;
  relDelta: number;
  tolerance: number;
}

/**
 * Reconcile an ADDITIVE headline: the sum of the per-group parts must equal the
 * charted total (within tolerance). This is the "sum of the bars = the total"
 * trust check that catches silent aggregation drift.
 */
export function reconcileAdditive(
  parts: number[],
  charted: number,
  tolerance = 0.01,
): Reconciliation {
  const recomputed = parts.reduce(
    (a, b) => a + (Number.isFinite(b) ? b : 0),
    0,
  );
  const denom = Math.max(Math.abs(charted), 1e-9);
  const relDelta = Math.abs(recomputed - charted) / denom;
  return {
    ok: relDelta <= tolerance,
    recomputed,
    charted,
    relDelta,
    tolerance,
  };
}

/**
 * Reconcile a RATIO headline from its components: ratio must equal
 * SUM(numerator)/SUM(denominator) — NOT the average of per-row ratios. Passing
 * the raw component sums here is what makes the avg-of-ratios bug impossible to
 * reintroduce silently.
 */
export function reconcileRatio(
  sumNumerator: number,
  sumDenominator: number,
  charted: number,
  tolerance = 0.01,
): Reconciliation {
  const recomputed = sumDenominator === 0 ? 0 : sumNumerator / sumDenominator;
  const denom = Math.max(Math.abs(charted), 1e-9);
  const relDelta = Math.abs(recomputed - charted) / denom;
  return {
    ok: relDelta <= tolerance,
    recomputed,
    charted,
    relDelta,
    tolerance,
  };
}

/** Defense-in-depth: the executed SQL must carry the tenant scope predicate. */
export function verifyScoped(sql: string): { ok: boolean; reason?: string } {
  const hasTenant = /tenant_id\s*=\s*\{tenantId:String\}/.test(sql);
  const hasOrg = /org_id\s+IN\s+\(\{externalOrgIds:Array\(String\)\}\)/i.test(
    sql,
  );
  if (hasTenant && hasOrg) return { ok: true };
  return {
    ok: false,
    reason: `query is not tenant-scoped (expected: ${SCOPE_WHERE})`,
  };
}

/** Pick the reconciliation appropriate to a measure's expression kind. */
export function reconcileForExpr(
  expr: MeasureExpr,
  data: {
    parts?: number[];
    sumNumerator?: number;
    sumDenominator?: number;
    charted: number;
  },
): Reconciliation | { skipped: string } {
  switch (expr.kind) {
    case 'sum':
    case 'sum_if':
      return data.parts
        ? reconcileAdditive(data.parts, data.charted)
        : { skipped: 'no parts to reconcile' };
    case 'ratio_of_sums':
    case 'ratio_of_sum_to_total':
      return typeof data.sumNumerator === 'number' &&
        typeof data.sumDenominator === 'number'
        ? reconcileRatio(data.sumNumerator, data.sumDenominator, data.charted)
        : { skipped: 'no ratio components to reconcile' };
    case 'count_distinct':
    case 'last_value':
    case 'max':
    case 'mean':
    case 'ratio_of_aggs':
      // Not linearly reconcilable from parts (a mean of parts ≠ the grand mean,
      // a stock is a level, a distinct-count doesn't add, a composed ratio mixes
      // aggregations); scope check still applies.
      return { skipped: `${expr.kind} is not part-reconcilable` };
  }
}
