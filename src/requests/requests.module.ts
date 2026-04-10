import { Module } from "@nestjs/common";
import { PassportModule } from "@nestjs/passport";
import { JwtModule } from "@nestjs/jwt";
import { RequestsService } from "./requests.service";
import { RequestsController } from "./requests.controller";
import { PrismaModule } from "../prisma/prisma.module";
import { UsersModule } from "../users/users.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { FavoritesModule } from "../favorites/favorites.module";
import { AvailabilityModule } from "../availability/availability.module";
import { MailModule } from "../mail/mail.module";

@Module({
  imports: [
    PrismaModule,
    UsersModule,
    NotificationsModule,
    FavoritesModule,
    AvailabilityModule,
    MailModule,
    PassportModule,
    JwtModule.register({}),
  ],
  controllers: [RequestsController],
  providers: [RequestsService],
  exports: [RequestsService],
})
export class RequestsModule {}
