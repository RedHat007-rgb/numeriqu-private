import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Res,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import type { Response } from 'express';
import { IsEmail, IsIn, IsOptional, IsString, Length } from 'class-validator';
import { AuthService } from './auth.service';
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard';
import { CurrentUser } from '../../common/decorators/user.decorator';
import type { AuthUser } from '../../common/decorators/user.decorator';
import { OrganizationContextService } from '../org-context/org-context.service';

class SendOtpDto {
  @IsEmail()
  email!: string;
}

class VerifyOtpDto {
  @IsEmail()
  email!: string;

  @IsString()
  @Length(6, 6)
  otp!: string;

  @IsOptional()
  @IsIn(['SOLO', 'ORGANIZATION'])
  accountType?: 'SOLO' | 'ORGANIZATION';
}

@Controller('auth')
@UsePipes(
  new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  }),
)
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly organizationContext: OrganizationContextService,
  ) {}

  @Post('send-otp')
  @HttpCode(200)
  async sendOtp(@Body() body: SendOtpDto) {
    await this.authService.sendOtp(body.email);
    return { success: true };
  }

  @Post('resend-otp')
  @HttpCode(200)
  async resendOtp(@Body() body: SendOtpDto) {
    await this.authService.resendOtp(body.email);
    return { success: true };
  }

  @Post('verify-otp')
  @HttpCode(200)
  async verifyOtp(
    @Body() body: VerifyOtpDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.authService.verifyOtpAndCreateSession({
      email: body.email,
      otp: body.otp,
      response,
      accountType: body.accountType,
    });
  }

  @Post('logout')
  @HttpCode(200)
  logout(@Res({ passthrough: true }) response: Response) {
    this.authService.clearAuthCookies(response);
    return { success: true };
  }

  @Get('me')
  @UseGuards(SupabaseAuthGuard)
  async me(@CurrentUser() user: AuthUser) {
    const context = await this.organizationContext.ensureContext({
      id: user.id,
      email: user.email,
    });
    return {
      user: {
        id: context.user.id,
        email: context.user.email,
      },
      tenant: {
        id: context.organization.id,
        name: context.organization.name,
        accountType: context.organization.accountType,
        createdAt: context.organization.createdAt.toISOString(),
      },
    };
  }

  @Post('xero/connect')
  @UseGuards(SupabaseAuthGuard)
  async connectXero() {
    const url = process.env.XERO_CONNECT_URL;
    if (!url) {
      return { url: '' };
    }
    return { url };
  }

  @Post('quickbooks/connect')
  @UseGuards(SupabaseAuthGuard)
  async connectQuickBooks() {
    const url = process.env.QB_CONNECT_URL;
    if (!url) {
      return { url: '' };
    }
    return { url };
  }
}
