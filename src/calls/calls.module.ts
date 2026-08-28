import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { CallsService } from "./calls.service";
import { CallsGateway } from "./calls.gateway";
import { CallsController } from "./calls.controller";
import { PrismaService } from "../prisma/prisma.service";
import { TokenBlacklistService } from "../auth/token-blacklist.service";

@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => ({
        secret: configService.get<string>("JWT_SECRET") || "secretKey",
        signOptions: { expiresIn: "60m" },
      }),
      inject: [ConfigService],
    }),
  ],
  controllers: [CallsController],
  // See ChatModule: provided directly to avoid an AuthModule import cycle.
  providers: [CallsService, CallsGateway, TokenBlacklistService, PrismaService],
})
export class CallsModule {}
