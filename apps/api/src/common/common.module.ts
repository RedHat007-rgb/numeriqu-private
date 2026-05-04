import { Module, Global } from '@nestjs/common';
import { UserProvisioningService } from './services/user-provisioning.service';
import { CryptoService } from './crypto.service';
import { DatabaseModule } from '../database/database.module';
import { PersistenceService } from './services/persistence.service';
import { OtpService } from './services/otp.service';

@Global()
@Module({
  imports: [DatabaseModule],
  providers: [UserProvisioningService, CryptoService, PersistenceService, OtpService],
  exports: [UserProvisioningService, CryptoService, PersistenceService, OtpService],
})
export class CommonModule {}
