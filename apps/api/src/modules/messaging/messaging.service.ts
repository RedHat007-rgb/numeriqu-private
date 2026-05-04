import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { PrismaClient } from '@repo/db';
import { PRISMA_TOKEN } from '../../database/database.module';
import { OrganizationContextService } from '../org-context/org-context.service';

@Injectable()
export class MessagingService {
  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient,
    private readonly orgContext: OrganizationContextService,
  ) {}

  private buildDmKey(userA: string, userB: string) {
    return [userA, userB].sort().join(':');
  }

  private async assertParticipant(
    organizationId: string,
    conversationId: string,
    userId: string,
  ) {
    await this.orgContext.assertOrganizationMember(organizationId, userId);
    const participant = await this.prisma.conversationParticipant.findFirst({
      where: { organizationId, conversationId, userId, leftAt: null },
      select: { id: true },
    });
    if (!participant) {
      throw new HttpException(
        { message: 'You are not a participant in this conversation.', code: 'FORBIDDEN' },
        HttpStatus.FORBIDDEN,
      );
    }
  }

  async listConversations(organizationId: string, userId: string) {
    await this.orgContext.assertOrganizationMember(organizationId, userId);
    const participantRows = await this.prisma.conversationParticipant.findMany({
      where: { organizationId, userId, leftAt: null },
      select: { conversationId: true },
    });
    const ids = participantRows.map((row) => row.conversationId);
    if (ids.length === 0) return [];

    const conversations = await this.prisma.conversation.findMany({
      where: { organizationId, id: { in: ids } },
      orderBy: { updatedAt: 'desc' },
      include: {
        participants: {
          where: { leftAt: null },
          include: { user: { select: { id: true, email: true, fullName: true } } },
        },
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { id: true, content: true, createdAt: true, senderId: true, deletedAt: true },
        },
      },
    });

    return conversations.map((conversation) => ({
      id: conversation.id,
      type: conversation.type,
      createdAt: conversation.createdAt.toISOString(),
      updatedAt: conversation.updatedAt.toISOString(),
      participants: conversation.participants.map((part) => ({
        userId: part.userId,
        email: part.user.email,
        fullName: part.user.fullName,
      })),
      latestMessage: conversation.messages[0]
        ? {
            id: conversation.messages[0].id,
            content: conversation.messages[0].deletedAt ? null : conversation.messages[0].content,
            senderId: conversation.messages[0].senderId,
            createdAt: conversation.messages[0].createdAt.toISOString(),
          }
        : null,
    }));
  }

  async createDirectMessageConversation(organizationId: string, userId: string, peerUserId: string) {
    await this.orgContext.assertOrganizationMember(organizationId, userId);
    await this.orgContext.assertOrganizationMember(organizationId, peerUserId);

    if (userId === peerUserId) {
      throw new HttpException(
        { message: 'Cannot create DM with yourself.', code: 'VALIDATION_FAILED' },
        HttpStatus.BAD_REQUEST,
      );
    }

    const dmKey = this.buildDmKey(userId, peerUserId);
    const existing = await this.prisma.conversation.findFirst({
      where: { organizationId, type: 'DM', dmKey },
    });
    if (existing) return existing;

    return this.prisma.$transaction(async (tx) => {
      const conversation = await tx.conversation.create({
        data: {
          organizationId,
          type: 'DM',
          dmKey,
          createdById: userId,
        },
      });

      await tx.conversationParticipant.createMany({
        data: [
          { organizationId, conversationId: conversation.id, userId },
          { organizationId, conversationId: conversation.id, userId: peerUserId },
        ],
      });

      return conversation;
    });
  }

  async createGroupConversation(
    organizationId: string,
    userId: string,
    participantUserIds: string[],
  ) {
    await this.orgContext.assertOrganizationMember(organizationId, userId);
    const uniqueUsers = [...new Set([userId, ...participantUserIds])];
    for (const participantId of uniqueUsers) {
      await this.orgContext.assertOrganizationMember(organizationId, participantId);
    }

    const conversation = await this.prisma.conversation.create({
      data: {
        organizationId,
        type: 'GROUP',
        createdById: userId,
      },
    });

    await this.prisma.conversationParticipant.createMany({
      data: uniqueUsers.map((participantId) => ({
        organizationId,
        conversationId: conversation.id,
        userId: participantId,
      })),
    });
    return conversation;
  }

  async listMessages(organizationId: string, userId: string, conversationId: string) {
    await this.assertParticipant(organizationId, conversationId, userId);
    const messages = await this.prisma.message.findMany({
      where: { organizationId, conversationId },
      orderBy: { createdAt: 'asc' },
      include: {
        dashboardReferences: true,
      },
    });

    return messages.map((message) => ({
      id: message.id,
      senderId: message.senderId,
      content: message.deletedAt ? null : message.content,
      createdAt: message.createdAt.toISOString(),
      editedAt: message.editedAt?.toISOString() ?? null,
      deletedAt: message.deletedAt?.toISOString() ?? null,
      dashboardIds: message.dashboardReferences.map((ref) => ref.dashboardId),
    }));
  }

  async sendMessage(params: {
    organizationId: string;
    userId: string;
    conversationId: string;
    content: string;
    dashboardId?: string;
  }) {
    await this.assertParticipant(params.organizationId, params.conversationId, params.userId);

    const message = await this.prisma.message.create({
      data: {
        organizationId: params.organizationId,
        conversationId: params.conversationId,
        senderId: params.userId,
        content: params.content,
      },
    });

    if (params.dashboardId) {
      const dashboard = await this.prisma.dashboard.findFirst({
        where: {
          id: params.dashboardId,
          organizationId: params.organizationId,
          deletedAt: null,
        },
        select: { id: true },
      });
      if (!dashboard) {
        throw new HttpException(
          { message: 'Dashboard not found for sharing.', code: 'NOT_FOUND' },
          HttpStatus.NOT_FOUND,
        );
      }
      await this.prisma.messageDashboardReference.create({
        data: {
          organizationId: params.organizationId,
          messageId: message.id,
          dashboardId: params.dashboardId,
        },
      });
    }

    return {
      id: message.id,
      content: message.content,
      senderId: message.senderId,
      createdAt: message.createdAt.toISOString(),
    };
  }

  async editMessage(params: {
    organizationId: string;
    userId: string;
    messageId: string;
    content: string;
  }) {
    const message = await this.prisma.message.findFirst({
      where: { id: params.messageId, organizationId: params.organizationId },
      select: { id: true, senderId: true, content: true, deletedAt: true },
    });
    if (!message || message.deletedAt) {
      throw new HttpException(
        { message: 'Message not found.', code: 'NOT_FOUND' },
        HttpStatus.NOT_FOUND,
      );
    }
    if (message.senderId !== params.userId) {
      throw new HttpException(
        { message: 'Only sender can edit message.', code: 'FORBIDDEN' },
        HttpStatus.FORBIDDEN,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.messageRevision.create({
        data: {
          organizationId: params.organizationId,
          messageId: params.messageId,
          editorId: params.userId,
          previousContent: message.content,
        },
      });
      await tx.message.update({
        where: { id: params.messageId },
        data: { content: params.content, editedAt: new Date() },
      });
    });

    return { success: true };
  }

  async softDeleteMessage(params: { organizationId: string; userId: string; messageId: string }) {
    const message = await this.prisma.message.findFirst({
      where: { id: params.messageId, organizationId: params.organizationId },
      select: { id: true, senderId: true, deletedAt: true },
    });
    if (!message || message.deletedAt) {
      throw new HttpException(
        { message: 'Message not found.', code: 'NOT_FOUND' },
        HttpStatus.NOT_FOUND,
      );
    }
    if (message.senderId !== params.userId) {
      throw new HttpException(
        { message: 'Only sender can delete message.', code: 'FORBIDDEN' },
        HttpStatus.FORBIDDEN,
      );
    }

    await this.prisma.message.update({
      where: { id: params.messageId },
      data: { deletedAt: new Date() },
    });
    return { success: true };
  }
}

