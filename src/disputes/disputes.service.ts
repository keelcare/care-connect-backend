import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CreateDisputeDto } from "./dto/create-dispute.dto";
import { ResolveDisputeDto, DisputeOutcome } from "./dto/resolve-dispute.dto";
import { PaymentsService } from "../payments/payments.service";
import { NotificationsService } from "../notifications/notifications.service";
import { PaymentStatus } from "../constants";

@Injectable()
export class DisputesService {
  private readonly logger = new Logger(DisputesService.name);

  constructor(
    private prisma: PrismaService,
    private readonly paymentsService: PaymentsService,
    private readonly notificationsService: NotificationsService,
  ) {}

  async create(userId: string, dto: CreateDisputeDto) {
    // Validate booking ownership
    const booking = await this.prisma.bookings.findUnique({
      where: { id: dto.bookingId },
    });

    if (!booking) throw new NotFoundException("Booking not found");
    if (booking.parent_id !== userId && booking.nanny_id !== userId) {
      throw new BadRequestException(
        "You can only raise disputes for your own bookings",
      );
    }

    // One open dispute per user per booking: without this, repeated taps on
    // "raise dispute" (or deliberate spam) floods the admin queue with rows
    // that each independently carry refund power once resolved.
    const existing = await this.prisma.disputes.findFirst({
      where: { booking_id: dto.bookingId, raised_by: userId, status: "open" },
      select: { id: true },
    });
    if (existing) {
      throw new BadRequestException(
        "You already have an open dispute for this booking",
      );
    }

    return this.prisma.disputes.create({
      data: {
        booking_id: dto.bookingId,
        raised_by: userId,
        reason: dto.reason,
        description: dto.description,
        status: "open",
      },
    });
  }

  async findAll() {
    return this.prisma.disputes.findMany({
      orderBy: { created_at: "desc" },
      include: {
        bookings: true,
        users_disputes_raised_byTousers: {
          select: { email: true, profiles: true },
        },
      },
    });
  }

  async findByUserId(userId: string) {
    return this.prisma.disputes.findMany({
      where: { raised_by: userId },
      orderBy: { created_at: "desc" },
      include: {
        bookings: true,
      },
    });
  }

  async findOne(id: string) {
    const dispute = await this.prisma.disputes.findUnique({
      where: { id },
      include: {
        bookings: true,
        users_disputes_raised_byTousers: {
          select: { email: true, profiles: true },
        },
      },
    });
    if (!dispute) throw new NotFoundException("Dispute not found");
    return dispute;
  }

  async resolve(id: string, adminId: string, dto: ResolveDisputeDto) {
    const dispute = await this.prisma.disputes.findUnique({
      where: { id },
      include: { bookings: { include: { payments: true } } },
    });

    if (!dispute) throw new NotFoundException("Dispute not found");
    if (dispute.status !== "open") {
      throw new BadRequestException("Dispute is already resolved");
    }

    // Financial outcome, taken from the explicit `outcome` field rather than
    // sniffed out of the resolution text — see DisputeOutcome for why.
    //
    // The payment to act on is the CAPTURED one, not `payments[0]`: a booking
    // accumulates a `payments` row per checkout attempt (`created` orders that
    // were opened and abandoned, `failed` attempts), so the first row in
    // unspecified order was frequently not the money actually held. When it
    // wasn't, the old `payments[0].status === captured` guard failed silently
    // and a REFUND outcome resolved the dispute with no money moved.
    const payment =
      dispute.bookings?.payments?.find(
        (p) => p.status === PaymentStatus.CAPTURED,
      ) ?? null;

    // An admin who explicitly chose a financial outcome must not get a silent
    // no-op. If there is nothing captured to refund or release, refuse and say
    // so — the admin can re-resolve with `no_action` if that is the truth.
    if (
      (dto.outcome === DisputeOutcome.REFUND ||
        dto.outcome === DisputeOutcome.RELEASE) &&
      !payment
    ) {
      throw new BadRequestException(
        `Cannot ${dto.outcome} — this booking has no captured payment. ` +
          `Resolve with outcome "no_action" if no money should move.`,
      );
    }

    // Atomic claim on the open status. The read-check above is advisory only:
    // two admins resolving concurrently would both pass it, and with a bare
    // `update` both would then trigger the financial branch — a double refund.
    // Only the caller whose updateMany actually flips open→resolved proceeds.
    const claim = await this.prisma.disputes.updateMany({
      where: { id, status: "open" },
      data: {
        status: "resolved",
        resolution: dto.resolution,
        resolved_by: adminId,
        updated_at: new Date(),
      },
    });
    if (claim.count === 0) {
      throw new BadRequestException("Dispute is already resolved");
    }

    let financialResult: string | null = null;

    if (payment) {
      switch (dto.outcome) {
        case DisputeOutcome.REFUND: {
          // Perform the refund for real. This previously wrote a
          // `refund_pending` status that is not in the PaymentStatus enum and
          // was read by no cron, queue or listener anywhere in the codebase —
          // so the dispute showed "resolved" while the money never moved.
          try {
            await this.paymentsService.refundPayment(payment.id, dto.amount);
            financialResult = dto.amount
              ? `Refunded ₹${dto.amount} to the parent.`
              : "Refunded in full to the parent.";
          } catch (err) {
            // Leave the dispute open so the refund is retried rather than
            // silently lost behind a "resolved" badge.
            this.logger.error(
              `Dispute ${id}: refund of payment ${payment.id} failed: ${err.message}`,
              err.stack,
            );
            // Guarded rollback: only reopen the row this call resolved.
            await this.prisma.disputes.updateMany({
              where: { id, status: "resolved" },
              data: { status: "open", resolution: null, resolved_by: null },
            });
            throw new BadRequestException(
              `Dispute not resolved: the refund could not be processed (${err.message}). Please retry or refund manually.`,
            );
          }
          break;
        }

        case DisputeOutcome.RELEASE: {
          // Guarded claim, not a bare update: the payment was read before the
          // dispute was claimed, and in that gap a refund webhook (or another
          // flow) may have moved it off `captured`. Overwriting `refunded`
          // with `pending_release` would queue a payout for money already
          // returned to the parent — paid out twice, once to each side.
          const released = await this.prisma.payments.updateMany({
            where: { id: payment.id, status: PaymentStatus.CAPTURED },
            data: { status: PaymentStatus.PENDING_RELEASE },
          });
          if (released.count === 0) {
            // Payment changed underneath us — reopen the dispute and surface it.
            await this.prisma.disputes.updateMany({
              where: { id, status: "resolved" },
              data: { status: "open", resolution: null, resolved_by: null },
            });
            throw new BadRequestException(
              "Dispute not resolved: the payment is no longer in a releasable " +
                "state (it may have been refunded concurrently). Re-check and retry.",
            );
          }
          financialResult = "Payment released for payout to the caregiver.";
          break;
        }

        case DisputeOutcome.NO_ACTION:
        default:
          financialResult = null;
          break;
      }
    }

    // Every other state-changing flow in this codebase notifies the affected
    // user; dispute resolution was the one that left the raiser to poll.
    try {
      await this.notificationsService.createNotification(
        dispute.raised_by,
        "Your dispute has been resolved",
        [dto.resolution, financialResult].filter(Boolean).join(" "),
        "info",
        "dispute",
        id,
      );
    } catch (err) {
      this.logger.warn(
        `Dispute ${id} resolved but notification failed: ${err.message}`,
      );
    }

    // Re-read after the claim: updateMany returns no row.
    return this.prisma.disputes.findUnique({ where: { id } });
  }
}
