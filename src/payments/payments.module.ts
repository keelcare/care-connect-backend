import { Module } from "@nestjs/common";
import { PaymentsService } from "./payments.service";
import { PaymentsController } from "./payments.controller";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationsModule } from "src/notifications/notifications.module";
import { ConfigModule } from "@nestjs/config";
import { PaymentGatewayService } from "./payment-gateway.service";
import { PaymentAuditService } from "./payment-audit.service";
import { MailModule } from "../mail/mail.module";

@Module({
  imports: [ConfigModule, NotificationsModule, MailModule],
  controllers: [PaymentsController],
  providers: [PaymentsService, PaymentGatewayService, PaymentAuditService],
  exports: [PaymentsService, PaymentGatewayService, PaymentAuditService],
})
export class PaymentsModule {}
