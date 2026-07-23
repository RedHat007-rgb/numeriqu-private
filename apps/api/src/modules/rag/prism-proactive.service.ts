import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@repo/db';
import { ConfigService } from '@nestjs/config';
import { PRISMA_TOKEN } from '../../database/database.module';

@Injectable()
export class PrismProactiveService {
  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient,
    private readonly config: ConfigService,
  ) {}

  async opportunities(organizationId: string) {
    const configured = Number(
      this.config.get<string>('PRISM_PROACTIVE_SUGGESTION_LIMIT'),
    );
    const take =
      Number.isInteger(configured) && configured > 0 ? configured : 4;
    const signals = await this.prisma.signal.findMany({
      where: {
        organizationId,
        status: { in: ['NEW', 'ACKNOWLEDGED', 'INVESTIGATING'] },
        evidenceComputedAt: { not: null },
      },
      orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }],
      take,
      select: {
        id: true,
        title: true,
        severity: true,
        evidenceComputedAt: true,
      },
    });
    return signals.map((signal) => ({
      id: signal.id,
      label: signal.title,
      severity: signal.severity,
      prompt: `Analyze the verified finance signal: ${signal.title}`,
      dataAsOf: signal.evidenceComputedAt!.toISOString(),
    }));
  }
}
