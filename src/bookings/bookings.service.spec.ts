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
    },
    payments: {
      create: jest.fn(),
      findMany: jest.fn(),
    },
    payment_installments: {
      findMany: jest.fn(),
    },
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
      // (status log, pricing, progress reports, event emitter). Auto-stub them so
      // adding one more never breaks the module from compiling.
      .useMocker(() => ({}))
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

  describe("cancelBooking", () => {
    it("should cancel with fee if < 24 hours", async () => {
      const bookingId = "1";
      const start = new Date(Date.now() + 1000 * 60 * 60 * 5); // 5 hours from now
      const hourlyRate = 20;

      mockPrisma.bookings.findUnique.mockResolvedValue({
        id: bookingId,
        status: "CONFIRMED",
        start_time: start,
        nanny_id: "nanny1",
        parent_id: "parent1",
        users_bookings_nanny_idTousers: {
          nanny_details: { hourly_rate: hourlyRate },
        },
        service_requests: { category: "CC" },
      });

      mockPrisma.bookings.update.mockResolvedValue({
        id: bookingId,
        status: "CANCELLED",
      });

      await service.cancelBooking(bookingId, "Emergency", "parent1");

      expect(mockNotificationsService.createNotification).toHaveBeenCalledWith(
        "nanny1",
        "Booking Cancelled",
        expect.any(String),
        "warning",
      );
    });

    it("should cancel without fee if > 24 hours", async () => {
      const bookingId = "2";
      const start = new Date(Date.now() + 1000 * 60 * 60 * 25); // 25 hours from now
      const hourlyRate = 20;

      mockPrisma.bookings.findUnique.mockResolvedValue({
        id: bookingId,
        status: "CONFIRMED",
        start_time: start,
        nanny_id: "nanny1",
        parent_id: "parent1",
        users_bookings_nanny_idTousers: {
          nanny_details: { hourly_rate: hourlyRate },
        },
      });

      await service.cancelBooking(bookingId, "Changed plans");

      expect(mockPrisma.bookings.update).toHaveBeenCalledWith({
        where: { id: bookingId },
        data: expect.objectContaining({
          status: "CANCELLED",
          cancellation_fee: 0,
          cancellation_fee_status: "no_fee",
        }),
      });
    });
  });

  describe("completeBooking", () => {
    it("should complete booking and create payment", async () => {
      const bookingId = "3";
      const start = new Date(Date.now() - 1000 * 60 * 60 * 2); // Started 2 hours ago
      const end = new Date(Date.now() + 1000 * 60 * 60 * 2); // Scheduled to end in 2 hours
      const hourlyRate = 25;

      mockPrisma.bookings.findUnique.mockResolvedValue({
        id: bookingId,
        status: "IN_PROGRESS",
        start_time: start,
        end_time: end,
        nanny_id: "nanny1",
        parent_id: "parent1",
        users_bookings_nanny_idTousers: {
          nanny_details: { hourly_rate: hourlyRate },
        },
        service_requests: { category: "CC" },
      });

      mockPrisma.bookings.update.mockResolvedValue({
        id: bookingId,
        status: "COMPLETED",
      });

      await service.completeBooking(bookingId);

      expect(mockPrisma.payments.create).toHaveBeenCalled();
      // Parent should be notified
      expect(mockNotificationsService.createNotification).toHaveBeenCalledWith(
        "parent1",
        "Booking Completed",
        expect.any(String),
        "success",
      );
      // Nanny should be notified
      expect(mockNotificationsService.createNotification).toHaveBeenCalledWith(
        "nanny1",
        "Booking Completed",
        expect.any(String),
        "success",
      );
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
