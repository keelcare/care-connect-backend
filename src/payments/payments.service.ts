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
import {
  AdvancePaymentConfig,
  MATCHING_FEE_KIND,
  PricingEngineService,
} from "../common/pricing.service";
import { MailService } from "../mail/mail.service";
import {
  MANUAL_PENDING_PROVIDER,
  PaymentStatus,
  INSTALMENT_PAID,
  INSTALMENT_PENDING,
  INSTALMENT_REFUNDED,
  INSTALMENT_VOID,
} from "../constants";
import {
  caregiverEarningsWhere,
  preTaxBookingValue,
  preTaxServiceFee,
  projectableBookingsWhere,
  round2,
} from "../common/payout-policy";
import { daysInWindow, istDateKey, resolvePeriod } from "../common/period";
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
  /**
   * The installment this order should charge.
   *
   * Defaults to the earliest unpaid one so a parent tapping "Pay" always settles
   * the oldest thing they owe; `installmentId` lets the pending-payments screen
   * name a specific balance. Either way the row must be pending and belong to this
   * booking — a caller cannot re-charge something settled or reach another
   * parent's balance by guessing an id.
   */
  private async resolveInstallmentToCharge(
    bookingId: string,
    snapshotId: string,
    installmentId?: string,
  ) {
    if (installmentId) {
      const named = await this.prisma.payment_installments.findUnique({
        where: { id: installmentId },
      });
      if (!named || named.booking_id !== bookingId) {
        throw new NotFoundException("Instalment not found for this booking");
      }
      if (named.status !== INSTALMENT_PENDING) {
        // Same wording the client matches on to distinguish a settled charge from
        // a real failure — see usePayment's ALREADY_PAID classification.
        throw new BadRequestException("This instalment has already been paid.");
      }
      return named;
    }

    const next = await this.prisma.payment_installments.findFirst({
      where: { booking_id: bookingId, status: INSTALMENT_PENDING },
      orderBy: [{ cycle_number: "asc" }, { installment_no: "asc" }],
    });
    if (next) return next;

    // A snapshot written before installments existed has none; treat it as a
    // single full-amount charge rather than failing a legacy booking.
    const legacy = await this.backfillLegacySnapshotInstallment(bookingId, snapshotId);
    if (legacy) return legacy;

    throw new BadRequestException("This booking has already been paid.");
  }

  /**
   * Give a pre-split snapshot the one installment row the rest of the flow assumes.
   * Only ever called when a snapshot genuinely has none — never to re-split a cycle
   * whose terms were already agreed with the parent.
   */
  private async backfillLegacySnapshotInstallment(
    bookingId: string,
    snapshotId: string,
  ) {
    const snapshot = await this.prisma.price_snapshots.findUnique({
      where: { id: snapshotId },
      include: { payment_installments: { select: { id: true } } },
    });
    if (!snapshot || snapshot.payment_installments.length > 0) return null;

    return this.prisma.payment_installments.create({
      data: {
        booking_id: bookingId,
        price_snapshot_id: snapshot.id,
        payment_plan_id: snapshot.payment_plan_id,
        cycle_number: snapshot.cycle_number,
        installment_no: 1,
        total_installments: 1,
        amount: snapshot.final_amount,
        subtotal_amount: snapshot.subtotal_amount,
        gst_amount: snapshot.gst_amount,
        due_date: new Date(),
        status: INSTALMENT_PENDING,
      },
    });
  }

  /**
   * Open the first billing cycle of a recurring plan the moment a caregiver is
   * assigned, so the advance (and the matching fee, if one is configured) is
   * payable immediately instead of waiting for a session to be delivered.
   *
   * Billing for a plan anchors to its **earliest live session**: a cycle is priced
   * as a whole month, so it must hang off one booking rather than each session
   * snapshotting a month of its own. The earliest one is the stable choice —
   * later sessions come and go as the rolling generator runs.
   *
   * Best-effort by design. This runs after the assignment transaction has already
   * committed; a pricing failure here must leave the caregiver assigned and let
   * `createOrder` snapshot lazily as it always has, not roll back a placement.
   */
  async openCycleForPlan(recurringRequestId: string, cycleNumber: number): Promise<void> {
    const anchor = await this.planBillingAnchor(recurringRequestId);

    if (!anchor) {
      this.logger.warn(
        `Plan ${recurringRequestId} has no assigned session to anchor billing to; skipping cycle ${cycleNumber}.`,
      );
      return;
    }

    // Assignment can be retried and the cron runs daily, so re-opening a cycle
    // the parent may already be paying must be a no-op rather than a second bill.
    const existing = await this.prisma.price_snapshots.findFirst({
      where: { booking_id: anchor, cycle_number: cycleNumber },
      select: { id: true },
    });
    if (existing) return;

    try {
      const { finalAmount } = await this.pricingService.calculateAndSnapshot({
        bookingId: anchor,
        cycleNumber,
      });
      this.logger.log(
        `Opened cycle ${cycleNumber} for plan ${recurringRequestId} on booking ${anchor} (${finalAmount})`,
      );
    } catch (err) {
      this.logger.error(
        `Could not open cycle ${cycleNumber} for plan ${recurringRequestId}; it will be snapshotted at checkout instead.`,
        err as Error,
      );
    }
  }

  /** Cycle 1, opened the moment a caregiver is assigned. */
  async openFirstCycleForPlan(recurringRequestId: string): Promise<void> {
    return this.openCycleForPlan(recurringRequestId, 1);
  }

  /**
   * The booking a plan's cycles are billed against — its earliest live session.
   *
   * Every cycle of a plan hangs off this one booking, because a cycle is priced
   * as a whole month and `price_snapshots` are keyed by `(booking_id, cycle_number)`.
   * Anchoring on the earliest session keeps that key stable as the rolling
   * generator adds later ones.
   */
  private async planBillingAnchor(recurringRequestId: string): Promise<string | null> {
    const anchor = await this.prisma.bookings.findFirst({
      where: {
        recurring_request_id: recurringRequestId,
        status: { not: BookingStatus.CANCELLED },
        nanny_id: { not: null },
      },
      orderBy: { start_time: "asc" },
      select: { id: true },
    });
    return anchor?.id ?? null;
  }

  /** "Payment for Booking #x", plus which half when the cycle is split. */
  private orderDescription(
    bookingId: string,
    installment: { installment_no: number; total_installments: number; kind: string },
  ): string {
    const base = `Payment for Booking #${bookingId}`;
    // The fee is a placement charge, not the nth share of a cycle price. Calling
    // it "Instalment 1 of 3" on the gateway screen would misdescribe it.
    if (installment.kind === MATCHING_FEE_KIND) return `Matching fee for Booking #${bookingId}`;
    return installment.total_installments > 1
      ? `${base} (Instalment ${installment.installment_no} of ${installment.total_installments})`
      : base;
  }

  /**
   * The terms to show before checkout, computed server-side.
   *
   * The client must never derive "50% of X" itself: rounding lands the odd paisa on
   * the advance, and a client that recomputed it would quote a figure a rupee off
   * from what we actually charge.
   */
  private splitDisclosure(
    installment: {
      id: string;
      installment_no: number;
      total_installments: number;
      kind: string;
    },
    snapshot: { final_amount: Prisma.Decimal | number },
    config: AdvancePaymentConfig,
  ) {
    return {
      installmentId: installment.id,
      installmentNo: installment.installment_no,
      totalInstallments: installment.total_installments,
      /** Lets the client label this charge as the placement fee rather than a share. */
      kind: installment.kind,
      cycleTotal: Number(snapshot.final_amount),
      /** Days from paying this half to the balance falling due; null when nothing follows. */
      balanceDueInDays:
        installment.installment_no < installment.total_installments ? config.dueDays : null,
    };
  }

  async createOrder(
    bookingId: string,
    requestingUserId?: string,
    installmentId?: string,
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

    // The oldest cycle that still has something owed on it wins, whatever the
    // plan counter says. A recurring plan has no `payment_plans` row, so this
    // used to resolve to cycle 1 forever: once cycle 1 settled, month 2 was
    // reported as "already paid" and could not be charged at all.
    const openCycle = await this.prisma.payment_installments.findFirst({
      where: { booking_id: bookingId, status: INSTALMENT_PENDING },
      orderBy: [{ cycle_number: "asc" }, { installment_no: "asc" }],
      select: { cycle_number: true },
    });

    const cycleNumber =
      openCycle?.cycle_number ?? (paymentPlan ? paymentPlan.cycles_completed + 1 : 1);

    // Check if we already took a snapshot for this cycle that is pending
    let snapshot = await this.prisma.price_snapshots.findFirst({
        where: { booking_id: bookingId, cycle_number: cycleNumber, status: 'pending' }
    });

    if (!snapshot) {
        // This cycle has already been settled in full. Only a plan advancing its
        // cycle counter should ever open a new one — snapshotting again here
        // would bill a second time for work already paid for, which is exactly
        // what the old "a captured payment exists" guard prevented before split
        // payments made that guard reject legitimate balances.
        const settled = await this.prisma.price_snapshots.findFirst({
          where: { booking_id: bookingId, cycle_number: cycleNumber, status: "charged" },
        });
        if (settled) {
          throw new BadRequestException("This booking has already been paid.");
        }

        // Calculate and snapshot
        const res = await this.pricingService.calculateAndSnapshot({
           bookingId,
           cycleNumber,
           paymentPlanId: paymentPlan?.id
        });
        snapshot = await this.prisma.price_snapshots.findUnique({where: {id: res.snapshotId}});
    }

    if (!snapshot) throw new BadRequestException("Failed to generate price snapshot");

    // What is owed, and how much of it, is a stored fact. Note this replaces the
    // old "already has a captured payment" guard: a split cycle legitimately takes
    // two charges, and a booking with no payment_plan (a Pay-in-Full multi-month
    // plan never gets one) would otherwise have its balance half refused as a
    // duplicate — leaving the booking unpayable while the app said it was settled.
    const installment = await this.resolveInstallmentToCharge(
      bookingId,
      snapshot.id,
      installmentId,
    );

    // The oldest unpaid instalment can belong to an earlier cycle than the one we
    // just resolved — a balance left outstanding holds the plan on its cycle, but
    // an explicitly named instalment need not. Quote the cycle the charge is
    // actually part of, not the one we happened to look up.
    if (installment.price_snapshot_id !== snapshot.id) {
      snapshot =
        (await this.prisma.price_snapshots.findUnique({
          where: { id: installment.price_snapshot_id },
        })) ?? snapshot;
    }

    const advanceConfig = await this.pricingService.getAdvancePaymentConfig();
    const amountInRupees = Number(installment.amount);
    const amountInPaise = Math.round(amountInRupees * RAZORPAY_PAISE_MULTIPLIER); // Razorpay requires paise

    this.logger.log(`Creating order for booking: ${bookingId}`);
    this.logger.log(
      `Cycle: ${cycleNumber}, Instalment: ${installment.installment_no}/${installment.total_installments}, Amount(Paise): ${amountInPaise}`,
    );

    if (amountInPaise < RAZORPAY_MIN_AMOUNT_PAISE) {
      throw new BadRequestException(
        `Amount too low to create order: ₹${amountInRupees} INR`,
      );
    }

    // Idempotency: has *this instalment* already got an open order? Keyed on the
    // instalment rather than the snapshot, because both halves of a split cycle
    // share a snapshot and a snapshot-keyed lookup cannot tell one half's
    // abandoned checkout from the other's.
    const existingPayment = installment.payment_id
      ? await this.prisma.payments.findFirst({
          where: { id: installment.payment_id, status: PaymentStatus.CREATED },
        })
      : null;

    if (existingPayment) {
      // A stored order is only safe to replay if Razorpay still recognises it
      // under the *current* key and it is still open for the amount we are
      // charging now. An order that is unknown (key rotated), already paid, or
      // priced differently makes checkout fail with a bare "Payment Failed -
      // Unexpected Error", and since we would hand back the same dead order on
      // every retry, the booking becomes permanently unpayable.
      const rupees = Number(existingPayment.amount);
      const expectedPaise = Math.round(rupees * RAZORPAY_PAISE_MULTIPLIER);
      const liveOrder = await this.gateway.fetchOrder(existingPayment.order_id);
      const reusable =
        liveOrder !== null &&
        (liveOrder.status === "created" || liveOrder.status === "attempted") &&
        liveOrder.amount === expectedPaise &&
        expectedPaise === amountInPaise;

      if (reusable) {
        // Must mirror the fresh-order shape exactly. amount is rupees for
        // display; amount_due is paise for the Razorpay SDK — returning only
        // rupees here made every retry send a mismatched amount to checkout.
        return {
          orderId: existingPayment.order_id,
          order_id: existingPayment.order_id,
          amount: rupees,
          amount_due: expectedPaise,
          // The column defaults to lowercase "inr"; checkout only accepts the
          // ISO form and rejects anything else as an unexpected error.
          currency: (existingPayment.currency ?? "INR").toUpperCase(),
          key: this.configService.get("RAZORPAY_KEY_ID"),
          key_id: this.configService.get("RAZORPAY_KEY_ID"),
          name: "Care Connect",
          description: this.orderDescription(bookingId, installment),
          ...this.splitDisclosure(installment, snapshot, advanceConfig),
        };
      }

      // Retire the unusable row so this lookup stops finding it, then fall
      // through and mint a fresh order below.
      this.logger.warn(
        `Discarding unusable order ${existingPayment.order_id} for booking ${bookingId} ` +
          `(gateway status: ${liveOrder?.status ?? "not found"}, ` +
          `gateway amount: ${liveOrder?.amount ?? "n/a"}, expected: ${amountInPaise})`,
      );
      await this.prisma.payments.update({
        where: { id: existingPayment.id },
        data: { status: PaymentStatus.FAILED, error_description: "Order no longer usable at gateway" },
      });
      // Release the instalment from the dead order, or the lookup above keeps
      // finding it and we never mint the replacement.
      await this.prisma.payment_installments.update({
        where: { id: installment.id },
        data: { payment_id: null },
      });
      await this.audit.writeLog(
        this.prisma,
        existingPayment.id,
        existingPayment.order_id,
        PaymentStatus.CREATED,
        PaymentStatus.FAILED,
        "api:create_order_stale",
      );
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

      // Link payment to the instalment it pays for. The snapshot's own payment_id
      // is left alone until the cycle is fully settled — it can only hold one id,
      // and pointing it at a half would misreport the cycle to everything that
      // reads it.
      await this.prisma.payment_installments.update({
        where: { id: installment.id },
        data: { payment_id: createdPayment.id },
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
        description: this.orderDescription(bookingId, installment),
        ...this.splitDisclosure(installment, snapshot, advanceConfig),
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
  async retryOrder(bookingId: string, requestingUserId: string) {
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

    // Nothing left owed means nothing to retry. Asked of the instalments rather
    // than "does a captured payment exist": a split cycle has a captured advance
    // while its balance is still outstanding, and a Pay-in-Full multi-month plan
    // has no payment_plan to make that distinction any other way.
    const outstanding = await this.prisma.payment_installments.count({
      where: { booking_id: bookingId, status: INSTALMENT_PENDING },
    });

    if (outstanding === 0) {
      throw new BadRequestException("Booking is already paid successfully.");
    }

    this.logger.log(`Retrying order calculation for booking: ${bookingId}`);
    // Pass the requesting user so createOrder's ownership guard still applies.
    return this.createOrder(bookingId, requestingUserId);
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
    // START TRANSACTION to prevent double-confirming.
    // IMPORTANT: keep ONLY fast, atomic DB writes inside the transaction. Anything
    // that hits an external service (FCM push, email) or touches `this.prisma`
    // instead of `tx` must run AFTER commit — otherwise it holds the interactive
    // transaction open and trips the 5s timeout ("transaction already closed").

    // Read the deferral window before opening the transaction — it is a settings
    // lookup on `this.prisma` and has no business holding the tx open.
    const { dueDays: advanceDueDays } =
      await this.pricingService.getAdvancePaymentConfig();
    const capturedAt = new Date();

    const result = await this.prisma.$transaction(async (tx) => {
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
        return { alreadyCaptured: true as const };
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

      const paymentPlan = await tx.payment_plans.findUnique({
        where: { booking_id: payment.booking_id },
      });

      // ── Settle the instalment this payment was for ─────────────────────────
      // Claimed with a guarded updateMany rather than read-then-write: the verify
      // endpoint and the webhook both fire for the same money, and a split cycle
      // has two orders whose captures can interleave. A second caller updates zero
      // rows and must then skip every downstream effect — otherwise the plan
      // advances twice and the parent is billed a cycle they never reached.
      const installment = await tx.payment_installments.findFirst({
        where: { payment_id: payment.id },
      });

      const claimed = installment
        ? (
            await tx.payment_installments.updateMany({
              where: { id: installment.id, status: INSTALMENT_PENDING },
              data: { status: INSTALMENT_PAID, paid_at: capturedAt, updated_at: capturedAt },
            })
          ).count
        : 0;

      // Legacy rows predating instalments still resolve their snapshot the old way.
      const snapshot = installment
        ? await tx.price_snapshots.findUnique({ where: { id: installment.price_snapshot_id } })
        : await tx.price_snapshots.findFirst({ where: { payment_id: payment.id } });

      if (installment && claimed === 0) {
        // Someone else already settled this half. The payment row is now CAPTURED
        // either way, but nothing downstream may run a second time.
        return {
          alreadyCaptured: false as const,
          duplicateInstalment: true as const,
          payment,
          paymentPlan,
          snapshot,
          installment,
          cycleSettled: false,
          updatedBooking: await tx.bookings.findUnique({ where: { id: payment.booking_id } }),
        };
      }

      // The balance's clock starts now — from the parent's money actually leaving,
      // not from a checkout screen. A date already written is a promise made at
      // checkout and is never moved by a later change to the setting.
      if (installment && installment.installment_no < installment.total_installments) {
        const due = new Date(capturedAt);
        due.setDate(due.getDate() + advanceDueDays);
        await tx.payment_installments.updateMany({
          where: {
            price_snapshot_id: installment.price_snapshot_id,
            installment_no: installment.installment_no + 1,
            due_date: null,
          },
          data: { due_date: due, updated_at: capturedAt },
        });
      }

      // ── Is the whole cycle settled? ────────────────────────────────────────
      const stillOwed = installment
        ? await tx.payment_installments.count({
            where: {
              price_snapshot_id: installment.price_snapshot_id,
              status: INSTALMENT_PENDING,
            },
          })
        : 0;
      const cycleSettled = stillOwed === 0;

      let updatedBooking = await tx.bookings.findUnique({
        where: { id: payment.booking_id },
      });

      if (cycleSettled) {
        if (snapshot) {
          await tx.price_snapshots.updateMany({
            where: { id: snapshot.id, status: "pending" },
            data: {
              status: "charged",
              payment_id: payment.id,
              razorpay_payment_id: paymentId,
            },
          });
        }

        if (paymentPlan) {
          // Guarded on the cycle we believe we just finished, so a racing capture
          // cannot advance the plan a second time.
          await this.pricingService.advancePaymentPlanTx(
            tx,
            paymentPlan.id,
            installment ? installment.cycle_number - 1 : undefined,
          );
        }

        const newBookingStatus =
          paymentPlan && paymentPlan.cycles_completed + 1 < paymentPlan.total_cycles
            ? BookingStatus.CONFIRMED
            : BookingStatus.COMPLETED;

        updatedBooking = await tx.bookings.update({
          where: { id: payment.booking_id },
          data: { status: newBookingStatus },
        });
      }
      // A part-paid cycle deliberately leaves booking status alone: capturing the
      // advance of a final cycle would otherwise flip the booking to COMPLETED — a
      // terminal state — with half the money still outstanding.

      return {
        alreadyCaptured: false as const,
        duplicateInstalment: false as const,
        payment,
        paymentPlan,
        snapshot,
        installment,
        cycleSettled,
        updatedBooking,
      };
    });

    if (result.alreadyCaptured) {
      return { alreadyCaptured: true };
    }

    // ── Post-commit side effects (outside the transaction) ──────────────────────
    // The payment is already durably CAPTURED, the instalment settled, and the plan
    // advanced — all of that committed atomically above, because a plan left behind
    // by a failed best-effort retry would stall the booking silently rather than
    // merely re-charging a cycle. What remains here is notification only: external
    // calls that must never hold the transaction open or fail verification.
    const { payment, snapshot, installment, cycleSettled, updatedBooking } = result;

    if (result.duplicateInstalment || !updatedBooking) {
      // Already settled by the racing caller, which sent these notifications.
      return { alreadyCaptured: false };
    }

    const isPartial = !!installment && installment.total_installments > 1;
    const balanceDue = isPartial && !cycleSettled
      ? Number(snapshot?.final_amount ?? 0) - Number(payment.amount)
      : 0;

    // Notify Parent
    await this.notificationsService
      .createNotification(
        updatedBooking.parent_id,
        "Payment Successful",
        balanceDue > 0
          ? `Your advance payment of ₹${payment.amount} is confirmed. The remaining ₹${round2(balanceDue)} is due in ${advanceDueDays} days.`
          : `Your payment of ₹${payment.amount} has been processed successfully.`,
        "success",
        "payment",
        updatedBooking.id,
      )
      .catch((err) =>
        this.logger.error("Failed to notify parent of payment", err),
      );

    // Notify Nanny
    if (updatedBooking.nanny_id) {
      await this.notificationsService
        .createNotification(
          updatedBooking.nanny_id,
          "Payment Received",
          `A payment of ₹${payment.amount} has been received for your booking.`,
          "success",
        )
        .catch((err) =>
          this.logger.error("Failed to notify nanny of payment", err),
        );
    }

    // Send Payment Receipt Email (fire-and-forget)
    try {
      const parentUser = await this.prisma.users.findUnique({
        where: { id: updatedBooking.parent_id },
        include: { profiles: true },
      });
      if (parentUser?.email) {
        const parentName = parentUser.profiles?.first_name
          ? `${parentUser.profiles.first_name} ${parentUser.profiles.last_name || ""}`.trim()
          : "Parent";

        this.mailService
          .sendPaymentReceiptEmail(parentUser.email, parentName, {
            amount: Number(payment.amount),
            currency: payment.currency,
            date: new Date().toLocaleDateString(),
            receiptId: payment.order_id,
            bookingDetails: isPartial
              ? `Booking #${updatedBooking.id.substring(0, 8)} — instalment ${installment!.installment_no} of ${installment!.total_installments}`
              : `Booking #${updatedBooking.id.substring(0, 8)}`,
            // Breakup for the amount actually charged. Taken from the instalment,
            // not the cycle: a receipt for half the money showing the full cycle's
            // GST line would not add up.
            subtotal: installment
              ? Number(installment.subtotal_amount)
              : snapshot
                ? Number(snapshot.subtotal_amount)
                : undefined,
            gstPercent: snapshot ? Number(snapshot.gst_percent_used) : undefined,
            gstAmount: installment
              ? Number(installment.gst_amount)
              : snapshot
                ? Number(snapshot.gst_amount)
                : undefined,
          })
          .catch((err) =>
            this.logger.error("Failed to send payment receipt email", err),
          );
      }
    } catch (err) {
      this.logger.error("Failed to load parent for receipt email", err as Error);
    }

    return { alreadyCaptured: false };
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
            // How each cycle is actually collected. The client renders halves from
            // these rows rather than computing 50% of the cycle itself — rounding
            // puts the odd paisa on the advance, so a client-side split would quote
            // a figure that differs from what we charge.
            payment_installments: {
              orderBy: { installment_no: "asc" },
            },
          },
        },
      },
    });

    return plans;
  }

  /**
   * Every real money movement on the parent's account, not just the ones tied to a
   * billing cycle — cancellation fees create a `payments` row with no price_snapshot,
   * so they are invisible to `getPaymentPlans`.
   *
   * Excluded: `manual_pending` rows, which the booking-completed listener writes as a
   * payout accrual when no payment exists. The parent never paid those, so surfacing
   * them would invent a charge. Also excluded: `created` orders, which are checkouts
   * that were opened and abandoned without money leaving the account.
   */
  /**
   * Everything this parent still owes, oldest first.
   *
   * Cancelled bookings are excluded outright rather than relying on their
   * instalments having been voided: a balance that keeps appearing for care that
   * was called off is the kind of thing a parent reasonably reads as being billed
   * for nothing.
   */
  async getPendingInstallments(userId: string) {
    const rows = await this.prisma.payment_installments.findMany({
      where: {
        status: INSTALMENT_PENDING,
        bookings: {
          parent_id: userId,
          status: { not: BookingStatus.CANCELLED },
        },
      },
      orderBy: [{ due_date: "asc" }, { cycle_number: "asc" }, { installment_no: "asc" }],
      take: 100,
      include: {
        price_snapshots: {
          select: { final_amount: true, cycle_number: true },
        },
        bookings: {
          select: {
            id: true,
            nanny_id: true,
            start_time: true,
            service_requests: { select: { category: true } },
            recurring_service_requests: { select: { id: true, category: true } },
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
      },
    });

    const now = Date.now();

    return rows.map((row) => {
      const profile = row.bookings?.users_bookings_nanny_idTousers?.profiles ?? null;
      const caregiverName =
        [profile?.first_name, profile?.last_name].filter(Boolean).join(" ") || null;

      return {
        id: row.id,
        bookingId: row.booking_id,
        cycleNumber: row.cycle_number,
        installmentNo: row.installment_no,
        totalInstallments: row.total_installments,
        amount: Number(row.amount),
        cycleTotal: Number(row.price_snapshots?.final_amount ?? row.amount),
        dueDate: row.due_date,
        // A balance with no date yet is waiting on its advance being paid, so it
        // is upcoming rather than late however long it has sat there.
        overdue: !!row.due_date && row.due_date.getTime() < now,
        caregiverName,
        caregiverImageUrl: profile?.profile_image_url ?? null,
        category:
          row.bookings?.service_requests?.category ??
          row.bookings?.recurring_service_requests?.category ??
          null,
        sessionStart: row.bookings?.start_time ?? null,
        payable: !!row.bookings?.nanny_id,
        /** `cycle` or `matching_fee` — the client labels the charge from this. */
        kind: row.kind,
        /** True when this is a recurring plan's cycle rather than a single session. */
        isPlan: !!row.bookings?.recurring_service_requests,
      };
    });
  }

  async getParentTransactions(userId: string, page = 1, pageSize = 20) {
    const where: Prisma.paymentsWhereInput = {
      bookings: { parent_id: userId },
      provider: { not: MANUAL_PENDING_PROVIDER },
      status: {
        in: [
          PaymentStatus.CAPTURED,
          PaymentStatus.PENDING_RELEASE,
          PaymentStatus.REFUNDED,
          PaymentStatus.FAILED,
        ],
      },
    };

    const [rows, total, settled] = await this.prisma.$transaction([
      this.prisma.payments.findMany({
        where,
        orderBy: { created_at: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          bookings: {
            select: {
              id: true,
              start_time: true,
              service_requests: { select: { category: true } },
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
            orderBy: { cycle_number: "asc" },
            select: { cycle_number: true, final_amount: true },
          },
          // The half of a split cycle that does not hold the snapshot's payment_id
          // still knows its cycle through here — without it, it would render in the
          // parent's history as a cancellation fee.
          payment_installments: {
            orderBy: { installment_no: "asc" },
            select: {
              cycle_number: true,
              installment_no: true,
              total_installments: true,
            },
          },
        },
      }),
      this.prisma.payments.count({ where }),
      // Only money that actually left the account counts toward the total. A refunded
      // payment nets to zero and a failed one never settled.
      this.prisma.payments.aggregate({
        where: {
          ...where,
          status: { in: [PaymentStatus.CAPTURED, PaymentStatus.PENDING_RELEASE] },
        },
        _sum: { amount: true },
      }),
    ]);

    const items = rows.map((row) => {
      const snapshot = row.price_snapshots[0] ?? null;
      const installment = row.payment_installments[0] ?? null;
      const profile = row.bookings?.users_bookings_nanny_idTousers?.profiles ?? null;
      const caregiverName =
        [profile?.first_name, profile?.last_name].filter(Boolean).join(" ") || null;

      return {
        id: row.id,
        bookingId: row.booking_id,
        orderId: row.order_id,
        paymentId: row.payment_id,
        // Decimal — serialise as a number so the client never has to parse a string.
        amount: Number(row.amount),
        currency: row.currency,
        status: row.status,
        kind: snapshot || installment ? "service_cycle" : "cancellation_fee",
        cycleNumber: snapshot?.cycle_number ?? installment?.cycle_number ?? null,
        // Null on an unsplit charge, so the client shows no instalment line at all.
        installmentNo:
          installment && installment.total_installments > 1
            ? installment.installment_no
            : null,
        totalInstallments:
          installment && installment.total_installments > 1
            ? installment.total_installments
            : null,
        date: row.created_at,
        caregiverName,
        caregiverImageUrl: profile?.profile_image_url ?? null,
        category: row.bookings?.service_requests?.category ?? null,
        errorDescription: row.error_description,
      };
    });

    return {
      items,
      total,
      page,
      pageSize,
      hasMore: page * pageSize < total,
      totalPaid: Number(settled._sum.amount ?? 0),
    };
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
    // 1. Calculate total earned. `pending_release` counts: completing a booking flips
    // a captured payment to that status, so filtering on `captured` alone would drop
    // a nanny's earnings the moment the job was done.
    const capturedPayments = await this.prisma.payments.aggregate({
      where: caregiverEarningsWhere(nannyId),
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
      where: caregiverEarningsWhere(nannyId),
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

  /**
   * The caregiver's view of the same ledger the admin revenue screen reads. Every
   * rule about which rows count, who they belong to and what the pre-tax base is
   * lives in `common/payout-policy.ts`, so the two can never drift apart.
   *
   * Windowing is on `created_at` to match the admin ledger — a caregiver querying a
   * day's earnings and an admin auditing that day must land on the same rows.
   *
   * The window is the *calendar* week (Mon–Sun) or month, in IST — see
   * `common/period.ts` for why both of those matter. It deliberately extends past
   * today: the days between now and the period end are the remainder that
   * `projectedEarnings` covers.
   */
  async getNannyEarningsAnalytics(nannyId: string, period: "week" | "month" = "week") {
    const now = new Date();
    const window = resolvePeriod(period, now);
    const startDate = window.start;

    const earned = caregiverEarningsWhere(nannyId);
    const earningRow = {
      amount: true,
      created_at: true,
      released_at: true,
      price_snapshots: { select: { gst_amount: true } },
      // A split cycle's halves carry their own frozen GST; see preTaxServiceFee.
      payment_installments: { select: { gst_amount: true } },
    } satisfies Prisma.paymentsSelect;

    const [
      allTime,
      periodPayments,
      lastPeriodPayments,
      jobsCompleted,
      jobsThisPeriod,
      upcomingBookings,
    ] = await this.prisma.$transaction([
      this.prisma.payments.findMany({ where: earned, select: earningRow }),
      this.prisma.payments.findMany({
        where: { ...earned, created_at: { gte: startDate } },
        select: earningRow,
      }),
      this.prisma.payments.findMany({
        where: {
          ...earned,
          created_at: { gte: window.previousStart, lte: window.previousEnd },
        },
        select: earningRow,
      }),
      this.prisma.bookings.count({
        where: { nanny_id: nannyId, status: BookingStatus.COMPLETED },
      }),
      this.prisma.bookings.count({
        where: {
          nanny_id: nannyId,
          status: BookingStatus.COMPLETED,
          end_time: { gte: startDate },
        },
      }),
      this.prisma.bookings.findMany({
        where: projectableBookingsWhere(nannyId, now, window.end),
        select: {
          start_time: true,
          end_time: true,
          pricing_mode: true,
          custom_hourly_rate: true,
          created_at: true,
          price_lock_mode: true,
          service_requests: { select: { category: true } },
          // Newest cycle first: its implied hourly rate is the most recent price
          // actually agreed for this booking.
          price_snapshots: {
            select: { subtotal_amount: true, hours_billed: true },
            orderBy: { cycle_number: "desc" },
            take: 1,
          },
        },
      }),
    ]);

    const sum = (rows: typeof allTime) =>
      round2(rows.reduce((s, p) => s + preTaxServiceFee(p), 0));

    const totalEarned = sum(allTime);
    const periodTotal = sum(periodPayments);
    const lastPeriodTotal = sum(lastPeriodPayments);

    // `lastPeriodPayments` is truncated to the same elapsed offset into the previous
    // period, so a Monday morning is compared against last Monday morning and not
    // against a whole finished week.
    const periodChange =
      lastPeriodTotal > 0
        ? Math.round(((periodTotal - lastPeriodTotal) / lastPeriodTotal) * 100)
        : null;

    // Resolved server-side and returned alongside the figures it produced, so a rate
    // change ships without a client release and no app can drift from the ledger.
    const { percent: commissionPercent } = await this.pricingService.getCommissionConfig();
    const share = (gross: number) => round2(gross * (1 - commissionPercent / 100));

    const commissionAmount = round2(totalEarned * (commissionPercent / 100));
    const netPayout = share(totalEarned);

    // An admin releasing a payout stamps `released_at`. Without splitting on it the
    // caregiver would keep seeing money already in her bank as still owed.
    const paidOut = share(sum(allTime.filter((p) => p.released_at != null)));
    const outstanding = round2(netPayout - paidOut);

    // ── Projected earnings ───────────────────────────────────────────────────
    //
    // Booked work only: the caregiver's share of sessions still on her calendar
    // before the period ends, on top of what she has already earned in it. Nothing
    // here is extrapolated from past averages — see `payout-policy.ts`.
    //
    // `projectableBookingsWhere` has already dropped any booking whose money is
    // sitting in `periodPayments`, so adding the two halves cannot double-count a
    // prepaid session.
    const bookedByDay = new Map<string, number>();
    let bookedAhead = 0;
    let valuedBookings = 0;

    for (const booking of upcomingBookings) {
      const standardRate = await this.pricingService.resolveStandardHourlyRate(booking);
      const value = preTaxBookingValue(booking, standardRate);
      // Null means the booking cannot be valued honestly (no schedule, or a
      // whole-cycle override with no per-session meaning). Dropping it
      // under-projects, which is the safe direction to be wrong in.
      if (value == null) continue;

      valuedBookings++;
      bookedAhead += value;
      const key = istDateKey(booking.start_time!);
      bookedByDay.set(key, round2((bookedByDay.get(key) ?? 0) + value));
    }

    // Null, not zero: a new caregiver with nothing earned and nothing booked is
    // told the figure isn't available yet rather than shown ₹0.00 as a forecast.
    //
    // Commission is applied once, to the combined pre-tax base, so the projection
    // is derived exactly the way `netPayout` is and the two stay reconcilable.
    //
    // NOTE: this is scoped to the *current period*, while `netPayout` above is
    // all-time. Both are correct for what they claim, but a client showing them
    // side by side is comparing different spans — see the endpoint's Swagger note.
    const projectedEarnings =
      valuedBookings === 0 && periodTotal === 0
        ? null
        : share(round2(periodTotal + bookedAhead));

    // Revenue trend: gross earnings grouped by day, matching `totalEarned`. Days
    // still ahead in the period carry `projection` instead — the same booked value
    // the card is built from, so the chart and the card can never disagree.
    const trend: { date: string; amount: number; projection?: number }[] = [];
    for (const dayStart of daysInWindow(window)) {
      const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000 - 1);
      const date = istDateKey(dayStart);

      const booked = bookedByDay.get(date);

      if (dayStart > now) {
        trend.push({ date, amount: 0, ...(booked ? { projection: booked } : {}) });
        continue;
      }

      const dayPayments = periodPayments.filter((p) => {
        const d = new Date(p.created_at!);
        return d >= dayStart && d <= dayEnd;
      });

      // Today can be both: earned this morning, still booked this evening. Carrying
      // both keeps the trend summing to the same figure the card reports.
      trend.push({ date, amount: sum(dayPayments), ...(booked ? { projection: booked } : {}) });
    }

    return {
      totalEarned,
      commissionPercent,
      commissionAmount,
      netPayout,
      paidOut,
      outstanding,
      jobsCompleted,
      jobsThisPeriod,
      periodTotal,
      periodChange,
      projectedEarnings,
      trend,
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

    // Money that came back is no longer owed, and nor is the rest of its cycle:
    // dunning a parent for the balance of a cycle we just refunded would be
    // indefensible. Both are marked so they leave the pending list and the
    // reminder cron without ever being counted as collected.
    const refunded = await this.prisma.payment_installments.findFirst({
      where: { payment_id: payment.id },
    });
    if (refunded) {
      await this.prisma.payment_installments.update({
        where: { id: refunded.id },
        data: { status: INSTALMENT_REFUNDED, updated_at: new Date() },
      });
      await this.prisma.payment_installments.updateMany({
        where: {
          price_snapshot_id: refunded.price_snapshot_id,
          status: INSTALMENT_PENDING,
        },
        data: { status: INSTALMENT_VOID, updated_at: new Date() },
      });
    }

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
