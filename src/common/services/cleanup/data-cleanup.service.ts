import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../../../prisma/prisma.service";
import { MailService } from "../../../mail/mail.service";

@Injectable()
export class DataCleanupService {
  private readonly logger = new Logger(DataCleanupService.name);

  /** Days a soft-deleted account/child is retained before permanent erasure. */
  static readonly RETENTION_DAYS = 30;
  /** How far ahead of erasure the DPDP pre-erasure notice is sent (48 hours). */
  static readonly NOTICE_LEAD_DAYS = 2;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailService: MailService,
    private readonly configService: ConfigService,
  ) {}

  private daysAgo(days: number): Date {
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  }

  private get supportEmail(): string {
    return (
      this.configService.get<string>("SUPPORT_EMAIL") || "support@keel.app"
    );
  }

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async cleanupOldData() {
    this.logger.log("Starting daily data cleanup...");

    // 1. Delete messages older than 1 year (Data Minimization)
    try {
      const messageCutoff = this.daysAgo(365);
      const deletedMessages = await this.prisma.messages.deleteMany({
        where: { created_at: { lt: messageCutoff } },
      });
      this.logger.log(`Deleted ${deletedMessages.count} old messages.`);
    } catch (error) {
      this.logger.error("Message cleanup failed", error);
    }

    // 2. DPDP 48-hour pre-erasure notices for accounts nearing purge.
    try {
      await this.sendPreErasureNotices();
    } catch (error) {
      this.logger.error("Pre-erasure notice step failed", error);
    }

    // 3. Purge accounts whose 30-day retention window has elapsed.
    try {
      await this.purgeExpiredAccounts();
    } catch (error) {
      this.logger.error("Account purge failed", error);
    }

    // 4. Purge child profiles whose 30-day retention window has elapsed.
    try {
      await this.purgeExpiredChildren();
    } catch (error) {
      this.logger.error("Child purge failed", error);
    }

    this.logger.log("Daily cleanup completed.");
  }

  /**
   * Accounts already anonymised carry a `deleted-<id>@keel.dev` email, so we
   * skip them when scanning for work still to do.
   */
  private isAnonymised(email: string | null): boolean {
    return !!email && email.startsWith("deleted-");
  }

  /**
   * DPDP Rules 2025 require informing the Data Principal at least 48 hours
   * before their personal data is erased. We e-mail (the account is logged out,
   * so push/in-app is unreliable) once, tracked by `deletion_notice_sent_at`.
   */
  private async sendPreErasureNotices() {
    const noticeThreshold = this.daysAgo(
      DataCleanupService.RETENTION_DAYS - DataCleanupService.NOTICE_LEAD_DAYS,
    );
    const purgeThreshold = this.daysAgo(DataCleanupService.RETENTION_DAYS);

    const candidates = await this.prisma.users.findMany({
      where: {
        is_active: false,
        deletion_notice_sent_at: null,
        deleted_at: { not: null, lte: noticeThreshold, gt: purgeThreshold },
      },
      select: { id: true, email: true, deleted_at: true },
    });

    for (const user of candidates) {
      if (this.isAnonymised(user.email)) continue;
      const eraseOn = new Date(
        user.deleted_at!.getTime() +
          DataCleanupService.RETENTION_DAYS * 24 * 60 * 60 * 1000,
      );
      const body = `
        <p>Hello,</p>
        <p>Your Keel account is scheduled to be <strong>permanently deleted on {{eraseDate}}</strong>.</p>
        <p>If you did not mean to delete your account, contact us at
        <a href="mailto:{{support}}">{{support}}</a> before then and we can restore it.
        After that date your personal data will be erased and cannot be recovered.</p>
        <p>— The Keel team</p>`;
      await this.mailService.sendMail(
        user.email!,
        "Your Keel account will be deleted in 48 hours",
        body,
        { eraseDate: eraseOn.toDateString(), support: this.supportEmail },
      );
      await this.prisma.users.update({
        where: { id: user.id },
        data: { deletion_notice_sent_at: new Date() },
      });
    }

    if (candidates.length) {
      this.logger.log(`Sent ${candidates.length} pre-erasure notice(s).`);
    }
  }

  private async purgeExpiredAccounts() {
    const cutoff = this.daysAgo(DataCleanupService.RETENTION_DAYS);
    const candidates = await this.prisma.users.findMany({
      where: { is_active: false, deleted_at: { not: null, lte: cutoff } },
      select: { id: true, email: true },
    });

    let purged = 0;
    for (const user of candidates) {
      if (this.isAnonymised(user.email)) continue;
      await this.anonymiseUserData(user.id);
      purged++;
    }
    if (purged) this.logger.log(`Purged (anonymised) ${purged} account(s).`);
  }

  private async purgeExpiredChildren() {
    const cutoff = this.daysAgo(DataCleanupService.RETENTION_DAYS);
    const deleted = await this.prisma.children.deleteMany({
      where: { deleted_at: { not: null, lte: cutoff } },
    });
    if (deleted.count) {
      this.logger.log(`Purged ${deleted.count} soft-deleted child profile(s).`);
    }
  }

  /**
   * DPDPA 2023 — Right to Erasure at the end of the 30-day retention window.
   *
   * We anonymise rather than hard-delete the user row: bookings and payments
   * are financial records Indian tax law requires us to retain (~8 years), and
   * they are kept, de-identified. All directly identifying data is erased:
   * profile PII, identity documents, children (sensitive health data), and the
   * user's authored reviews are unlinked (kept for nanny rating integrity).
   */
  async anonymiseUserData(userId: string): Promise<void> {
    this.logger.log(`Erasing personal data for user: ${userId}`);

    await this.prisma.$transaction(async (tx) => {
      // 1. Unlink authored reviews (keep the rating, drop the identity).
      await tx.reviews.updateMany({
        where: { reviewer_id: userId },
        data: { reviewer_id: null, comment: "[User deleted account]" },
      });

      // 2. Erase sensitive dependents: children (health/diagnosis) and identity
      //    documents. Children cascade-remove their booking_children links.
      await tx.children.deleteMany({ where: { parent_id: userId } });
      await tx.identity_documents.deleteMany({ where: { user_id: userId } });

      // 3. Anonymise the profile record.
      await tx.profiles.updateMany({
        where: { user_id: userId },
        data: {
          first_name: "Deleted",
          last_name: "User",
          phone: null,
          address: null,
          profile_image_url: null,
          lat: null,
          lng: null,
        },
      });

      // 4. Anonymise the user row itself. Kept (not deleted) so retained
      //    bookings/payments stay referentially valid but de-identified. The
      //    anonymised email doubles as the "already purged" marker.
      await tx.users.update({
        where: { id: userId },
        data: {
          email: `deleted-${userId}@keel.dev`,
          is_active: false,
          oauth_provider: null,
          oauth_provider_id: null,
          oauth_access_token: null,
          oauth_refresh_token: null,
          password_hash: null,
          fcm_token: null,
          refresh_token_hash: null,
        },
      });
    });

    this.logger.log(`Erased personal data for user: ${userId}`);
  }
}
