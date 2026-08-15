import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CreateRecurringRequestDto, RecurrenceType } from "./dto/create-recurring-request.dto";
import { TimeUtils } from "../common/utils/time.utils";
import {
  countSessionsInTerm,
  cycleWindow,
  resolveDaysPerWeek,
} from "../common/utils/pricing.utils";
import { PricingEngineService } from "../common/pricing.service";
import {
  DELIVERED_BOOKING_STATUSES,
  PlanEntitlement,
  PlanEntitlementService,
} from "../common/plan-entitlement.service";
import { BookingStatus } from "../common/constants/booking-status.enum";
import {
  PLAN_STATUS,
  isTerminalPlanStatus,
} from "../common/constants/plan-status.enum";
import { AddressesService } from "../addresses/addresses.service";
import { NotificationsService } from "../notifications/notifications.service";
import { EventEmitter2 } from "@nestjs/event-emitter";
import {
  BOOKING_EVENTS,
  PlanWoundDownEvent,
} from "../bookings/events/booking.events";
import { SseService } from "../sse/sse.service";
import { SSE_EVENTS } from "../events/sse-event.types";
import {
  INSTALMENT_PAID,
  INSTALMENT_PENDING,
  INSTALMENT_VOID,
  MATCHING_FEE_KIND,
} from "../constants";
import { DocumentIssuerService } from "../invoices/document-issuer.service";

/** One day, used only to make an inclusive end date exclusive. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** Money is Decimal(12,2); float sums leave a tail that formats a rupee out. */
function round2(value: number): number {
  return Math.round((Number.isFinite(value) ? value : 0) * 100) / 100;
}

/** Sessions still ahead of the parent: on the calendar, neither spent nor dropped. */
const SCHEDULED_BOOKING_STATUSES = [
  BookingStatus.REQUESTED,
  BookingStatus.CONFIRMED,
];

@Injectable()
export class RecurringRequestsService {
  private readonly logger = new Logger(RecurringRequestsService.name);

  constructor(
    private prisma: PrismaService,
    private addressesService: AddressesService,
    private notificationsService: NotificationsService,
    private pricingService: PricingEngineService,
    private entitlementService: PlanEntitlementService,
    private eventEmitter: EventEmitter2,
    private sseService: SseService,
    private documents: DocumentIssuerService,
  ) {}

  /**
   * The session counters every plan view shows, in one shape so the list and the
   * detail screen can never disagree.
   *
   * `sessions_entitled` comes off the frozen snapshot once a plan has been
   * cancelled: recomputing it live would let a refund issued afterwards shrink a
   * number the parent was already promised.
   */
  private sessionCounters(
    entitlement: PlanEntitlement,
    scheduled: number,
    entitledAtCancellation: number | null,
  ) {
    const sessionsEntitled = entitledAtCancellation ?? entitlement.sessionsEntitled;
    return {
      sessions_delivered: entitlement.sessionsDelivered,
      sessions_scheduled: scheduled,
      sessions_entitled: sessionsEntitled,
      sessions_remaining: Math.max(0, sessionsEntitled - entitlement.sessionsDelivered),
    };
  }

