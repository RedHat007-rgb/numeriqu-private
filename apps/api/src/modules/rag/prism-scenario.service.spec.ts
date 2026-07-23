import { ConfigService } from '@nestjs/config';
import { PrismScenarioService } from './prism-scenario.service';

describe('PrismScenarioService', () => {
  const service = new PrismScenarioService(new ConfigService());

  it('compounds explicit assumptions with decimal arithmetic', () => {
    const result = service.evaluate({
      baseline: '1000',
      unit: 'currency',
      currency: 'USD',
      assumptions: [
        { label: 'Price', basisPoints: 1000 },
        { label: 'Volume', basisPoints: -500 },
      ],
    });

    expect(result.result).toBe('1045');
    expect(result.totalImpact).toBe('45');
    expect(result.authority).toBe('user_assumptions');
  });

  it('does not assume a currency', () => {
    expect(() =>
      service.evaluate({
        baseline: '1000',
        unit: 'currency',
        assumptions: [{ label: 'Growth', basisPoints: 100 }],
      }),
    ).toThrow('Currency scenarios require');
  });
});
