import {
  Controller,
  DefaultValuePipe,
  Get,
  ParseIntPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard';
import { CurrentUser } from '../../common/decorators/user.decorator';
import type { AuthUser } from '../../common/decorators/user.decorator';
import { OrganizationContextService } from '../org-context/org-context.service';
import { AuditService } from './audit.service';

@Controller('audit')
@UseGuards(SupabaseAuthGuard)
export class AuditController {
  constructor(
    private readonly orgContext: OrganizationContextService,
    private readonly auditService: AuditService,
  ) {}

  @Get('events')
  async events(
    @CurrentUser() user: AuthUser,
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit: number,
  ) {
    const context = await this.orgContext.ensureContext({ id: user.id, email: user.email });
    await this.orgContext.assertAdmin(context.organization.id, context.user.id);
    const events = await this.auditService.listOrganizationAuditEvents(
      context.organization.id,
      limit,
    );

    return {
      organizationId: context.organization.id,
      events,
    };
  }
}
