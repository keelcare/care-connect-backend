import { Module, forwardRef } from "@nestjs/common";
import { PassportModule } from "@nestjs/passport";
import { JwtModule } from "@nestjs/jwt";
import { AdminService } from "./admin.service";
import { AdminController } from "./admin.controller";
import { AdminAuditService } from "./admin-audit.service";
import { RevenueService } from "./revenue.service";

import { NotificationsModule } from "../notifications/notifications.module";
import { FavoritesModule } from "../favorites/favorites.module";
import { ChatModule } from "../chat/chat.module";
import { RequestsModule } from "../requests/requests.module";
import { DisputesModule } from "../disputes/disputes.module";
import { MailModule } from "../mail/mail.module";
import { AvailabilityModule } from "../availability/availability.module";
import { BookingsModule } from "../bookings/bookings.module";
import { PaymentsModule } from "../payments/payments.module";

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
    forwardRef(() => BookingsModule),
    // Assigning a caregiver to a plan opens its first billing cycle, so the
    // advance is payable straight away rather than at the first checkout.
    PaymentsModule,
  ],
  controllers: [AdminController],
  providers: [AdminService, AdminAuditService, RevenueService],
  exports: [AdminService, AdminAuditService, RevenueService],
})
export class AdminModule {}
