import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  type PrismApprovalDecision,
  type PrismaClient,
} from '@repo/db';
import { PRISMA_TOKEN } from '../../database/database.module';

@Injectable()
export class PrismActionService {
  constructor(@Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient) {}

  async propose(input: {
    organizationId: string;
    userId: string;
    sourceRequestId: string;
    actionType: string;
    summary: string;
    preview: Prisma.InputJsonValue;
    riskLevel: string;
  }) {
    return this.prisma.prismActionProposal.upsert({
      where: {
        organizationId_sourceRequestId: {
          organizationId: input.organizationId,
          sourceRequestId: input.sourceRequestId,
        },
      },
      create: {
        organizationId: input.organizationId,
        createdById: input.userId,
        sourceRequestId: input.sourceRequestId,
        actionType: input.actionType,
        summary: input.summary,
        preview: input.preview,
        riskLevel: input.riskLevel,
      },
      update: {},
      include: { approvals: true },
    });
  }

  async decide(input: {
    organizationId: string;
    userId: string;
    proposalId: string;
    decision: PrismApprovalDecision;
    rationale?: string;
  }) {
    return this.prisma.$transaction(async (transaction) => {
      const proposal = await transaction.prismActionProposal.findFirst({
        where: { id: input.proposalId, organizationId: input.organizationId },
      });
      if (!proposal) throw new NotFoundException('Action proposal not found.');
      if (proposal.createdById === input.userId) {
        throw new BadRequestException(
          'The proposer cannot approve or reject their own action.',
        );
      }
      if (proposal.status !== 'PROPOSED') {
        throw new ConflictException('This proposal already has a decision.');
      }
      const event = await transaction.prismApprovalEvent.create({
        data: {
          organizationId: input.organizationId,
          proposalId: proposal.id,
          decidedById: input.userId,
          decision: input.decision,
          rationale: input.rationale,
        },
      });
      const updated = await transaction.prismActionProposal.update({
        where: { id: proposal.id },
        data: { status: input.decision },
      });
      await transaction.prismOutboxEvent.create({
        data: {
          organizationId: input.organizationId,
          aggregateType: 'PrismActionProposal',
          aggregateId: proposal.id,
          topic: `prism.action.${input.decision.toLowerCase()}`,
          payload: { proposalId: proposal.id, approvalEventId: event.id },
        },
      });
      return { proposal: updated, decision: event };
    });
  }

  async list(organizationId: string) {
    return this.prisma.prismActionProposal.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { approvals: { orderBy: { createdAt: 'asc' } } },
    });
  }
}
