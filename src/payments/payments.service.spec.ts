import { Test, TestingModule } from "@nestjs/testing";
import { PaymentsService } from "./payments.service";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";
import { ConfigService } from "@nestjs/config";
import { PaymentGatewayService } from "./payment-gateway.service";
import { PaymentAuditService } from "./payment-audit.service";
import { PricingEngineService } from "../common/pricing.service";
import { MailService } from "../mail/mail.service";
import { BookingStatusLogService } from "../bookings/booking-status-log.service";

describe("PaymentsService", () => {
  let service: PaymentsService;
  let notificationsService: NotificationsService;

  const mockPrisma = {
    payments: {
      findUnique: jest.fn(),
      update: jest.fn(),
      create: jest.fn(),
      findFirst: jest.fn(),
    },
    bookings: {
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    payment_audit_log: {
      create: jest.fn(),
    },
    users: {
      findUnique: jest.fn(),
    },
    price_snapshots: {
      updateMany: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
    },
    payment_plans: {
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    payment_installments: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      updateMany: jest.fn(),
      update: jest.fn(),
      create: jest.fn(),
      count: jest.fn(),
    },
    $transaction: jest
      .fn()
      .mockImplementation((cb: (tx: any) => any) => cb(mockPrisma)),
  };

  const mockNotificationsService = {
    // Resolved, not bare: the service chains .catch() on every notification so a
    // delivery failure can never fail a payment.
    createNotification: jest.fn().mockResolvedValue(undefined),
  };

  const mockPaymentGatewayService = {
    createOrder: jest.fn(),
    verifySignature: jest.fn(),
    verifyWebhookSignature: jest.fn(),
    fetchOrder: jest.fn(),
  };

  const mockPaymentAuditService = {
    writeLog: jest.fn(),
  };

  const mockMailService = {
    sendPaymentReceiptEmail: jest.fn().mockResolvedValue(undefined),
    sendInstallmentReminderEmail: jest.fn().mockResolvedValue(undefined),
  };

  const mockBookingStatusLog = {
    writeLog: jest.fn().mockResolvedValue(undefined),
  };

  const mockPricingService = {
    calculateCost: jest.fn(),
    calculateAndSnapshot: jest.fn(),
    advancePaymentPlanTx: jest.fn(),
    getAdvancePaymentConfig: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    // Sensible neutral defaults; each test overrides only what it is about.
    mockPricingService.getAdvancePaymentConfig.mockResolvedValue({
      enabled: true,
      ratioPercent: 50,
      dueDays: 14,
    });
    mockPrisma.payment_installments.findFirst.mockResolvedValue(null);
    mockPrisma.payment_installments.count.mockResolvedValue(0);
    // Nothing outstanding — so createOrder's "is this a fee-only charge?" probe
    // does not authorise billing a booking with no caregiver on it.
    mockPrisma.payment_installments.findMany.mockResolvedValue([]);
    mockPrisma.price_snapshots.findFirst.mockResolvedValue(null);
    mockPrisma.payment_plans.findUnique.mockResolvedValue(null);
    mockPrisma.bookings.findUnique.mockResolvedValue(null);
    mockPrisma.bookings.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.users.findUnique.mockResolvedValue(null);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: NotificationsService, useValue: mockNotificationsService },
        { provide: PaymentGatewayService, useValue: mockPaymentGatewayService },
        { provide: PaymentAuditService, useValue: mockPaymentAuditService },
        { provide: PricingEngineService, useValue: mockPricingService },
        { provide: MailService, useValue: mockMailService },
        { provide: BookingStatusLogService, useValue: mockBookingStatusLog },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === "RAZORPAY_KEY_ID") return "rzp_test_key";
              if (key === "RAZORPAY_KEY_SECRET") return "rzp_test_secret";
              if (key === "RAZORPAY_WEBHOOK_SECRET")
                return "rzp_test_webhook_secret";
              return undefined;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<PaymentsService>(PaymentsService);
    notificationsService =
      module.get<NotificationsService>(NotificationsService);
  });

  it("should notify parent and nanny on successful payment capture", async () => {
    const orderId = "order_123";
    const paymentId = "pay_123";
    const bookingId = "book_123";

    mockPrisma.payments.findUnique.mockResolvedValue({
      order_id: orderId,
      booking_id: bookingId,
      amount: 1000,
      status: "created",
    });

    mockPrisma.bookings.findUnique.mockResolvedValue({
      id: bookingId,
      parent_id: "parent-1",
      nanny_id: "nanny-1",
      status: "CONFIRMED",
    });

    await (service as any).capturePaymentSuccess(
      orderId,
      paymentId,
      "sig_123",
      "api:verify_payment",
    );

    // Parent notification
    expect(mockNotificationsService.createNotification).toHaveBeenCalledWith(
      "parent-1",
      "Payment Successful",
      expect.stringContaining("1000"),
      "success",
      "payment",
      bookingId,
    );

    // Nanny notification
    expect(mockNotificationsService.createNotification).toHaveBeenCalledWith(
      "nanny-1",
      "Payment Received",
      expect.stringContaining("₹1000"),
      "success",
    );
  });

  /**
   * Split payments: an advance charged at checkout and a balance due later. These
   * pin the failure modes that make the feature dangerous rather than merely
   * broken — a booking that cannot be paid, a plan that advances twice, a cycle
   * closed while half the money is still outstanding.
   */
  describe("split payments", () => {
    const bookingId = "book_split";
    const snapshotId = "snap_1";

    const half = (no: number, over: Partial<Record<string, unknown>> = {}) => ({
      id: `inst_${no}`,
      booking_id: bookingId,
      price_snapshot_id: snapshotId,
      payment_plan_id: null,
      cycle_number: 1,
      installment_no: no,
      total_installments: 2,
      amount: 5940,
      subtotal_amount: 5940,
      gst_amount: 0,
      status: "pending",
      payment_id: null,
      ...over,
    });

    it("offers the balance for payment after the advance is captured", async () => {
      // A Pay-in-Full multi-month plan never gets a payment_plans row, so the old
      // "a captured payment exists" guard rejected its balance as a duplicate —
      // leaving the booking unpayable while the app reported it settled.
      mockPrisma.bookings.findUnique.mockResolvedValue({
        id: bookingId,
        parent_id: "parent-1",
        nanny_id: "nanny-1",
        payment_plans: null,
      });
      mockPrisma.price_snapshots.findFirst.mockResolvedValue({
        id: snapshotId,
        final_amount: 11880,
        cycle_number: 1,
      });
      mockPrisma.payment_installments.findFirst.mockResolvedValue(half(2));
      mockPaymentGatewayService.createOrder.mockResolvedValue({ id: "order_bal" });
      mockPrisma.payments.create.mockResolvedValue({ id: "pay_bal", order_id: "order_bal" });

      const order = await service.createOrder(bookingId, "parent-1");

      expect(order.amount).toBe(5940);
      expect(order.installmentNo).toBe(2);
      expect(order.totalInstallments).toBe(2);
      // Nothing follows the final half, so no further balance is disclosed.
      expect(order.balanceDueInDays).toBeNull();
    });

    it("discloses the deferred balance when charging the advance", async () => {
      mockPrisma.bookings.findUnique.mockResolvedValue({
        id: bookingId,
        parent_id: "parent-1",
        nanny_id: "nanny-1",
        payment_plans: null,
      });
      mockPrisma.price_snapshots.findFirst.mockResolvedValue({
        id: snapshotId,
        final_amount: 11880,
        cycle_number: 1,
      });
      mockPrisma.payment_installments.findFirst.mockResolvedValue(half(1));
      mockPaymentGatewayService.createOrder.mockResolvedValue({ id: "order_adv" });
      mockPrisma.payments.create.mockResolvedValue({ id: "pay_adv", order_id: "order_adv" });

      const order = await service.createOrder(bookingId, "parent-1");

      expect(order.amount).toBe(5940);
      expect(order.cycleTotal).toBe(11880);
      expect(order.balanceDueInDays).toBe(14);
    });

    it("leaves the plan and the booking alone when only the advance is paid", async () => {
      // Advancing here would bill the next cycle early; flipping the booking to
      // COMPLETED — a terminal state — would close it with money still owed.
      mockPrisma.payments.findUnique.mockResolvedValue({
        id: "pay_adv",
        order_id: "order_adv",
        booking_id: bookingId,
        amount: 5940,
        status: "created",
      });
      mockPrisma.payment_plans.findUnique.mockResolvedValue({
        id: "plan_1",
        booking_id: bookingId,
        cycles_completed: 0,
        total_cycles: 6,
      });
      mockPrisma.payment_installments.findFirst.mockResolvedValue(half(1));
      mockPrisma.payment_installments.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.price_snapshots.findUnique.mockResolvedValue({
        id: snapshotId,
        final_amount: 11880,
        subtotal_amount: 11880,
        gst_amount: 0,
        gst_percent_used: 0,
      });
      // The balance is still outstanding.
      mockPrisma.payment_installments.count.mockResolvedValue(1);
      mockPrisma.bookings.findUnique.mockResolvedValue({
        id: bookingId,
        parent_id: "parent-1",
        nanny_id: "nanny-1",
      });

      await (service as any).capturePaymentSuccess(
        "order_adv",
        "pay_rzp_1",
        "sig",
        "api:verify_payment",
      );

      expect(mockPricingService.advancePaymentPlanTx).not.toHaveBeenCalled();
      expect(mockPrisma.bookings.updateMany).not.toHaveBeenCalled();
      expect(mockPrisma.price_snapshots.updateMany).not.toHaveBeenCalled();
      // The parent is told what is left and when, not just that money arrived.
      expect(mockNotificationsService.createNotification).toHaveBeenCalledWith(
        "parent-1",
        "Payment Successful",
        expect.stringContaining("5940"),
        "success",
        "payment",
        bookingId,
      );
    });

    it("dates the balance from when the advance actually cleared", async () => {
      mockPrisma.payments.findUnique.mockResolvedValue({
        id: "pay_adv",
        order_id: "order_adv",
        booking_id: bookingId,
        amount: 5940,
        status: "created",
      });
      mockPrisma.payment_installments.findFirst.mockResolvedValue(half(1));
      mockPrisma.payment_installments.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.price_snapshots.findUnique.mockResolvedValue({ id: snapshotId, final_amount: 11880 });
      mockPrisma.payment_installments.count.mockResolvedValue(1);
      mockPrisma.bookings.findUnique.mockResolvedValue({
        id: bookingId,
        parent_id: "parent-1",
        nanny_id: null,
      });

      await (service as any).capturePaymentSuccess("order_adv", "p", "s", "api:verify_payment");

      const dueWrite = mockPrisma.payment_installments.updateMany.mock.calls.find(
        ([arg]: any[]) => arg.where?.installment_no === 2,
      );
      expect(dueWrite).toBeDefined();
      // Only fills a date that has not been set: an agreed due date is a promise
      // made at checkout and must not move.
      expect(dueWrite[0].where.due_date).toBeNull();
      expect(dueWrite[0].data.due_date).toBeInstanceOf(Date);
    });

    it("settles the cycle and advances the plan once when the balance is paid", async () => {
      mockPrisma.payments.findUnique.mockResolvedValue({
        id: "pay_bal",
        order_id: "order_bal",
        booking_id: bookingId,
        amount: 5940,
        status: "created",
      });
      mockPrisma.payment_plans.findUnique.mockResolvedValue({
        id: "plan_1",
        booking_id: bookingId,
        cycles_completed: 0,
        total_cycles: 6,
      });
      mockPrisma.payment_installments.findFirst.mockResolvedValue(half(2));
      mockPrisma.payment_installments.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.price_snapshots.findUnique.mockResolvedValue({ id: snapshotId, final_amount: 11880 });
      mockPrisma.payment_installments.count.mockResolvedValue(0);
      mockPrisma.bookings.findUnique.mockResolvedValue({
        id: bookingId,
        parent_id: "parent-1",
        nanny_id: "nanny-1",
        status: "REQUESTED",
      });

      await (service as any).capturePaymentSuccess("order_bal", "p", "s", "api:verify_payment");

      expect(mockPrisma.price_snapshots.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: snapshotId, status: "pending" } }),
      );
      // Guarded on the cycle we believe we just finished.
      expect(mockPricingService.advancePaymentPlanTx).toHaveBeenCalledWith(
        expect.anything(),
        "plan_1",
        0,
      );
      // Settling a cycle confirms the booking; it never completes it. COMPLETED is
      // the nanny's checkout to write, not the parent's card.
      expect(mockPrisma.bookings.updateMany).toHaveBeenCalledWith({
        where: {
          id: bookingId,
          status: { in: ["requested", "CONFIRMED"] },
        },
        data: { status: "CONFIRMED" },
      });
      expect(mockPrisma.bookings.update).not.toHaveBeenCalled();
    });

    it("does not drag an in-progress booking back when a cycle is paid mid-session", async () => {
      // The guarded where matches nothing, so the session's own status stands.
      mockPrisma.payments.findUnique.mockResolvedValue({
        id: "pay_mid",
        order_id: "order_mid",
        booking_id: bookingId,
        amount: 5940,
        status: "created",
      });
      mockPrisma.payment_installments.findFirst.mockResolvedValue(half(2));
      mockPrisma.payment_installments.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.price_snapshots.findUnique.mockResolvedValue({ id: snapshotId, final_amount: 11880 });
      mockPrisma.payment_installments.count.mockResolvedValue(0);
      mockPrisma.bookings.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.bookings.findUnique.mockResolvedValue({
        id: bookingId,
        parent_id: "parent-1",
        nanny_id: "nanny-1",
        status: "IN_PROGRESS",
      });

      await (service as any).capturePaymentSuccess("order_mid", "p", "s", "api:verify_payment");

      expect(mockPrisma.bookings.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: { in: ["requested", "CONFIRMED"] },
          }),
        }),
      );
      expect(mockBookingStatusLog.writeLog).not.toHaveBeenCalled();
    });

    it("does nothing twice when the webhook and verify race the same capture", async () => {
      // Both fire for the same money. The loser's guarded claim updates zero rows
      // and must then skip every downstream effect, or the plan advances twice.
      mockPrisma.payments.findUnique.mockResolvedValue({
        id: "pay_bal",
        order_id: "order_bal",
        booking_id: bookingId,
        amount: 5940,
        status: "created",
      });
      mockPrisma.payment_plans.findUnique.mockResolvedValue({
        id: "plan_1",
        cycles_completed: 0,
        total_cycles: 6,
      });
      mockPrisma.payment_installments.findFirst.mockResolvedValue(half(2));
      mockPrisma.payment_installments.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.price_snapshots.findUnique.mockResolvedValue({ id: snapshotId, final_amount: 11880 });
      mockPrisma.bookings.findUnique.mockResolvedValue({ id: bookingId, parent_id: "parent-1" });

      await (service as any).capturePaymentSuccess("order_bal", "p", "s", "webhook");

      expect(mockPricingService.advancePaymentPlanTx).not.toHaveBeenCalled();
      expect(mockPrisma.price_snapshots.updateMany).not.toHaveBeenCalled();
      expect(mockNotificationsService.createNotification).not.toHaveBeenCalled();
    });

    it("reuses the order belonging to this half, not the other half's", async () => {
      // Both halves link to one snapshot, so a snapshot-keyed lookup could hand
      // the balance the advance's dead order and make checkout fail forever.
      mockPrisma.bookings.findUnique.mockResolvedValue({
        id: bookingId,
        parent_id: "parent-1",
        nanny_id: "nanny-1",
        payment_plans: null,
      });
      mockPrisma.price_snapshots.findFirst.mockResolvedValue({
        id: snapshotId,
        final_amount: 11880,
        cycle_number: 1,
      });
      mockPrisma.payment_installments.findFirst.mockResolvedValue(
        half(2, { payment_id: "pay_bal_open" }),
      );
      mockPrisma.payments.findFirst.mockResolvedValue({
        id: "pay_bal_open",
        order_id: "order_bal_open",
        amount: 5940,
        currency: "INR",
        status: "created",
      });
      mockPaymentGatewayService.fetchOrder.mockResolvedValue({
        status: "created",
        amount: 594000,
      });

      const order = await service.createOrder(bookingId, "parent-1");

      expect(order.orderId).toBe("order_bal_open");
      expect(mockPaymentGatewayService.createOrder).not.toHaveBeenCalled();
      // Looked up by the instalment's own payment id.
      expect(mockPrisma.payments.findFirst).toHaveBeenCalledWith({
        where: { id: "pay_bal_open", status: "created" },
      });
    });

    it("refuses to open a second cycle on a booking that has no plan", async () => {
      // Without a payment_plan nothing advances the cycle counter, so a settled
      // cycle must not be snapshotted again — that would bill twice for the same
      // care. This is the guard the B1 fix had to replace rather than delete.
      mockPrisma.bookings.findUnique.mockResolvedValue({
        id: bookingId,
        parent_id: "parent-1",
        nanny_id: "nanny-1",
        payment_plans: null,
      });
      // Nothing pending, but cycle 1 is charged.
      mockPrisma.price_snapshots.findFirst.mockImplementation(
        async ({ where }: any) =>
          where.status === "charged" ? { id: snapshotId, cycle_number: 1 } : null,
      );

      await expect(service.createOrder(bookingId, "parent-1")).rejects.toThrow(
        /already been paid/i,
      );
      expect(mockPricingService.calculateAndSnapshot).not.toHaveBeenCalled();
    });

    it("refuses to re-charge a settled instalment", async () => {
      mockPrisma.bookings.findUnique.mockResolvedValue({
        id: bookingId,
        parent_id: "parent-1",
        nanny_id: "nanny-1",
        payment_plans: null,
      });
      mockPrisma.price_snapshots.findFirst.mockResolvedValue({
        id: snapshotId,
        final_amount: 11880,
        cycle_number: 1,
      });
      mockPrisma.payment_installments.findUnique.mockResolvedValue(
        half(1, { status: "paid" }),
      );

      await expect(
        service.createOrder(bookingId, "parent-1", "inst_1"),
      ).rejects.toThrow(/already been paid/i);
    });

    it("will not let one parent name another parent's instalment", async () => {
      mockPrisma.bookings.findUnique.mockResolvedValue({
        id: bookingId,
        parent_id: "parent-1",
        nanny_id: "nanny-1",
        payment_plans: null,
      });
      mockPrisma.price_snapshots.findFirst.mockResolvedValue({
        id: snapshotId,
        final_amount: 11880,
        cycle_number: 1,
      });
      mockPrisma.payment_installments.findUnique.mockResolvedValue(
        half(1, { booking_id: "someone_elses_booking" }),
      );

      await expect(
        service.createOrder(bookingId, "parent-1", "inst_1"),
      ).rejects.toThrow(/not found/i);
    });
  });

  /**
   * The matching fee is charged at request time, on its own cycle 0, against a
   * booking that has no caregiver and no payment plan yet. It settles instantly —
   * one instalment, nothing left pending — which used to walk it straight into the
   * cycle-settled branch and mark the brand-new booking COMPLETED.
   */
  describe("matching fee", () => {
    const bookingId = "book_fee";
    const feeSnapshotId = "snap_fee";

    const feeInstalment = {
      id: "inst_fee",
      booking_id: bookingId,
      price_snapshot_id: feeSnapshotId,
      cycle_number: 0,
      installment_no: 1,
      total_installments: 1,
      kind: "matching_fee",
      amount: 249,
      subtotal_amount: 211,
      gst_amount: 38,
      status: "pending",
      payment_id: "pay_fee",
    };

    beforeEach(() => {
      mockPrisma.payments.findUnique.mockResolvedValue({
        id: "pay_fee",
        order_id: "order_fee",
        booking_id: bookingId,
        amount: 249,
        status: "created",
      });
      mockPrisma.payment_installments.findFirst.mockResolvedValue(feeInstalment);
      mockPrisma.payment_installments.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.price_snapshots.findUnique.mockResolvedValue({
        id: feeSnapshotId,
        cycle_number: 0,
        final_amount: 249,
        subtotal_amount: 211,
        gst_amount: 38,
        gst_percent_used: 18,
      });
      mockPrisma.payment_installments.count.mockResolvedValue(0);
      mockPrisma.bookings.findUnique.mockResolvedValue({
        id: bookingId,
        parent_id: "parent-1",
        nanny_id: null,
        status: "requested",
      });
    });

    it("leaves the booking's status alone — a paid fee is not delivered care", async () => {
      await (service as any).capturePaymentSuccess("order_fee", "p", "s", "api:verify_payment");

      expect(mockPrisma.bookings.updateMany).not.toHaveBeenCalled();
      expect(mockPrisma.bookings.update).not.toHaveBeenCalled();
      expect(mockBookingStatusLog.writeLog).not.toHaveBeenCalled();
    });

    it("does not consume a billing cycle", async () => {
      // A plan exists by the time a later fee capture is retried; it must not move.
      mockPrisma.payment_plans.findUnique.mockResolvedValue({
        id: "plan_fee",
        booking_id: bookingId,
        cycles_completed: 0,
        total_cycles: 6,
      });

      await (service as any).capturePaymentSuccess("order_fee", "p", "s", "api:verify_payment");

      expect(mockPricingService.advancePaymentPlanTx).not.toHaveBeenCalled();
    });

    it("still marks its own snapshot charged", async () => {
      await (service as any).capturePaymentSuccess("order_fee", "p", "s", "api:verify_payment");

      expect(mockPrisma.price_snapshots.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: feeSnapshotId, status: "pending" } }),
      );
    });
  });
});
