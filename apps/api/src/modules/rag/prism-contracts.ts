import type { PrismTone } from './prism-policy';

export const PRISM_CONTRACT_VERSION = '2026-07-22' as const;
export const PRISM_POLICY_VERSION = 'finance-policy-1' as const;
export const PRISM_PROMPT_VERSION = 'finance-planner-1' as const;
export const PRISM_SEMANTIC_VERSION = 'governed-semantic-1' as const;
export const PRISM_BRIEFING_VERSION = 'prism-briefing-1' as const;

export type PrismUnit = 'currency' | 'percent' | 'number' | 'days' | 'count';

export type PrismMetricView = {
  key: string;
  label: string;
  value: number | null;
  formattedValue: string;
  unit: PrismUnit;
  currency?: string;
};

export type PrismVisualization = {
  kind: 'line' | 'bar' | 'table';
  title: string;
  dimensionLabel: string;
  rows: Array<Record<string, string | number | null>>;
  series: Array<{
    key: string;
    label: string;
    unit: PrismUnit;
    currency?: string;
  }>;
};

export type PrismEvidenceSummary = {
  status: 'verified' | 'partial' | 'unavailable';
  period: string;
  calculatedAt: string;
  checks: Array<{
    code:
      | 'tenant_scope'
      | 'governed_metric'
      | 'unit_validation'
      | 'reconciliation';
    passed: boolean;
  }>;
  limitations: string[];
};

export type PrismAnswerEnvelope = {
  contractVersion: typeof PRISM_CONTRACT_VERSION;
  semanticVersion: typeof PRISM_SEMANTIC_VERSION;
  tone: PrismTone;
  title: string;
  period: string;
  metrics: PrismMetricView[];
  visualization?: PrismVisualization;
  evidence: PrismEvidenceSummary;
  actions: Array<{
    id: 'compare_period' | 'explain_drivers' | 'create_briefing';
    label: string;
    prompt: string;
  }>;
};

export interface PrismPlanningPort {
  plan(query: string, signal?: AbortSignal): Promise<unknown>;
}

export interface PrismPresentationPort {
  render(answer: PrismAnswerEnvelope): string;
}