  /**
   * Every date a recurrence pattern lands on within a window.
   *
   * The window is a *natural* month by default, not a flat 28 or 30 days: a plan
   * starting 1 Aug generates through 31 Aug, one starting 4 Sep through 3 Oct. So
   * a 6-day-a-week plan yields 27 sessions in August and 24 in February — the
   * calendar decides, and the flat monthly price does not change with it.
   *
   * The derived end is exclusive (`[start, start+1 month)`), which is what keeps
   * the boundary day out. It used to be inclusive *and* a full month away, so an
   * August plan generated 1 Aug – 1 Sep and quietly billed a 32-day month.
   *
   * `endDateStr` — the parent's own plan end date — is inclusive instead: they
   * chose that last day and expect care on it.
   */
  public generateDates(
    startDateStr: string | Date,
    endDateStr: string | Date | undefined,
    recurrenceType: RecurrenceType,
    pattern: any,
    maxMonths: number = 1 // Generate bookings for one natural month by default
  ): Date[] {
    const dates: Date[] = [];
    const start = new Date(startDateStr);

    // An explicit end date is a day the parent still gets care on; a derived
    // window stops the instant the next cycle begins.
    const explicitEnd = endDateStr ? new Date(endDateStr) : null;
    let end = explicitEnd
      ? new Date(explicitEnd.getTime() + DAY_MS)
      : cycleWindow(start, maxMonths).end;

    // Limit generation to max 6 months to prevent massive DB inserts at once
    const maxEnd = TimeUtils.addMonths(start, 6);
    if (end > maxEnd) {
      end = maxEnd;
    }

    // Normalize hours to prevent timezone shift issues during day iteration
    const current = new Date(start);
    current.setHours(12, 0, 0, 0);
    const limit = new Date(end);
    limit.setHours(12, 0, 0, 0);

    if (recurrenceType === RecurrenceType.WEEKLY) {
      const targetDays: string[] = pattern.days || [];
      const dayMap: Record<string, number> = {
        "Sun": 0, "Mon": 1, "Tue": 2, "Wed": 3, "Thu": 4, "Fri": 5, "Sat": 6
      };
      const targetInts = targetDays.map(d => dayMap[d]).filter(d => d !== undefined);

      while (current < limit) {
        if (targetInts.includes(current.getDay())) {
          dates.push(new Date(current));
        }
        current.setDate(current.getDate() + 1);
      }
    } else if (recurrenceType === RecurrenceType.SPECIFIC_DATES) {
      const targetDates: number[] = pattern.dates || [];
      while (current < limit) {
        if (targetDates.includes(current.getDate())) {
          dates.push(new Date(current));
        }
        current.setDate(current.getDate() + 1);
      }
    }

    return dates;
  }

  async create(parentId: string, dto: CreateRecurringRequestDto) {
    this.logger.log(`Parent ${parentId} creating recurring request`);

    // 1. Get the sessions' location — the address the parent picked, else their
    // default saved address, falling back to the legacy profiles.lat/lng.
    const selectedAddress = await this.addressesService.resolveForUser(
      parentId,
      dto.address_id,
    );
    const parent = await this.prisma.users.findUnique({
      where: { id: parentId },
      include: { profiles: true },
    });

    if (!parent || !parent.profiles) {
      throw new NotFoundException("Parent profile not found");
    }

    const lat = selectedAddress?.lat ?? parent.profiles.lat;
    const lng = selectedAddress?.lng ?? parent.profiles.lng;
    if (!lat || !lng) {
      throw new BadRequestException(
        "Add a saved address before requesting a caregiver.",
      );
    }

    const generatedDates = this.generateDates(
      dto.start_date,
      dto.end_date,
      dto.recurrence_type,
      dto.recurrence_pattern,
      1 // Only generate the first month upfront to keep transaction fast
    );

    if (generatedDates.length === 0) {
      throw new BadRequestException("The recurrence pattern yielded no valid dates.");
    }

    // The weekday list the parent tapped is what the plan costs: rate × hours per
    // day × these days × 4 weeks × plan months. Stored on both the plan and each
    // booking so pricing never has to re-parse the pattern JSON.
    const daysPerWeek = resolveDaysPerWeek({
      planType: dto.plan_type || "MONTHLY",
      daysPerWeek: dto.days_per_week,
      recurrencePattern: dto.recurrence_pattern,
      sessionsPerMonth: dto.sessions_per_month,
    });

    // Convert start time string to DateTime for schema
    const startTimeObj = TimeUtils.combineDateAndTime(dto.start_date, dto.start_time);

    // 2. Transaction to create the master request and all daily bookings
    const result = await this.prisma.$transaction(async (tx) => {
      const recurringReq = await tx.recurring_service_requests.create({
        data: {
          parent_id: parentId,
          // A plan is only "active" once a nanny is assigned to its bookings
          // (see AdminService.manualAssign). Until then it is pending — the column
          // default of "active" would otherwise show every brand-new plan as live.
          status: "pending",
          recurrence_type: dto.recurrence_type,
          recurrence_pattern: dto.recurrence_pattern,
          start_date: new Date(dto.start_date),
          end_date: dto.end_date ? new Date(dto.end_date) : null,
          start_time: startTimeObj,
          duration_hours: dto.duration_hours,
          num_children: dto.num_children,
          children_ages: dto.children_ages || [],
          special_requirements: dto.special_requirements,
          required_skills: dto.required_skills || [],
          category: dto.category,
          plan_duration_months: dto.plan_duration_months,
          plan_type: dto.plan_type,
          sessions_per_month: dto.sessions_per_month,
          days_per_week: daysPerWeek,
          max_hourly_rate: dto.max_hourly_rate,
          location_lat: lat,
          location_lng: lng,
        },
      });

      // Prepare bookings
      const bookingsData = generatedDates.map(date => {
        const startTimestamp = TimeUtils.combineDateAndTime(
          date.toISOString().split("T")[0],
          dto.start_time
        );
        const endTimestamp = TimeUtils.getEndTime(startTimestamp, dto.duration_hours);

        return {
          parent_id: parentId,
          recurring_request_id: recurringReq.id,
          status: "requested",
          start_time: startTimestamp,
          end_time: endTimestamp,
          tags: ["recurring", `category:${dto.category}`],
          hours_per_day: dto.duration_hours,
          days_per_week: daysPerWeek,
          plan_duration_months: dto.plan_duration_months || 1,
        };
      });

      // Need to create bookings individually if we want to link children
      // Executing them concurrently with Promise.all to speed up the transaction
      const createdBookings = await Promise.all(
        bookingsData.map(async (bookingData) => {
          const booking = await tx.bookings.create({
            data: bookingData
          });
          
          if (dto.child_ids && dto.child_ids.length > 0) {
            await tx.booking_children.createMany({
              data: dto.child_ids.map(childId => ({
                booking_id: booking.id,
                child_id: childId
              }))
            });
          }
          return booking;
        })
      );

      // Billing for the whole plan anchors to its earliest session (see
      // PaymentsService.planBillingAnchor); the fee is raised against the same row.
      const anchorBooking = createdBookings.reduce(
        (earliest, b) => (b.start_time < earliest.start_time ? b : earliest),
        createdBookings[0],
      );

      return {
        recurringReq,
        generatedBookingsCount: createdBookings.length,
        anchorBookingId: anchorBooking?.id ?? null,
      };
    }, {
      timeout: 20000, // Increase timeout to 20s for bulk inserts
      maxWait: 5000,
    });

    // The matching fee is charged now, at confirmation — the parent has just
    // agreed to the plan, and it is deducted from the first cycle rather than
    // added on top. Raised outside the transaction so a pricing problem cannot
    // roll back a plan the parent has already committed to; without a fee row the
    // first cycle simply bills in full.
    const matchingFee = result.anchorBookingId
      ? await this.pricingService.raiseMatchingFee(result.anchorBookingId)
      : null;

    return {
      ...result,
      /** Present only when a fee applies — the client charges it immediately. */
      matching_fee: matchingFee
        ? {
            bookingId: result.anchorBookingId,
            installmentId: matchingFee.installmentId,
            amount: matchingFee.amount,
          }
        : null,
    };
  }

