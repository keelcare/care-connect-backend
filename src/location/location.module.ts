import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { LocationService } from "./location.service";
import { LocationController } from "./location.controller";
import { LocationGateway } from "./location.gateway";
import { PrismaModule } from "../prisma/prisma.module";
import { NotificationsModule } from "../notifications/notifications.module";

@Module({
  imports: [ConfigModule, PrismaModule, NotificationsModule],
  providers: [LocationService, LocationGateway],
  controllers: [LocationController],
  exports: [LocationService],
})
export class LocationModule {}
