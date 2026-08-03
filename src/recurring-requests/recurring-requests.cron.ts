import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { RecurringRequestsService } from './recurring-requests.service';
import { NotificationsService } from '../notifications/notifications.service';
import { TimeUtils } from '../common/utils/time.utils';
import { RecurrenceType } from './dto/create-recurring-request.dto';
import { BookingStatus } from '../common/constants/booking-status.enum';
import { cycleWindow } from '../common/utils/pricing.utils';
import { PaymentsService } from '../payments/payments.service';

// If generation has been stuck (latest booking further in the past than this)
// for a plan, stop retrying it automatically and flag it for the parent.
const STUCK_GENERATION_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

// A plan is not allowed to roll forever while we search for the cycle a date
// falls in; well past any sold term, so only a corrupt anchor date hits it.
const MAX_CYCLE_LOOKAHEAD = 120;

// How far ahead a cycle is opened for payment. A parent should be able to settle
// next month's advance before that month's care begins, not on the morning of.
const CYCLE_BILLING_LEAD_DAYS = 7;

@Injectable()
export class RecurringRequestsCron {
  private readonly logger = new Logger(RecurringRequestsCron.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly recurringRequestsService: RecurringRequestsService,
    private readonly notificationsService: NotificationsService,
    private readonly paymentsService: PaymentsService,
  ) {}

  /**
   * Open the next billing cycle of every live plan shortly before that month
   * actually starts, so its 50% advance is payable *before* the care it pays for
   * begins rather than after the fact.
   *
   * Cycle 1 is opened at assignment (`openFirstCycleForPlan`) — this is what keeps
   * months 2..N coming. Opening is idempotent, so a daily re-run over the same
   * lead window costs a lookup and writes nothing.
   */
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async handleCycleBilling() {
    const plans = await this.prisma.recurring_service_requests.findMany({
      where: {
        status: 'active',
        // Nothing is owed for a plan nobody is serving yet.
        nanny_id: { not: null },
      },
      select: { id: true, start_date: true, plan_duration_months: true },
    });

    const horizon = new Date(Date.now() + CYCLE_BILLING_LEAD_DAYS * DAY_MS);

    for (const plan of plans) {
      try {
        const termMonths = plan.plan_duration_months
          ? Number(plan.plan_duration_months)
          : MAX_CYCLE_LOOKAHEAD;

        // Every cycle whose month has started or is about to. Past cycles are
        // included so a plan that was down while a boundary passed still gets
        // billed rather than skipping a month silently.
        for (let n = 1; n <= termMonths; n++) {
          const { start } = cycleWindow(plan.start_date, n);
          if (start > horizon) break;
          await this.paymentsService.openCycleForPlan(plan.id, n);
        }
      } catch (err) {
        this.logger.error(`Cycle billing failed for plan ${plan.id}`, err as Error);
      }
    }
  }

  /**
   * A plan nobody was ever assigned to is dead once its first session date has
   * passed — there is no longer a schedule to serve. Without this it sits in the
   * parent's list forever, generating sessions no nanny will ever take.
   */
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async handleUnassignedExpiry() {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const stale = await this.prisma.recurring_service_requests.findMany({
      where: {
        status: { in: ['active', 'pending'] },
        start_date: { lt: startOfToday },
        // Nobody is serving this plan.
        nanny_id: null,
      },
      select: { id: true, parent_id: true },
    });

    for (const req of stale) {
      try {
        await this.prisma.$transaction([
          this.prisma.recurring_service_requests.update({
            where: { id: req.id },
            data: { status: 'expired' },
          }),
          // Leave no orphaned sessions behind that can never be served.
          this.prisma.bookings.updateMany({
            where: { recurring_request_id: req.id, status: { not: 'CANCELLED' } },
            data: { status: 'CANCELLED' },
          }),
        ]);

        await this.notificationsService.createNotification(
          req.parent_id,
          'Recurring plan expired',
          "We couldn't match a caregiver to your recurring plan before its start date, so it has been closed. You can create a new plan at any time.",
          'warning',
          'recurring_request',
          req.id,
        );
        this.logger.log(`Expired unassigned recurring request ${req.id}`);
      } catch (err) {
        this.logger.error(`Failed to expire recurring request ${req.id}`, err);
      }
    }
  }

