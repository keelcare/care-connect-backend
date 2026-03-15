import { Module, forwardRef } from "@nestjs/common";
import { PassportModule } from "@nestjs/passport";
import { JwtModule } from "@nestjs/jwt";
import { AdminService } from "./admin.service";
import { AdminController } from "./admin.controller";

import { NotificationsModule } from "../notifications/notifications.module";
import { FavoritesModule } from "../favorites/favorites.module";
import { ChatModule } from "../chat/chat.module";
import { RequestsModule } from "../requests/requests.module";
import { DisputesModule } from "../disputes/disputes.module";
import { MailModule } from "../mail/mail.module";
import { AvailabilityModule } from "../availability/availability.module";

@Module({
  imports: [
    PassportModule,
    JwtModule.register({}),
    NotificationsModule,
    FavoritesModule,
    ChatModule,
    forwardRef(() => RequestsModule),
    DisputesModule,
    MailModule,
    AvailabilityModule,
  ],
  controllers: [AdminController],
  providers: [AdminService],
  exports: [AdminService],
})
export class AdminModule { }
