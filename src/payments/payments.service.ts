import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import Razorpay from "razorpay";
import * as crypto from "crypto";
import { ConfigService } from "@nestjs/config";
import { NotificationsService } from "../notifications/notifications.service";
import { PricingUtils } from "../common/utils/pricing.utils";
import { PaymentAuditQueryDto } from "./dto/payment-audit-query.dto";

@Injectable()
export class PaymentsService {
  private razorpay: Razorpay;
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
    private notificationsService: NotificationsService,
  ) {
    const keyId = this.configService.get<string>("RAZORPAY_KEY_ID");
    const keySecret = this.configService.get<string>("RAZORPAY_KEY_SECRET");

    if (!keyId || !keySecret) {
      this.logger.warn(
        "RAZORPAY_KEY_ID or RAZORPAY_KEY_SECRET is not configured. Payment features will be disabled.",
      );
    }

    // Initialize Razorpay even if keys are missing (library might handle it or fail on call)
    this.razorpay = new Razorpay({
      key_id: keyId || "",
      key_secret: keySecret || "",
    });
  }

  // 1. Create Order (Server-Side Price Calculation)
  async createOrder(
    bookingId: string,
    installmentId?: string,
    requestingUserId?: string,
  ) {
    if (!this.configService.get("RAZORPAY_KEY_ID")) {
      this.logger.error("Cannot create order: RAZORPAY_KEY_ID missing");
      throw new BadRequestException("Payment service is currently unavailable");
    }

    const booking = await this.prisma.bookings.findUnique({
      where: { id: bookingId },
      include: {
        users_bookings_nanny_idTousers: {
          include: { nanny_details: true },
        },
        service_requests: true,
      },
    });

    if (!booking) throw new NotFoundException("Booking not found");

    // Security: ensure the user requesting payment is the booking's parent
    if (requestingUserId && booking.parent_id !== requestingUserId) {
      throw new BadRequestException(
        "You are not authorised to pay for this booking",
      );
    }

    // Calculate Amount
    const service = await this.prisma.services.findUnique({
      where: { name: booking.service_requests?.category || "CC" },
    });
    const hourlyRate = Number(service?.hourly_rate || 500);

    if (!booking.start_time || !booking.end_time) {
      throw new BadRequestException("Booking start or end time is missing");
    }
    let durationHours =
      (new Date(booking.end_time).getTime() -
        new Date(booking.start_time).getTime()) /
      (1000 * 60 * 60);

    // Robustness: if duration is negative, it's likely an overnight booking that wasn't correctly handled
    if (durationHours < 0) {
      durationHours += 24;
    }

    const { totalAmount, monthlyCost, planDurationMonths } =
      PricingUtils.calculateTotal(
        hourlyRate,
        durationHours,
        Number(booking.service_requests?.["discount_percentage"] || 0),
        Number(booking.service_requests?.["plan_duration_months"] || 1),
        booking.service_requests?.["plan_type"] || "ONE_TIME",
      );

    let amountInRupees = totalAmount;

    // Default to first pending installment if planDurationMonths > 1
    let activeInstallmentId = installmentId;
    if (planDurationMonths > 1) {
      amountInRupees = monthlyCost;

      let installment;
      if (installmentId) {
        installment = await this.prisma.payment_installments.findUnique({
          where: { id: installmentId },
        });
        if (!installment || installment.booking_id !== bookingId) {
          throw new BadRequestException("Invalid installment specified");
        }
      } else {
        installment = await this.prisma.payment_installments.findFirst({
          where: { booking_id: bookingId, status: "pending" },
          orderBy: { installment_no: "asc" },
        });
        if (!installment) {
          throw new BadRequestException(
            "No pending installments found for this booking.",
          );
        }
      }

      amountInRupees = Number(installment.amount_due);
      activeInstallmentId = installment.id;
    }

    const amountInPaise = Math.round(amountInRupees * 100); // Razorpay requires paise

    this.logger.log(`Creating order for booking: ${bookingId}`);
    this.logger.log(
      `Hourly Rate: ${hourlyRate}, Duration: ${durationHours}, Amount(Paise): ${amountInPaise}`,
    );

    if (amountInPaise < 100) {
      throw new BadRequestException(
        `Amount too low to create order: ₹${amountInRupees} INR`,
      );
    }

    // Idempotency: Check if order already exists for this booking/installment
    const existingPayment = await this.prisma.payments.findFirst({
      where: {
        booking_id: bookingId,
        status: "created",
        payment_installments: activeInstallmentId
          ? {
              some: { id: activeInstallmentId },
            }
          : undefined,
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

    // Protection: Ensure we don't pay for an already paid installment
    if (activeInstallmentId) {
      const inst = await this.prisma.payment_installments.findUnique({
        where: { id: activeInstallmentId },
      });
      if (inst?.status === "paid") {
        throw new BadRequestException(
          "This installment has already been paid.",
        );
      }
    }

    try {
      const options = {
        amount: amountInPaise,
        currency: "INR",
        receipt: `receipt_${bookingId.substring(0, 10)}`,
        notes: { booking_id: bookingId },
      };

      const order = await this.razorpay.orders.create(options);

      // Save to DB
      const createdPayment = await this.prisma.payments.create({
        data: {
          booking_id: bookingId,
          amount: amountInRupees,
          currency: "INR",
          provider: "razorpay",
          order_id: order.id,
          status: "created",
        },
      });

      if (activeInstallmentId) {
        await this.prisma.payment_installments.update({
          where: { id: activeInstallmentId },
          data: { payment_id: createdPayment.id },
        });
      }

      await this.writeAuditLog(
        this.prisma,
        createdPayment.id,
        order.id,
        null,
        "created",
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
    const secret = this.configService.get<string>("RAZORPAY_KEY_SECRET");

    if (!secret) {
      this.logger.error(
        "RAZORPAY_KEY_SECRET not configured. Cannot verify payment.",
      );
      throw new BadRequestException(
        "Payment verification is currently unavailable",
      );
    }

    const generatedSignature = crypto
      .createHmac("sha256", secret)
      .update(orderId + "|" + paymentId)
      .digest("hex");

    if (generatedSignature !== signature) {
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
    const secret = this.configService.get<string>("RAZORPAY_WEBHOOK_SECRET");

    if (!secret) {
      this.logger.error(
        "RAZORPAY_WEBHOOK_SECRET not configured. Cannot verify webhook.",
      );
      throw new BadRequestException(
        "Webhook verification is currently unavailable",
      );
    }

    // Validate Webhook Signature
    const shasum = crypto.createHmac("sha256", secret);
    shasum.update(JSON.stringify(payload));
    const digest = shasum.digest("hex");

    if (digest !== signature) {
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
      await this.capturePaymentSuccess(
        orderId,
        paymentId,
        "webhook_verified",
        `webhook:${event}`,
      );
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

      await this.writeAuditLog(
        this.prisma,
        existingPayment.id,
        orderId,
        existingPayment.status ?? null,
        "failed",
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

      await this.writeAuditLog(
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

  private async writeAuditLog(
    tx: any, // Use any for transaction context (flexible for different transaction types)
    paymentDbId: string,
    orderId: string,
    fromStatus: string | null,
    toStatus: string,
    triggeredBy: string,
    razorpayPaymentId?: string,
    metadata: Prisma.InputJsonValue = {},
  ) {
    // Check if table exists in tx (Prisma Client might not show it if not regenerated properly)
    if (tx.payment_audit_log) {
      await tx.payment_audit_log.create({
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
      this.logger.warn(
        "payment_audit_log not found in transaction context, skipping audit log.",
      );
    }
  }

  // Helper: Atomically Successful Update
  private async capturePaymentSuccess(
    orderId: string,
    paymentId: string,
    signature: string,
    triggeredBy: string,
  ) {
    // START TRANSACTION to prevent double-confirming
    await this.prisma.$transaction(async (tx) => {
      const payment = await tx.payments.findUnique({
        where: { order_id: orderId },
      });

      if (!payment) throw new NotFoundException("Payment record not found");
      if (payment.status === "captured") {
        await this.writeAuditLog(
          tx,
          payment.id,
          orderId,
          "captured",
          "captured",
          `${triggeredBy}:duplicate`,
          paymentId,
        );
        return;
      }

      // Update Payment
      await tx.payments.update({
        where: { order_id: orderId },
        data: {
          status: "captured",
          payment_id: paymentId,
          signature: signature,
        },
      });

      // Update Installment status if exists
      await tx.payment_installments.updateMany({
        where: { payment_id: payment.id },
        data: {
          status: "paid",
          updated_at: new Date(),
        },
      });

      await this.writeAuditLog(
        tx,
        payment.id,
        orderId,
        payment.status,
        "captured",
        triggeredBy,
        paymentId,
        {
          amount: Number(payment.amount),
          currency: payment.currency,
        },
      );

      // Update Booking status:
      // - For subscription bookings (has a subscription_plan), set to "confirmed"
      //   so the booking remains active across all installment months.
      // - For one-time bookings, set to "COMPLETED" as the service is now fully paid.
      const subscriptionPlan = await tx.subscription_plans.findUnique({
        where: { booking_id: payment.booking_id },
      });

      // Update next_due_date to the next pending installment if available
      if (subscriptionPlan) {
        const nextInstallment = await tx.payment_installments.findFirst({
          where: {
            booking_id: payment.booking_id,
            status: "pending",
          },
          orderBy: { installment_no: "asc" },
        });

        if (nextInstallment) {
          await tx.subscription_plans.update({
            where: { id: subscriptionPlan.id },
            data: { next_due_date: nextInstallment.due_date },
          });
        }
      }

      const newBookingStatus = subscriptionPlan ? "confirmed" : "COMPLETED";

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
          to_status: "failed",
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
          status: "created",
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

  async generateInstallmentsForBooking(
    bookingId: string,
    totalAmount: number,
    months: number,
    startDate: Date,
  ) {
    if (months <= 1) return;

    // Check if installments already exist
    const existing = await this.prisma.payment_installments.count({
      where: { booking_id: bookingId },
    });
    if (existing > 0) return;

    this.logger.log(
      `Generating ${months} installments for booking ${bookingId}`,
    );
    const amountPerInstallment = totalAmount / months;

    const installments = Array.from({ length: months }).map((_, index) => {
      const dueDate = new Date(startDate);
      dueDate.setMonth(dueDate.getMonth() + index);
      return {
        booking_id: bookingId,
        installment_no: index + 1,
        amount_due: amountPerInstallment,
        due_date: dueDate,
        status: "pending",
      };
    });

    await this.prisma.payment_installments.createMany({
      data: installments,
    });
  }

  async getSubscriptionPlans(userId: string) {
    const plans = await this.prisma.subscription_plans.findMany({
      where: {
        parent_id: userId,
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
        payment_installments: {
          orderBy: {
            installment_no: "asc",
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
}
