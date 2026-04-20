import {
  Controller,
  Get,
  Req,
  Res,
  Query,
  UseGuards,
  UnauthorizedException,
  InternalServerErrorException,
} from '@nestjs/common';
import type { Response } from 'express';
import { MetricsService } from './metrics.service';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import type { AuthUser } from '../common/decorators/user.decorator';
import { UserProvisioningService } from '../common/services/user-provisioning.service';

@Controller('metrics')
@UseGuards(SupabaseAuthGuard)
export class MetricsController {
  constructor(
    private readonly metricsService: MetricsService,
    private readonly provisioning: UserProvisioningService,
  ) {}

  @Get('revenue')
  async getRevenue(@CurrentUser() user: AuthUser) {
    const { tenant } = await this.provisioning.ensureProvisioned(
      user.id,
      user.email,
    );
    return this.metricsService.getRevenueByMonth(tenant.id);
  }

  @Get('invoices')
  async getInvoices(@CurrentUser() user: AuthUser) {
    const { tenant } = await this.provisioning.ensureProvisioned(
      user.id,
      user.email,
    );
    return this.metricsService.getInvoices(tenant.id);
  }

  @Get('export/xero')
  async downloadXero(
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
    @Query('resource') resource?: string,
  ) {
    const { tenant } = await this.provisioning.ensureProvisioned(
      user.id,
      user.email,
    );

    const csv = await this.metricsService.getXeroExport(tenant.id, resource);

    const filename = resource
      ? `xero_${resource}_export.csv`
      : 'xero_full_export.csv';
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    return res.send(csv);
  }
}
