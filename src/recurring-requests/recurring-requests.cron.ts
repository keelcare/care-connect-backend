import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { RecurringRequestsService } from './recurring-requests.service';
import { NotificationsService } from '../notifications/notifications.service';
import { TimeUtils } from '../common/utils/time.utils';
import { RecurrenceType } from './dto/create-recurring-request.dto';
import { BookingStatus } from '../common/constants/booking-status.enum';
import {
  cycleWindow,
  cycleNumberFor,
  MAX_CYCLE_LOOKAHEAD,
} from '../common/utils/pricing.utils';
import { PaymentsService } from '../payments/payments.service';
import {
  PLAN_STATUS,
  PLAN_STATUSES_GENERATING,
} from '../common/constants/plan-status.enum';
import { SseService } from '../sse/sse.service';
import { SSE_EVENTS } from '../events/sse-event.types';
import { INSTALMENT_PENDING, INSTALMENT_VOID } from '../constants';

// If generation has been stuck (latest booking further in the past than this)
// for a plan, stop retrying it automatically and flag it for the parent.
const STUCK_GENERATION_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

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
    private readonly sseService: SseService,
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
        // Only a live plan bills. A winding-down plan is excluded deliberately:
        // its remaining sessions are already paid for, so opening another cycle
        // would charge a parent who has cancelled for care they never asked for.
        status: PLAN_STATUS.ACTIVE,
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
        status: { in: PLAN_STATUSES_GENERATING },
        start_date: { lt: startOfToday },
        // Nobody is serving this plan. A winding-down plan keeps its caregiver
        // until its last retained session lands, so it can never match here.
        nanny_id: null,
      },
      select: { id: true, parent_id: true },
    });

    for (const req of stale) {
      try {
        const expired = await this.prisma.$transaction(async (tx) => {
          // Guarded claim: an admin can assign a caregiver between the read
          // above and this write, which sets status ACTIVE and nanny_id. A bare
          // update here would expire a plan that just went live and cancel its
          // freshly-staffed sessions.
          const claimed = await tx.recurring_service_requests.updateMany({
            where: {
              id: req.id,
              status: { in: PLAN_STATUSES_GENERATING },
              nanny_id: null,
            },
            data: { status: PLAN_STATUS.EXPIRED },
          });
          if (claimed.count === 0) return false;

          // Leave no orphaned sessions behind that can never be served. Only
          // the unstaffed, still-requested ones: a session staffed directly by
          // booking id (which never sets the plan's nanny_id) may be CONFIRMED,
          // IN_PROGRESS or even COMPLETED, and the old `status != CANCELLED`
          // filter rewrote delivered care as cancelled.
          await tx.bookings.updateMany({
            where: {
              recurring_request_id: req.id,
              status: BookingStatus.REQUESTED,
              nanny_id: null,
            },
            data: {
              status: BookingStatus.CANCELLED,
              cancellation_reason:
                "Recurring plan expired before a caregiver could be matched",
            },
          });

          // Money billed against a plan nobody ever served stops being owed —
          // the matching fee is raised at creation, before any assignment, and
          // used to stay PENDING (collectible) forever after expiry. The fee is
          // *not* carved out here as it is at cancellation: cancellation keeps
          // it because the placement was made, and here it never was.
          await tx.payment_installments.updateMany({
            where: {
              bookings: { recurring_request_id: req.id },
              status: INSTALMENT_PENDING,
            },
            data: { status: INSTALMENT_VOID, updated_at: new Date() },
          });

          return true;
        });
        if (!expired) continue;

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
   * Close out plans that were cancelled but still owed the parent sessions.
   *
   * A wound-down plan keeps its caregiver so the sessions already paid for can
   * actually be served. Once the last of them is delivered there is nothing left
   * to serve, so the plan finishes and the caregiver is released.
   *
   * Keyed on the last remaining session's *status*, not on its start time having
   * passed: a session that is still `IN_PROGRESS` is not finished, and completing
   * the plan out from under it would release the caregiver mid-shift.
   */
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async handleWindDownCompletion() {
    const plans = await this.prisma.recurring_service_requests.findMany({
      where: { status: PLAN_STATUS.WINDING_DOWN },
      select: { id: true, parent_id: true },
    });

    for (const plan of plans) {
      try {
        // Outstanding means *still deliverable*: a session under way (whatever
        // its clock says), or one whose window has not closed yet. A REQUESTED/
        // CONFIRMED session whose end time has already passed can never be
        // served — cancellation deliberately leaves past-dated sessions alone,
        // so counting them here deadlocked the plan in winding_down forever and
        // the caregiver was never released.
        const outstanding = await this.prisma.bookings.count({
          where: {
            recurring_request_id: plan.id,
            OR: [
              { status: BookingStatus.IN_PROGRESS },
              {
                status: {
                  in: [BookingStatus.REQUESTED, BookingStatus.CONFIRMED],
                },
                end_time: { gt: new Date() },
              },
            ],
          },
        });
        if (outstanding > 0) continue;

        // Guarded claim: the count above is a separate read, and the plan list
        // itself was fetched earlier still. Only complete a plan that is *still*
        // winding down, and only notify when this run was the one that did it.
        const claimed = await this.prisma.recurring_service_requests.updateMany({
          where: { id: plan.id, status: PLAN_STATUS.WINDING_DOWN },
          data: {
            status: PLAN_STATUS.COMPLETED,
            // Nothing left to serve — the caregiver is free.
            nanny_id: null,
            updated_at: new Date(),
          },
        });
        if (claimed.count === 0) continue;

        await this.notificationsService
          .createNotification(
            plan.parent_id,
            'Recurring plan closed',
            'The last session on your cancelled plan has been delivered, so the plan is now closed. You can create a new plan at any time.',
            'info',
            'recurring_request',
            plan.id,
          )
          .catch((err) =>
            this.logger.error(`Failed to notify parent of plan ${plan.id} closing`, err),
          );

        this.sseService.emitToUser(plan.parent_id, {
          type: SSE_EVENTS.REQUEST_CANCELLED,
          data: { planId: plan.id, status: PLAN_STATUS.COMPLETED },
          timestamp: new Date().toISOString(),
        });

        this.logger.log(`Wound-down plan ${plan.id} completed; caregiver released.`);
      } catch (err) {
        this.logger.error(`Failed to complete wound-down plan ${plan.id}`, err as Error);
      }
    }
  }

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async handleRollingGeneration() {
    this.logger.log('Starting daily rolling generation for recurring requests');

    try {
      const activeRequests = await this.prisma.recurring_service_requests.findMany({
        where: {
          // `winding_down` is absent by design: a cancelled plan keeps the
          // sessions it has already paid for, but must never grow new ones.
          status: { in: PLAN_STATUSES_GENERATING },
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

        // Where generation would resume, and which natural cycle that falls in.
        // Computed before the stuck check because the two must be told apart:
        // a plan whose sold term has simply run out has nothing left to
        // generate *by design*, and the stuck detector used to catch it two
        // weeks after its last session, flip it to ERROR and send the parent a
        // "we couldn't generate your sessions" warning about a plan that had
        // finished exactly as promised.
        const nextStartDate = new Date(latestBookingDate);
        nextStartDate.setDate(nextStartDate.getDate() + 1);

        // Roll forward by whole natural cycles anchored on the plan's start
        // date, not by a flat 30 days. A 30-day step drifts off the anchor —
        // after a few months a plan that began on the 4th is generating from
        // the 1st — and it under-generates every 31-day month.
        const cycle = cycleNumberFor(req.start_date, nextStartDate);

        // The sold term is a count of natural months. Plans predating the
        // column (no duration stored) keep rolling indefinitely as before,
        // rather than being cut off after a single month.
        const termMonths = req.plan_duration_months
          ? Number(req.plan_duration_months)
          : null;
        const termExhausted =
          (termMonths !== null && cycle.number > termMonths) ||
          (!!req.end_date && nextStartDate > new Date(req.end_date));

        if (termExhausted) {
          // Nothing more will ever be generated. Once the last session's
          // window has closed (or it is not in progress), the plan ran its
          // full term: close it and release the caregiver, mirroring the
          // wind-down completion rule.
          const outstanding = await this.prisma.bookings.count({
            where: {
              recurring_request_id: req.id,
              OR: [
                { status: BookingStatus.IN_PROGRESS },
                {
                  status: {
                    in: [BookingStatus.REQUESTED, BookingStatus.CONFIRMED],
                  },
                  end_time: { gt: new Date() },
                },
              ],
            },
          });
          if (outstanding === 0) {
            const claimed = await this.prisma.recurring_service_requests.updateMany({
              where: { id: req.id, status: { in: PLAN_STATUSES_GENERATING } },
              data: {
                status: PLAN_STATUS.COMPLETED,
                nanny_id: null,
                updated_at: new Date(),
              },
            });
            if (claimed.count > 0) {
              await this.notificationsService
                .createNotification(
                  req.parent_id,
                  'Recurring plan completed',
                  'Your recurring plan has run its full term and is now complete. You can create a new plan at any time.',
                  'info',
                  'recurring_request',
                  req.id,
                )
                .catch((err) =>
                  this.logger.error(`Failed to notify parent of plan ${req.id} completing`, err),
                );
              this.logger.log(`Recurring plan ${req.id} ran its full term; marked completed.`);
            }
          }
          continue;
        }

        // Generation has been stuck for two+ weeks — stop retrying and alert the parent
        // instead of silently failing every night.
        if (daysUntilLatestBooking < -STUCK_GENERATION_DAYS) {
          await this.prisma.recurring_service_requests.updateMany({
            // Guarded so a plan cancelled or completed in the gap is not
            // dragged back to ERROR.
            where: { id: req.id, status: { in: PLAN_STATUSES_GENERATING } },
            data: { status: PLAN_STATUS.ERROR },
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
