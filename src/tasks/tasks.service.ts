import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { BookingsService } from "../bookings/bookings.service";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";
import { MailService } from "../mail/mail.service";

@Injectable()
export class TasksService {
  private readonly logger = new Logger(TasksService.name);

  constructor(
    private readonly bookingsService: BookingsService,
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
    private readonly mailService: MailService,
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

  // 1. Overdue installment reminders — runs daily at 9am IST
  @Cron("0 30 3 * * *") // 03:30 UTC = 09:00 IST
  async handleOverdueInstallments() {
    const overdue = await this.prisma.payment_installments.findMany({
      where: { status: "pending", due_date: { lt: new Date() } },
      include: { bookings: { select: { parent_id: true } } },
    });

    for (const inst of overdue) {
      await this.prisma.payment_installments.update({
        where: { id: inst.id },
        data: { status: "overdue" },
      });
      if (inst.bookings?.parent_id) {
        await this.notificationsService.createNotification(
          inst.bookings.parent_id,
          "Payment Overdue",
          `Installment #${inst.installment_no} of ₹${inst.amount_due} is overdue.`,
          "warning",
        );
      }
    }
    if (overdue.length > 0) {
      this.logger.log(`Marked ${overdue.length} installments as overdue`);
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

  // 4. Subscription renewal reminder — runs daily at 8am IST (02:30 UTC)
  @Cron("0 30 2 * * *")
  async handleSubscriptionRenewalReminders() {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const dayAfter = new Date(tomorrow);
    dayAfter.setDate(dayAfter.getDate() + 1);

    const dueSoon = await this.prisma.subscription_plans.findMany({
      where: {
        status: "active",
        next_due_date: { gte: tomorrow, lt: dayAfter },
      },
      select: { parent_id: true, monthly_amount: true, next_due_date: true },
    });

    for (const plan of dueSoon) {
      await this.notificationsService.createNotification(
        plan.parent_id,
        "Subscription Payment Due Tomorrow",
        `Your subscription payment of ₹${plan.monthly_amount} is due tomorrow.`,
        "info",
      );
    }
    if (dueSoon.length > 0) {
      this.logger.log(`Sent ${dueSoon.length} subscription renewal reminders`);
    }
  }

  // 5. Upcoming installment reminders (due in 3 days) — runs daily at 9am IST (03:30 UTC)
  @Cron("0 30 3 * * *")
  async checkUpcomingInstallments() {
    this.logger.debug("Running Cron Job: Checking for upcoming installments due in 3 days...");
    try {
      const now = new Date();
      // Target date: exactly 3 days from now
      const targetDateMin = new Date(now);
      targetDateMin.setDate(targetDateMin.getDate() + 3);
      targetDateMin.setHours(0, 0, 0, 0);

      const targetDateMax = new Date(targetDateMin);
      targetDateMax.setHours(23, 59, 59, 999);

      const upcomingInstallments = await this.prisma.payment_installments.findMany({
        where: {
          status: "pending",
          due_date: {
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

      for (const inst of upcomingInstallments) {
        const parent = inst.bookings?.users_bookings_parent_idTousers;
        if (!parent) continue;

        // 1. Send in-app notification
        await this.notificationsService.createNotification(
          parent.id,
          "Upcoming Payment Reminder",
          `Installment #${inst.installment_no} of ₹${inst.amount_due} is due in 3 days.`,
          "info",
        );

        // 2. Send email reminder (fire-and-forget)
        if (parent.email) {
          const parentName = parent.profiles?.first_name 
            ? `${parent.profiles.first_name} ${parent.profiles.last_name || ''}`.trim() 
            : "Parent";
            
          const bookingDetails = `Booking #${inst.booking_id.substring(0, 8)}`;
          
          this.mailService.sendInstallmentReminderEmail(
            parent.email,
            parentName,
            {
              amount: Number(inst.amount_due),
              dueDate: inst.due_date.toLocaleDateString(),
              installmentNo: inst.installment_no,
              bookingDetails,
            }
          ).catch((err) => 
            this.logger.error(`Failed to send upcoming installment email to ${parent.email}`, err)
          );
        }
      }

      if (upcomingInstallments.length > 0) {
        this.logger.log(`Sent ${upcomingInstallments.length} upcoming installment reminders.`);
      }
    } catch (error) {
      this.logger.error("Error in checkUpcomingInstallments cron job", error);
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

