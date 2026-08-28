import { Module } from "@nestjs/common";
import { DisputesService } from "./disputes.service";
import { DisputesController } from "./disputes.controller";
// Resolving a dispute now issues a real refund and notifies the raiser, rather
// than writing a payment status nothing consumed.
import { PaymentsModule } from "../payments/payments.module";
import { NotificationsModule } from "../notifications/notifications.module";

@Module({
  imports: [PaymentsModule, NotificationsModule],
  controllers: [DisputesController],
  providers: [DisputesService],
  exports: [DisputesService],
})
export class DisputesModule {}
