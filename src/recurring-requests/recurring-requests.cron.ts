import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { RecurringRequestsService } from './recurring-requests.service';
import { NotificationsService } from '../notifications/notifications.service';
import { TimeUtils } from '../common/utils/time.utils';
import { RecurrenceType } from './dto/create-recurring-request.dto';

// If generation has been stuck (latest booking further in the past than this)
// for a plan, stop retrying it automatically and flag it for the parent.
const STUCK_GENERATION_DAYS = 14;

@Injectable()
export class RecurringRequestsCron {
  private readonly logger = new Logger(RecurringRequestsCron.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly recurringRequestsService: RecurringRequestsService,
    private readonly notificationsService: NotificationsService,
  ) {}

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
          // Generate for next 30 days starting after the latest booking
          const nextStartDate = new Date(latestBookingDate);
          nextStartDate.setDate(nextStartDate.getDate() + 1);

          // Ensure we don't generate past the end_date if it exists
          let targetEndDate = new Date(nextStartDate);
          targetEndDate.setDate(targetEndDate.getDate() + 30);

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
                  status: "requested",
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
