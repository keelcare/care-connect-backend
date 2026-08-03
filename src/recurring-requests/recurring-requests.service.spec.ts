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
    it('spans a calendar month inclusively, which is more dates than the plan bills', () => {
      // This is precisely why a plan's price must not be derived from its row
      // count: a month of weekdays generates 22–24 sessions, while the plan is
      // sold and billed as 4 weeks — 20.
      const dates = service.generateDates(
        '2026-09-01',
        undefined,
        RecurrenceType.WEEKLY,
        { days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'] },
        1,
      );
      expect(dates.length).toBeGreaterThan(20);
      expect(dates.every((d) => d.getDay() >= 1 && d.getDay() <= 5)).toBe(true);
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
        start_time: new Date('2026-09-01T04:30:00.000Z'),
        duration_hours: 8,
        plan_type: 'MONTHLY',
        plan_duration_months: 1,
        days_per_week: 5,
        sessions_per_month: null,
        recurrence_pattern: { days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'] },
        _count: { bookings: 24 },
        bookings: [],
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

    it('reports the sessions the plan was sold as, not the month already scheduled', async () => {
      mockPrisma.recurring_service_requests.findMany.mockResolvedValue([
        plan({ plan_duration_months: 6, plan_type: 'SIX_MONTH' }),
      ]);
      mockPricing.calculateCost.mockResolvedValue({ totalAmount: 95040, appliedRate: 99 });

      const [result] = await service.findAllByParent('parent-1');

      // 5 days × 4 weeks × 6 months. Counting generated rows would say 24 — a
      // six-month plan rendered as a fraction of its own first month.
      expect(result.total_sessions).toBe(120);
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
  });
});
