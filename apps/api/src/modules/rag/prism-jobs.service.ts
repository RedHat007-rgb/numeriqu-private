import { Inject, Injectable } from '@nestjs/common';
import { Prisma, type PrismaClient, type PrismJobType } from '@repo/db';
import { PRISMA_TOKEN } from '../../database/database.module';

export type PrismJobPayload = {
  prompt: string;
  period?: string;
  tone?: string;
};

@Injectable()
export class PrismJobsService {
  constructor(@Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient) {}

  async enqueue(params: {
    organizationId: string;
    userId: string;
    type: PrismJobType;
    idempotencyKey: string;
    payload: PrismJobPayload;
  }) {
    const existing = await this.prisma.prismJob.findUnique({
      where: {
        organizationId_idempotencyKey: {
          organizationId: params.organizationId,
          idempotencyKey: params.idempotencyKey,
        },
      },
    });
    if (existing) return existing;

    return this.prisma.$transaction(async (transaction) => {
      const job = await transaction.prismJob.create({
        data: {
          organizationId: params.organizationId,
          userId: params.userId,
          type: params.type,
          idempotencyKey: params.idempotencyKey,
          payload: params.payload as Prisma.InputJsonValue,
        },
      });
      await transaction.prismOutboxEvent.create({
        data: {
          organizationId: params.organizationId,
          aggregateType: 'PrismJob',
          aggregateId: job.id,
          topic: `prism.job.${params.type.toLowerCase()}.queued`,
          payload: { jobId: job.id } as Prisma.InputJsonValue,
        },
      });
      return job;
    });
  }

  async get(organizationId: string, userId: string, id: string) {
    return this.prisma.prismJob.findFirst({
      where: { id, organizationId, userId },
    });
  }

  async claimNext(types: PrismJobType[]) {
    return this.prisma.$transaction(async (transaction) => {
      const rows = await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT id
        FROM prism_jobs
        WHERE status = 'QUEUED'
          AND available_at <= NOW()
          AND type::text IN (${Prisma.join(types)})
        ORDER BY created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      `;
      const id = rows[0]?.id;
      if (!id) return null;
      return transaction.prismJob.update({
        where: { id },
        data: {
          status: 'RUNNING',
          startedAt: new Date(),
          attempts: { increment: 1 },
        },
      });
    });
  }

  async complete(id: string, result: Prisma.InputJsonValue) {
    return this.prisma.prismJob.update({
      where: { id },
      data: { status: 'SUCCEEDED', result, completedAt: new Date() },
    });
  }

  async fail(id: string, errorCode: string) {
    return this.prisma.prismJob.update({
      where: { id },
      data: { status: 'FAILED', errorCode, completedAt: new Date() },
    });
  }
}
