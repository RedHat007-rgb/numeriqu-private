import type { EngineAnswer } from '../chart-engine/chart-engine.service';
import {
  PRISM_CONTRACT_VERSION,
  PRISM_SEMANTIC_VERSION,
  type PrismAnswerEnvelope,
  type PrismEvidenceSummary,
  type PrismUnit,
} from './prism-contracts';
import type { PrismTone } from './prism-policy';
import { formatPrismMoney, formatPrismPercentage } from './prism-calculations';

function unitFor(
  measure: Extract<EngineAnswer, { ok: true }>['measures'][number],
): PrismUnit {
  if (measure.unit === '%') return 'percent';
  if (measure.unit === 'count') return 'count';
  if (measure.unit.toLowerCase().includes('day')) return 'days';
  if (/^[A-Z]{3}$/.test(measure.unit)) return 'currency';
  return 'number';
}

function formatted(
  value: number | null,
  unit: PrismUnit,
  currency?: string,
): string {
  if (value === null || !Number.isFinite(value)) return 'Unavailable';
  if (unit === 'currency') return formatPrismMoney(value, currency ?? null);
  if (unit === 'percent') return formatPrismPercentage(value);
  return new Intl.NumberFormat('en', { maximumFractionDigits: 2 }).format(
    value,
  );
}

function numericValue(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function presentationValue(
  value: unknown,
  measure: Extract<EngineAnswer, { ok: true }>['measures'][number],
): number | null {
  const numeric = numericValue(value);
  if (numeric === null) return null;
  return measure.unit === '%' && measure.valueRepresentation === 'ratio'
    ? numeric * 100
    : numeric;
}

export function capabilityAnswerEnvelope(
  answer: Extract<EngineAnswer, { ok: true }>,
  period: string,
  tone: PrismTone,
  evidence: PrismEvidenceSummary,
): PrismAnswerEnvelope {
  const first = answer.rows[0] ?? {};
  const measureKeys = new Set(answer.measures.map((measure) => measure.key));
  const dimensionKey = Object.keys(first).find((key) => !measureKeys.has(key));
  // A row-level value must never masquerade as a period total. KPI cards are
  // emitted only when the result itself is a single aggregate row.
  const metrics =
    answer.rows.length === 1
      ? answer.measures.map((measure) => {
          const value = presentationValue(first[measure.key], measure);
          const unit = unitFor(measure);
          const currency = /^[A-Z]{3}$/.test(measure.unit)
            ? measure.unit
            : undefined;
          return {
            key: measure.key,
            label: measure.label,
            value,
            formattedValue: formatted(value, unit, currency),
            unit,
            ...(currency ? { currency } : {}),
          };
        })
      : [];
  const chartKind = ['line', 'area'].includes(answer.widgetChartType)
    ? 'line'
    : ['bar', 'horizontal_bar', 'stacked_bar'].includes(answer.widgetChartType)
      ? 'bar'
      : 'table';
  const seriesUnits = new Set(answer.measures.map(unitFor));
  const safeChartKind = seriesUnits.size > 1 ? 'table' : chartKind;
  const hasVisualization = answer.rows.length > 1 || Boolean(dimensionKey);
  const presentationRows = answer.rows.slice(0, 100).map((row) => {
    const presented: Record<string, string | number | null> = {};
    for (const [key, value] of Object.entries(row)) {
      if (value === null || typeof value === 'string') presented[key] = value;
      if (typeof value === 'number') {
        presented[key] = Number.isFinite(value) ? value : null;
      }
    }
    for (const measure of answer.measures) {
      presented[measure.key] = presentationValue(row[measure.key], measure);
    }
    return presented;
  });

  return {
    contractVersion: PRISM_CONTRACT_VERSION,
    semanticVersion: PRISM_SEMANTIC_VERSION,
    tone,
    title: answer.title,
    period,
    metrics,
    ...(hasVisualization
      ? {
          visualization: {
            // A single Cartesian axis must never imply that unlike units are
            // directly comparable. Mixed-unit results remain an exact table.
            kind: safeChartKind,
            title: answer.title,
            dimensionLabel: dimensionKey
              ? dimensionKey.replaceAll('_', ' ')
              : 'Category',
            rows: presentationRows,
            series: answer.measures.map((measure) => {
              const unit = unitFor(measure);
              return {
                key: measure.key,
                label: measure.label,
                unit,
                ...(/^[A-Z]{3}$/.test(measure.unit)
                  ? { currency: measure.unit }
                  : {}),
              };
            }),
          },
        }
      : {}),
    evidence,
    actions: [
      {
        id: 'compare_period',
        label: 'Compare period',
        prompt: `Compare ${answer.title} with the previous period.`,
      },
      {
        id: 'explain_drivers',
        label: 'Explain drivers',
        prompt: `Explain the verified drivers of ${answer.title}.`,
      },
      {
        id: 'create_briefing',
        label: 'Create briefing',
        prompt: `Create an executive finance briefing for ${answer.title}.`,
      },
    ],
  };
}
