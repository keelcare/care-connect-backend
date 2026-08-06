import { Module } from "@nestjs/common";
import { PaymentsService } from "./payments.service";
import { PaymentsController } from "./payments.controller";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationsModule } from "src/notifications/notifications.module";
import { ConfigModule } from "@nestjs/config";
import { PaymentGatewayService } from "./payment-gateway.service";
import { PaymentAuditService } from "./payment-audit.service";
import { MailModule } from "../mail/mail.module";
// Provided directly rather than by importing BookingsModule: it needs only
// PrismaService, and BookingsModule already depends on this module.
import { BookingStatusLogService } from "../bookings/booking-status-log.service";

@Module({
  imports: [ConfigModule, NotificationsModule, MailModule],
  controllers: [PaymentsController],
  providers: [
    PaymentsService,
    PaymentGatewayService,
    PaymentAuditService,
    BookingStatusLogService,
  ],
  exports: [PaymentsService, PaymentGatewayService, PaymentAuditService],
})
export class PaymentsModule {}
