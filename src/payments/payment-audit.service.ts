import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { Prisma } from "@prisma/client";

@Injectable()
export class PaymentAuditService {
  private readonly logger = new Logger(PaymentAuditService.name);

  constructor(private prisma: PrismaService) {}

  async writeLog(
    tx: any,
    paymentDbId: string,
    orderId: string,
    fromStatus: string | null,
    toStatus: string,
    triggeredBy: string,
    razorpayPaymentId?: string,
    metadata: Prisma.InputJsonValue = {},
  ) {
    const context = tx || this.prisma;
    
    if (context.payment_audit_log) {
      await context.payment_audit_log.create({
        data: {
          payment_id: paymentDbId,
          order_id: orderId,
          from_status: fromStatus,
          to_status: toStatus,
          triggered_by: triggeredBy,
          razorpay_payment_id: razorpayPaymentId,
          metadata,
        },
      });
    } else {
      this.logger.warn("payment_audit_log table not accessible in current context.");
    }
  }
}
