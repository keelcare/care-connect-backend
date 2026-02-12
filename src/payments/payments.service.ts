import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import Razorpay from "razorpay";
import * as crypto from "crypto";
import { ConfigService } from "@nestjs/config";
import { NotificationsService } from "../notifications/notifications.service";

@Injectable()
export class PaymentsService {
  private razorpay: Razorpay;
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
    private notificationsService: NotificationsService,
  ) {
    const keyId = this.configService.get<string>('RAZORPAY_KEY_ID');
    const keySecret = this.configService.get<string>('RAZORPAY_KEY_SECRET');

    if (!keyId || !keySecret) {
      this.logger.warn(
        'RAZORPAY_KEY_ID or RAZORPAY_KEY_SECRET is not configured. Payment features will be disabled.',
      );
    }

    // Initialize Razorpay even if keys are missing (library might handle it or fail on call)
    this.razorpay = new Razorpay({
      key_id: keyId || '',
      key_secret: keySecret || '',
    });
  }

  // 1. Create Order (Server-Side Price Calculation)
  async createOrder(bookingId: string) {
    if (!this.configService.get('RAZORPAY_KEY_ID')) {
      this.logger.error('Cannot create order: RAZORPAY_KEY_ID missing');
      throw new BadRequestException('Payment service is currently unavailable');
    }

    const booking = await this.prisma.bookings.findUnique({
      where: { id: bookingId },
      include: {
        users_bookings_nanny_idTousers: {
          include: { nanny_details: true },
        },
      },
    });

    if (!booking) throw new NotFoundException("Booking not found");

    // Calculate Amount
    const hourlyRate =
      Number(booking.users_bookings_nanny_idTousers?.nanny_details?.hourly_rate) || 0;

    if (!booking.start_time || !booking.end_time) {
      throw new BadRequestException("Booking start or end time is missing");
    }
    let durationHours =
      (new Date(booking.end_time).getTime() - new Date(booking.start_time).getTime()) /
      (1000 * 60 * 60);

    // Robustness: if duration is negative, it's likely an overnight booking that wasn't correctly handled
    if (durationHours < 0) {
      durationHours += 24;
    }

    const amountInRupees = hourlyRate * durationHours;
    const amountInPaise = Math.round(amountInRupees * 100); // Razorpay requires paise

    this.logger.log(`Creating order for booking: ${bookingId}`);
    this.logger.log(`Hourly Rate: ${hourlyRate}, Duration: ${durationHours}, Amount(Paise): ${amountInPaise}`);

    if (amountInPaise < 100) {
      throw new BadRequestException(`Amount too low to create order: ₹${amountInRupees} INR`);
    }

    // Idempotency: Check if order already exists
    const existingPayment = await this.prisma.payments.findFirst({
      where: { booking_id: bookingId, status: "created" },
    });

    if (existingPayment) {
      return {
        orderId: existingPayment.order_id,
        amount: existingPayment.amount,
        currency: existingPayment.currency,
        key: this.configService.get("RAZORPAY_KEY_ID"),
      };
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
      await this.prisma.payments.create({
        data: {
          booking_id: bookingId,
          amount: amountInRupees,
          currency: "INR",
          provider: "razorpay",
          order_id: order.id,
          status: "created",
        },
      });

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
      const errorMessage = error?.error?.description || error?.message || "Failed to create payment order";
      throw new BadRequestException(errorMessage);
    }
  }

  // 2. Verify Payment (HMAC SHA256 Signature Check)
  async verifyPayment(orderId: string, paymentId: string, signature: string) {
    const secret = this.configService.get<string>('RAZORPAY_KEY_SECRET');

    if (!secret) {
      this.logger.error('RAZORPAY_KEY_SECRET not configured. Cannot verify payment.');
      throw new BadRequestException('Payment verification is currently unavailable');
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
    await this.capturePaymentSuccess(orderId, paymentId, signature);

    return { success: true };
  }

  // 3. Webhook Handler (Source of Truth)
  async handleWebhook(signature: string, payload: any) {
    const secret = this.configService.get<string>('RAZORPAY_WEBHOOK_SECRET');

    if (!secret) {
      this.logger.error('RAZORPAY_WEBHOOK_SECRET not configured. Cannot verify webhook.');
      throw new BadRequestException('Webhook verification is currently unavailable');
    }

    // Validate Webhook Signature
    const shasum = crypto.createHmac("sha256", secret);
    shasum.update(JSON.stringify(payload));
    const digest = shasum.digest("hex");

    if (digest !== signature) {
      this.logger.warn('Webhook signature mismatch - potential spoofing attempt');
      throw new BadRequestException("Invalid webhook signature");
    }

    const event = payload.event;
    const paymentEntity = payload.payload.payment.entity;
    const orderId = paymentEntity.order_id;
    const paymentId = paymentEntity.id;

    if (event === "payment.captured" || event === "order.paid") {
      await this.capturePaymentSuccess(orderId, paymentId, "webhook_verified");
    } else if (event === "payment.failed") {
      const payment = await this.prisma.payments.update({
        where: { order_id: orderId },
        data: {
          status: "failed",
          error_code: paymentEntity.error_code,
          error_description: paymentEntity.error_description,
        },
        include: { bookings: true }
      });

      if (payment.bookings) {
        await this.notificationsService.createNotification(
          payment.bookings.parent_id,
          "Payment Failed",
          `Your payment for booking #${payment.booking_id} failed. Please try again.`,
          "error"
        );
      }
    }

    return { status: "processed" };
  }

  // Helper: Atomically Successful Update
  private async capturePaymentSuccess(
    orderId: string,
    paymentId: string,
    signature: string,
  ) {
    // START TRANSACTION to prevent double-confirming
    await this.prisma.$transaction(async (tx) => {
      const payment = await tx.payments.findUnique({
        where: { order_id: orderId },
      });

      if (!payment) throw new NotFoundException("Payment record not found");
      if (payment.status === "captured") return; // Idempotency check

      // Update Payment
      await tx.payments.update({
        where: { order_id: orderId },
        data: {
          status: "captured",
          payment_id: paymentId,
          signature: signature,
        },
      });

      // Update Booking
      const updatedBooking = await tx.bookings.update({
        where: { id: payment.booking_id },
        data: { status: "COMPLETED" }, // Or whatever status signifies "Paid & Done"
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
}
