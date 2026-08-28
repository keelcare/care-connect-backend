import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { JwtModule } from "@nestjs/jwt";
import { LocationService } from "./location.service";
import { LocationController } from "./location.controller";
import { LocationGateway } from "./location.gateway";
import { PrismaModule } from "../prisma/prisma.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { AttendanceModule } from "../attendance/attendance.module";
import { TokenBlacklistService } from "../auth/token-blacklist.service";

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    NotificationsModule,
    AttendanceModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => ({
        secret: configService.get<string>("JWT_SECRET") || "secretKey",
        signOptions: { expiresIn: "60m" },
      }),
      inject: [ConfigService],
    }),
  ],
  // See ChatModule: provided directly to avoid an AuthModule import cycle.
  providers: [LocationService, LocationGateway, TokenBlacklistService],
  controllers: [LocationController],
  exports: [LocationService],
})
export class LocationModule {}
