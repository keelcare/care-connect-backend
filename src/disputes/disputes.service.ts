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

    const updated = await this.prisma.disputes.update({
      where: { id },
      data: {
        status: "resolved",
        resolution: dto.resolution,
        resolved_by: adminId,
        updated_at: new Date(),
      },
    });

    // Financial outcome, taken from the explicit `outcome` field rather than
    // sniffed out of the resolution text — see DisputeOutcome for why.
    const payment = dispute.bookings?.payments?.[0];
    let financialResult: string | null = null;

    if (payment && payment.status === PaymentStatus.CAPTURED) {
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
            await this.prisma.disputes.update({
              where: { id },
              data: { status: "open", resolution: null, resolved_by: null },
            });
            throw new BadRequestException(
              `Dispute not resolved: the refund could not be processed (${err.message}). Please retry or refund manually.`,
            );
          }
          break;
        }

        case DisputeOutcome.RELEASE: {
          await this.prisma.payments.update({
            where: { id: payment.id },
            data: { status: PaymentStatus.PENDING_RELEASE },
          });
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

    return updated;
  }
}
