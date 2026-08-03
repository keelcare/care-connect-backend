import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { PaymentsService } from "./payments.service";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";
import { PaymentGatewayService } from "./payment-gateway.service";
import { PaymentAuditService } from "./payment-audit.service";
import { PricingEngineService } from "../common/pricing.service";
import { MailService } from "../mail/mail.service";

/**
 * `getNannyEarningsAnalytics` builds the caregiver's own earnings screen, so the
 * cases that matter are the ones where a wrong number misleads someone about their
 * income: double-counting a prepaid session, applying commission twice, or showing
 * a confident ₹0.00 where the honest answer is "not yet".
 *
 * The service issues its reads as an *array* `$transaction`, so the mock resolves
 * them with `Promise.all` in declaration order — the ordering below mirrors the
 * order of that array in the service.
 */
describe("PaymentsService — nanny earnings analytics", () => {
  // Thursday 6 Aug 2026, 12:00 IST. Week runs Mon 3rd – Sun 9th.
  const NOW = new Date("2026-08-06T06:30:00.000Z");

  let service: PaymentsService;
  let prisma: any;
  let pricing: any;

  /** A settled payment worth `amount` pre-tax (no GST snapshot attached). */
  const payment = (amount: number, at: string, releasedAt: string | null = null) => ({
    amount,
    created_at: new Date(at),
    released_at: releasedAt ? new Date(releasedAt) : null,
    price_snapshots: [],
  });

  /** A confirmed session ahead on the calendar, priced off the rate card. */
  const upcoming = (startIso: string, hours: number) => ({
    start_time: new Date(startIso),
    end_time: new Date(new Date(startIso).getTime() + hours * 3_600_000),
    pricing_mode: "standard",
    custom_hourly_rate: null,
    created_at: new Date("2026-07-01T00:00:00.000Z"),
    price_lock_mode: "locked",
    service_requests: { category: "CC" },
    price_snapshots: [],
  });

  /**
   * Wire up one call. Arguments mirror the service's `$transaction` array so a
   * reordering there fails loudly here rather than silently swapping figures.
   */
  async function build(opts: {
    allTime?: any[];
    periodPayments?: any[];
    lastPeriodPayments?: any[];
    jobsCompleted?: number;
    jobsThisPeriod?: number;
    upcomingBookings?: any[];
    commissionPercent?: number;
    hourlyRate?: number | null;
  }) {
    prisma = {
      payments: { findMany: jest.fn() },
      bookings: { count: jest.fn(), findMany: jest.fn() },
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    };

    prisma.payments.findMany
      .mockResolvedValueOnce(opts.allTime ?? [])
      .mockResolvedValueOnce(opts.periodPayments ?? [])
      .mockResolvedValueOnce(opts.lastPeriodPayments ?? []);
    prisma.bookings.count
      .mockResolvedValueOnce(opts.jobsCompleted ?? 0)
      .mockResolvedValueOnce(opts.jobsThisPeriod ?? 0);
    prisma.bookings.findMany.mockResolvedValue(opts.upcomingBookings ?? []);

    pricing = {
      getCommissionConfig: jest
        .fn()
        .mockResolvedValue({ percent: opts.commissionPercent ?? 5, configured: true }),
      resolveStandardHourlyRate: jest
        .fn()
        .mockResolvedValue(opts.hourlyRate === undefined ? 300 : opts.hourlyRate),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentsService,
        { provide: PrismaService, useValue: prisma },
        { provide: NotificationsService, useValue: { createNotification: jest.fn() } },
        { provide: PaymentGatewayService, useValue: {} },
        { provide: PaymentAuditService, useValue: { writeLog: jest.fn() } },
        { provide: PricingEngineService, useValue: pricing },
        { provide: MailService, useValue: {} },
        { provide: ConfigService, useValue: { get: jest.fn(() => undefined) } },
      ],
    }).compile();

    service = module.get(PaymentsService);
    return service.getNannyEarningsAnalytics("nanny-1", "week");
  }

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("projects earnings so far plus the caregiver's share of what is still booked", async () => {
    // ₹6,000 earned Mon–Wed; 4h Friday and 5h Saturday still booked at ₹300/h.
    const result = await build({
      allTime: [payment(6000, "2026-08-04T05:00:00.000Z")],
      periodPayments: [payment(6000, "2026-08-04T05:00:00.000Z")],
      upcomingBookings: [
        upcoming("2026-08-07T04:30:00.000Z", 4), // ₹1,200
        upcoming("2026-08-08T04:30:00.000Z", 5), // ₹1,500
      ],
      commissionPercent: 5,
    });

    // (6000 + 2700) × 0.95
    expect(result.projectedEarnings).toBe(8265);
    // Commission applied exactly once — never on top of an already-net figure.
    expect(result.netPayout).toBe(5700);
  });

  it("never counts a prepaid upcoming session twice", async () => {
    // The exclusion is enforced in the query, so assert the filter reaches Prisma:
    // a booking whose money is already in `periodPayments` must not come back as
    // projectable in the first place.
    await build({ periodPayments: [payment(6000, "2026-08-04T05:00:00.000Z")] });

    expect(prisma.bookings.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          NOT: { payments: { some: { status: { in: ["captured", "pending_release"] } } } },
        }),
      }),
    );
  });

  it("is never below what has already been earned this period", async () => {
    const result = await build({
      allTime: [payment(4000, "2026-08-04T05:00:00.000Z")],
      periodPayments: [payment(4000, "2026-08-04T05:00:00.000Z")],
      upcomingBookings: [],
      commissionPercent: 10,
    });

    expect(result.projectedEarnings).toBe(3600); // 4000 × 0.9, nothing booked ahead
  });

  it("returns null rather than a confident zero when there is nothing to project", async () => {
    const result = await build({ periodPayments: [], upcomingBookings: [] });
    expect(result.projectedEarnings).toBeNull();
  });

  it("drops bookings it cannot price instead of failing the whole screen", async () => {
    const result = await build({
      periodPayments: [payment(1000, "2026-08-04T05:00:00.000Z")],
      allTime: [payment(1000, "2026-08-04T05:00:00.000Z")],
      upcomingBookings: [
        upcoming("2026-08-07T04:30:00.000Z", 4),
        { ...upcoming("2026-08-08T04:30:00.000Z", 5), pricing_mode: "custom_override" },
      ],
      commissionPercent: 0,
    });

    // Only the priceable ₹1,200 session is added; the override is omitted.
    expect(result.projectedEarnings).toBe(2200);
  });

  it("spans the whole calendar week, marking days still ahead as projection", async () => {
    const result = await build({
      periodPayments: [payment(6000, "2026-08-04T05:00:00.000Z")], // Tuesday
      upcomingBookings: [upcoming("2026-08-07T04:30:00.000Z", 4)], // Friday
    });

    expect(result.trend.map((t) => t.date)).toEqual([
      "2026-08-03",
      "2026-08-04",
      "2026-08-05",
      "2026-08-06",
      "2026-08-07",
      "2026-08-08",
      "2026-08-09",
    ]);

    const tuesday = result.trend.find((t) => t.date === "2026-08-04")!;
    expect(tuesday.amount).toBe(6000);
    expect(tuesday.projection).toBeUndefined();

    // The chart's grey bar and the card are built from the same booked value.
    const friday = result.trend.find((t) => t.date === "2026-08-07")!;
    expect(friday.amount).toBe(0);
    expect(friday.projection).toBe(1200);

    const sunday = result.trend.find((t) => t.date === "2026-08-09")!;
    expect(sunday.projection).toBeUndefined();
  });

  it("compares against the same elapsed slice of the previous week", async () => {
    await build({});

    // Thursday noon of the previous week, not the whole finished week.
    const lastPeriodCall = prisma.payments.findMany.mock.calls[2][0];
    expect(lastPeriodCall.where.created_at.gte.toISOString()).toBe(
      "2026-07-26T18:30:00.000Z",
    );
    expect(lastPeriodCall.where.created_at.lte.toISOString()).toBe(
      "2026-07-30T06:30:00.000Z",
    );
  });
});
