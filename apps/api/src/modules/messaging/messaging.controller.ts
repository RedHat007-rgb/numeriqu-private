import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  HttpCode,
  HttpStatus,
  Headers,
  Param,
  Patch,
  Post,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import {
  IsArray,
  IsOptional,
  IsString,
  Length,
} from 'class-validator';
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard';
import { CurrentUser } from '../../common/decorators/user.decorator';
import type { AuthUser } from '../../common/decorators/user.decorator';
import { OrganizationContextService } from '../org-context/org-context.service';
import { MessagingService } from './messaging.service';

class CreateDmDto {
  @IsString()
  peerUserId!: string;
}

class CreateGroupDto {
  @IsArray()
  participantUserIds!: string[];
}

class SendMessageDto {
  @IsString()
  @Length(1, 8000)
  content!: string;

  @IsOptional()
  @IsString()
  dashboardId?: string;
}

class EditMessageDto {
  @IsString()
  @Length(1, 8000)
  content!: string;
}

@Controller('messaging')
@UseGuards(SupabaseAuthGuard)
@UsePipes(
  new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  }),
)
export class MessagingController {
  constructor(
    private readonly orgContext: OrganizationContextService,
    private readonly messagingService: MessagingService,
  ) {}

  private assertMessagingAllowed(accountType: 'SOLO' | 'ORGANIZATION') {
    if (accountType === 'SOLO') {
      throw new HttpException(
        {
          message: 'Messaging is not available for solo workspaces.',
          code: 'SOLO_RESTRICTION',
        },
        HttpStatus.FORBIDDEN,
      );
    }
  }

  @Get('conversations')
  async conversations(
    @CurrentUser() user: AuthUser,
    @Headers('x-organization-id') organizationId?: string,
  ) {
    const context = await this.orgContext.ensureContext(
      { id: user.id, email: user.email },
      { organizationId },
    );
    this.assertMessagingAllowed(context.organization.accountType);
    return this.messagingService.listConversations(context.organization.id, context.user.id);
  }

  @Post('conversations/dm')
  async createDm(
    @CurrentUser() user: AuthUser,
    @Body() body: CreateDmDto,
    @Headers('x-organization-id') organizationId?: string,
  ) {
    const context = await this.orgContext.ensureContext(
      { id: user.id, email: user.email },
      { organizationId },
    );
    this.assertMessagingAllowed(context.organization.accountType);
    return this.messagingService.createDirectMessageConversation(
      context.organization.id,
      context.user.id,
      body.peerUserId,
    );
  }

  @Post('conversations/group')
  async createGroup(
    @CurrentUser() user: AuthUser,
    @Body() body: CreateGroupDto,
    @Headers('x-organization-id') organizationId?: string,
  ) {
    const context = await this.orgContext.ensureContext(
      { id: user.id, email: user.email },
      { organizationId },
    );
    this.assertMessagingAllowed(context.organization.accountType);
    return this.messagingService.createGroupConversation(
      context.organization.id,
      context.user.id,
      body.participantUserIds,
    );
  }

  @Get('conversations/:id/messages')
  async messages(
    @CurrentUser() user: AuthUser,
    @Param('id') conversationId: string,
    @Headers('x-organization-id') organizationId?: string,
  ) {
    const context = await this.orgContext.ensureContext(
      { id: user.id, email: user.email },
      { organizationId },
    );
    this.assertMessagingAllowed(context.organization.accountType);
    return this.messagingService.listMessages(context.organization.id, context.user.id, conversationId);
  }

  @Post('conversations/:id/messages')
  async sendMessage(
    @CurrentUser() user: AuthUser,
    @Param('id') conversationId: string,
    @Body() body: SendMessageDto,
    @Headers('x-organization-id') organizationId?: string,
  ) {
    const context = await this.orgContext.ensureContext(
      { id: user.id, email: user.email },
      { organizationId },
    );
    this.assertMessagingAllowed(context.organization.accountType);
    return this.messagingService.sendMessage({
      organizationId: context.organization.id,
      userId: context.user.id,
      conversationId,
      content: body.content,
      dashboardId: body.dashboardId,
    });
  }

  @Patch('messages/:id')
  @HttpCode(200)
  async editMessage(
    @CurrentUser() user: AuthUser,
    @Param('id') messageId: string,
    @Body() body: EditMessageDto,
    @Headers('x-organization-id') organizationId?: string,
  ) {
    const context = await this.orgContext.ensureContext(
      { id: user.id, email: user.email },
      { organizationId },
    );
    this.assertMessagingAllowed(context.organization.accountType);
    return this.messagingService.editMessage({
      organizationId: context.organization.id,
      userId: context.user.id,
      messageId,
      content: body.content,
    });
  }

  @Delete('messages/:id')
  @HttpCode(200)
  async deleteMessage(
    @CurrentUser() user: AuthUser,
    @Param('id') messageId: string,
    @Headers('x-organization-id') organizationId?: string,
  ) {
    const context = await this.orgContext.ensureContext(
      { id: user.id, email: user.email },
      { organizationId },
    );
    this.assertMessagingAllowed(context.organization.accountType);
    return this.messagingService.softDeleteMessage({
      organizationId: context.organization.id,
      userId: context.user.id,
      messageId,
    });
  }
}
