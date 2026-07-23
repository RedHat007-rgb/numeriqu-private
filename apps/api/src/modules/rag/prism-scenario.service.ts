import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Decimal from 'decimal.js-light';

export type PrismScenarioAssumption = {
  label: string;
  basisPoints: number;
};

@Injectable()
export class PrismScenarioService {
  constructor(private readonly config: ConfigService) {}

  evaluate(input: {
    baseline: string;
    unit: 'currency' | 'percent' | 'number';
    currency?: string;
    assumptions: PrismScenarioAssumption[];
  }) {
    const limit = this.positiveInt('PRISM_SCENARIO_ASSUMPTION_LIMIT', 12);
    if (input.assumptions.length === 0 || input.assumptions.length > limit) {
      throw new BadRequestException(
        `A scenario requires between 1 and ${limit} assumptions.`,
      );
    }
    if (
      input.unit === 'currency' &&
      (!input.currency || !/^[A-Z]{3}$/.test(input.currency))
    ) {
      throw new BadRequestException(
        'Currency scenarios require an ISO 4217 currency code.',
      );
    }

    let combined = new Decimal(input.baseline);
    const baseline = combined;
    const steps = input.assumptions.map((assumption) => {
      const before = combined;
      const multiplier = new Decimal(assumption.basisPoints)
        .div(10_000)
        .plus(1);
      combined = before.mul(multiplier);
      return {
        label: assumption.label,
        basisPoints: assumption.basisPoints,
        before: before.toString(),
        after: combined.toString(),
        impact: combined.minus(before).toString(),
      };
    });

    return {
      contractVersion: 'prism-scenario-1' as const,
      authority: 'user_assumptions' as const,
      unit: input.unit,
      ...(input.currency ? { currency: input.currency } : {}),
      baseline: baseline.toString(),
      result: combined.toString(),
      totalImpact: combined.minus(baseline).toString(),
      steps,
      formula:
        'Each change is applied sequentially as previous value × (1 + basis points ÷ 10,000).',
    };
  }

  private positiveInt(key: string, fallback: number): number {
    const configured = Number(this.config.get<string>(key));
    return Number.isInteger(configured) && configured > 0
      ? configured
      : fallback;
  }
}
