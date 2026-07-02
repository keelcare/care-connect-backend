import { Module } from "@nestjs/common";
import { NannyOnboardingService } from "./nanny-onboarding.service";
import { NannyOnboardingController } from "./nanny-onboarding.controller";
import { PrismaModule } from "../prisma/prisma.module";

@Module({
  imports: [PrismaModule],
  controllers: [NannyOnboardingController],
  providers: [NannyOnboardingService],
  exports: [NannyOnboardingService],
})
export class NannyOnboardingModule {}
