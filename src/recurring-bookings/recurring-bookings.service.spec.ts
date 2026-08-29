import { Test, TestingModule } from "@nestjs/testing";
import { RecurringBookingsService } from "./recurring-bookings.service";
import { PrismaService } from "../prisma/prisma.service";

/**
 * The legacy recurring-bookings generator creates tomorrow's session each
 * night. Its end date is inclusive — care is owed *on* it, never past it.
 */
describe("RecurringBookingsService — generation cron", () => {
  let service: RecurringBookingsService;

  const mockPrisma = {
    recurring_bookings: { findMany: jest.fn(), update: jest.fn() },
    bookings: { findFirst: jest.fn(), create: jest.fn() },
    recurring_booking_logs: { create: jest.fn() },
    users: { findUnique: jest.fn() },
    $transaction: jest.fn(),
  };

  function recurring(over: Record<string, unknown> = {}) {
    return {
      id: "rec-1",
      parent_id: "parent-1",
      nanny_id: "nanny-1",
      recurrence_pattern: "DAILY",
      start_date: new Date("2026-09-01T00:00:00Z"),
      end_date: null,
      start_time: "09:00",
      duration_hours: 4,
      is_active: true,
      ...over,
    };
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma.bookings.findFirst.mockResolvedValue(null);
    mockPrisma.$transaction.mockImplementation(async (fn: any) =>
      typeof fn === "function" ? fn(mockPrisma) : Promise.all(fn),
    );
    mockPrisma.bookings.create.mockResolvedValue({
      id: "b-new",
      start_time: new Date(),
      end_time: new Date(),
    });
    mockPrisma.recurring_booking_logs.create.mockResolvedValue({});

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RecurringBookingsService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get(RecurringBookingsService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("does not generate a session for the day after the end date", async () => {
    // Cron fires at IST midnight on the end date itself: the pattern is still
    // live (deactivation compares the end date to *today*), but "tomorrow" is
    // one day past the end date. Without the guard every plan with an end date
    // got exactly one extra session past the day the parent agreed to.
    jest.useFakeTimers().setSystemTime(new Date("2026-09-09T18:30:00Z")); // 10 Sep 00:00 IST
    mockPrisma.recurring_bookings.findMany.mockResolvedValue([
      recurring({ end_date: new Date("2026-09-10T00:00:00Z") }),
    ]);

    await service.generateRecurringBookings();

    expect(mockPrisma.bookings.create).not.toHaveBeenCalled();
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("still generates the session that falls on the end date itself", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-09-08T18:30:00Z")); // 9 Sep 00:00 IST
    mockPrisma.recurring_bookings.findMany.mockResolvedValue([
      recurring({ end_date: new Date("2026-09-10T00:00:00Z") }),
    ]);

    await service.generateRecurringBookings();

    expect(mockPrisma.bookings.create).toHaveBeenCalledTimes(1);
  });

  it("deactivates a pattern whose end date has passed", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-09-12T12:00:00Z"));
    mockPrisma.recurring_bookings.findMany.mockResolvedValue([
      recurring({ end_date: new Date("2026-09-10T00:00:00Z") }),
    ]);

    await service.generateRecurringBookings();

    expect(mockPrisma.recurring_bookings.update).toHaveBeenCalledWith({
      where: { id: "rec-1" },
      data: { is_active: false },
    });
    expect(mockPrisma.bookings.create).not.toHaveBeenCalled();
  });
});
