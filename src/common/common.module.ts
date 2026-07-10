import { Module, Global } from "@nestjs/common";
import { EncryptionService } from "./services/encryption.service";
import { ConfigModule } from "@nestjs/config";

import { DataCleanupService } from "./services/cleanup/data-cleanup.service";
import { AuditService } from "./services/audit/audit.service";
import { PricingEngineService } from "./pricing.service";
import { PricingController } from "./pricing.controller";

@Global()
@Module({
  imports: [ConfigModule],
  controllers: [PricingController],
  providers: [EncryptionService, DataCleanupService, AuditService, PricingEngineService],
  exports: [EncryptionService, DataCleanupService, AuditService, PricingEngineService],
})
export class CommonModule {}
