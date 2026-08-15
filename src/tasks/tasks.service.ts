import { Inject, Injectable, Logger, forwardRef } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { BookingsService } from "../bookings/bookings.service";
import { PaymentsService } from "../payments/payments.service";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";
import { SseService } from "../sse/sse.service";
import { MailService } from "../mail/mail.service";
import { PricingEngineService } from "../common/pricing.service";
import { endOfIstDay } from "../common/period";
import { INSTALMENT_PENDING } from "../constants";
import { BookingStatus } from "../common/constants/booking-status.enum";

/** Days between reminders for a balance that is due or overdue. */
const INSTALMENT_REMINDER_INTERVAL_DAYS = 3;

/**
 * Reminders sent per instalment before we stop. Care is never suspended over an
 * unpaid balance, so without a cap this would nag indefinitely; past the cap the
 * amount stays visible in the app instead.
 */
const INSTALMENT_REMINDER_MAX = 6;

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
    // forwardRef because BookingsModule (which provides this service) and
    // PaymentsModule already import each other.
    @Inject(forwardRef(() => PaymentsService))
    private paymentsService: PaymentsService,
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

  /**
   * Remind parents about a balance that is due today or already overdue.
   *
   * We never suspend care over an unpaid balance, which means an overdue
   * instalment stays overdue indefinitely — so this must be paced or it emails the
   * same parent every morning forever. `last_reminded_at` gates the cadence and
   * `reminder_count` caps it: after the cap we stop nagging and leave the balance
   * visible in the app.
   */
  /**
   * Catch captured money that ended up with no invoice behind it.
   *
   * Invoices are issued just after the capture transaction commits, so a crash in
   * that narrow window leaves settled money undocumented — invisible until a
   * parent goes looking for a receipt, and awkward to explain at year end. Runs
   * before the reminder job so a parent is never chased for a balance on an
   * engagement whose receipts are still missing.
   */
  @Cron("0 30 3 * * *")
  async reconcileMissingInvoices() {
    try {
      await this.paymentsService.reconcileMissingInvoices();
    } catch (error) {
      this.logger.error("Error in reconcileMissingInvoices cron job", error);
    }
  }

  @Cron("0 45 3 * * *")
  async remindOutstandingInstallments() {
    this.logger.debug("Running Cron Job: Checking for due/overdue instalments...");
    try {
      const now = new Date();
      // End of today in IST, so "due today" means the parent's today rather than
      // whichever day the server happens to be in.
      const dueThrough = endOfIstDay(now);
      const remindedBefore = new Date(
        now.getTime() - INSTALMENT_REMINDER_INTERVAL_DAYS * 24 * 60 * 60 * 1000,
      );

      const due = await this.prisma.payment_installments.findMany({
        where: {
          status: INSTALMENT_PENDING,
          due_date: { not: null, lte: dueThrough },
          reminder_count: { lt: INSTALMENT_REMINDER_MAX },
          OR: [{ last_reminded_at: null }, { last_reminded_at: { lte: remindedBefore } }],
          bookings: { status: { not: BookingStatus.CANCELLED } },
        },
        take: 500,
        include: {
          bookings: {
            include: {
              users_bookings_parent_idTousers: { include: { profiles: true } },
            },
          },
        },
      });

      for (const instalment of due) {
        const parent = instalment.bookings?.users_bookings_parent_idTousers;
        if (!parent) continue;

        const amount = Number(instalment.amount);
        const overdue = !!instalment.due_date && instalment.due_date < now;
        const dueLabel = instalment.due_date?.toLocaleDateString() ?? "soon";

        await this.notificationsService
          .createNotification(
            parent.id,
            overdue ? "Payment overdue" : "Payment due today",
            overdue
              ? `The remaining ₹${amount} for your care plan was due on ${dueLabel}. You can settle it under Pending payments.`
              : `The remaining ₹${amount} for your care plan is due today. You can settle it under Pending payments.`,
            overdue ? "warning" : "info",
            "payment",
            instalment.booking_id,
          )
          .catch((err) =>
            this.logger.error("Failed to notify parent of due instalment", err),
          );

        if (parent.email) {
          const parentName = parent.profiles?.first_name
            ? `${parent.profiles.first_name} ${parent.profiles.last_name || ""}`.trim()
            : "Parent";

          this.mailService
            .sendInstallmentReminderEmail(parent.email, parentName, {
              amount,
              dueDate: dueLabel,
              installmentNo: instalment.installment_no,
              bookingDetails: `Booking #${instalment.booking_id.substring(0, 8)}`,
            })
            .catch((err) =>
              this.logger.error(`Failed to send instalment reminder to ${parent.email}`, err),
            );
        }

        // Recorded per-row after sending, so a crash midway through the batch
        // re-reminds only the parents we hadn't reached.
        await this.prisma.payment_installments.update({
          where: { id: instalment.id },
          data: { last_reminded_at: now, reminder_count: { increment: 1 } },
        });
      }

      if (due.length > 0) {
        this.logger.log(`Sent ${due.length} outstanding instalment reminders.`);
      }
    } catch (error) {
      this.logger.error("Error in remindOutstandingInstallments cron job", error);
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

        // A cycle whose advance is already paid is not "due in 3 days" — its
        // balance has its own date and its own reminder. Announcing the whole
        // cycle again would tell the parent to pay money they have paid.
        const advancePaid = await this.prisma.payment_installments.count({
          where: {
            booking_id: plan.booking_id,
            cycle_number: cycleNo,
            status: { not: INSTALMENT_PENDING },
          },
        });
        if (advancePaid > 0) continue;

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

