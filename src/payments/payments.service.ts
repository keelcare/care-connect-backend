import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import Razorpay from "razorpay";
import * as crypto from "node:crypto";
import { ConfigService } from "@nestjs/config";
import { NotificationsService } from "../notifications/notifications.service";
import { PaymentAuditQueryDto } from "./dto/payment-audit-query.dto";
import { PaymentGatewayService } from "./payment-gateway.service";
import { PaymentAuditService } from "./payment-audit.service";
import { PricingEngineService } from "../common/pricing.service";
import { MailService } from "../mail/mail.service";
import { PaymentStatus } from "../constants";
import { BookingStatus } from "../common/constants/booking-status.enum";
import { TimeUtils } from "../common/utils/time.utils";
import {
  RAZORPAY_PAISE_MULTIPLIER,
  RAZORPAY_MIN_AMOUNT_PAISE,
} from "../common/constants/constants";

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private readonly processingOrders = new Set<string>();

  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
    private notificationsService: NotificationsService,
    private gateway: PaymentGatewayService,
    private audit: PaymentAuditService,
    private pricingService: PricingEngineService,
    private mailService: MailService,
  ) { }

  // 1. Create Order (Server-Side Price Calculation)
  async createOrder(
    bookingId: string,
    requestingUserId?: string,
  ) {
    if (!this.configService.get("RAZORPAY_KEY_ID")) {
      this.logger.error("Cannot create order: RAZORPAY_KEY_ID missing");
      throw new BadRequestException("Payment service is currently unavailable");
    }

    const booking = await this.prisma.bookings.findUnique({
      where: { id: bookingId },
      include: {
        payment_plans: true,
      },
    });

    if (!booking) throw new NotFoundException("Booking not found");
    if (!booking.nanny_id) {
      throw new BadRequestException(
        "Payment is only allowed after a nanny has been assigned.",
      );
    }

    // Security: ensure the user requesting payment is the booking's parent
    if (requestingUserId && booking.parent_id !== requestingUserId) {
      throw new BadRequestException(
        "You are not authorised to pay for this booking",
      );
    }

    const paymentPlan = booking.payment_plans;
    const cycleNumber = paymentPlan ? paymentPlan.cycles_completed + 1 : 1;
    
    // Check if we already took a snapshot for this cycle that is pending
    let snapshot = await this.prisma.price_snapshots.findFirst({
        where: { booking_id: bookingId, cycle_number: cycleNumber, status: 'pending' }
    });
    
    if (!snapshot) {
        // Calculate and snapshot
        const res = await this.pricingService.calculateAndSnapshot({
           bookingId,
           cycleNumber,
           paymentPlanId: paymentPlan?.id
        });
        snapshot = await this.prisma.price_snapshots.findUnique({where: {id: res.snapshotId}});
    }

    if (!snapshot) throw new BadRequestException("Failed to generate price snapshot");

    const amountInRupees = Number(snapshot.final_amount);
    const amountInPaise = Math.round(amountInRupees * RAZORPAY_PAISE_MULTIPLIER); // Razorpay requires paise

    this.logger.log(`Creating order for booking: ${bookingId}`);
    this.logger.log(
      `Cycle: ${cycleNumber}, Amount(Paise): ${amountInPaise}`,
    );

    if (amountInPaise < RAZORPAY_MIN_AMOUNT_PAISE) {
      throw new BadRequestException(
        `Amount too low to create order: ₹${amountInRupees} INR`,
      );
    }

    // Idempotency: Check if order already exists for this booking/cycle
    const existingPayment = await this.prisma.payments.findFirst({
      where: {
        booking_id: bookingId,
        status: "created",
        price_snapshots: {
           some: { id: snapshot.id }
        }
      },
    });

    if (existingPayment) {
      return {
        orderId: existingPayment.order_id,
        amount: Number(existingPayment.amount),
        currency: existingPayment.currency,
        key: this.configService.get("RAZORPAY_KEY_ID"),
      };
    }

    try {
      const order = await this.gateway.createOrder(amountInPaise, `receipt_${bookingId.substring(0, 10)}`, {
        booking_id: bookingId,
        nanny_id: booking.nanny_id,
      });

      // Save to DB
      const createdPayment = await this.prisma.payments.create({
        data: {
          booking_id: bookingId,
          nanny_id: booking.nanny_id,
          amount: amountInRupees,
          currency: "INR",
          provider: "razorpay",
          order_id: order.id,
          status: PaymentStatus.CREATED,
        },
      });

      // Link payment to snapshot
      await this.prisma.price_snapshots.update({
          where: { id: snapshot.id },
          data: { payment_id: createdPayment.id }
      });

      await this.audit.writeLog(
        this.prisma,
        createdPayment.id,
        order.id,
        null,
        PaymentStatus.CREATED,
        "api:create_order",
      );

      return {
        orderId: order.id,
        order_id: order.id, // Compatible with Razorpay options
        amount: amountInRupees, // For display
        amount_due: amountInPaise, // For Razorpay options (subunits)
        currency: "INR",
        key: this.configService.get("RAZORPAY_KEY_ID"),
        key_id: this.configService.get("RAZORPAY_KEY_ID"), // Compatible with Razorpay options
        name: "Care Connect",
        description: `Payment for Booking #${bookingId}`,
      };
    } catch (error: any) {
      this.logger.error("Error creating Razorpay order", error);
      // Construct a more useful error message
      const errorMessage =
        error?.error?.description ||
        error?.message ||
        "Failed to create payment order";
      throw new BadRequestException(errorMessage);
    }
  }

  // 1.5. Retry Failed Order
  async retryOrder(bookingId: string) {
    // Check if there is a failed payment for this booking
    const failedPayment = await this.prisma.payments.findFirst({
      where: { booking_id: bookingId, status: "failed" },
      orderBy: { created_at: "desc" },
    });

    if (!failedPayment) {
      throw new BadRequestException(
        "No failed payment found for this booking to retry",
      );
    }

    // Check if it's already paid successfully
    const successPayment = await this.prisma.payments.findFirst({
      where: { booking_id: bookingId, status: "captured" },
    });

    if (successPayment) {
      throw new BadRequestException("Booking is already paid successfully.");
    }

    this.logger.log(`Retrying order calculation for booking: ${bookingId}`);
    return this.createOrder(bookingId);
  }

  // 2. Verify Payment (HMAC SHA256 Signature Check)
  async verifyPayment(orderId: string, paymentId: string, signature: string) {
    const isValid = this.gateway.verifySignature(orderId, paymentId, signature);

    if (!isValid) {
      this.logger.warn(`Payment signature mismatch for order ${orderId}`);
      throw new BadRequestException(
        "Invalid payment signature (Potential Fraud)",
      );
    }

    // Update DB
    await this.capturePaymentSuccess(
      orderId,
      paymentId,
      signature,
      "api:verify_payment",
    );

    return { success: true };
  }

  // 3. Webhook Handler (Source of Truth)
  async handleWebhook(signature: string, payload: any) {
    if (!this.gateway.verifyWebhookSignature(payload, signature)) {
      this.logger.warn(
        "Webhook signature mismatch - potential spoofing attempt",
      );
      throw new BadRequestException("Invalid webhook signature");
    }

    const event = payload.event;
    const paymentEntity = payload.payload.payment.entity;
    const orderId = paymentEntity.order_id;
    const paymentId = paymentEntity.id;

    if (event === "payment.captured" || event === "order.paid") {
      if (this.processingOrders.has(orderId)) {
        this.logger.warn(`Webhook ${event} for order ${orderId} already in-flight, skipping`);
        return { status: 'duplicate_in_flight' };
      }
      this.processingOrders.add(orderId);
      try {
        const result = await this.capturePaymentSuccess(
          orderId,
          paymentId,
          "webhook_verified",
          `webhook:${event}`,
        );
        return { status: result?.alreadyCaptured ? 'duplicate_skipped' : 'processed' };
      } finally {
        this.processingOrders.delete(orderId);
      }
    } else if (event === "payment.failed") {
      const existingPayment = await this.prisma.payments.findUnique({
        where: { order_id: orderId },
        select: { id: true, status: true },
      });

      if (!existingPayment) {
        throw new NotFoundException("Payment record not found");
      }

      const payment = await this.prisma.payments.update({
        where: { order_id: orderId },
        data: {
          status: "failed",
          error_code: paymentEntity.error_code,
          error_description: paymentEntity.error_description,
        },
        include: { bookings: true },
      });

      await this.audit.writeLog(
        this.prisma,
        existingPayment.id,
        orderId,
        existingPayment.status ?? null,
        PaymentStatus.FAILED,
        "webhook:payment.failed",
        paymentId,
        {
          error_code: paymentEntity.error_code,
          error_description: paymentEntity.error_description,
        },
      );

      if (payment.bookings) {
        await this.notificationsService.createNotification(
          payment.bookings.parent_id,
          "Payment Failed",
          `Your payment for booking #${payment.booking_id} failed. Please try again.`,
          "error",
        );
      }
    }

    return { status: "processed" };
  }

  /**
   * Public method to update payment status with an audit log.
   * Ensures that status transitions are tracked according to main branch standards.
   */
  async updatePaymentStatus(
    paymentDbId: string,
    toStatus: string,
    triggeredBy: string,
    metadata: Prisma.InputJsonValue = {},
  ) {
    return await this.prisma.$transaction(async (tx) => {
      const payment = await tx.payments.findUnique({
        where: { id: paymentDbId },
      });

      if (!payment) throw new NotFoundException("Payment record not found");

      const updatedPayment = await tx.payments.update({
        where: { id: paymentDbId },
        data: { status: toStatus },
      });

      await this.audit.writeLog(
        tx,
        payment.id,
        payment.order_id,
        payment.status,
        toStatus,
        triggeredBy,
        payment.payment_id,
        metadata,
      );

      return updatedPayment;
    });
  }

  // Helper: Atomically Successful Update
  private async capturePaymentSuccess(
    orderId: string,
    paymentId: string,
    signature: string,
    triggeredBy: string,
  ): Promise<{ alreadyCaptured: boolean }> {
    // START TRANSACTION to prevent double-confirming
    return await this.prisma.$transaction(async (tx) => {
      const payment = await tx.payments.findUnique({
        where: { order_id: orderId },
      });

      if (!payment) throw new NotFoundException("Payment record not found");
      if (payment.status === PaymentStatus.CAPTURED) {
        await this.audit.writeLog(
          tx,
          payment.id,
          orderId,
          PaymentStatus.CAPTURED,
          PaymentStatus.CAPTURED,
          `${triggeredBy}:duplicate`,
          paymentId,
        );
        return { alreadyCaptured: true };
      }

      // Update Payment
      await tx.payments.update({
        where: { order_id: orderId },
        data: {
          status: PaymentStatus.CAPTURED,
          payment_id: paymentId,
          signature: signature,
        },
      });

      await this.audit.writeLog(
        tx,
        payment.id,
        orderId,
        payment.status,
        PaymentStatus.CAPTURED,
        triggeredBy,
        paymentId,
        {
          amount: Number(payment.amount),
          currency: payment.currency,
        },
      );

      // Advance payment plan if it exists
      const paymentPlan = await tx.payment_plans.findUnique({
        where: { booking_id: payment.booking_id },
      });

      if (paymentPlan) {
        await this.pricingService.advancePaymentPlan(paymentPlan.id);
      }
      
      // Update snapshot
      const snapshot = await tx.price_snapshots.findFirst({
        where: { payment_id: payment.id }
      });
      if (snapshot) {
         await this.pricingService.markSnapshotCharged(snapshot.id, paymentId, payment.id);
      }

      const newBookingStatus = paymentPlan && (paymentPlan.cycles_completed + 1) < paymentPlan.total_cycles 
         ? BookingStatus.CONFIRMED 
         : BookingStatus.COMPLETED;

      const updatedBooking = await tx.bookings.update({
        where: { id: payment.booking_id },
        data: { status: newBookingStatus },
      });

      // Notify Parent
      await this.notificationsService.createNotification(
        updatedBooking.parent_id,
        "Payment Successful",
        `Your payment of ₹${payment.amount} has been processed successfully.`,
        "success",
      );

      // Notify Nanny
      if (updatedBooking.nanny_id) {
        await this.notificationsService.createNotification(
          updatedBooking.nanny_id,
          "Payment Received",
          `A payment of ₹${payment.amount} has been received for your booking.`,
          "success",
        );
      }

      // Send Payment Receipt Email (fire-and-forget)
      const parentUser = await tx.users.findUnique({
        where: { id: updatedBooking.parent_id },
        include: { profiles: true }
      });
      if (parentUser?.email) {
        const parentName = parentUser.profiles?.first_name 
          ? `${parentUser.profiles.first_name} ${parentUser.profiles.last_name || ''}`.trim() 
          : "Parent";
        
        this.mailService.sendPaymentReceiptEmail(
          parentUser.email,
          parentName,
          {
            amount: Number(payment.amount),
            currency: payment.currency,
            date: new Date().toLocaleDateString(),
            receiptId: payment.order_id,
            bookingDetails: `Booking #${updatedBooking.id.substring(0, 8)}`,
          }
        ).catch(err => this.logger.error("Failed to send payment receipt email", err));
      }

      return { alreadyCaptured: false };
    });
  }

  async getPaymentByOrderId(orderId: string) {
    return this.prisma.payments.findUnique({
      where: { order_id: orderId },
    });
  }

  async getAuditLog(orderId: string) {
    return this.prisma.payment_audit_log.findMany({
      where: { order_id: orderId },
      orderBy: { created_at: "asc" },
    });
  }

  async getAuditLogs(query: PaymentAuditQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    const where: Prisma.payment_audit_logWhereInput = {};

    if (query.orderId) {
      where.order_id = { contains: query.orderId, mode: "insensitive" };
    }

    if (query.bookingId) {
      where.payments = { booking_id: query.bookingId };
    }

    if (query.razorpayPaymentId) {
      where.razorpay_payment_id = {
        contains: query.razorpayPaymentId,
        mode: "insensitive",
      };
    }

    if (query.toStatus) {
      where.to_status = query.toStatus;
    }

    if (query.triggeredBy) {
      where.triggered_by = {
        contains: query.triggeredBy,
        mode: "insensitive",
      };
    }

    if (query.from || query.to) {
      where.created_at = {};
      if (query.from) {
        const fromDate = new Date(query.from);
        if (isNaN(fromDate.getTime())) {
          throw new BadRequestException("Invalid 'from' date format");
        }
        where.created_at.gte = fromDate;
      }
      if (query.to) {
        const toDate = new Date(query.to);
        if (isNaN(toDate.getTime())) {
          throw new BadRequestException("Invalid 'to' date format");
        }
        where.created_at.lte = toDate;
      }
    }

    const [items, total] = await this.prisma.$transaction([
      this.prisma.payment_audit_log.findMany({
        where,
        include: {
          payments: {
            select: {
              booking_id: true,
              amount: true,
              currency: true,
              status: true,
            },
          },
        },
        orderBy: { created_at: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.payment_audit_log.count({ where }),
    ]);

    return {
      items,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize) || 1,
      },
    };
  }

  async getAuditSummary() {
    const now = new Date();
    const failedFrom = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const duplicateFrom = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const stuckCreatedBefore = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const [
      failedLast7Days,
      duplicateAttemptsLast7Days,
      createdStuckOver24Hours,
    ] = await this.prisma.$transaction([
      this.prisma.payment_audit_log.count({
        where: {
          to_status: PaymentStatus.FAILED,
          created_at: { gte: failedFrom },
        },
      }),
      this.prisma.payment_audit_log.count({
        where: {
          triggered_by: { contains: ":duplicate" },
          created_at: { gte: duplicateFrom },
        },
      }),
      this.prisma.payments.count({
        where: {
          status: PaymentStatus.CREATED,
          created_at: { lte: stuckCreatedBefore },
        },
      }),
    ]);

    return {
      window: {
        failedDays: 7,
        duplicateDays: 7,
        stuckCreatedHours: 24,
      },
      counts: {
        failedLast7Days,
        duplicateAttemptsLast7Days,
        createdStuckOver24Hours,
      },
      generatedAt: now,
    };
  }

  async getPaymentPlans(userId: string) {
    const plans = await this.prisma.payment_plans.findMany({
      where: {
        bookings: {
           parent_id: userId
        }
      },
      orderBy: {
        created_at: "desc",
      },
      include: {
        bookings: {
          include: {
            service_requests: true,
            users_bookings_nanny_idTousers: {
              select: {
                profiles: {
                  select: {
                    first_name: true,
                    last_name: true,
                    profile_image_url: true,
                  },
                },
              },
            },
          },
        },
        price_snapshots: {
          orderBy: {
            cycle_number: "asc",
          },
          include: {
            payments: {
              select: {
                status: true,
                amount: true,
                currency: true,
                created_at: true,
                order_id: true,
              },
            },
          },
        },
      },
    });

    return plans;
  }

  async chargeCancellationFee(bookingId: string, amount: number) {
    const amountInPaise = Math.round(amount * RAZORPAY_PAISE_MULTIPLIER);
    try {
      const order = await this.gateway.createOrder(amountInPaise, `cancel_${bookingId.substring(0, 10)}`, {
        booking_id: bookingId,
        type: 'cancellation_fee'
      });
      
      // Save to DB
      const createdPayment = await this.prisma.payments.create({
        data: {
          booking_id: bookingId,
          amount: amount,
          currency: "INR",
          provider: "razorpay",
          order_id: order.id,
          status: PaymentStatus.CAPTURED, // Simulating successful auto-charge
        },
      });

      await this.audit.writeLog(
        this.prisma,
        createdPayment.id,
        order.id,
        null,
        PaymentStatus.CAPTURED,
        "api:charge_cancellation_fee",
      );

      return { success: true, orderId: order.id };
    } catch (error) {
      this.logger.error("Failed to charge cancellation fee", error);
      return { success: false };
    }
  }

  async getNannyEarnings(nannyId: string) {
    // 1. Calculate total earned from captured payments
    const capturedPayments = await this.prisma.payments.aggregate({
      where: {
        nanny_id: nannyId,
        status: PaymentStatus.CAPTURED,
      },
      _sum: {
        amount: true,
      },
    });

    const totalEarned = Number(capturedPayments._sum.amount || 0);

    // 2. Fetch pending bookings to calculate pending earnings
    // "Pending" could mean bookings that are CONFIRMED or IN_PROGRESS, but not yet paid.
    // To simplify, we sum up the amount from created/pending payments for this nanny, or estimate from bookings.
    // Let's sum the amount from payments with status 'created' for this nanny.
    const pendingPayments = await this.prisma.payments.aggregate({
      where: {
        nanny_id: nannyId,
        status: PaymentStatus.CREATED,
      },
      _sum: {
        amount: true,
      },
    });

    const pendingEarned = Number(pendingPayments._sum.amount || 0);

    // 3. Fetch recent transactions (captured payments)
    const recentTransactions = await this.prisma.payments.findMany({
      where: {
        nanny_id: nannyId,
        status: PaymentStatus.CAPTURED,
      },
      include: {
        bookings: {
          select: {
            id: true,
            start_time: true,
            end_time: true,
            service_requests: {
              select: {
                category: true,
              },
            },
          },
        },
      },
      orderBy: {
        updated_at: "desc",
      },
      take: 10,
    });

    return {
      totalEarned,
      pendingEarned,
      bookings: recentTransactions,
    };
  }

  async refundPayment(paymentDbId: string, amount?: number) {
    const payment = await this.prisma.payments.findUnique({
      where: { id: paymentDbId },
      include: {
        bookings: true,
      },
    });

    if (!payment) {
      throw new NotFoundException("Payment record not found");
    }

    if (payment.status !== PaymentStatus.CAPTURED) {
      throw new BadRequestException("Only captured payments can be refunded");
    }

    if (!payment.payment_id) {
      throw new BadRequestException("No gateway payment ID associated with this record");
    }

    const amountPaise = amount ? Math.round(amount * RAZORPAY_PAISE_MULTIPLIER) : undefined;

    // Call Razorpay refund
    const refund = await this.gateway.refund(payment.payment_id, amountPaise);

    // Update DB
    const updatedPayment = await this.prisma.payments.update({
      where: { id: paymentDbId },
      data: {
        refund_id: refund.id,
        status: PaymentStatus.REFUNDED,
      },
    });

    // Write Audit Log
    await this.audit.writeLog(
      this.prisma,
      payment.id,
      payment.order_id,
      payment.status,
      PaymentStatus.REFUNDED,
      "admin:refund",
      payment.payment_id,
      { refund_id: refund.id, amount_refunded: amount || Number(payment.amount) }
    );

    // Notify Parent
    if (payment.bookings?.parent_id) {
      await this.notificationsService.createNotification(
        payment.bookings.parent_id,
        "Refund Processed",
        `A refund of ₹${amount || payment.amount} has been processed for your booking.`,
        "info",
      );
    }

    return updatedPayment;
  }
}
