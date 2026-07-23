import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma, PrismaClient } from '@repo/db';
import { PRISMA_TOKEN } from '../../database/database.module';
import { PrismJobsService } from './prism-jobs.service';
import { PRISM_BRIEFING_VERSION } from './prism-contracts';

@Injectable()
export class PrismBriefingWorker {
  private readonly logger = new Logger(PrismBriefingWorker.name);

  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient,
    private readonly jobs: PrismJobsService,
    private readonly config: ConfigService,
  ) {}

  async processOne(): Promise<boolean> {
    const job = await this.jobs.claimNext(['BRIEFING']);
    if (!job) return false;
    try {
      const signals = await this.prisma.signal.findMany({
        where: {
          organizationId: job.organizationId,
          status: { in: ['NEW', 'ACKNOWLEDGED', 'INVESTIGATING'] },
        },
        orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }],
        take: this.positiveInt('PRISM_BRIEFING_SIGNAL_LIMIT', 12),
        include: { signalMetric: true },
      });
      const severityCounts = signals.reduce<Record<string, number>>(
        (counts, signal) => {
          counts[signal.severity] = (counts[signal.severity] ?? 0) + 1;
          return counts;
        },
        {},
      );
      const result = {
        contractVersion: PRISM_BRIEFING_VERSION,
        generatedAt: new Date().toISOString(),
        organizationId: job.organizationId,
        headline: `${signals.length} active finance signal${signals.length === 1 ? '' : 's'} require attention.`,
        severityCounts,
        items: signals.map((signal) => ({
          id: signal.id,
          title: signal.title,
          severity: signal.severity,
          metric: signal.signalMetric.label,
          impactAmount: Number(signal.impactAmount),
          evidenceComputedAt: signal.evidenceComputedAt?.toISOString() ?? null,
        })),
      } satisfies Prisma.JsonObject;
      await this.jobs.complete(job.id, result);
      return true;
    } catch (error) {
      this.logger.error(
        `Briefing job ${job.id} failed: ${error instanceof Error ? error.message : 'unknown'}`,
      );
      await this.jobs.fail(job.id, 'BRIEFING_GENERATION_FAILED');
      return true;
    }
  }

  async run(signal: AbortSignal): Promise<void> {
    const pollMs = this.positiveInt('PRISM_WORKER_POLL_MS', 1_000);
    while (!signal.aborted) {
      const processed = await this.processOne();
      if (!processed) await this.delay(pollMs, signal);
    }
  }

  private async delay(ms: number, signal: AbortSignal) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }

  private positiveInt(key: string, fallback: number): number {
    const configured = Number(this.config.get<string>(key));
    return Number.isInteger(configured) && configured > 0
      ? configured
      : fallback;
  }
}
