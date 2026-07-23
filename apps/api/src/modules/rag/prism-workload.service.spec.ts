import { ConfigService } from '@nestjs/config';
import { PrismWorkloadService } from './prism-workload.service';

describe('Prism workload bulkheads', () => {
  it('enforces organization concurrency independently', async () => {
    const workload = new PrismWorkloadService(
      new ConfigService({
        PRISM_GLOBAL_CONCURRENCY: '4',
        PRISM_ORGANIZATION_CONCURRENCY: '1',
      }),
    );
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => (release = resolve));
    const first = workload.withPermit('org-a', () => blocker);
    await expect(
      workload.withPermit('org-a', async () => 'second'),
    ).rejects.toThrow(/capacity/i);
    await expect(
      workload.withPermit('org-b', async () => 'other tenant'),
    ).resolves.toBe('other tenant');
    release();
    await first;
  });
});
