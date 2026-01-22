import { Module } from "@nestjs/common";
import { RequestsService } from "./requests.service";
import { RequestsController } from "./requests.controller";
import { PrismaModule } from "../prisma/prisma.module";
import { UsersModule } from "../users/users.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { FavoritesModule } from "../favorites/favorites.module";
import { AiModule } from "../ai/ai.module";
import { AvailabilityModule } from "../availability/availability.module";

@Module({
  imports: [
    PrismaModule,
    UsersModule,
    NotificationsModule,
    FavoritesModule,
    AiModule,
    AvailabilityModule,
  ],
  controllers: [RequestsController],
  providers: [RequestsService],
  exports: [RequestsService],
})
export class RequestsModule {}
