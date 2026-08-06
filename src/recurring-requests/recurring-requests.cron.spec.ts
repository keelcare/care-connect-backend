import { Test, TestingModule } from "@nestjs/testing";
import { RecurringRequestsCron } from "./recurring-requests.cron";
import { RecurringRequestsService } from "./recurring-requests.service";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";
import { PaymentsService } from "../payments/payments.service";
import { SseService } from "../sse/sse.service";

/**
 * A wound-down plan is cancelled but still owes the parent sessions. The crons
 * have to leave it alone — no new sessions, no new bills — and then close it
 * once the last one has actually been delivered.
 */
describe("RecurringRequestsCron", () => {
  let cron: RecurringRequestsCron;

  const mockPrisma = {
    recurring_service_requests: { findMany: jest.fn(), update: jest.fn() },
    bookings: { count: jest.fn() },
    booking_children: { findMany: jest.fn() },
    $transaction: jest.fn(),
  };
  const mockPayments = { openCycleForPlan: jest.fn() };
  const mockNotifications = { createNotification: jest.fn() };
  const mockSse = { emitToUser: jest.fn(), emitToUsers: jest.fn() };
  const mockService = { generateDates: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma.recurring_service_requests.findMany.mockResolvedValue([]);
    mockNotifications.createNotification.mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RecurringRequestsCron,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RecurringRequestsService, useValue: mockService },
        { provide: NotificationsService, useValue: mockNotifications },
        { provide: PaymentsService, useValue: mockPayments },
        { provide: SseService, useValue: mockSse },
      ],
    }).compile();

    cron = module.get(RecurringRequestsCron);
  });

  describe("skips winding-down plans", () => {
    it("does not open another billing cycle for one", async () => {
      // The remaining sessions are already paid for. Opening a cycle would bill
      // a parent who has cancelled for care they never asked for.
      await cron.handleCycleBilling();

      const where = mockPrisma.recurring_service_requests.findMany.mock.calls[0][0].where;
      expect(where.status).toBe("active");
    });

    it("does not generate new sessions for one", async () => {
      await cron.handleRollingGeneration();

      const where = mockPrisma.recurring_service_requests.findMany.mock.calls[0][0].where;
      expect(where.status.in).toEqual(["pending", "active"]);
      expect(where.status.in).not.toContain("winding_down");
    });

    it("cannot expire one, because it still holds its caregiver", async () => {
      await cron.handleUnassignedExpiry();

      const where = mockPrisma.recurring_service_requests.findMany.mock.calls[0][0].where;
      expect(where.status.in).not.toContain("winding_down");
      expect(where.nanny_id).toBeNull();
    });
  });

  describe("handleWindDownCompletion", () => {
    beforeEach(() => {
      mockPrisma.recurring_service_requests.findMany.mockResolvedValue([
        { id: "plan-1", parent_id: "parent-1" },
      ]);
    });

    it("closes the plan and releases the caregiver once nothing is left to serve", async () => {
      mockPrisma.bookings.count.mockResolvedValue(0);

      await cron.handleWindDownCompletion();

      expect(mockPrisma.recurring_service_requests.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "plan-1" },
          data: expect.objectContaining({ status: "completed", nanny_id: null }),
        }),
      );
      expect(mockNotifications.createNotification).toHaveBeenCalled();
      expect(mockSse.emitToUser).toHaveBeenCalled();
    });

    it("waits while a retained session is still to come", async () => {
      mockPrisma.bookings.count.mockResolvedValue(3);

      await cron.handleWindDownCompletion();

      expect(mockPrisma.recurring_service_requests.update).not.toHaveBeenCalled();
    });

    it("waits while the last session is still in progress", async () => {
      // Closing the plan here would release the caregiver mid-shift. The count
      // is of sessions not yet finished, and IN_PROGRESS is one of them.
      mockPrisma.bookings.count.mockResolvedValue(1);

      await cron.handleWindDownCompletion();

      const where = mockPrisma.bookings.count.mock.calls[0][0].where;
      expect(where.status.in).toEqual(
        expect.arrayContaining(["requested", "CONFIRMED", "IN_PROGRESS"]),
      );
      expect(mockPrisma.recurring_service_requests.update).not.toHaveBeenCalled();
    });

    it("carries on with the next plan when one fails", async () => {
      mockPrisma.recurring_service_requests.findMany.mockResolvedValue([
        { id: "plan-1", parent_id: "parent-1" },
        { id: "plan-2", parent_id: "parent-2" },
      ]);
      mockPrisma.bookings.count.mockResolvedValue(0);
      mockPrisma.recurring_service_requests.update
        .mockRejectedValueOnce(new Error("db down"))
        .mockResolvedValueOnce({});

      await expect(cron.handleWindDownCompletion()).resolves.not.toThrow();
      expect(mockPrisma.recurring_service_requests.update).toHaveBeenCalledTimes(2);
    });
  });
});
