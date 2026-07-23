import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsIn,
  IsArray,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import type { Prisma } from '@repo/db';
import { CurrentUser } from '../../common/decorators/user.decorator';
import type { AuthUser } from '../../common/decorators/user.decorator';
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard';
import { OrganizationContextService } from '../org-context/org-context.service';
import { PrismScenarioService } from './prism-scenario.service';
import { PrismActionService } from './prism-action.service';

class ScenarioAssumptionDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  label!: string;

  @IsInt()
  @Min(-100_000)
  @Max(100_000)
  basisPoints!: number;
}

class EvaluateScenarioDto {
  @IsString()
  @Matches(/^-?\d+(\.\d+)?$/)
  baseline!: string;

  @IsIn(['currency', 'percent', 'number'])
  unit!: 'currency' | 'percent' | 'number';

  @IsOptional()
  @Matches(/^[A-Z]{3}$/)
  currency?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ScenarioAssumptionDto)
  assumptions!: ScenarioAssumptionDto[];
}

class ProposeActionDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  actionType!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  summary!: string;

  @IsObject()
  preview!: Record<string, unknown>;

  @IsIn(['low', 'medium', 'high'])
  riskLevel!: string;
}

class DecideActionDto {
  @IsIn(['APPROVED', 'REJECTED'])
  decision!: 'APPROVED' | 'REJECTED';

  @IsOptional()
  @IsString()
  @MaxLength(1_000)
  rationale?: string;
}

@Controller('rag/decisions')
@UseGuards(SupabaseAuthGuard)
export class PrismDecisionController {
  constructor(
    private readonly organizations: OrganizationContextService,
    private readonly scenarios: PrismScenarioService,
    private readonly actions: PrismActionService,
  ) {}

  @Post('scenarios/evaluate')
  evaluateScenario(@Body() body: EvaluateScenarioDto) {
    return this.scenarios.evaluate(body);
  }

  @Post('actions')
  async proposeAction(
    @CurrentUser() user: AuthUser,
    @Body() body: ProposeActionDto,
    @Headers('x-organization-id') organizationId?: string,
    @Headers('idempotency-key') sourceRequestId?: string,
  ) {
    if (!sourceRequestId?.trim() || sourceRequestId.length > 128) {
      throw new BadRequestException('A valid Idempotency-Key is required.');
    }
    const context = await this.context(user, organizationId);
    return this.actions.propose({
      organizationId: context.organization.id,
      userId: context.user.id,
      sourceRequestId: sourceRequestId.trim(),
      ...body,
      preview: body.preview as Prisma.InputJsonValue,
    });
  }

  @Post('actions/:id/decisions')
  async decideAction(
    @CurrentUser() user: AuthUser,
    @Param('id') proposalId: string,
    @Body() body: DecideActionDto,
    @Headers('x-organization-id') organizationId?: string,
  ) {
    const context = await this.context(user, organizationId);
    return this.actions.decide({
      organizationId: context.organization.id,
      userId: context.user.id,
      proposalId,
      ...body,
    });
  }

  @Get('actions')
  async listActions(
    @CurrentUser() user: AuthUser,
    @Headers('x-organization-id') organizationId?: string,
  ) {
    const context = await this.context(user, organizationId);
    return this.actions.list(context.organization.id);
  }

  private context(user: AuthUser, organizationId?: string) {
    return this.organizations.ensureContext(
      { id: user.id, email: user.email },
      { organizationId },
    );
  }
}
