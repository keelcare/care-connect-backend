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
// Documents are issued by the events that create them: a tax invoice at capture,
// a credit note at refund. Safe to import — InvoicesModule reads billing rows
// directly and does not depend back on this one.
import { InvoicesModule } from "../invoices/invoices.module";
import { PayoutsService } from "./payouts.service";
import { RazorpayxService } from "./razorpayx.service";
import {
  AdminPayoutsController,
  PayoutWebhookController,
  PayoutsController,
} from "./payouts.controller";
// Same reasoning as BookingStatusLogService above: it needs only PrismaService, and
// importing AdminModule for it would be circular — AdminModule already imports this
// one.
import { AdminAuditService } from "../admin/admin-audit.service";

@Module({
  imports: [ConfigModule, NotificationsModule, MailModule, InvoicesModule],
  controllers: [
    PaymentsController,
    PayoutsController,
    AdminPayoutsController,
    PayoutWebhookController,
  ],
  providers: [
    PaymentsService,
    PaymentGatewayService,
    PaymentAuditService,
    BookingStatusLogService,
    RazorpayxService,
    PayoutsService,
    AdminAuditService,
  ],
  exports: [
    PaymentsService,
    PaymentGatewayService,
    PaymentAuditService,
    PayoutsService,
    RazorpayxService,
  ],
})
export class PaymentsModule {}
