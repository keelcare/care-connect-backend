import { Test, TestingModule } from "@nestjs/testing";
import { BookingsService } from "./bookings.service";
import { PrismaService } from "../prisma/prisma.service";
import { ChatService } from "../chat/chat.service";
import { NotificationsService } from "../notifications/notifications.service";
import { RequestsService } from "../requests/requests.service";
import { SseService } from "../sse/sse.service";
import { NotFoundException, BadRequestException } from "@nestjs/common";
import { MailService } from "../mail/mail.service";
import { PaymentsService } from "../payments/payments.service";

describe("BookingsService", () => {
  let service: BookingsService;
  let prisma: PrismaService;
  let notificationsService: NotificationsService;

  const mockPrisma = {
    bookings: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    payments: {
      create: jest.fn(),
      findMany: jest.fn(),
    },
    payment_installments: {
      findMany: jest.fn(),
      updateMany: jest.fn(),
    },
    service_requests: {
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    assignments: {
      findFirst: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    $transaction: jest.fn(async (fn: (tx: unknown) => unknown) => fn(mockPrisma)),
    jobs: {
      findUnique: jest.fn(),
    },
    users: {
      findUnique: jest.fn(),
    },
    services: {
      findUnique: jest.fn().mockResolvedValue({ hourly_rate: 500 }),
    },
  };

  const mockNotificationsService = {
    createNotification: jest.fn(),
    notifyNannyCancellationToParent: jest.fn(),
  };

  const mockChatService = {
    createChat: jest.fn(),
  };

  const mockRequestsService = {
    triggerMatching: jest.fn(),
  };

  const mockSseService = {
    emitToUser: jest.fn(),
    emitToUsers: jest.fn(),
  };

  const mockCalculateCost = jest.fn().mockResolvedValue({
    totalAmount: 500,
    appliedRate: 500,
    subtotalAmount: 500,
    gstAmount: 0,
    gstPercent: 0,
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: NotificationsService, useValue: mockNotificationsService },
        { provide: ChatService, useValue: mockChatService },
        { provide: RequestsService, useValue: mockRequestsService },
        { provide: SseService, useValue: mockSseService },
        { provide: MailService, useValue: {} },
        { provide: PaymentsService, useValue: {} },
      ],
    })
      // The service has grown collaborators this suite does not exercise
      // (status log, pricing, progress reports, event emitter). One stub object
      // covers the methods the paths under test touch.
      .useMocker(() => ({
        emit: jest.fn(),
        writeLog: jest.fn().mockResolvedValue(undefined),
        calculateCost: mockCalculateCost,
        generateReportForBooking: jest.fn().mockResolvedValue(undefined),
        prefetchServiceCategories: jest.fn().mockResolvedValue(undefined),
      }))
      .compile();

    service = module.get<BookingsService>(BookingsService);
    prisma = module.get<PrismaService>(PrismaService);
    notificationsService =
      module.get<NotificationsService>(NotificationsService);

    jest.clearAllMocks();
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  describe("derivePaymentStatus", () => {
    const bookingId = "book_1";
    const captured = [{ status: "captured" }];

    const instalment = (over: Record<string, unknown>) => ({
      booking_id: bookingId,
      status: "paid",
      kind: "cycle",
      ...over,
    });

    it("reports a booking whose only settled instalment is the matching fee as partially paid", async () => {
      // ₹249 has genuinely arrived, but the care itself has not even been priced
      // yet — the cycle instalments are raised when a caregiver is assigned.
      // Calling this `paid` would hide the real amount due from every list.
      mockPrisma.payments.findMany.mockResolvedValue(captured);
      mockPrisma.payment_installments.findMany.mockResolvedValue([
        instalment({ kind: "matching_fee" }),
      ]);

      await expect(service.derivePaymentStatus(bookingId)).resolves.toBe(
        "partially_paid",
      );
    });

    it("reports paid once a care instalment is settled alongside the fee", async () => {
      mockPrisma.payments.findMany.mockResolvedValue(captured);
      mockPrisma.payment_installments.findMany.mockResolvedValue([
        instalment({ kind: "matching_fee" }),
        instalment({ kind: "cycle" }),
      ]);

      await expect(service.derivePaymentStatus(bookingId)).resolves.toBe("paid");
    });

    it("still reports partially paid while a cycle instalment is pending", async () => {
      mockPrisma.payments.findMany.mockResolvedValue(captured);
      mockPrisma.payment_installments.findMany.mockResolvedValue([
        instalment({ kind: "cycle" }),
        instalment({ kind: "cycle", status: "pending" }),
      ]);

      await expect(service.derivePaymentStatus(bookingId)).resolves.toBe(
        "partially_paid",
      );
    });

    it("reports paid for a legacy booking with no instalment rows at all", async () => {
      mockPrisma.payments.findMany.mockResolvedValue(captured);
      mockPrisma.payment_installments.findMany.mockResolvedValue([]);

      await expect(service.derivePaymentStatus(bookingId)).resolves.toBe("paid");
    });
  });

  /**
   * What the parent is charged next. The prompt has to name the figure checkout
   * will name, and the matching fee comes off the first cycle rather than being
   * asked for twice.
   */
  describe("instalmentSummaries", () => {
    const bookingId = "book_1";
    const summarise = async (rows: unknown[]) => {
      mockPrisma.payment_installments.findMany.mockResolvedValue(rows);
      const summaries = await (service as any).instalmentSummaries([bookingId]);
      return summaries.get(bookingId);
    };

    it("credits a paid matching fee while the care is still unpriced", async () => {
      const summary = await summarise([
        { booking_id: bookingId, status: "paid", kind: "matching_fee", amount: 249, cycle_number: 0 },
      ]);

      expect(summary).toEqual({ outstanding: true, feeCredit: 249, pendingCare: null });
    });

    it("prefers the priced instalment over any estimate once the cycle exists", async () => {
      // The engine already deducted the fee when it wrote this row; crediting it
      // again here would discount the same ₹249 twice.
      const summary = await summarise([
        { booking_id: bookingId, status: "paid", kind: "matching_fee", amount: 249, cycle_number: 0 },
        { booking_id: bookingId, status: "pending", kind: "cycle", amount: 5691, cycle_number: 1 },
      ]);

      expect(summary.pendingCare).toBe(5691);
    });

    it("spends the credit once care has been settled", async () => {
      const summary = await summarise([
        { booking_id: bookingId, status: "paid", kind: "matching_fee", amount: 249, cycle_number: 0 },
        { booking_id: bookingId, status: "paid", kind: "cycle", amount: 5691, cycle_number: 1 },
      ]);

      expect(summary).toEqual({ outstanding: false, feeCredit: 0, pendingCare: null });
    });

    it("sums both halves of a split cycle that is still owed", async () => {
      const summary = await summarise([
        { booking_id: bookingId, status: "pending", kind: "cycle", amount: 2970, cycle_number: 1 },
        { booking_id: bookingId, status: "pending", kind: "cycle", amount: 2970, cycle_number: 1 },
      ]);

      expect(summary).toEqual({ outstanding: true, feeCredit: 0, pendingCare: 5940 });
    });
  });

  describe("cancelBooking", () => {
    const booking = (over: Record<string, unknown> = {}) => ({
      id: "1",
      status: "CONFIRMED",
      start_time: new Date(Date.now() + 1000 * 60 * 60 * 5), // 5 hours from now
      nanny_id: "nanny1",
      parent_id: "parent1",
      request_id: null,
      users_bookings_nanny_idTousers: { profiles: {}, nanny_details: {} },
      users_bookings_parent_idTousers: { profiles: {} },
      service_requests: { category: "CC" },
      ...over,
    });

    it("records a fee owed when the parent cancels < 24 hours out", async () => {
      mockPrisma.bookings.findUnique.mockResolvedValue(booking());
      mockPrisma.bookings.update.mockResolvedValue({ id: "1", status: "CANCELLED" });

      await service.cancelBooking("1", "Emergency", "parent1");

      expect(mockPrisma.bookings.update).toHaveBeenCalledWith({
        where: { id: "1" },
        data: expect.objectContaining({
          status: "CANCELLED",
          cancellation_fee: 500,
          cancellation_fee_status: "owed",
        }),
      });
      // Money that stopped being owed is voided
      expect(mockPrisma.payment_installments.updateMany).toHaveBeenCalledWith({
        where: { booking_id: "1", status: "pending" },
        data: expect.objectContaining({ status: "void" }),
      });
    });

    it("records no fee when the parent cancels > 24 hours out", async () => {
      mockPrisma.bookings.findUnique.mockResolvedValue(
        booking({ start_time: new Date(Date.now() + 1000 * 60 * 60 * 25) }),
      );
      mockPrisma.bookings.update.mockResolvedValue({ id: "1", status: "CANCELLED" });

      await service.cancelBooking("1", "Changed plans", "parent1");

      expect(mockPrisma.bookings.update).toHaveBeenCalledWith({
        where: { id: "1" },
        data: expect.objectContaining({
          status: "CANCELLED",
          cancellation_fee: 0,
          cancellation_fee_status: "no_fee",
        }),
      });
    });

    it("does not bill the parent when the nanny cancels a direct booking < 24 hours out", async () => {
      // No request_id, so the nanny cancellation takes the standard path — the
      // late-cancellation fee compensates for a slot the *parent* pulled, and
      // must not be raised against them for their caregiver walking away.
      mockPrisma.bookings.findUnique.mockResolvedValue(booking());
      mockPrisma.bookings.update.mockResolvedValue({ id: "1", status: "CANCELLED" });

      await service.cancelBooking("1", "Emergency", "nanny1");

      expect(mockPrisma.bookings.update).toHaveBeenCalledWith({
        where: { id: "1" },
        data: expect.objectContaining({
          cancellation_fee: 0,
          cancellation_fee_status: "no_fee",
        }),
      });
    });

    it("records no fee for a system cancellation < 24 hours out", async () => {
      mockPrisma.bookings.findUnique.mockResolvedValue(booking());
      mockPrisma.bookings.update.mockResolvedValue({ id: "1", status: "CANCELLED" });

      await service.cancelBooking("1", "Ops cleanup");

      expect(mockPrisma.bookings.update).toHaveBeenCalledWith({
        where: { id: "1" },
        data: expect.objectContaining({
          cancellation_fee: 0,
          cancellation_fee_status: "no_fee",
        }),
      });
    });
  });

  describe("completeBooking", () => {
    it("claims the transition atomically and prices with the booking's plan", async () => {
      const bookingId = "3";
      const start = new Date(Date.now() - 1000 * 60 * 60 * 2);
      const end = new Date(start.getTime() + 1000 * 60 * 60 * 4); // 4 hour session

      mockPrisma.bookings.findUnique
        .mockResolvedValueOnce({
          id: bookingId,
          status: "IN_PROGRESS",
          start_time: start,
          end_time: end,
          nanny_id: "nanny1",
          parent_id: "parent1",
          days_per_week: 3,
          users_bookings_nanny_idTousers: { nanny_details: {} },
          service_requests: {
            category: "CC",
            plan_type: "MONTHLY",
            plan_duration_months: 2,
          },
          payments: [],
        })
        .mockResolvedValue({ id: bookingId, status: "COMPLETED" });
      mockPrisma.bookings.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.completeBooking(bookingId);

      // The claim is guarded on the expected status, not a blind update
      expect(mockPrisma.bookings.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: bookingId, status: "IN_PROGRESS" },
          data: expect.objectContaining({ status: "COMPLETED" }),
        }),
      );
      // The payout accrual is priced with the plan the booking was sold under,
      // not the ONE_TIME defaults
      expect(mockCalculateCost).toHaveBeenCalledWith("CC", 4, 2, "MONTHLY", 3);
      expect(result).toEqual({ id: bookingId, status: "COMPLETED" });
    });

    it("does not duplicate side effects when another call claimed the completion first", async () => {
      mockPrisma.bookings.findUnique
        .mockResolvedValueOnce({
          id: "3",
          status: "IN_PROGRESS",
          start_time: new Date(Date.now() - 3600_000),
          end_time: new Date(),
          nanny_id: "nanny1",
          parent_id: "parent1",
          users_bookings_nanny_idTousers: { nanny_details: {} },
          service_requests: { category: "CC" },
          payments: [],
        })
        .mockResolvedValue({ id: "3", status: "COMPLETED" });
      mockPrisma.bookings.updateMany.mockResolvedValue({ count: 0 });

      const result = await service.completeBooking("3");
      expect(result).toEqual({ id: "3", status: "COMPLETED" });
    });
  });

  describe("reportNoShow", () => {
    const base = {
      id: "b1",
      status: "CONFIRMED",
      parent_id: "parent1",
      nanny_id: "nanny1",
      request_id: "req1",
      start_time: new Date(Date.now() - 3600_000), // started an hour ago
    };

    it("rejects a report before the booking's start time", async () => {
      mockPrisma.bookings.findUnique.mockResolvedValue({
        ...base,
        start_time: new Date(Date.now() + 3600_000),
      });

      await expect(
        service.reportNoShow("b1", "nanny1", "not here"),
      ).rejects.toThrow(BadRequestException);
      expect(mockPrisma.bookings.updateMany).not.toHaveBeenCalled();
    });

    it("cancels atomically, voids pending instalments and closes the request", async () => {
      mockPrisma.bookings.findUnique
        .mockResolvedValueOnce(base)
        .mockResolvedValue({ ...base, status: "CANCELLED" });
      mockPrisma.bookings.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.reportNoShow("b1", "nanny1", "parent absent");

      expect(mockPrisma.bookings.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "b1", status: "CONFIRMED" },
        }),
      );
      expect(mockPrisma.payment_installments.updateMany).toHaveBeenCalledWith({
        where: { booking_id: "b1", status: "pending" },
        data: expect.objectContaining({ status: "void" }),
      });
      expect(mockPrisma.service_requests.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: "req1" }),
          data: { status: "CANCELLED" },
        }),
      );
      expect(result.status).toBe("CANCELLED");
    });

    it("throws when another actor moved the booking between read and claim", async () => {
      mockPrisma.bookings.findUnique.mockResolvedValue(base);
      mockPrisma.bookings.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.reportNoShow("b1", "nanny1", "parent absent"),
      ).rejects.toThrow(BadRequestException);
    });
  });

  /*
  describe("createBooking", () => {
    it("should handle overnight bookings correctly by incrementing the end date", async () => {
      const date = "2026-01-25";
      const startTime = "18:00";
      const endTime = "06:00"; // Next day
      const parentId = "parent1";
      const nannyId = "nanny1";

      // Mock verified nanny
      mockPrisma.users.findUnique.mockResolvedValue({
        id: nannyId,
        role: "nanny",
        identity_verification_status: "verified",
      });

      mockPrisma.bookings.create.mockImplementation(({ data }) => ({
        id: "new-booking-id",
        ...data,
      }));

      const result = await (service as any).createBooking(
        undefined,
        parentId,
        nannyId,
        date,
        startTime,
        endTime,
      );

      const start = new Date(`${date}T18:00:00`);
      const expectedEnd = new Date(`${date}T06:00:00`);
      expectedEnd.setDate(expectedEnd.getDate() + 1);

      expect(result.start_time!.getTime()).toBe(start.getTime());
      expect(result.end_time!.getTime()).toBe(expectedEnd.getTime());
      expect(result.end_time!.getTime() - result.start_time!.getTime()).toBe(
        12 * 60 * 60 * 1000,
      );
    });

    it("should fail if nanny is not verified", async () => {
      const parentId = "parent1";
      const nannyId = "nannyUnverified";

      mockPrisma.users.findUnique.mockResolvedValue({
        id: nannyId,
        role: "nanny",
        identity_verification_status: "pending", // Not verified
      });

      await expect(
        (service as any).createBooking(
          undefined,
          parentId,
          nannyId,
          "2026-01-25",
          "10:00",
          "12:00",
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });
  */
});
