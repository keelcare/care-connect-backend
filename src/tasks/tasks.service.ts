import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { BookingsService } from "../bookings/bookings.service";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";

@Injectable()
export class TasksService {
  private readonly logger = new Logger(TasksService.name);

  constructor(
    private readonly bookingsService: BookingsService,
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
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
}
