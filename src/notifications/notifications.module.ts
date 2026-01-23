import { Module, Global } from "@nestjs/common";
import { NotificationsService } from "./notifications.service";
import { NotificationsController } from "./notifications.controller";
import { ConfigModule } from "@nestjs/config";
import { JwtModule } from "@nestjs/jwt";
import { NotificationsGateway } from "./notifications.gateway";

@Global() // Make it global so it can be easily injected into other modules (Bookings, Chat, etc.)
@Module({
  imports: [ConfigModule, JwtModule.register({})],
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationsGateway],
  exports: [NotificationsService],
})
export class NotificationsModule {}
