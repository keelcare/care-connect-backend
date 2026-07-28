import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { Prisma } from "@prisma/client";

/**
 * Append-only per-booking status history — the booking equivalent of
 * PaymentAuditService. One-off bookings previously kept only the latest
 * `updated_at`, so prior states were lost; this records every transition.
 *
 * Mirrors PaymentAuditService: transaction-aware (pass the tx client so the log
 * commits atomically with the status change) and error-swallowing so a logging
 * failure never breaks the primary booking write.
 */
@Injectable()
export class BookingStatusLogService {
  private readonly logger = new Logger(BookingStatusLogService.name);

  constructor(private prisma: PrismaService) {}

  async writeLog(
    tx: Prisma.TransactionClient | null,
    bookingId: string,
    fromStatus: string | null,
    toStatus: string,
    opts: {
      changedBy?: string | null;
      actorRole?: "parent" | "nanny" | "admin" | "system";
      reason?: string | null;
      metadata?: Prisma.InputJsonValue;
    } = {},
  ) {
    const context = (tx as any) || this.prisma;
    try {
      await context.booking_status_log.create({
        data: {
          booking_id: bookingId,
          // Normalize casing so the known `requested`-lowercase footgun doesn't
          // leak into history and break status queries/reporting downstream.
          from_status: fromStatus ? fromStatus.toUpperCase() : null,
          to_status: toStatus.toUpperCase(),
          changed_by: opts.changedBy ?? null,
          actor_role: opts.actorRole ?? "system",
          reason: opts.reason ?? null,
          metadata: opts.metadata ?? {},
        },
      });
    } catch (err) {
      // Never let audit logging break the primary status transition.
      this.logger.warn(
        `Failed to write booking_status_log for ${bookingId} (${fromStatus} -> ${toStatus}): ${
          (err as Error)?.message
        }`,
      );
    }
  }

  /** Full transition history for a booking, oldest first. */
  async getHistory(bookingId: string) {
    return this.prisma.booking_status_log.findMany({
      where: { booking_id: bookingId },
      orderBy: { created_at: "asc" },
    });
  }
}
