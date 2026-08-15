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

@Module({
  imports: [ConfigModule, NotificationsModule, MailModule, InvoicesModule],
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
