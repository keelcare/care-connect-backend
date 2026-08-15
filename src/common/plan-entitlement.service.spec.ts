import { Test, TestingModule } from "@nestjs/testing";
import { PlanEntitlementService } from "./plan-entitlement.service";
import { PrismaService } from "../prisma/prisma.service";

/**
 * A plan is bought a month at a time, half up front and half later. These tests
 * pin down what that money is worth in sessions, because cancellation hands the
 * parent exactly that many and nothing was previously counting it at all.
 */
describe("PlanEntitlementService", () => {
  let service: PlanEntitlementService;

  const mockPrisma = {
    recurring_service_requests: { findUnique: jest.fn(), findMany: jest.fn() },
    payment_installments: { findMany: jest.fn() },
    bookings: { count: jest.fn(), groupBy: jest.fn() },
  };

  // Weekdays through September 2026: 22 sessions in cycle 1.
  const WEEKDAY_PLAN = {
    id: "plan-1",
    start_date: new Date("2026-09-01"),
    plan_duration_months: 1,
    recurrence_type: "WEEKLY",
    recurrence_pattern: { days: ["Mon", "Tue", "Wed", "Thu", "Fri"] },
  };

  const inst = (over: Record<string, unknown> = {}) => ({
    cycle_number: 1,
    amount: 5000,
    status: "pending",
    ...over,
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlanEntitlementService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();
    service = module.get(PlanEntitlementService);
    mockPrisma.bookings.count.mockResolvedValue(0);
    mockPrisma.recurring_service_requests.findUnique.mockResolvedValue(WEEKDAY_PLAN);
  });

  it("gives nothing for a plan that has never been billed", async () => {
    mockPrisma.payment_installments.findMany.mockResolvedValue([]);

    const result = await service.computeEntitlement("plan-1");

    expect(result.sessionsEntitled).toBe(0);
    expect(result.cycles).toEqual([]);
  });

  it("gives nothing for a cycle that has been billed but not paid", async () => {
    mockPrisma.payment_installments.findMany.mockResolvedValue([
      inst({ installment_no: 1 }),
      inst({ installment_no: 2 }),
    ]);

    const result = await service.computeEntitlement("plan-1");

    expect(result.sessionsEntitled).toBe(0);
  });

  it("gives half a cycle's sessions when only the advance is paid", async () => {
    // The scenario the whole feature exists for: 50% paid on a 22-session month.
    mockPrisma.payment_installments.findMany.mockResolvedValue([
      inst({ installment_no: 1, status: "paid" }),
      inst({ installment_no: 2, status: "pending" }),
    ]);

    const result = await service.computeEntitlement("plan-1");

    expect(result.cycles[0].paidFraction).toBeCloseTo(0.5);
    expect(result.cycles[0].sessionsInCycle).toBe(22);
    expect(result.sessionsEntitled).toBe(11);
  });

  it("gives the whole cycle once the balance is paid too", async () => {
    mockPrisma.payment_installments.findMany.mockResolvedValue([
      inst({ installment_no: 1, status: "paid" }),
      inst({ installment_no: 2, status: "paid" }),
    ]);

    const result = await service.computeEntitlement("plan-1");

    expect(result.sessionsEntitled).toBe(22);
  });

  it("weighs by amount, not by installment count", async () => {
    // A matching fee carved out of cycle 1 leaves the two halves uneven. Counting
    // installments would call an unequal split 50/50 and hand out the wrong number.
    mockPrisma.payment_installments.findMany.mockResolvedValue([
      inst({ installment_no: 1, amount: 2000, status: "paid" }),
      inst({ installment_no: 2, amount: 8000, status: "pending" }),
    ]);

    const result = await service.computeEntitlement("plan-1");

    expect(result.cycles[0].paidFraction).toBeCloseTo(0.2);
    expect(result.sessionsEntitled).toBe(Math.floor(0.2 * 22)); // 4, not 11
  });

  it("drops voided money from both sides of the ratio", async () => {
    // A voided balance is no longer owed. Leaving it in the denominator would
    // report the cycle as half paid forever, when it is in fact settled.
    mockPrisma.payment_installments.findMany.mockResolvedValue([
      inst({ installment_no: 1, status: "paid" }),
      inst({ installment_no: 2, status: "void" }),
    ]);

    const result = await service.computeEntitlement("plan-1");

    expect(result.cycles[0].paidFraction).toBe(1);
    expect(result.sessionsEntitled).toBe(22);
  });

  it("treats a fully voided cycle as buying nothing, not as NaN", async () => {
    mockPrisma.payment_installments.findMany.mockResolvedValue([
      inst({ installment_no: 1, status: "void" }),
      inst({ installment_no: 2, status: "void" }),
    ]);

    const result = await service.computeEntitlement("plan-1");

    expect(result.sessionsEntitled).toBe(0);
    expect(Number.isNaN(result.sessionsEntitled)).toBe(false);
  });

  it("excludes the matching fee from the query it bills against", async () => {
    mockPrisma.payment_installments.findMany.mockResolvedValue([]);

    await service.computeEntitlement("plan-1");

    // The fee bought a placement, not care. Cycle 0 and the fee kind are both
    // filtered out; counting either would hand over sessions nobody paid for.
    const where = mockPrisma.payment_installments.findMany.mock.calls[0][0].where;
    expect(where.cycle_number).toEqual({ not: 0 });
    expect(where.kind).toEqual({ not: "matching_fee" });
  });

  it("floors once over the term rather than once per cycle", async () => {
    // Two half-paid 21-session cycles are 21 sessions bought. Flooring each
    // cycle separately says 20 — a session lost to arithmetic, for the same money.
    mockPrisma.recurring_service_requests.findUnique.mockResolvedValue({
      ...WEEKDAY_PLAN,
      start_date: new Date("2026-11-02"),
      plan_duration_months: 2,
    });
    mockPrisma.payment_installments.findMany.mockResolvedValue([
      inst({ cycle_number: 1, installment_no: 1, status: "paid" }),
      inst({ cycle_number: 1, installment_no: 2, status: "pending" }),
      inst({ cycle_number: 2, installment_no: 1, status: "paid" }),
      inst({ cycle_number: 2, installment_no: 2, status: "pending" }),
    ]);

    const result = await service.computeEntitlement("plan-1");

    const raw = result.cycles.reduce((sum, c) => sum + c.sessionsEarned, 0);
    const flooredPerCycle = result.cycles.reduce(
      (sum, c) => sum + Math.floor(c.sessionsEarned),
      0,
    );
    expect(result.sessionsEntitled).toBe(Math.floor(raw));
    expect(result.sessionsEntitled).toBeGreaterThanOrEqual(flooredPerCycle);
  });

  it("nets delivered sessions off what is still owed", async () => {
    mockPrisma.payment_installments.findMany.mockResolvedValue([
      inst({ installment_no: 1, status: "paid" }),
      inst({ installment_no: 2, status: "pending" }),
    ]);
    mockPrisma.bookings.count.mockResolvedValue(3);

    const result = await service.computeEntitlement("plan-1");

    // The user's own worked example: 11 bought, 3 used, 8 left.
    expect(result.sessionsEntitled).toBe(11);
    expect(result.sessionsDelivered).toBe(3);
    expect(result.sessionsRemaining).toBe(8);
  });

  it("never reports a negative remainder when more was delivered than bought", async () => {
    mockPrisma.payment_installments.findMany.mockResolvedValue([]);
    mockPrisma.bookings.count.mockResolvedValue(5);

    const result = await service.computeEntitlement("plan-1");

    expect(result.sessionsRemaining).toBe(0);
  });

  it("returns an empty entitlement for a plan that no longer exists", async () => {
    mockPrisma.recurring_service_requests.findUnique.mockResolvedValue(null);

    const result = await service.computeEntitlement("gone");

    expect(result).toEqual({
      sessionsEntitled: 0,
      sessionsDelivered: 0,
      sessionsRemaining: 0,
      cycles: [],
    });
  });

  describe("cyclesToVoid", () => {
    const entitlement = (over: Record<string, unknown> = {}) => ({
      sessionsEntitled: 0,
      sessionsDelivered: 0,
      sessionsRemaining: 0,
      cycles: [],
      ...over,
    }) as Parameters<PlanEntitlementService["cyclesToVoid"]>[0]["entitlement"];

    it("releases every cycle when the parent used no more than they paid for", () => {
      // The bug this replaced: a parent pays the 50% advance on a 22-session
      // month, attends nothing and cancels. They correctly keep 11 sessions —
      // and were then still chased for the balance that would have bought the
      // 11 sessions just cancelled.
      const dropped = service.cyclesToVoid({
        planMonths: 4,
        entitlement: entitlement({
          sessionsEntitled: 11,
          sessionsDelivered: 0,
          sessionsRemaining: 11,
          cycles: [
            { cycleNumber: 1, paidFraction: 0.5, sessionsInCycle: 22, sessionsEarned: 11 },
          ],
        }),
        deliveredByCycle: new Map(),
      });
      expect(dropped).toEqual([1, 2, 3, 4]);
    });

    it("keeps the balance of a cycle whose care outran its payment", () => {
      // 15 sessions delivered against an advance that bought 11. The balance is
      // genuinely owed — that care happened.
      const dropped = service.cyclesToVoid({
        planMonths: 3,
        entitlement: entitlement({
          sessionsEntitled: 11,
          sessionsDelivered: 15,
          sessionsRemaining: 0,
          cycles: [
            { cycleNumber: 1, paidFraction: 0.5, sessionsInCycle: 22, sessionsEarned: 11 },
          ],
        }),
        deliveredByCycle: new Map([[1, 15]]),
      });
      expect(dropped).toEqual([2, 3]);
    });

    it("does not bill a later cycle for sessions spilling forward from an earlier one", () => {
      // Cycle 1 fully paid (22 sessions), 18 served in cycle 1 and 4 in cycle 2.
      // Delivery has not outrun payment across the term, so cycle 2 owes nothing
      // even though sessions were served in it.
      const dropped = service.cyclesToVoid({
        planMonths: 2,
        entitlement: entitlement({
          sessionsEntitled: 22,
          sessionsDelivered: 22,
          sessionsRemaining: 0,
          cycles: [
            { cycleNumber: 1, paidFraction: 1, sessionsInCycle: 22, sessionsEarned: 22 },
            { cycleNumber: 2, paidFraction: 0, sessionsInCycle: 22, sessionsEarned: 0 },
          ],
        }),
        deliveredByCycle: new Map([[1, 18], [2, 4]]),
      });
      expect(dropped).toEqual([1, 2]);
    });

    it("covers cycles billed beyond the sold term", () => {
      const dropped = service.cyclesToVoid({
        planMonths: 1,
        entitlement: entitlement({
          cycles: [
            { cycleNumber: 1, paidFraction: 0, sessionsInCycle: 22, sessionsEarned: 0 },
            { cycleNumber: 2, paidFraction: 0, sessionsInCycle: 22, sessionsEarned: 0 },
          ],
        }),
        deliveredByCycle: new Map(),
      });
      expect(dropped).toEqual([1, 2]);
    });
  });

  describe("computeEntitlementMany", () => {
    it("short-circuits on an empty list without querying", async () => {
      const result = await service.computeEntitlementMany([]);
      expect(result.size).toBe(0);
      expect(mockPrisma.payment_installments.findMany).not.toHaveBeenCalled();
    });

    it("agrees with the single-plan path", async () => {
      mockPrisma.recurring_service_requests.findMany.mockResolvedValue([WEEKDAY_PLAN]);
      mockPrisma.payment_installments.findMany.mockResolvedValue([
        { ...inst({ installment_no: 1, status: "paid" }), bookings: { recurring_request_id: "plan-1" } },
        { ...inst({ installment_no: 2, status: "pending" }), bookings: { recurring_request_id: "plan-1" } },
      ]);
      mockPrisma.bookings.groupBy.mockResolvedValue([
        { recurring_request_id: "plan-1", _count: { _all: 3 } },
      ]);

      const result = await service.computeEntitlementMany(["plan-1"]);

      expect(result.get("plan-1")).toMatchObject({
        sessionsEntitled: 11,
        sessionsDelivered: 3,
        sessionsRemaining: 8,
      });
    });
  });
});
