import { ConfigService } from '@nestjs/config';
import { PrismRuntimeService } from './prism-runtime.service';

describe('Prism runtime cache', () => {
  it('single-flights and caches the same tenant-scoped calculation', async () => {
    const runtime = new PrismRuntimeService(
      new ConfigService({ PRISM_CACHE_TTL_SECONDS: '60' }),
    );
    let calculations = 0;
    const identity = {
      organizationId: 'org-a',
      capability: 'revenue',
      period: 'YTD',
      semanticVersion: 'v1',
      sourceWatermark: 'sync-1',
    };
    const compute = async () => {
      calculations += 1;
      await Promise.resolve();
      return { value: 100 };
    };
    const [first, second] = await Promise.all([
      runtime.cached(identity, compute),
      runtime.cached(identity, compute),
    ]);
    expect(first).toEqual({ value: 100 });
    expect(second).toEqual(first);
    expect(calculations).toBe(1);
    await expect(runtime.cached(identity, compute)).resolves.toEqual(first);
    expect(calculations).toBe(1);
    await runtime.onModuleDestroy();
  });

  it('isolates cache identities by organization and source watermark', async () => {
    const runtime = new PrismRuntimeService(new ConfigService({}));
    let calculations = 0;
    const compute = async () => ({ value: ++calculations });
    const base = {
      capability: 'revenue',
      period: 'YTD',
      semanticVersion: 'v1',
      sourceWatermark: 'sync-1',
    };
    await runtime.cached({ ...base, organizationId: 'org-a' }, compute);
    await runtime.cached({ ...base, organizationId: 'org-b' }, compute);
    await runtime.cached(
      { ...base, organizationId: 'org-a', sourceWatermark: 'sync-2' },
      compute,
    );
    expect(calculations).toBe(3);
    await runtime.onModuleDestroy();
  });
});