  async findAllByParent(parentId: string) {
    const requests = await this.prisma.recurring_service_requests.findMany({
      where: { parent_id: parentId },
      include: {
        _count: {
          select: { bookings: { where: { status: { not: "CANCELLED" } } } }
        },
        // Only needed to find the next session — staffing now comes off the plan.
        bookings: {
          where: { status: { not: "CANCELLED" } },
          orderBy: { start_time: 'asc' },
          select: { start_time: true },
        },
        nanny: {
          select: {
            id: true,
            profiles: {
              select: { first_name: true, last_name: true, profile_image_url: true },
            },
          },
        },
      },
      orderBy: { created_at: "desc" },
    });

    const now = new Date();

    await this.pricingService.prefetchServiceCategories(
      requests.map((r) => r.category || "CC"),
    );

    // Entitlement and the scheduled count are batched across every plan rather
    // than resolved inside the map below: this list is the parent's home screen,
    // and a per-plan round trip for each would be two more queries per row.
    const planIds = requests.map((r) => r.id);
    const [entitlements, scheduledCounts] = await Promise.all([
      this.entitlementService.computeEntitlementMany(planIds),
      this.prisma.bookings.groupBy({
        by: ["recurring_request_id"],
        where: {
          recurring_request_id: { in: planIds },
          status: { in: SCHEDULED_BOOKING_STATUSES },
        },
        _count: { _all: true },
      }),
    ]);
    const scheduledByPlan = new Map(
      scheduledCounts.map((row) => [row.recurring_request_id as string, row._count._all]),
    );
    const emptyEntitlement: PlanEntitlement = {
      sessionsEntitled: 0,
      sessionsDelivered: 0,
      sessionsRemaining: 0,
      cycles: [],
    };

    return Promise.all(
      requests.map(async (req) => {
        const { bookings, _count, nanny, ...rest } = req;
        const upcoming = bookings.find((b) => b.start_time >= now) ?? null;

        const planType = req.plan_type || "MONTHLY";
        const planMonths = Number(req.plan_duration_months || 1);
        const daysPerWeek = resolveDaysPerWeek({
          planType,
          daysPerWeek: req.days_per_week,
          recurrencePattern: req.recurrence_pattern,
          sessionsPerMonth: req.sessions_per_month,
        });

        // Priced through the engine, never re-derived here. The old sum was
        // `rate × hours × <rows generated so far>`, which is a different figure
        // entirely: generation walks a calendar month inclusive of both ends and
        // yields 22–24 dates, while the plan is sold as 4 weeks. That is why a
        // plan quoted at ₹15,840 displayed as ₹19,008.
        const { totalAmount, appliedRate } = await this.pricingService.calculateCost(
          req.category || "CC",
          Number(req.duration_hours || 0),
          planMonths,
          planType,
          daysPerWeek,
        );

        return {
          ...rest,
          status: this.effectiveStatus(rest.status, !!rest.nanny_id),
          start_time_formatted: TimeUtils.formatShortTime(req.start_time),
          ...this.sessionCounters(
            entitlements.get(req.id) ?? emptyEntitlement,
            scheduledByPlan.get(req.id) ?? 0,
            req.sessions_entitled_at_cancellation,
          ),
          /** Sessions actually on the calendar — only the first month is generated upfront. */
          total_bookings: _count.bookings,
          /**
           * Sessions across the plan's whole term, counted off the real calendar
           * month by month. The progress bar measures against this: counting
           * generated rows would show a six-month plan as "0 of 24" when it runs
           * to roughly 130 sessions.
           *
           * Not `daysPerWeek × 4 × months` — that is the *billing* factor, and
           * borrowing it here is what pinned every six-day plan at "24" no matter
           * whether the month had 28 days or 31, disagreeing with the sessions
           * generation had actually written.
           */
          total_sessions: countSessionsInTerm(
            req.start_date,
            planMonths,
            req.recurrence_type,
            req.recurrence_pattern,
          ),
          next_upcoming_date: upcoming ? upcoming.start_time : null,
          nanny: nanny ?? null,
          hourly_rate: appliedRate || null,
          estimated_total: totalAmount || null,
        };
      }),
    );
  }

