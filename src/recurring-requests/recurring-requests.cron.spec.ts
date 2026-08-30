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
    recurring_service_requests: {
      findMany: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    bookings: { count: jest.fn(), updateMany: jest.fn(), create: jest.fn() },
    payment_installments: { updateMany: jest.fn() },
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
    mockPrisma.bookings.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.payment_installments.updateMany.mockResolvedValue({ count: 0 });
    // Expiry runs its writes inside an interactive transaction.
    mockPrisma.$transaction.mockImplementation(async (fn: any) =>
      typeof fn === 'function' ? fn(mockPrisma) : Promise.all(fn),
    );

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

  describe("handleUnassignedExpiry", () => {
    beforeEach(() => {
      mockPrisma.recurring_service_requests.findMany.mockResolvedValue([
        { id: "plan-1", parent_id: "parent-1" },
      ]);
      mockPrisma.recurring_service_requests.updateMany.mockResolvedValue({ count: 1 });
    });

    it("expires the plan with a guarded claim, so a just-made assignment survives", async () => {
      await cron.handleUnassignedExpiry();

      const claim = mockPrisma.recurring_service_requests.updateMany.mock.calls[0][0];
      // Only a still-unstaffed, still-generating plan can expire — an admin
      // assigning a caregiver between the read and this write sets nanny_id and
      // status active, and must not have the plan expired out from under them.
      expect(claim.where).toEqual({
        id: "plan-1",
        status: { in: ["pending", "active"] },
        nanny_id: null,
      });
      expect(claim.data.status).toBe("expired");
    });

    it("cancels only the unstaffed requested sessions, never delivered care", async () => {
      // A session staffed directly by booking id never sets the plan's
      // nanny_id, so it can be CONFIRMED or even COMPLETED under an otherwise
      // unassigned plan. The old `status != CANCELLED` filter rewrote that
      // delivered care as cancelled.
      await cron.handleUnassignedExpiry();

      const cancelWhere = mockPrisma.bookings.updateMany.mock.calls[0][0].where;
      expect(cancelWhere).toEqual({
        recurring_request_id: "plan-1",
        status: "requested",
        nanny_id: null,
      });
    });

    it("voids the pending instalments so an expired plan stops being collectible", async () => {
      // The matching fee is raised at creation, before any assignment — it used
      // to stay PENDING forever on a plan nobody ever served.
      await cron.handleUnassignedExpiry();

      const voidCall = mockPrisma.payment_installments.updateMany.mock.calls[0][0];
      expect(voidCall.where).toEqual(
        expect.objectContaining({
          bookings: { recurring_request_id: "plan-1" },
          status: "pending",
        }),
      );
      expect(voidCall.data.status).toBe("void");
      expect(mockNotifications.createNotification).toHaveBeenCalled();
    });

    it("does nothing further when the claim is lost", async () => {
      mockPrisma.recurring_service_requests.updateMany.mockResolvedValue({ count: 0 });

      await cron.handleUnassignedExpiry();

      expect(mockPrisma.bookings.updateMany).not.toHaveBeenCalled();
      expect(mockPrisma.payment_installments.updateMany).not.toHaveBeenCalled();
      expect(mockNotifications.createNotification).not.toHaveBeenCalled();
    });
  });

  describe("handleRollingGeneration — end of term", () => {
    const DAY = 24 * 60 * 60 * 1000;

    /** A one-month plan started 75 days ago whose last session was `daysAgo` days in the past. */
    function exhaustedPlan(daysAgo: number, over: Record<string, unknown> = {}) {
      const start = new Date(Date.now() - 75 * DAY);
      return {
        id: "plan-1",
        parent_id: "parent-1",
        nanny_id: "nanny-1",
        status: "active",
        start_date: start,
        end_date: null,
        plan_duration_months: 1,
        recurrence_type: "weekly",
        recurrence_pattern: { days: ["Mon", "Tue", "Wed", "Thu", "Fri"] },
        start_time: new Date("2026-09-01T04:30:00.000Z"),
        duration_hours: 8,
        category: "CC",
        bookings: [
          { id: "b-last", start_time: new Date(Date.now() - daysAgo * DAY) },
        ],
        ...over,
      };
    }

    it("completes a plan that ran its full term instead of flagging it as an error", async () => {
      // The stuck detector used to catch a finished plan two weeks after its
      // last session, flip it to ERROR and warn the parent that "we couldn't
      // generate your sessions" — about a plan that ended exactly as sold.
      mockPrisma.recurring_service_requests.findMany.mockResolvedValue([
        // Last session 31 days ago, one-month term sold 60 days ago: the term
        // is over, and the old stuck detector (>14 days) would have fired.
        exhaustedPlan(31),
      ]);
      mockPrisma.bookings.count.mockResolvedValue(0);
      mockPrisma.recurring_service_requests.updateMany.mockResolvedValue({ count: 1 });

      await cron.handleRollingGeneration();

      const claim = mockPrisma.recurring_service_requests.updateMany.mock.calls[0][0];
      expect(claim.data.status).toBe("completed");
      expect(claim.data.nanny_id).toBeNull();
      expect(claim.where.status).toEqual({ in: ["pending", "active"] });
      const [, title, , kind] = mockNotifications.createNotification.mock.calls[0];
      expect(title).toBe("Recurring plan completed");
      expect(kind).toBe("info");
    });

    it("waits for the term's last outstanding session before completing", async () => {
      mockPrisma.recurring_service_requests.findMany.mockResolvedValue([
        exhaustedPlan(31),
      ]);
      mockPrisma.bookings.count.mockResolvedValue(1);

      await cron.handleRollingGeneration();

      expect(mockPrisma.recurring_service_requests.updateMany).not.toHaveBeenCalled();
      expect(mockPrisma.recurring_service_requests.update).not.toHaveBeenCalled();
    });

    it("still flags a genuinely stuck plan whose term has months to run", async () => {
      mockPrisma.recurring_service_requests.findMany.mockResolvedValue([
        exhaustedPlan(31, { plan_duration_months: 12 }),
      ]);
      mockPrisma.recurring_service_requests.updateMany.mockResolvedValue({ count: 1 });

      await cron.handleRollingGeneration();

      const claim = mockPrisma.recurring_service_requests.updateMany.mock.calls[0][0];
      expect(claim.data.status).toBe("error");
      const [, title] = mockNotifications.createNotification.mock.calls[0];
      expect(title).toBe("Recurring booking issue");
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
      mockPrisma.recurring_service_requests.updateMany.mockResolvedValue({ count: 1 });

      await cron.handleWindDownCompletion();

      // The completion is a guarded claim: only a plan still winding down is
      // completed, so a concurrent cancel retry cannot be clobbered.
      expect(mockPrisma.recurring_service_requests.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "plan-1", status: "winding_down" },
          data: expect.objectContaining({ status: "completed", nanny_id: null }),
        }),
      );
      expect(mockNotifications.createNotification).toHaveBeenCalled();
      expect(mockSse.emitToUser).toHaveBeenCalled();
    });

    it("does not notify when another writer already closed the plan", async () => {
      mockPrisma.bookings.count.mockResolvedValue(0);
      mockPrisma.recurring_service_requests.updateMany.mockResolvedValue({ count: 0 });

      await cron.handleWindDownCompletion();

      expect(mockNotifications.createNotification).not.toHaveBeenCalled();
      expect(mockSse.emitToUser).not.toHaveBeenCalled();
    });

    it("waits while a retained session is still to come", async () => {
      mockPrisma.bookings.count.mockResolvedValue(3);

      await cron.handleWindDownCompletion();

      expect(mockPrisma.recurring_service_requests.updateMany).not.toHaveBeenCalled();
    });

    it("waits while the last session is still in progress", async () => {
      // Closing the plan here would release the caregiver mid-shift. Outstanding
      // means still deliverable: IN_PROGRESS whatever the clock says, or a
      // scheduled session whose window has not closed. A REQUESTED/CONFIRMED
      // session already in the past can never be served — counting it used to
      // deadlock the plan in winding_down forever.
      mockPrisma.bookings.count.mockResolvedValue(1);

      await cron.handleWindDownCompletion();

      const where = mockPrisma.bookings.count.mock.calls[0][0].where;
      expect(where.OR).toEqual([
        { status: "IN_PROGRESS" },
        {
          status: { in: ["requested", "CONFIRMED"] },
          end_time: { gt: expect.any(Date) },
        },
      ]);
      expect(mockPrisma.recurring_service_requests.updateMany).not.toHaveBeenCalled();
    });

    it("carries on with the next plan when one fails", async () => {
      mockPrisma.recurring_service_requests.findMany.mockResolvedValue([
        { id: "plan-1", parent_id: "parent-1" },
        { id: "plan-2", parent_id: "parent-2" },
      ]);
      mockPrisma.bookings.count.mockResolvedValue(0);
      mockPrisma.recurring_service_requests.updateMany
        .mockRejectedValueOnce(new Error("db down"))
        .mockResolvedValueOnce({ count: 1 });

      await expect(cron.handleWindDownCompletion()).resolves.not.toThrow();
      expect(mockPrisma.recurring_service_requests.updateMany).toHaveBeenCalledTimes(2);
    });
  });
});
