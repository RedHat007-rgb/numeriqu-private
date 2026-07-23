import { Controller, Get, Headers, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/user.decorator';
import type { AuthUser } from '../../common/decorators/user.decorator';
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard';
import { OrganizationContextService } from '../org-context/org-context.service';
import { PrismProactiveService } from './prism-proactive.service';

@Controller('rag/opportunities')
@UseGuards(SupabaseAuthGuard)
export class PrismProactiveController {
  constructor(
    private readonly organizations: OrganizationContextService,
    private readonly proactive: PrismProactiveService,
  ) {}

  @Get()
  async list(
    @CurrentUser() user: AuthUser,
    @Headers('x-organization-id') organizationId?: string,
  ) {
    const context = await this.organizations.ensureContext(
      { id: user.id, email: user.email },
      { organizationId },
    );
    return this.proactive.opportunities(context.organization.id);
  }
}