  /**
   * "active" means a nanny is actually serving the plan. Rows created before the
   * pending-by-default fix were stored as "active" from birth (the column default),
   * so a stored "active" with no nanny on any booking is really still pending.
   * Terminal states (cancelled/completed/expired/error) are reported as-is.
   */
  private effectiveStatus(stored: string, hasNanny: boolean): string {
    if (stored !== "active") return stored;
    return hasNanny ? "active" : "pending";
  }

  async findOne(id: string, userId: string, role: string) {
    const req = await this.prisma.recurring_service_requests.findUnique({
      where: { id },
      include: {
        _count: {
          select: { bookings: { where: { status: { not: "CANCELLED" } } } }
        },
        nanny: {
          select: {
            id: true,
            profiles: { select: { first_name: true, last_name: true, profile_image_url: true } },
          },
        },
      }
    });

    if (!req) throw new NotFoundException("Recurring request not found");
    // Scope the read to the owning parent (mirrors cancel) or an admin. Return
    // NotFound for anyone else so existence of the plan isn't leaked.
    if (req.parent_id !== userId && role !== "admin") {
      throw new NotFoundException("Recurring request not found");
    }

    const { _count, ...rest } = req;

    const [entitlement, scheduled] = await Promise.all([
      this.entitlementService.computeEntitlement(id),
      this.prisma.bookings.count({
        where: { recurring_request_id: id, status: { in: SCHEDULED_BOOKING_STATUSES } },
      }),
    ]);

    return {
      ...rest,
      status: this.effectiveStatus(req.status, !!req.nanny_id),
      start_time_formatted: TimeUtils.formatShortTime(req.start_time),
      /**
       * Sessions served, still to come, paid for, and still owed. `total_bookings`
       * and `total_sessions` below answer a different question — what is on the
       * calendar and what the term contains — and neither of them moves when a
       * session is completed, which is why progress never appeared to change.
       */
      ...this.sessionCounters(
        entitlement,
        scheduled,
        req.sessions_entitled_at_cancellation,
      ),
      /** Sessions on the calendar today — only the current cycle is generated. */
      total_bookings: _count.bookings,
      /**
       * Sessions over the whole term, off the real calendar. The detail screen
       * showed `total_bookings` but this endpoint never sent it, so the header
       * silently counted whatever page of sessions happened to be loaded.
       */
      total_sessions: countSessionsInTerm(
        req.start_date,
        Number(req.plan_duration_months || 1),
        req.recurrence_type,
        req.recurrence_pattern,
      ),
    };
  }

