import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { AdminService } from "./admin.service";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";
import { FavoritesService } from "../favorites/favorites.service";
import { ChatService } from "../chat/chat.service";
import { RequestsService } from "../requests/requests.service";
import { SseService } from "../sse/sse.service";
import { DisputesService } from "../disputes/disputes.service";
import { MailService } from "../mail/mail.service";
import { AvailabilityService } from "../availability/availability.service";
import { AdminAuditService } from "./admin-audit.service";
import { PricingEngineService } from "../common/pricing.service";
import { EncryptionService } from "../common/services/encryption.service";
import { PaymentsService } from "../payments/payments.service";

describe("AdminService", () => {
  let service: AdminService;
  let prisma: any;
  let tx: any;
  let auditService: { logAction: jest.Mock };
  let paymentsService: { openFirstCycleForPlan: jest.Mock };
  let chatService: { createChat: jest.Mock };

  const verifiedNanny = {
    id: "nanny-1",
    role: "nanny",
    email: "nanny@example.com",
    identity_verification_status: "verified",
    is_active: true,
    deleted_at: null,
    nanny_details: {},
    profiles: { first_name: "Nina", last_name: "N" },
  };

  const parentUser = {
    email: "parent@example.com",
    profiles: {
      first_name: "Pat",
      last_name: "P",
      address: "12 Lane",
    },
  };

  beforeEach(async () => {
    tx = {
      assignments: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: "assignment-1" }),
        update: jest.fn().mockResolvedValue({ id: "assignment-1" }),
      },
      service_requests: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      recurring_service_requests: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      bookings: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };

    prisma = {
      users: {
        findMany: jest.fn(),
        findUnique: jest.fn().mockResolvedValue(verifiedNanny),
        update: jest.fn(),
        count: jest.fn(),
      },
      bookings: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockResolvedValue(null),
        count: jest.fn(),
      },
      service_requests: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      recurring_service_requests: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      availability_blocks: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      payments: {
        count: jest.fn(),
        aggregate: jest.fn(),
      },
      reviews: {
        update: jest.fn().mockResolvedValue({ id: "review-1" }),
      },
      $transaction: jest
        .fn()
        .mockImplementation((arg: any) =>
          typeof arg === "function" ? arg(tx) : Promise.all(arg),
        ),
    };

    auditService = { logAction: jest.fn().mockResolvedValue(undefined) };
    paymentsService = {
      openFirstCycleForPlan: jest.fn().mockResolvedValue(undefined),
    };
    chatService = { createChat: jest.fn().mockResolvedValue({ id: "chat-1" }) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: NotificationsService,
          useValue: { createNotification: jest.fn() },
        },
        {
          provide: FavoritesService,
          useValue: { getFavoriteNannyIds: jest.fn().mockResolvedValue([]) },
        },
        { provide: ChatService, useValue: chatService },
        {
          provide: RequestsService,
          useValue: {
            triggerMatching: jest.fn(),
            createRecurringRecord: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: SseService,
          useValue: { emitToUser: jest.fn(), emitToUsers: jest.fn() },
        },
        { provide: DisputesService, useValue: {} },
        {
          provide: MailService,
          useValue: {
            sendBookingConfirmationEmail: jest.fn().mockResolvedValue(true),
          },
        },
        {
          provide: AvailabilityService,
          useValue: { doesBlockOverlap: jest.fn().mockReturnValue(false) },
        },
        { provide: AdminAuditService, useValue: auditService },
        {
          provide: PricingEngineService,
          useValue: {
            prefetchServiceCategories: jest.fn(),
            calculateCost: jest
              .fn()
              .mockResolvedValue({ totalAmount: 100, appliedRate: 50 }),
          },
        },
        { provide: EncryptionService, useValue: { decrypt: jest.fn() } },
        { provide: PaymentsService, useValue: paymentsService },
      ],
    }).compile();

    service = module.get<AdminService>(AdminService);
  });

  const futureDate = () => new Date(Date.now() + 24 * 60 * 60 * 1000);

  const pendingServiceRequest = () => ({
    id: "req-1",
    status: "pending",
    category: "CC",
    date: futureDate(),
    start_time: futureDate(),
    duration_hours: 2,
    parent_id: "parent-1",
    users: parentUser,
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  describe("banUser / unbanUser", () => {
    it("bans a user and writes an audit entry", async () => {
      prisma.users.update.mockResolvedValue({
        id: "user-123",
        is_active: false,
        ban_reason: "Violation",
      });

      const result = await service.banUser("user-123", "Violation", "admin-1");

      expect(prisma.users.update).toHaveBeenCalledWith({
        where: { id: "user-123" },
        data: { is_active: false, ban_reason: "Violation" },
      });
      expect(auditService.logAction).toHaveBeenCalledWith(
        expect.objectContaining({ action: "BAN_USER", targetId: "user-123" }),
      );
      expect(result.is_active).toBe(false);
    });

    it("unbans a user", async () => {
      prisma.users.update.mockResolvedValue({
        id: "user-123",
        is_active: true,
        ban_reason: null,
      });

      const result = await service.unbanUser("user-123");

      expect(prisma.users.update).toHaveBeenCalledWith({
        where: { id: "user-123" },
        data: { is_active: true, ban_reason: null },
      });
      expect(result.is_active).toBe(true);
    });
  });

  describe("manuallyAssignNanny — nanny eligibility", () => {
    beforeEach(() => {
      prisma.service_requests.findUnique.mockResolvedValue(
        pendingServiceRequest(),
      );
    });

    it("rejects an unverified nanny even though it never appeared on the candidate list", async () => {
      prisma.users.findUnique.mockResolvedValue({
        ...verifiedNanny,
        identity_verification_status: "pending",
      });

      await expect(
        service.manuallyAssignNanny("req-1", "nanny-1"),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("rejects a banned or deleted nanny", async () => {
      prisma.users.findUnique.mockResolvedValue({
        ...verifiedNanny,
        is_active: false,
      });

      await expect(
        service.manuallyAssignNanny("req-1", "nanny-1"),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe("manuallyAssignNanny — atomic claims", () => {
    it("claims a single request with a guarded updateMany and succeeds", async () => {
      prisma.service_requests.findUnique.mockResolvedValue(
        pendingServiceRequest(),
      );

      const result = await service.manuallyAssignNanny("req-1", "nanny-1");

      expect(tx.service_requests.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: "req-1",
            status: { in: ["pending", "active"] },
          }),
        }),
      );
      expect(result.success).toBe(true);
    });

    it("rolls back when another process claimed the request first", async () => {
      prisma.service_requests.findUnique.mockResolvedValue(
        pendingServiceRequest(),
      );
      tx.service_requests.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.manuallyAssignNanny("req-1", "nanny-1"),
      ).rejects.toThrow(/another process/);
    });

    it("claims a recurring plan only when it is still unstaffed", async () => {
      prisma.recurring_service_requests.findUnique.mockResolvedValue({
        id: "plan-1",
        status: "pending",
        category: "CC",
        start_date: futureDate(),
        start_time: futureDate(),
        duration_hours: 2,
        parent_id: "parent-1",
        users: parentUser,
        bookings: [{ start_time: futureDate(), end_time: futureDate() }],
      });
      tx.recurring_service_requests.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.manuallyAssignNanny("plan-1", "nanny-1"),
      ).rejects.toThrow(/another process/);
      expect(
        tx.recurring_service_requests.updateMany,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: "plan-1", nanny_id: null }),
        }),
      );
    });

    it("claims a single booking guarded on unassigned + assignable status", async () => {
      prisma.bookings.findUnique.mockResolvedValue({
        id: "booking-1",
        status: "requested",
        parent_id: "parent-1",
        recurring_request_id: "plan-1",
        start_time: futureDate(),
        end_time: new Date(futureDate().getTime() + 2 * 3600000),
        users_bookings_parent_idTousers: parentUser,
      });
      tx.bookings.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.manuallyAssignNanny(undefined, "nanny-1", "booking-1"),
      ).rejects.toThrow(/another process/);
      expect(tx.bookings.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: "booking-1",
            nanny_id: null,
          }),
        }),
      );
    });
  });

  describe("manuallyAssignNanny — side effects", () => {
    it("creates the chat on the assigned booking itself in the bookingId path", async () => {
      prisma.bookings.findUnique.mockResolvedValue({
        id: "booking-1",
        status: "requested",
        parent_id: "parent-1",
        recurring_request_id: "plan-1",
        start_time: futureDate(),
        end_time: new Date(futureDate().getTime() + 2 * 3600000),
        users_bookings_parent_idTousers: parentUser,
      });
      prisma.bookings.findFirst.mockResolvedValue({ id: "booking-1" });

      await service.manuallyAssignNanny(undefined, "nanny-1", "booking-1");

      // The post-commit lookup must target the booking that was assigned, not
      // an arbitrary confirmed booking (the old undefined-filter bug).
      expect(prisma.bookings.findFirst).toHaveBeenCalledWith({
        where: { id: "booking-1" },
      });
      expect(chatService.createChat).toHaveBeenCalledWith("booking-1");
    });

    it("does not fail the placement when opening the first billing cycle throws", async () => {
      prisma.recurring_service_requests.findUnique.mockResolvedValue({
        id: "plan-1",
        status: "pending",
        category: "CC",
        start_date: futureDate(),
        start_time: futureDate(),
        duration_hours: 2,
        parent_id: "parent-1",
        users: parentUser,
        bookings: [{ start_time: futureDate(), end_time: futureDate() }],
      });
      paymentsService.openFirstCycleForPlan.mockRejectedValue(
        new Error("pricing exploded"),
      );

      const result = await service.manuallyAssignNanny("plan-1", "nanny-1");

      expect(result.success).toBe(true);
      expect(paymentsService.openFirstCycleForPlan).toHaveBeenCalledWith(
        "plan-1",
      );
    });
  });

  describe("getPaymentStats", () => {
    it("counts and sums only genuinely collected money", async () => {
      prisma.payments.count
        .mockResolvedValueOnce(7) // collected count
        .mockResolvedValueOnce(3); // pending_release count
      prisma.payments.aggregate.mockResolvedValue({
        _sum: { amount: "1234.50" },
      });

      const stats = await service.getPaymentStats();

      expect(prisma.payments.aggregate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            provider: { not: "manual_pending" },
          }),
        }),
      );
      expect(stats.totalAmount).toBe(1234.5);
      expect(stats.totalPayments).toBe(7);
      expect(stats.pendingPayments).toBe(3);
    });
  });

  describe("review moderation audit", () => {
    it("logs an audit entry when a review is approved", async () => {
      await service.approveReview("review-1", "admin-1", "1.2.3.4");
      expect(auditService.logAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "APPROVE_REVIEW",
          targetId: "review-1",
        }),
      );
    });

    it("logs an audit entry when a review is rejected", async () => {
      await service.rejectReview("review-1", "admin-1", "1.2.3.4");
      expect(auditService.logAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "REJECT_REVIEW",
          targetId: "review-1",
        }),
      );
    });
  });
});
