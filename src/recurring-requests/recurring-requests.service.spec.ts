import { Test, TestingModule } from '@nestjs/testing';
import { RecurringRequestsService } from './recurring-requests.service';
import { PrismaService } from '../prisma/prisma.service';
import { AddressesService } from '../addresses/addresses.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PricingEngineService } from '../common/pricing.service';
import { PlanEntitlementService } from '../common/plan-entitlement.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { SseService } from '../sse/sse.service';
import { DocumentIssuerService } from '../invoices/document-issuer.service';
import { RecurrenceType } from './dto/create-recurring-request.dto';

describe('RecurringRequestsService', () => {
  let service: RecurringRequestsService;

  const mockPrisma = {
    users: { findUnique: jest.fn() },
    recurring_service_requests: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      // The cancel path claims the plan atomically (guarded updateMany), so a
      // concurrent cancel/cron transition loses the claim instead of racing.
      updateMany: jest.fn(),
    },
    bookings: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn(),
      groupBy: jest.fn(),
    },
    payment_installments: { updateMany: jest.fn(), findMany: jest.fn() },
    $transaction: jest.fn(),
  };

  const mockPricing = {
    calculateCost: jest.fn(),
    prefetchServiceCategories: jest.fn(),
  };

  const noEntitlement = {
    sessionsEntitled: 0,
    sessionsDelivered: 0,
    sessionsRemaining: 0,
    cycles: [],
  };

  const mockEntitlement = {
    computeEntitlement: jest.fn(),
    computeEntitlementMany: jest.fn(),
    countDelivered: jest.fn(),
    deliveredByCycle: jest.fn(),
    cyclesToVoid: jest.fn(),
  };

  const mockAddresses = { resolveForUser: jest.fn() };
  const mockEmitter = { emit: jest.fn() };
  const mockSse = { emitToUser: jest.fn(), emitToUsers: jest.fn() };
  const mockDocuments = { issueSettlement: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPricing.prefetchServiceCategories.mockResolvedValue(undefined);
    mockEntitlement.computeEntitlementMany.mockResolvedValue(new Map());
    mockEntitlement.computeEntitlement.mockResolvedValue(noEntitlement);
    mockEntitlement.deliveredByCycle.mockResolvedValue(new Map());
    mockEntitlement.cyclesToVoid.mockReturnValue([]);
    mockDocuments.issueSettlement.mockResolvedValue({ id: 's-1', number: 'KL-ST-2026-0001' });
    // The settlement statement reads the plan's ledger before anything is voided.
    mockPrisma.payment_installments.findMany.mockResolvedValue([]);
    mockPrisma.bookings.groupBy.mockResolvedValue([]);
    mockPrisma.bookings.count.mockResolvedValue(0);
    // The cancel path runs its writes inside an interactive transaction.
    mockPrisma.$transaction.mockImplementation(async (fn: any) =>
      typeof fn === 'function' ? fn(mockPrisma) : Promise.all(fn),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RecurringRequestsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: AddressesService, useValue: mockAddresses },
        { provide: NotificationsService, useValue: { createNotification: jest.fn() } },
        { provide: PricingEngineService, useValue: mockPricing },
        { provide: PlanEntitlementService, useValue: mockEntitlement },
        { provide: EventEmitter2, useValue: mockEmitter },
        { provide: SseService, useValue: mockSse },
        { provide: DocumentIssuerService, useValue: mockDocuments },
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

    it('accepts the recurrence type in either casing', () => {
      // The column stores the DTO's lowercase values; older rows and callers
      // carry uppercase. Both must classify identically or generation and
      // entitlement drift apart.
      const upper = service.generateDates(
        '2026-09-01', undefined, 'SPECIFIC_DATES' as RecurrenceType, { dates: [1, 15] }, 1,
      );
      const lower = service.generateDates(
        '2026-09-01', undefined, RecurrenceType.SPECIFIC_DATES, { dates: [1, 15] }, 1,
      );
      expect(upper.map((d) => d.toISOString())).toEqual(lower.map((d) => d.toISOString()));
      expect(lower).toHaveLength(2);
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

  describe('create — date validation', () => {
    const dto: any = {
      recurrence_type: 'weekly',
      recurrence_pattern: { days: ['Mon', 'Wed'] },
      start_time: '09:00',
      duration_hours: 4,
      num_children: 1,
      category: 'CC',
      plan_type: 'MONTHLY',
    };

    beforeEach(() => {
      mockAddresses.resolveForUser.mockResolvedValue({ lat: 12.9, lng: 77.6 });
      mockPrisma.users.findUnique.mockResolvedValue({
        id: 'parent-1',
        profiles: { lat: 12.9, lng: 77.6 },
      });
    });

    it('rejects a start date that has already passed', async () => {
      // Past sessions can never be served, and the unassigned-expiry cron would
      // kill the plan the same night — after the matching fee had been raised.
      await expect(
        service.create('parent-1', { ...dto, start_date: '2020-01-01' }),
      ).rejects.toThrow("The plan's start date cannot be in the past.");
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('rejects an end date before the start date', async () => {
      const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);
      const beforeIt = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);
      await expect(
        service.create('parent-1', { ...dto, start_date: future, end_date: beforeIt }),
      ).rejects.toThrow("The plan's end date cannot be before its start date.");
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

    it('reports delivered sessions from the server, not from the booking rows', async () => {
      // This endpoint selects only `start_time` on its bookings, so the client
      // could never count COMPLETED ones itself — its progress bar sat at zero
      // for the life of every plan. The count has to come off the entitlement.
      mockPrisma.recurring_service_requests.findMany.mockResolvedValue([plan()]);
      mockPricing.calculateCost.mockResolvedValue({ totalAmount: 15840, appliedRate: 99 });
      mockEntitlement.computeEntitlementMany.mockResolvedValue(
        new Map([
          ['plan-1', { sessionsEntitled: 11, sessionsDelivered: 3, sessionsRemaining: 8, cycles: [] }],
        ]),
      );
      mockPrisma.bookings.groupBy.mockResolvedValue([
        { recurring_request_id: 'plan-1', _count: { _all: 19 } },
      ]);

      const [result] = await service.findAllByParent('parent-1');

      expect(result.sessions_delivered).toBe(3);
      expect(result.sessions_entitled).toBe(11);
      expect(result.sessions_remaining).toBe(8);
      expect(result.sessions_scheduled).toBe(19);
    });
  });

  describe('cancel', () => {
    const NOW = new Date('2026-09-10T00:00:00.000Z');

    function planRow(over: Record<string, unknown> = {}) {
      return {
        id: 'plan-1',
        parent_id: 'parent-1',
        nanny_id: 'nanny-1',
        status: 'active',
        category: 'ST',
        start_date: new Date('2026-09-01'),
        end_date: null,
        plan_duration_months: 1,
        recurrence_type: 'WEEKLY',
        recurrence_pattern: { days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'] },
        start_time: new Date('2026-09-01T04:30:00.000Z'),
        duration_hours: 8,
        ...over,
      };
    }

    /** `n` future sessions, a day apart, ordered as the query returns them. */
    function futureSessions(n: number) {
      return Array.from({ length: n }, (_, i) => ({
        id: `b${i + 1}`,
        start_time: new Date(NOW.getTime() + (i + 1) * 24 * 60 * 60 * 1000),
        nanny_id: 'nanny-1',
      }));
    }

    function setup(over: {
      plan?: Record<string, unknown>;
      entitled?: number;
      delivered?: number;
      future?: number;
    } = {}) {
      const entitled = over.entitled ?? 0;
      const delivered = over.delivered ?? 0;
      mockPrisma.recurring_service_requests.findUnique.mockResolvedValue(
        planRow(over.plan),
      );
      mockEntitlement.computeEntitlement.mockResolvedValue({
        sessionsEntitled: entitled,
        sessionsDelivered: delivered,
        sessionsRemaining: Math.max(0, entitled - delivered),
        cycles: [],
      });
      mockPrisma.bookings.findMany.mockResolvedValue(futureSessions(over.future ?? 0));
      mockPrisma.bookings.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.payment_installments.updateMany.mockResolvedValue({ count: 0 });
      // The guarded claim succeeds by default; individual tests set count 0 to
      // simulate losing the race.
      mockPrisma.recurring_service_requests.updateMany.mockResolvedValue({ count: 1 });
    }

    it('keeps the sessions the parent already paid for', async () => {
      // The bug this replaces: 20 sessions, 3 delivered, the advance paid — the
      // parent lost all 17 remaining instead of keeping the 7 they had bought.
      setup({ entitled: 10, delivered: 3, future: 17 });

      const result = await service.cancel('plan-1', 'parent-1');

      expect(result.retainedSessions).toBe(7);
      expect(result.cancelledSessions).toBe(10);
      expect(result.status).toBe('winding_down');
    });

    it('cancels the sessions beyond the retained ones, earliest kept first', async () => {
      setup({ entitled: 10, delivered: 3, future: 17 });

      await service.cancel('plan-1', 'parent-1');

      const cancelled = mockPrisma.bookings.updateMany.mock.calls[0][0];
      // b1..b7 are the seven earliest and stay; b8 onwards go.
      expect(cancelled.where.id.in).toEqual([
        'b8', 'b9', 'b10', 'b11', 'b12', 'b13', 'b14', 'b15', 'b16', 'b17',
      ]);
      expect(cancelled.data.status).toBe('CANCELLED');
    });

    it('keeps the caregiver attached while sessions remain to be served', async () => {
      // Releasing the caregiver here would orphan the very sessions being kept.
      setup({ entitled: 10, delivered: 3, future: 17 });

      await service.cancel('plan-1', 'parent-1');

      const update = mockPrisma.recurring_service_requests.updateMany.mock.calls[0][0];
      expect(update.data.nanny_id).toBe('nanny-1');
      expect(update.data.status).toBe('winding_down');
      expect(update.data.sessions_entitled_at_cancellation).toBe(10);
      expect(update.data.cancellation_reason).toBeTruthy();
      expect(update.data.cancelled_at).toBeInstanceOf(Date);
      // The write is a claim, not a bare update: it only lands on a plan that
      // is still cancellable, so a concurrent transition rolls this cancel back.
      expect(update.where.status.notIn).toEqual(
        expect.arrayContaining(['cancelled', 'completed', 'expired', 'winding_down']),
      );
    });

    it('cancels outright and releases the caregiver when nothing was paid for', async () => {
      setup({ entitled: 0, delivered: 0, future: 12 });

      const result = await service.cancel('plan-1', 'parent-1');

      expect(result.retainedSessions).toBe(0);
      expect(result.cancelledSessions).toBe(12);
      expect(result.status).toBe('cancelled');
      const update = mockPrisma.recurring_service_requests.updateMany.mock.calls[0][0];
      expect(update.data.nanny_id).toBeNull();
    });

    it('keeps everything when the whole plan has been paid for', async () => {
      setup({ entitled: 22, delivered: 5, future: 17 });

      const result = await service.cancel('plan-1', 'parent-1');

      expect(result.cancelledSessions).toBe(0);
      expect(result.retainedSessions).toBe(17);
      expect(mockPrisma.bookings.updateMany).not.toHaveBeenCalled();
    });

    it('generates the paid-for sessions that generation had not reached yet', async () => {
      // Generation only ever runs a cycle ahead. Clamping to what happens to be
      // on the calendar would forfeit sessions the parent has already bought.
      setup({ entitled: 12, delivered: 0, future: 8 });
      let created = 0;
      mockPrisma.bookings.create.mockImplementation(async () => ({
        id: `gen${++created}`,
        start_time: new Date(NOW.getTime() + (100 + created) * 24 * 60 * 60 * 1000),
        nanny_id: 'nanny-1',
      }));

      const result = await service.cancel('plan-1', 'parent-1');

      expect(mockPrisma.bookings.create).toHaveBeenCalledTimes(4);
      expect(result.retainedSessions).toBe(12);
      expect(result.cancelledSessions).toBe(0);
    });

    it('voids what is owed for months that are no longer being served', async () => {
      setup({ entitled: 10, delivered: 3, future: 17 });
      mockEntitlement.cyclesToVoid.mockReturnValue([2, 3]);

      await service.cancel('plan-1', 'parent-1');

      const voided = mockPrisma.payment_installments.updateMany.mock.calls[0][0];
      expect(voided.where.cycle_number).toEqual({ in: [2, 3] });
      expect(voided.where.status).toBe('pending');
      expect(voided.data.status).toBe('void');
      // Keyed on the plan, not on the cancelled booking ids: every cycle is
      // billed against one anchor booking, so voiding by booking id finds nothing.
      expect(voided.where.bookings).toEqual({ recurring_request_id: 'plan-1' });
      // The matching fee bought a placement that was made.
      expect(voided.where.kind).toEqual({ not: 'matching_fee' });
    });

    it('leaves installments alone when every cycle is still owed for', async () => {
      setup({ entitled: 22, delivered: 0, future: 22 });
      mockEntitlement.cyclesToVoid.mockReturnValue([]);

      await service.cancel('plan-1', 'parent-1');

      expect(mockPrisma.payment_installments.updateMany).not.toHaveBeenCalled();
    });

    it('announces the wind-down once, not once per cancelled session', async () => {
      // The per-booking cancellation listener emails both parties. Reusing it
      // here would send one email per dropped session.
      setup({ entitled: 10, delivered: 3, future: 17 });

      await service.cancel('plan-1', 'parent-1');

      expect(mockEmitter.emit).toHaveBeenCalledTimes(1);
      const [eventName, payload] = mockEmitter.emit.mock.calls[0];
      expect(eventName).toBe('plan.wound_down');
      expect(payload.cancelledBookingIds).toHaveLength(10);
      expect(payload.retainedCount).toBe(7);
      expect(payload.parentId).toBe('parent-1');
      expect(payload.nannyId).toBe('nanny-1');
      expect(mockSse.emitToUsers).toHaveBeenCalledTimes(1);
    });

    it('is idempotent when the plan is already winding down', async () => {
      // A double-tapped button, or a retry after a dropped response, should see
      // the same answer as the first call rather than an error about a
      // cancellation that did in fact work.
      setup({ plan: { status: 'winding_down' } });
      mockPrisma.bookings.count.mockResolvedValue(7);

      const result = await service.cancel('plan-1', 'parent-1');

      expect(result).toEqual({ success: true, cancelledSessions: 0, retainedSessions: 7 });
      expect(mockPrisma.recurring_service_requests.updateMany).not.toHaveBeenCalled();
      expect(mockEmitter.emit).not.toHaveBeenCalled();
    });

    it.each(['cancelled', 'completed', 'expired'])(
      'refuses to cancel a plan that is already %s',
      async (status) => {
        setup({ plan: { status } });
        await expect(service.cancel('plan-1', 'parent-1')).rejects.toThrow(
          `This plan is already ${status}`,
        );
      },
    );

    it("refuses to cancel someone else's plan", async () => {
      setup();
      await expect(service.cancel('plan-1', 'intruder')).rejects.toThrow(
        'You can only cancel your own recurring plans',
      );
    });

    it('answers idempotently when a concurrent cancel wins the claim', async () => {
      // The status was valid on the pre-read, but the guarded claim found the
      // plan already moved on (a double-tap racing itself, or the cron). The
      // transaction rolls back — shortfall sessions included — and the caller
      // gets the same answer the earlier winner produced.
      setup({ entitled: 10, delivered: 3, future: 17 });
      mockPrisma.recurring_service_requests.updateMany.mockResolvedValue({ count: 0 });
      // The post-loss re-read sees the state the winner left behind.
      mockPrisma.recurring_service_requests.findUnique
        .mockResolvedValueOnce(planRow())
        .mockResolvedValueOnce({ status: 'winding_down' });
      mockPrisma.bookings.count.mockResolvedValue(7);

      const result = await service.cancel('plan-1', 'parent-1');

      expect(result).toEqual({ success: true, cancelledSessions: 0, retainedSessions: 7 });
      expect(mockEmitter.emit).not.toHaveBeenCalled();
      expect(mockDocuments.issueSettlement).not.toHaveBeenCalled();
    });

    it('reports the winning terminal state when the claim is lost to a full cancellation', async () => {
      setup({ entitled: 0, delivered: 0, future: 5 });
      mockPrisma.recurring_service_requests.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.recurring_service_requests.findUnique
        .mockResolvedValueOnce(planRow())
        .mockResolvedValueOnce({ status: 'cancelled' });

      await expect(service.cancel('plan-1', 'parent-1')).rejects.toThrow(
        'This plan is already cancelled',
      );
    });

    it('never touches sessions that were completed or are under way', async () => {
      setup({ entitled: 10, delivered: 3, future: 17 });

      await service.cancel('plan-1', 'parent-1');

      const where = mockPrisma.bookings.findMany.mock.calls[0][0].where;
      expect(where.status.notIn).toEqual(
        expect.arrayContaining(['CANCELLED', 'COMPLETED', 'IN_PROGRESS']),
      );
      expect(where.start_time.gt).toBeInstanceOf(Date);
    });
  });
});