  /**
   * Which natural cycle of a plan a given date falls in, and that cycle's
   * exclusive end.
   *
   * Cycles are anchored on the plan's start date — a plan beginning 4 Sep has
   * cycles 4 Sep–3 Oct, 4 Oct–3 Nov, and so on — so month lengths vary and the
   * anchor day never drifts.
   */
  private cycleFor(planStart: Date, date: Date): { number: number; end: Date } {
    for (let n = 1; n <= MAX_CYCLE_LOOKAHEAD; n++) {
      const { end } = cycleWindow(planStart, n);
      if (date < end) return { number: n, end };
    }
    // Anchor is implausibly far in the past; fall back to a single month from
    // the date itself so generation still makes progress rather than stalling.
    return { number: MAX_CYCLE_LOOKAHEAD, end: TimeUtils.addMonths(date, 1) };
  }

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async handleRollingGeneration() {
    this.logger.log('Starting daily rolling generation for recurring requests');

    try {
      const activeRequests = await this.prisma.recurring_service_requests.findMany({
        where: {
          status: { in: ['active', 'pending'] }
        },
        include: {
          bookings: {
            orderBy: { start_time: 'desc' },
            take: 1,
            select: { id: true, start_time: true }
          }
        }
      });

      let generatedCount = 0;

      for (const req of activeRequests) {
        try {
        // If there is no latest booking, something went wrong during creation,
        // we can generate from start_date.
        const latestBookingDate = req.bookings.length > 0
          ? new Date(req.bookings[0].start_time)
          : new Date(req.start_date);

        // Check if latest booking is within 7 days from now
        const daysUntilLatestBooking = (latestBookingDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24);

        // Generation has been stuck for two+ weeks — stop retrying and alert the parent
        // instead of silently failing every night.
        if (daysUntilLatestBooking < -STUCK_GENERATION_DAYS) {
          await this.prisma.recurring_service_requests.update({
            where: { id: req.id },
            data: { status: 'error' },
          });
          await this.notificationsService.createNotification(
            req.parent_id,
            'Recurring booking issue',
            "We couldn't generate your next sessions automatically — please check your recurring plan.",
            'warning',
            'recurring_request',
            req.id,
          );
          this.logger.warn(`Recurring request ${req.id} flagged as errored after ${Math.round(-daysUntilLatestBooking)} days stuck.`);
          continue;
        }

        if (daysUntilLatestBooking <= 7) {
          const nextStartDate = new Date(latestBookingDate);
          nextStartDate.setDate(nextStartDate.getDate() + 1);

          // Roll forward by whole natural cycles anchored on the plan's start
          // date, not by a flat 30 days. A 30-day step drifts off the anchor —
          // after a few months a plan that began on the 4th is generating from
          // the 1st — and it under-generates every 31-day month.
          const cycle = this.cycleFor(req.start_date, nextStartDate);

          // The sold term is a count of natural months. Plans predating the
          // column (no duration stored) keep rolling indefinitely as before,
          // rather than being cut off after a single month.
          const termMonths = req.plan_duration_months
            ? Number(req.plan_duration_months)
            : null;
          if (termMonths && cycle.number > termMonths) {
            continue;
          }

          // `generateDates` takes an *inclusive* end date, and the cycle window's
          // end is exclusive — step back a day so the next cycle's first session
          // isn't generated twice.
          let targetEndDate = new Date(cycle.end.getTime() - DAY_MS);

          // Ensure we don't generate past the end_date if it exists
          if (req.end_date && targetEndDate > new Date(req.end_date)) {
            targetEndDate = new Date(req.end_date);
          }

          // If nextStartDate > end_date, we're done generating for this plan
          if (req.end_date && nextStartDate > new Date(req.end_date)) {
            continue;
          }

          // Use the service helper to generate dates
          const dates = this.recurringRequestsService.generateDates(
            nextStartDate,
            targetEndDate,
            req.recurrence_type as RecurrenceType,
            req.recurrence_pattern,
            1
          );

          if (dates.length > 0) {
            this.logger.log(`Generating ${dates.length} new bookings for recurring request ${req.id}`);
            
            // Execute in transaction
            await this.prisma.$transaction(async (tx) => {
              const bookingsData = dates.map(date => {
                const dateStr = date.toISOString().split("T")[0];
                const startTimeStr = req.start_time instanceof Date 
                  ? req.start_time.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }) 
                  : (typeof req.start_time === 'string' ? (req.start_time as string).substring(0, 5) : "09:00");
                  
                const startTimestamp = TimeUtils.combineDateAndTime(dateStr, startTimeStr);
                const endTimestamp = TimeUtils.getEndTime(startTimestamp, Number(req.duration_hours));

                return {
                  parent_id: req.parent_id,
                  recurring_request_id: req.id,
                  // Staffing lives on the plan, so sessions generated after the
                  // assignment inherit the caregiver instead of coming out
                  // unassigned and silently dropping off their schedule.
                  nanny_id: req.nanny_id,
                  status: req.nanny_id ? BookingStatus.CONFIRMED : "requested",
                  start_time: startTimestamp,
                  end_time: endTimestamp,
                  tags: ["recurring", `category:${req.category}`],
                };
              });

              await Promise.all(
                bookingsData.map(async (data) => {
                  const booking = await tx.bookings.create({ data });
                  // If children are associated, we'd need them here but we didn't store child_ids
                  // on the recurring_request table directly. We can infer from existing bookings.
                  // For a true implementation, we should store child_ids on recurring_service_requests.
                  // We'll skip children linking here or fetch them from previous bookings.
                  
                  // Fetch children from previous booking
                  if (req.bookings.length > 0 && req.bookings[0].id) {
                    const prevBookingChildren = await this.prisma.booking_children.findMany({
                      where: { booking_id: req.bookings[0].id }
                    });
                    
                    if (prevBookingChildren.length > 0) {
                      await tx.booking_children.createMany({
                        data: prevBookingChildren.map(bc => ({
                          booking_id: booking.id,
                          child_id: bc.child_id
                        }))
                      });
                    }
                  }
                  return booking;
                })
              );
            }, { timeout: 20000, maxWait: 5000 });

            generatedCount += dates.length;
          }
        }
        } catch (reqError) {
          // Isolate this plan's failure so one broken recurring request doesn't
          // block generation for every other active plan in the batch.
          this.logger.error(`Failed to generate bookings for recurring request ${req.id}`, reqError);
        }
      }

      this.logger.log(`Rolling generation complete. Generated ${generatedCount} new bookings.`);
    } catch (error) {
      this.logger.error('Error during rolling generation of recurring bookings', error);
    }
  }
}
