import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { BookingsService } from "../bookings/bookings.service";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";
import { SseService } from "../sse/sse.service";
import { MailService } from "../mail/mail.service";
import { PricingEngineService } from "../common/pricing.service";

@Injectable()
export class TasksService {
  private readonly logger = new Logger(TasksService.name);

  constructor(
    private readonly bookingsService: BookingsService,
    private prisma: PrismaService,
    private notificationsService: NotificationsService,
    private sseService: SseService,
    private mailService: MailService,
    private pricingService: PricingEngineService,
  ) {}

  @Cron(CronExpression.EVERY_30_MINUTES)
  async handleExpiredBookings() {
    this.logger.debug("Running Cron Job: Checking for expired bookings...");
    try {
      const { expired, autoCompleted } =
        await this.bookingsService.checkExpiredBookings();
      if (expired > 0 || autoCompleted > 0) {
        this.logger.log(
          `Processed stale bookings: ${expired} expired, ${autoCompleted} auto-completed.`,
        );
      }
    } catch (error) {
      this.logger.error("Error in handleExpiredBookings cron job", error);
    }
  }

  // 2. Overdue progress reports — runs daily at midnight UTC
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async handleOverdueProgressReports() {
    const result = await this.prisma.progress_reports.updateMany({
      where: { status: "PENDING", due_at: { lt: new Date() } },
      data: { status: "OVERDUE" },
    });
    if (result.count > 0) {
      this.logger.log(`Marked ${result.count} progress reports as OVERDUE`);
    }
  }

  // 3. Cleanup expired revoked tokens — runs every day at 2am UTC
  @Cron("0 0 2 * * *")
  async cleanupRevokedTokens() {
    const result = await this.prisma.revoked_tokens.deleteMany({
      where: { expires_at: { lt: new Date() } },
    });
    if (result.count > 0) {
      this.logger.log(`Cleaned up ${result.count} expired revoked tokens`);
    }
  }

  // 4. Payment Plan reminders (due in 3 days) — runs daily at 9am IST (03:30 UTC)
  @Cron("0 30 3 * * *")
  async checkUpcomingBillingCycles() {
    this.logger.debug("Running Cron Job: Checking for upcoming billing cycles due in 3 days...");
    try {
      const now = new Date();
      // Target date: exactly 3 days from now
      const targetDateMin = new Date(now);
      targetDateMin.setDate(targetDateMin.getDate() + 3);
      targetDateMin.setHours(0, 0, 0, 0);

      const targetDateMax = new Date(targetDateMin);
      targetDateMax.setHours(23, 59, 59, 999);

      const dueSoon = await this.prisma.payment_plans.findMany({
        where: {
          status: "active",
          next_due_date: {
            gte: targetDateMin,
            lte: targetDateMax,
          },
        },
        include: {
          bookings: {
            include: {
              users_bookings_parent_idTousers: {
                include: {
                  profiles: true,
                },
              },
            },
          },
        },
      });

      for (const plan of dueSoon) {
        const parent = plan.bookings?.users_bookings_parent_idTousers;
        if (!parent) continue;

        const cycleNo = plan.cycles_completed + 1;

        // 1. Send in-app notification
        await this.notificationsService.createNotification(
          parent.id,
          "Upcoming Payment Reminder",
          `Payment for billing cycle #${cycleNo} of your booking is due in 3 days.`,
          "info",
        );

        // 2. Send email reminder (fire-and-forget)
        if (parent.email) {
          const parentName = parent.profiles?.first_name 
            ? `${parent.profiles.first_name} ${parent.profiles.last_name || ''}`.trim() 
            : "Parent";
            
          const bookingDetails = `Booking #${plan.booking_id.substring(0, 8)}`;
          
          this.mailService.sendInstallmentReminderEmail(
            parent.email,
            parentName,
            {
              amount: 0, // In reality, we'd snapshot here or preview. 0 means we just tell them to check the app.
              dueDate: plan.next_due_date.toLocaleDateString(),
              installmentNo: cycleNo,
              bookingDetails,
            }
          ).catch((err) => 
            this.logger.error(`Failed to send upcoming cycle email to ${parent.email}`, err)
          );
        }
      }

      if (dueSoon.length > 0) {
        this.logger.log(`Sent ${dueSoon.length} upcoming billing cycle reminders.`);
      }
    } catch (error) {
      this.logger.error("Error in checkUpcomingBillingCycles cron job", error);
    }
  }

  // 6. Weekly location updates cleanup — runs weekly (Sundays at midnight UTC)
  @Cron("0 0 0 * * 0")
  async cleanLocationUpdates() {
    this.logger.debug("Running Cron Job: Cleaning up location updates older than 30 days...");
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - 30);

      const result = await this.prisma.location_updates.deleteMany({
        where: {
          timestamp: {
            lt: cutoffDate,
          },
        },
      });

      if (result.count > 0) {
        this.logger.log(`Cleaned up ${result.count} stale location updates.`);
      }
    } catch (error) {
      this.logger.error("Error in cleanLocationUpdates cron job", error);
    }
  }
}

