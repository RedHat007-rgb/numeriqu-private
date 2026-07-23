import {
  PRISM_CONTRACT_VERSION,
  PRISM_SEMANTIC_VERSION,
  type PrismAnswerEnvelope,
} from './prism-contracts';

const INTERNAL_DISCLOSURE =
  /\b(select\s+.+\s+from|tenant_id|connection_id|query_params|system prompt|openai_api_key|clickhouse|prisma\.)\b/i;

export type PrismOutputValidation =
  | { ok: true }
  | { ok: false; reasons: string[] };

export function validatePrismOutput(
  answer: PrismAnswerEnvelope,
  markdown: string,
): PrismOutputValidation {
  const reasons: string[] = [];
  if (answer.contractVersion !== PRISM_CONTRACT_VERSION)
    reasons.push('contract_version');
  if (answer.semanticVersion !== PRISM_SEMANTIC_VERSION)
    reasons.push('semantic_version');
  if (INTERNAL_DISCLOSURE.test(markdown)) reasons.push('internal_disclosure');
  for (const metric of answer.metrics) {
    if (metric.value !== null && !Number.isFinite(metric.value))
      reasons.push(`non_finite:${metric.key}`);
    if (metric.unit === 'percent' && /[$€£¥]/.test(metric.formattedValue))
      reasons.push(`percent_as_currency:${metric.key}`);
    if (metric.unit === 'currency' && metric.formattedValue.includes('%'))
      reasons.push(`currency_as_percent:${metric.key}`);
  }
  for (const row of answer.visualization?.rows ?? []) {
    for (const [key, value] of Object.entries(row)) {
      if (typeof value === 'number' && !Number.isFinite(value))
        reasons.push(`non_finite_row:${key}`);
    }
  }
  return reasons.length ? { ok: false, reasons } : { ok: true };
}
