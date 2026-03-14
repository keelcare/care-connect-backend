import { Module, Global } from '@nestjs/common';
import { EncryptionService } from './services/encryption.service';
import { ConfigModule } from '@nestjs/config';

import { DataCleanupService } from './services/cleanup/data-cleanup.service';
import { BookingExpirationService } from './services/cleanup/booking-expiration.service';
import { AuditService } from './services/audit/audit.service';

@Global()
@Module({
    imports: [ConfigModule],
    providers: [EncryptionService, DataCleanupService, BookingExpirationService, AuditService],
    exports: [EncryptionService, DataCleanupService, BookingExpirationService, AuditService],
})
export class CommonModule { }
