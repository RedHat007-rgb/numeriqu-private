import type { EngineAnswer } from '../chart-engine/chart-engine.service';
import { capabilityAnswerEnvelope } from './prism-presenter';

const evidence = {
  status: 'verified' as const,
  period: 'YTD',
  calculatedAt: '2026-07-22T00:00:00.000Z',
  checks: [
    { code: 'tenant_scope' as const, passed: true },
    { code: 'unit_validation' as const, passed: true },
  ],
  limitations: [],
};

function answer(
  rows: Array<Record<string, unknown>>,
  measures: Extract<EngineAnswer, { ok: true }>['measures'],
): Extract<EngineAnswer, { ok: true }> {
  return {
    ok: true,
    routedView: 'governed_view',
    spec: {} as Extract<EngineAnswer, { ok: true }>['spec'],
    sql: 'SELECT governed_metrics',
    nameValueSql: 'SELECT name, value',
    dynamicSql: 'SELECT period, value',
    title: 'Finance performance',
    chartType: 'line',
    widgetChartType: 'line',
    display: {} as Extract<EngineAnswer, { ok: true }>['display'],
    valueFormat: 'percent',
    mode: 'create',
    rows,
    measures,
  };
}

describe('Prism presenter', () => {
  it('normalizes stored ratios into percentage points exactly once', () => {
    const result = capabilityAnswerEnvelope(
      answer(
        [
          { month: 'Jan', gross_margin: 0.425 },
          { month: 'Feb', gross_margin: 0.5 },
        ],
        [
          {
            key: 'gross_margin',
            label: 'Gross margin',
            unit: '%',
            valueRepresentation: 'ratio',
          },
        ],
      ),
      'YTD',
      'professional',
      evidence,
    );

    expect(result.metrics).toEqual([]);
    expect(result.visualization?.rows).toEqual([
      { month: 'Jan', gross_margin: 42.5 },
      { month: 'Feb', gross_margin: 50 },
    ]);
  });

  it('formats a single-row ratio KPI as percentage points', () => {
    const result = capabilityAnswerEnvelope(
      answer(
        [{ period: 'YTD', gross_margin: 0.425 }],
        [
          {
            key: 'gross_margin',
            label: 'Gross margin',
            unit: '%',
            valueRepresentation: 'ratio',
          },
        ],
      ),
      'YTD',
      'professional',
      evidence,
    );

    expect(result.metrics[0]).toMatchObject({
      value: 42.5,
      formattedValue: '42.5%',
      unit: 'percent',
    });
  });

  it('uses a table when measures have unlike units', () => {
    const result = capabilityAnswerEnvelope(
      answer(
        [{ month: 'Jan', revenue: 100, margin: 25 }],
        [
          {
            key: 'revenue',
            label: 'Revenue',
            unit: 'USD',
            valueRepresentation: 'native',
          },
          {
            key: 'margin',
            label: 'Margin',
            unit: '%',
            valueRepresentation: 'percentage_points',
          },
        ],
      ),
      'YTD',
      'professional',
      evidence,
    );

    expect(result.visualization?.kind).toBe('table');
  });

  it('does not turn missing values into zero', () => {
    const result = capabilityAnswerEnvelope(
      answer(
        [{ period: 'YTD', revenue: null }],
        [
          {
            key: 'revenue',
            label: 'Revenue',
            unit: 'USD',
            valueRepresentation: 'native',
          },
        ],
      ),
      'YTD',
      'professional',
      evidence,
    );

    expect(result.metrics[0]).toMatchObject({
      value: null,
      formattedValue: 'Unavailable',
    });
  });
});
