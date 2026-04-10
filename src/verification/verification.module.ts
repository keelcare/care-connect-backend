import { Module } from "@nestjs/common";
import { PassportModule } from "@nestjs/passport";
import { JwtModule } from "@nestjs/jwt";
import { VerificationService } from "./verification.service";
import { VerificationController } from "./verification.controller";
import { PrismaModule } from "../prisma/prisma.module";
import { SupabaseStorageModule } from "../supabase-storage/supabase-storage.module";

@Module({
  imports: [
    PrismaModule,
    PassportModule,
    JwtModule.register({}),
    SupabaseStorageModule,
  ],
  controllers: [VerificationController],
  providers: [VerificationService],
})
export class VerificationModule {}