  /**
   * Parent-initiated cancellation of a whole plan.
   *
   * A plan is bought a month at a time, half up front and half later, but was
   * cancelled as though none of that had happened: every future session went,
   * regardless of how much of it the parent had already paid for. A parent who
   * had settled the advance on a twenty-session month and used three of them
   * lost the other seventeen outright.
   *
   * So the plan ends, but the sessions already paid for do not. The earliest
   * `entitled − delivered` future sessions stay on the calendar with their
   * caregiver attached; everything past that is cancelled, and the money still
   * owed for those dropped months is voided rather than chased. The plan sits in
   * `winding_down` until the last retained session is delivered.
   *
   * Sessions already completed or under way are never touched — they were
   * delivered and still have to settle.
   */
  async cancel(id: string, parentId: string, reason?: string) {
    const req = await this.prisma.recurring_service_requests.findUnique({
      where: { id },
      select: {
        id: true,
        parent_id: true,
        nanny_id: true,
        status: true,
        category: true,
        start_date: true,
        end_date: true,
        plan_duration_months: true,
        recurrence_type: true,
        recurrence_pattern: true,
        start_time: true,
        duration_hours: true,
      },
    });
    if (!req) throw new NotFoundException("Recurring request not found");
    if (req.parent_id !== parentId) {
      throw new ForbiddenException("You can only cancel your own recurring plans");
    }
    if (isTerminalPlanStatus(req.status)) {
      throw new BadRequestException(`This plan is already ${req.status}`);
    }
    // Already wound down. A parent double-tapping the button, or retrying after a
    // dropped response, should see the same answer as the first call rather than
    // an error about a cancellation that did work.
    if (req.status === PLAN_STATUS.WINDING_DOWN) {
      const retained = await this.prisma.bookings.count({
        where: {
          recurring_request_id: id,
          status: { in: SCHEDULED_BOOKING_STATUSES },
        },
      });
      return { success: true, cancelledSessions: 0, retainedSessions: retained };
    }

    const now = TimeUtils.nowIST();
    const cancellationReason = reason?.trim() || "Recurring plan cancelled by parent";

    const [entitlement, deliveredByCycle] = await Promise.all([
      this.entitlementService.computeEntitlement(id),
      this.entitlementService.deliveredByCycle(id, req.start_date),
    ]);
    let retainCount = entitlement.sessionsRemaining;

    const futureBookings = await this.prisma.bookings.findMany({
      where: {
        recurring_request_id: id,
        start_time: { gt: now },
        status: {
          notIn: [
            BookingStatus.CANCELLED,
            BookingStatus.COMPLETED,
            BookingStatus.IN_PROGRESS,
          ],
        },
      },
      orderBy: { start_time: "asc" },
      select: { id: true, start_time: true, nanny_id: true },
    });

    // The parent has bought more sessions than are on the calendar. Generation
    // only ever runs a cycle ahead, so this is rare — but clamping to what
    // happens to be generated would quietly forfeit sessions they have paid for,
    // which is the whole bug. Write the missing dates instead.
    let generated: { id: string; start_time: Date; nanny_id: string | null }[] = [];
    if (retainCount > futureBookings.length) {
      generated = await this.generateShortfallSessions(
        req,
        futureBookings,
        retainCount - futureBookings.length,
        now,
      );
    }

    const candidates = [...futureBookings, ...generated].sort(
      (a, b) => a.start_time.getTime() - b.start_time.getTime(),
    );
    // Generation can still fall short (a plan at the end of its term simply has
    // no more dates to give), so the retained set is what actually exists.
    retainCount = Math.min(retainCount, candidates.length);

    const retained = candidates.slice(0, retainCount);
    const toCancel = candidates.slice(retainCount);
    const toCancelIds = toCancel.map((b) => b.id);

    // Which cycles stop being owed for. See `cyclesToVoid` for why this is no
    // longer "every cycle after the last retained session": that rule kept
    // chasing the balance of a month the parent had just cancelled the sessions
    // of, because the month was technically still being served.
    const droppedCycles = this.entitlementService.cyclesToVoid({
      planMonths: Number(req.plan_duration_months || 1),
      entitlement,
      deliveredByCycle,
    });

    const nextStatus =
      retainCount > 0 ? PLAN_STATUS.WINDING_DOWN : PLAN_STATUS.CANCELLED;

    // Read before the transaction voids anything, so the settlement statement can
    // say what was billed and paid as at cancellation rather than after it.
    const ledger = await this.planLedger(id, droppedCycles);

    await this.prisma.$transaction(async (tx) => {
      await tx.recurring_service_requests.update({
        where: { id },
        data: {
          status: nextStatus,
          // The caregiver stays attached while there are sessions left to serve;
          // releasing them here would orphan the very sessions being retained.
          // The wind-down cron clears it once the last one lands.
          nanny_id: retainCount > 0 ? req.nanny_id : null,
          cancellation_reason: cancellationReason,
          cancelled_at: now,
          sessions_entitled_at_cancellation: entitlement.sessionsEntitled,
          updated_at: now,
        },
      });

      if (toCancelIds.length > 0) {
        await tx.bookings.updateMany({
          where: { id: { in: toCancelIds } },
          data: {
            status: BookingStatus.CANCELLED,
            cancellation_reason: cancellationReason,
          },
        });
      }

      // Money for care that will never be delivered stops being owed. This is
      // keyed on the *cycle*, not on the cancelled bookings: every cycle of a
      // plan is billed against one anchor booking, so voiding by booking id
      // (as the per-booking cancellation listener does) would find nothing.
      //
      // The matching fee is excluded — it bought a placement that was made, and
      // is not a share of any month's care.
      if (droppedCycles.length > 0) {
        await tx.payment_installments.updateMany({
          where: {
            bookings: { recurring_request_id: id },
            cycle_number: { in: droppedCycles },
            kind: { not: MATCHING_FEE_KIND },
            status: INSTALMENT_PENDING,
          },
          data: { status: INSTALMENT_VOID, updated_at: now },
        });
      }
    });

    // ── Freeze the settlement statement ────────────────────────────────────────
    // Outside the transaction on purpose: it renders a whole document, and the
    // cancellation itself must not be held open behind paperwork or rolled back
    // by it. Unique on `plan_id`, so a retry issues the same statement rather
    // than a second one — and a plan cancelled with no statement is a support
    // question, not a broken cancellation.
    const settlement = await this.documents
      .issueSettlement({
        planId: id,
        parentId,
        cancelledAt: now,
        reason: cancellationReason,
        entitlement,
        retainedBookingIds: retained.map((b) => b.id),
        amounts: {
          billed: ledger.billed,
          paid: ledger.paid,
          voided: ledger.voidedNow,
          stillOwed: ledger.stillOwed,
          matchingFeeRetained: ledger.matchingFee,
        },
      })
      .catch((err) => {
        this.logger.error(
          `Cancelled plan ${id} but could not issue its settlement statement.`,
          err as Error,
        );
        return null;
      });

    // One event for the whole plan. Emitting a per-booking cancellation instead
    // would email both parties once per dropped session.
    this.eventEmitter.emit(
      BOOKING_EVENTS.PLAN_WOUND_DOWN,
      new PlanWoundDownEvent(
        id,
        parentId,
        req.nanny_id,
        toCancelIds,
        retainCount,
        cancellationReason,
      ),
    );

    this.sseService.emitToUsers(
      [parentId, req.nanny_id].filter(Boolean) as string[],
      {
        type: SSE_EVENTS.REQUEST_CANCELLED,
        data: {
          planId: id,
          status: nextStatus,
          cancelledSessions: toCancelIds.length,
          retainedSessions: retainCount,
        },
        timestamp: new Date().toISOString(),
      },
    );

    this.logger.log(
      `Recurring request ${id} cancelled by parent ${parentId}; ${toCancelIds.length} sessions cancelled, ${retainCount} paid-for sessions retained (entitled ${entitlement.sessionsEntitled}, delivered ${entitlement.sessionsDelivered}).`,
    );
    return {
      success: true,
      cancelledSessions: toCancelIds.length,
      retainedSessions: retainCount,
      status: nextStatus,
      settlementNumber: settlement?.number ?? null,
    };
  }

