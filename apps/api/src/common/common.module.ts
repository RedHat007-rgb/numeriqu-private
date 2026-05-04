import { Module, Global } from '@nestjs/common';
import { UserProvisioningService } from './services/user-provisioning.service';
import { UserPermissionsService } from './services/user-permissions.service';
import { CryptoService } from './crypto.service';
import { DatabaseModule } from '../database/database.module';
import { PersistenceService } from './services/persistence.service';
import { OtpService } from './services/otp.service';
import { AuditLogService } from './services/audit-log.service';

/**
 * CommonModule — Global shared infrastructure.
 *
 * Marked @Global() so all other modules can inject these services
 * without importing CommonModule themselves.
 *
 * Provides:
 *   - UserProvisioningService  (JIT user + tenant creation)
 *   - UserPermissionsService   (granular member permission management)
 *   - AuditLogService          (immutable security trail)
 *   - OtpService               (email verification via Resend)
 *   - CryptoService            (AES-256-GCM token encryption)
 *   - PersistenceService       (generic Prisma helpers)
 */
@Global()
@Module({
  imports: [DatabaseModule],
  providers: [
    AuditLogService,
    UserPermissionsService,
    UserProvisioningService,
    CryptoService,
    PersistenceService,
    OtpService,
  ],
  exports: [
    AuditLogService,
    UserPermissionsService,
    UserProvisioningService,
    CryptoService,
    PersistenceService,
    OtpService,
  ],
})
export class CommonModule {}
