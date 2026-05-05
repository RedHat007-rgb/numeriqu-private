import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { OtpService } from './otp.service';
import { ResendService } from './resend.service';
import { SupabaseService } from './supabase.service';
import { RedisService } from './redis.service';
import { CryptoService } from '../../common/crypto.service';
import { DatabaseModule } from '../../database/database.module';
import { OrganizationContextModule } from '../org-context/org-context.module';

@Module({
  imports: [DatabaseModule, OrganizationContextModule],
  controllers: [AuthController],
  providers: [AuthService, OtpService, ResendService, SupabaseService, RedisService, CryptoService],
  exports: [AuthService],
})
export class AuthModule {}