  /**
   * What a parent would actually get if they cancelled right now, without
   * cancelling.
   *
   * Runs the same arithmetic as `cancel` and writes nothing. A cancellation that
   * silently keeps some sessions and drops others is a good outcome the parent
   * cannot see coming, and "you will keep 7 sessions, on these dates" is a very
   * different decision from "cancel plan?".
   */
  async cancellationPreview(id: string, parentId: string) {
    const req = await this.prisma.recurring_service_requests.findUnique({
      where: { id },
      select: {
        id: true,
        parent_id: true,
        status: true,
        start_date: true,
        plan_duration_months: true,
      },
    });
    if (!req) throw new NotFoundException("Recurring request not found");
    if (req.parent_id !== parentId) {
      throw new ForbiddenException("You can only preview your own recurring plans");
    }

    const now = TimeUtils.nowIST();
    const [entitlement, deliveredByCycle] = await Promise.all([
      this.entitlementService.computeEntitlement(id),
      this.entitlementService.deliveredByCycle(id, req.start_date),
    ]);

    const futureBookings = await this.prisma.bookings.findMany({
      where: {
        recurring_request_id: id,
        start_time: { gt: now },
        status: {
          notIn: [
            BookingStatus.CANCELLED,
            BookingStatus.COMPLETED,
            BookingStatus.IN_PROGRESS,
          ],
        },
      },
      orderBy: { start_time: "asc" },
      select: { id: true, start_time: true },
    });

    // Unlike `cancel`, this does not generate the shortfall — writing sessions is
    // not something a preview may do. The count is still the honest promise;
    // only the *dates* of any sessions past what is generated are unknown here.
    const retainCount = entitlement.sessionsRemaining;
    const retained = futureBookings.slice(0, retainCount);
    const cancelled = futureBookings.slice(retainCount);

    const droppedCycles = this.entitlementService.cyclesToVoid({
      planMonths: Number(req.plan_duration_months || 1),
      entitlement,
      deliveredByCycle,
    });
    const ledger = await this.planLedger(id, droppedCycles);

    return {
      planId: id,
      alreadyCancelled: isTerminalPlanStatus(req.status) ||
        req.status === PLAN_STATUS.WINDING_DOWN,
      sessionsEntitled: entitlement.sessionsEntitled,
      sessionsDelivered: entitlement.sessionsDelivered,
      sessionsRetained: retainCount,
      /** Dates already on the calendar. May be fewer than `sessionsRetained`. */
      retainedSessions: retained.map((b) => ({
        id: b.id,
        startTime: b.start_time,
      })),
      sessionsCancelled: cancelled.length,
      /** Money that stops being payable. Nothing captured is ever refunded here. */
      amountReleased: ledger.voidedNow,
      amountStillPayable: ledger.stillOwed,
      amountPaid: ledger.paid,
      matchingFeeRetained: ledger.matchingFee,
      refundAmount: 0,
      cycles: entitlement.cycles,
    };
  }

