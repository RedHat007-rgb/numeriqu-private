import { Module, Global } from '@nestjs/common';
import { UserProvisioningService } from './services/user-provisioning.service';
import { CryptoService } from './crypto.service';
import { DatabaseModule } from '../database/database.module';

/**
 * COMMON MODULE (GLOBAL)
 * 
 * Provides shared utilities for Auth, Multi-tenancy, and Data Encryption.
 * Marked as @Global() so it can be used across Metrics, Intelligence, 
 * and Integrations without redundant imports.
 */
@Global()
@Module({
  imports: [DatabaseModule],
  providers: [UserProvisioningService, CryptoService],
  exports: [UserProvisioningService, CryptoService],
})
export class CommonModule {}
