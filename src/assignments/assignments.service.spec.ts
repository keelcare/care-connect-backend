import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { AssignmentsService } from "./assignments.service";
import { PrismaService } from "../prisma/prisma.service";
import { RequestsService } from "../requests/requests.service";
import { NotificationsService } from "../notifications/notifications.service";
import { ChatService } from "../chat/chat.service";
import { SseService } from "../sse/sse.service";
import { MailService } from "../mail/mail.service";

describe("AssignmentsService", () => {
  let service: AssignmentsService;
  let prisma: any;
  let tx: any;
  let notificationsService: any;
  let chatService: any;
  let requestsServiceMock: any;

  const parent = {
    profiles: { first_name: "Pat", last_name: "Parent", address: "12 Lane" },
    email: "parent@example.com",
  };
  const nannyUser = {
    profiles: { first_name: "Nina", last_name: "Nanny" },
    email: "nanny@example.com",
  };
  const serviceRequest = {
    id: "req-1",
    parent_id: "parent-1",
    date: new Date("2026-09-10T00:00:00.000Z"),
    start_time: new Date("1970-01-01T04:30:00.000Z"), // 10:00 IST
    duration_hours: 2,
    users: parent,
  };
  const pendingAssignment = {
    id: "as-1",
    request_id: "req-1",
    nanny_id: "nanny-1",
    status: "pending",
    service_requests: serviceRequest,
  };

  beforeEach(async () => {
    tx = {
      assignments: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          ...pendingAssignment,
          status: "accepted",
          users: nannyUser,
        }),
        findMany: jest.fn().mockResolvedValue([{ status: "accepted" }]),
      },
      service_requests: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      bookings: {
        findFirst: jest.fn().mockResolvedValue(null), // no overlap by default
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue({ id: "bk-1", status: "CONFIRMED", nanny_id: "nanny-1" }),
      },
      nanny_details: { update: jest.fn() },
    };
    // accept() calls bookings.findFirst twice: once for the overlap re-check
    // (nanny_id-scoped) and once to locate the request's booking. Route by args.
    tx.bookings.findFirst.mockImplementation(({ where }: any) =>
      where.nanny_id
        ? Promise.resolve(null) // overlap check
        : Promise.resolve({ id: "bk-1", status: "requested" }),
    );

    prisma = {
      assignments: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      nanny_details: { update: jest.fn() },
      $transaction: jest.fn().mockImplementation((cb) => cb(tx)),
    };
    notificationsService = { createNotification: jest.fn() };
    chatService = { createChat: jest.fn() };
    requestsServiceMock = {
      triggerMatching: jest.fn().mockResolvedValue(null),
      createRecurringRecord: jest.fn(),
      createPaymentPlan: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AssignmentsService,
        { provide: PrismaService, useValue: prisma },
        { provide: RequestsService, useValue: requestsServiceMock },
        { provide: NotificationsService, useValue: notificationsService },
        { provide: ChatService, useValue: chatService },
        {
          provide: SseService,
          useValue: { emitToUser: jest.fn(), emitToUsers: jest.fn() },
        },
        {
          provide: MailService,
          useValue: {
            sendBookingConfirmationEmail: jest.fn().mockResolvedValue(true),
          },
        },
      ],
    }).compile();

    service = module.get(AssignmentsService);
  });

  describe("accept", () => {
    beforeEach(() => {
      prisma.assignments.findUnique.mockResolvedValue({ ...pendingAssignment });
    });

    it("claims the assignment atomically with a status guard", async () => {
      await service.accept("as-1", "nanny-1");
      expect(tx.assignments.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "as-1", status: "pending" },
          data: expect.objectContaining({ status: "accepted" }),
        }),
      );
    });

    it("throws and fires no side effects when the claim loses the race", async () => {
      // Timeout cron / concurrent reject won: the guarded claim matches 0 rows.
      tx.assignments.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.accept("as-1", "nanny-1")).rejects.toThrow(
        BadRequestException,
      );
      expect(tx.bookings.updateMany).not.toHaveBeenCalled();
      expect(notificationsService.createNotification).not.toHaveBeenCalled();
      expect(chatService.createChat).not.toHaveBeenCalled();
    });

    it("rejects acceptance when the nanny has an overlapping booking", async () => {
      tx.bookings.findFirst.mockImplementation(({ where }: any) =>
        where.nanny_id
          ? Promise.resolve({ id: "other-bk", status: "CONFIRMED" })
          : Promise.resolve({ id: "bk-1", status: "requested" }),
      );
      await expect(service.accept("as-1", "nanny-1")).rejects.toThrow(
        /overlaps this time slot/,
      );
      expect(notificationsService.createNotification).not.toHaveBeenCalled();
    });

    it("guards the request update so a cancelled request cannot be resurrected", async () => {
      tx.service_requests.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.accept("as-1", "nanny-1")).rejects.toThrow(
        /no longer active/,
      );
      expect(tx.bookings.updateMany).not.toHaveBeenCalled();
    });

    it("confirms the booking through a status-guarded claim and records current_assignment_id", async () => {
      await service.accept("as-1", "nanny-1");
      expect(tx.service_requests.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: "accepted", current_assignment_id: "as-1" },
        }),
      );
      expect(tx.bookings.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: "bk-1",
            status: { in: ["requested", "CONFIRMED"] },
          }),
          data: expect.objectContaining({
            nanny_id: "nanny-1",
            status: "CONFIRMED",
          }),
        }),
      );
    });

    it("throws when the booking can no longer be confirmed (cancelled/started mid-flight)", async () => {
      tx.bookings.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.accept("as-1", "nanny-1")).rejects.toThrow(
        /can no longer be confirmed/,
      );
      expect(notificationsService.createNotification).not.toHaveBeenCalled();
    });

    it("runs chat creation and parent notification only after the transaction commits", async () => {
      const result = await service.accept("as-1", "nanny-1");
      expect(chatService.createChat).toHaveBeenCalledWith("bk-1");
      expect(notificationsService.createNotification).toHaveBeenCalledWith(
        "parent-1",
        "Booking Confirmed!",
        expect.any(String),
        "success",
      );
      expect(result.booking.status).toBe("CONFIRMED");
    });
  });

  describe("reject", () => {
    beforeEach(() => {
      prisma.assignments.findUnique.mockResolvedValue({ ...pendingAssignment });
      prisma.assignments.findMany.mockResolvedValue([{ status: "rejected" }]);
    });

    it("claims the rejection atomically and triggers re-matching", async () => {
      await service.reject("as-1", "nanny-1", "sick");
      expect(prisma.assignments.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "as-1", status: "pending" },
          data: expect.objectContaining({ status: "rejected" }),
        }),
      );
      expect(requestsServiceMock.triggerMatching).toHaveBeenCalledWith("req-1");
    });

    it("does not re-match when the claim loses the race (already accepted/timed out)", async () => {
      prisma.assignments.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.reject("as-1", "nanny-1")).rejects.toThrow(
        BadRequestException,
      );
      expect(requestsServiceMock.triggerMatching).not.toHaveBeenCalled();
    });
  });
});