  /**
   * The money side of a cancellation: what has been billed and captured on the
   * plan, what the void rule is about to release, and what survives it.
   *
   * Kept in one place so the preview and the statement cannot quote different
   * numbers for the same cancellation.
   */
  private async planLedger(planId: string, cyclesToVoid: number[]) {
    const installments = await this.prisma.payment_installments.findMany({
      where: {
        bookings: { recurring_request_id: planId },
        status: { in: [INSTALMENT_PENDING, INSTALMENT_PAID] },
      },
      select: {
        amount: true,
        status: true,
        cycle_number: true,
        kind: true,
      },
    });

    const dropped = new Set(cyclesToVoid);
    let billed = 0;
    let paid = 0;
    let voidedNow = 0;
    let stillOwed = 0;
    let matchingFee = 0;

    for (const instalment of installments) {
      const amount = Number(instalment.amount);
      billed += amount;

      if (instalment.status === INSTALMENT_PAID) {
        paid += amount;
        // The fee bought a placement that was made, so it is retained rather
        // than released — called out separately because it is the one amount a
        // cancelling parent most often asks about.
        if (instalment.kind === MATCHING_FEE_KIND) matchingFee += amount;
        continue;
      }

      // Pending. The matching fee is never released by a cancellation.
      const releasable =
        instalment.kind !== MATCHING_FEE_KIND && dropped.has(instalment.cycle_number);
      if (releasable) voidedNow += amount;
      else stillOwed += amount;
    }

    return {
      billed: round2(billed),
      paid: round2(paid),
      voidedNow: round2(voidedNow),
      stillOwed: round2(stillOwed),
      matchingFee: round2(matchingFee),
    };
  }

