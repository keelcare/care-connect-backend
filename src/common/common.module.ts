import { Module, Global } from "@nestjs/common";
import { EncryptionService } from "./services/encryption.service";
import { ConfigModule } from "@nestjs/config";

import { AuthModule } from "../auth/auth.module";
import { DataCleanupService } from "./services/cleanup/data-cleanup.service";
import { AuditService } from "./services/audit/audit.service";
import { PricingEngineService } from "./pricing.service";
import { PricingController } from "./pricing.controller";

@Global()
@Module({
  // AuthModule: PricingController's TransparentJwtAuthGuard is instantiated in
  // this module's context, so the guard's deps (AuthService, JwtService) must
  // be resolvable here.
  imports: [ConfigModule, AuthModule],
  controllers: [PricingController],
  providers: [EncryptionService, DataCleanupService, AuditService, PricingEngineService],
  exports: [EncryptionService, DataCleanupService, AuditService, PricingEngineService],
})
export class CommonModule {}
