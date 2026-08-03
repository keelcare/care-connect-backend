import { Test, TestingModule } from '@nestjs/testing';
import { RecurringRequestsService } from './recurring-requests.service';
import { PrismaService } from '../prisma/prisma.service';
import { AddressesService } from '../addresses/addresses.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PricingEngineService } from '../common/pricing.service';
import { RecurrenceType } from './dto/create-recurring-request.dto';

describe('RecurringRequestsService', () => {
  let service: RecurringRequestsService;

  const mockPrisma = {
    recurring_service_requests: { findMany: jest.fn() },
    bookings: { findFirst: jest.fn() },
  };

  const mockPricing = {
    calculateCost: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RecurringRequestsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: AddressesService, useValue: { resolveForUser: jest.fn() } },
        { provide: NotificationsService, useValue: { createNotification: jest.fn() } },
        { provide: PricingEngineService, useValue: mockPricing },
      ],
    }).compile();

    service = module.get<RecurringRequestsService>(RecurringRequestsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('generateDates', () => {
    it('spans one natural month, ending before the next one starts', () => {
      // A plan's price must not be derived from its row count: September's
      // weekdays generate 22 sessions while the plan is sold and billed as
      // 4 weeks — 20. Both are correct; they answer different questions.
      const dates = service.generateDates(
        '2026-09-01',
        undefined,
        RecurrenceType.WEEKLY,
        { days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'] },
        1,
      );
      expect(dates).toHaveLength(22);
      expect(dates.every((d) => d.getDay() >= 1 && d.getDay() <= 5)).toBe(true);
      // The boundary day belongs to cycle 2. Generating it here is what used to
      // make an August plan a 32-day month.
      expect(dates.every((d) => d < new Date('2026-10-01T00:00:00'))).toBe(true);
    });

    it('gives a longer month more sessions than a shorter one', () => {
      const forMonth = (start: string) =>
        service.generateDates(
          start,
          undefined,
          RecurrenceType.WEEKLY,
          { days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'] },
          1,
        ).length;

      // The whole point of natural months: February is short and December is
      // long, and the schedule says so at one flat monthly price.
      expect(forMonth('2027-02-01')).toBe(20);
      expect(forMonth('2026-12-01')).toBe(23);
    });

    it('anchors the month on the start date, not on the 1st', () => {
      const dates = service.generateDates(
        '2026-09-04',
        undefined,
        RecurrenceType.WEEKLY,
        { days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'] },
        1,
      );
      // 4 Sep – 3 Oct, as a parent starting mid-month would expect.
      expect(dates[0].toISOString().slice(0, 10)).toBe('2026-09-04');
      expect(dates[dates.length - 1] < new Date('2026-10-04T00:00:00')).toBe(true);
    });

    it('only emits the weekdays that were selected', () => {
      const dates = service.generateDates(
        '2026-09-01',
        undefined,
        RecurrenceType.WEEKLY,
        { days: ['Mon', 'Wed'] },
        1,
      );
      expect(dates.length).toBeGreaterThan(0);
      expect(dates.every((d) => [1, 3].includes(d.getDay()))).toBe(true);
    });
  });

  describe('findAllByParent', () => {
    function plan(over: Record<string, unknown> = {}) {
      return {
        id: 'plan-1',
        parent_id: 'parent-1',
        category: 'ST',
        status: 'pending',
        start_date: new Date('2026-09-01'),
        recurrence_type: 'WEEKLY',
        start_time: new Date('2026-09-01T04:30:00.000Z'),
        duration_hours: 8,
        plan_type: 'MONTHLY',
        plan_duration_months: 1,
        days_per_week: 5,
        sessions_per_month: null,
        recurrence_pattern: { days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'] },
        _count: { bookings: 24 },
        bookings: [],
        nanny_id: null,
        nanny: null,
        ...over,
      };
    }

    it('quotes the plan through the pricing engine, not the rows generated', async () => {
      // The bug this replaces: 8h × ₹99 × 24 generated rows = ₹19,008 displayed
      // against a plan the parent was quoted ₹15,840 for.
      mockPrisma.recurring_service_requests.findMany.mockResolvedValue([plan()]);
      mockPricing.calculateCost.mockResolvedValue({
        totalAmount: 15840,
        appliedRate: 99,
      });

      const [result] = await service.findAllByParent('parent-1');

      expect(mockPricing.calculateCost).toHaveBeenCalledWith('ST', 8, 1, 'MONTHLY', 5);
      expect(result.estimated_total).toBe(15840);
      expect(result.hourly_rate).toBe(99);
    });

    it('counts sessions off the real calendar, not a flat four weeks a month', async () => {
      mockPrisma.recurring_service_requests.findMany.mockResolvedValue([
        plan({ plan_duration_months: 6, plan_type: 'SIX_MONTH' }),
      ]);
      mockPricing.calculateCost.mockResolvedValue({ totalAmount: 95040, appliedRate: 99 });

      const [result] = await service.findAllByParent('parent-1');

      // Six natural months of weekdays from 1 Sep 2026: 22 + 22 + 21 + 23 + 21 + 20.
      // Not 120 (5 × 4 × 6) — that is the billing factor, and using it as a session
      // count is what pinned the label at a flat number whatever the calendar said.
      // Counting generated rows would say 24 instead: a six-month plan rendered as
      // a fraction of its own first month.
      expect(result.total_sessions).toBe(129);
      expect(result.total_bookings).toBe(24);
    });

    it('falls back to the weekday pattern when days_per_week was never stored', async () => {
      mockPrisma.recurring_service_requests.findMany.mockResolvedValue([
        plan({ days_per_week: null }),
      ]);
      mockPricing.calculateCost.mockResolvedValue({ totalAmount: 15840, appliedRate: 99 });

      await service.findAllByParent('parent-1');

      expect(mockPricing.calculateCost).toHaveBeenCalledWith('ST', 8, 1, 'MONTHLY', 5);
    });

    it('reads staffing off the plan rather than scanning its sessions', async () => {
      // Staffing used to be inferred from whichever booking happened to carry a
      // nanny_id, which meant a plan whose generated sessions had drifted back to
      // unassigned reported itself as pending despite having a caregiver.
      const caregiver = {
        id: 'nanny-1',
        profiles: { first_name: 'Asha', last_name: 'R', profile_image_url: null },
      };
      mockPrisma.recurring_service_requests.findMany.mockResolvedValue([
        plan({ status: 'active', nanny_id: 'nanny-1', nanny: caregiver, bookings: [] }),
      ]);
      mockPricing.calculateCost.mockResolvedValue({ totalAmount: 15840, appliedRate: 99 });

      const [result] = await service.findAllByParent('parent-1');

      expect(result.status).toBe('active');
      expect(result.nanny).toEqual(caregiver);
    });

    it('still reports an unstaffed plan as pending even when stored active', async () => {
      mockPrisma.recurring_service_requests.findMany.mockResolvedValue([
        plan({ status: 'active', nanny_id: null, nanny: null }),
      ]);
      mockPricing.calculateCost.mockResolvedValue({ totalAmount: 15840, appliedRate: 99 });

      const [result] = await service.findAllByParent('parent-1');

      expect(result.status).toBe('pending');
      expect(result.nanny).toBeNull();
    });
  });
});