  /**
   * Write the sessions a parent has paid for but that generation has not reached
   * yet, so cancellation can hand them over rather than forfeit them.
   *
   * Dates continue on from the last one already on the calendar and follow the
   * plan's own recurrence, capped by the parent's end date. Staffed with the
   * plan's caregiver and confirmed outright — this care is already bought.
   */
  private async generateShortfallSessions(
    req: {
      id: string;
      parent_id: string;
      nanny_id: string | null;
      category: string | null;
      start_date: Date;
      end_date: Date | null;
      recurrence_type: string;
      recurrence_pattern: unknown;
      start_time: Date;
      duration_hours: unknown;
    },
    existing: { start_time: Date }[],
    shortfall: number,
    now: Date,
  ): Promise<{ id: string; start_time: Date; nanny_id: string | null }[]> {
    const lastKnown =
      existing.length > 0 ? existing[existing.length - 1].start_time : now;
    const from = new Date(lastKnown.getTime() + DAY_MS);

    // Enough runway to find `shortfall` more dates whatever the pattern's
    // density, without walking the calendar indefinitely.
    const horizon = TimeUtils.addMonths(from, Math.max(1, Math.ceil(shortfall / 4) + 1));
    const until =
      req.end_date && new Date(req.end_date) < horizon ? new Date(req.end_date) : horizon;

    let dates: Date[];
    try {
      dates = this.generateDates(
        from,
        until,
        req.recurrence_type as RecurrenceType,
        req.recurrence_pattern,
        1,
      ).slice(0, shortfall);
    } catch (err) {
      this.logger.error(
        `Could not generate shortfall sessions for plan ${req.id}; retaining only what is already scheduled.`,
        err as Error,
      );
      return [];
    }

    if (dates.length === 0) return [];

    const startTimeStr =
      req.start_time instanceof Date
        ? req.start_time.toLocaleTimeString("en-GB", {
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          })
        : String(req.start_time).substring(0, 5);

    const created: { id: string; start_time: Date; nanny_id: string | null }[] = [];
    for (const date of dates) {
      const dateStr = date.toISOString().split("T")[0];
      const startTimestamp = TimeUtils.combineDateAndTime(dateStr, startTimeStr);
      const booking = await this.prisma.bookings.create({
        data: {
          parent_id: req.parent_id,
          recurring_request_id: req.id,
          nanny_id: req.nanny_id,
          status: BookingStatus.CONFIRMED,
          start_time: startTimestamp,
          end_time: TimeUtils.getEndTime(startTimestamp, Number(req.duration_hours)),
          tags: ["recurring", `category:${req.category}`],
        },
        select: { id: true, start_time: true, nanny_id: true },
      });
      created.push(booking);
    }

    this.logger.log(
      `Generated ${created.length} paid-for session(s) for plan ${req.id} that cancellation would otherwise have forfeited.`,
    );
    return created;
  }

  async findBookingsForRequest(
    id: string,
    page: number = 1,
    limit: number = 10,
    userId?: string,
    role?: string,
  ) {
    // Scope to the owning parent (mirrors cancel) or an admin before listing
    // any bookings under the plan.
    const parent = await this.prisma.recurring_service_requests.findUnique({
      where: { id },
      select: { parent_id: true },
    });
    if (!parent) throw new NotFoundException("Recurring request not found");
    if (parent.parent_id !== userId && role !== "admin") {
      throw new NotFoundException("Recurring request not found");
    }

    const skip = (page - 1) * limit;

    const [bookings, total] = await this.prisma.$transaction([
      this.prisma.bookings.findMany({
        where: { recurring_request_id: id },
        include: {
          users_bookings_nanny_idTousers: {
            select: {
              id: true,
              profiles: { select: { first_name: true, last_name: true, profile_image_url: true } }
            }
          },
          assignments: {
            include: {
              users: { select: { id: true, profiles: { select: { first_name: true, last_name: true, profile_image_url: true } } } }
            }
          }
        },
        orderBy: { start_time: 'asc' },
        skip,
        take: limit,
      }),
      this.prisma.bookings.count({ where: { recurring_request_id: id } })
    ]);

    return {
      items: bookings,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit)
      }
    };
  }
}
