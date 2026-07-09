import { Injectable, Logger } from "@nestjs/common";
import { OnEvent, EventEmitter2 } from "@nestjs/event-emitter";
import { 
  BookingCreatedEvent, 
  BookingStartedEvent, 
  BookingCompletedEvent, 
  BookingCancelledEvent, 
  BookingRescheduledEvent,
  BOOKING_EVENTS 
} from "../events/booking.events";
import { ChatService } from "../../chat/chat.service";
import { NotificationsService } from "../../notifications/notifications.service";
import { MailService } from "../../mail/mail.service";
import { SseService } from "../../sse/sse.service";
import { PrismaService } from "../../prisma/prisma.service";
import { SSE_EVENTS } from "../../events/sse-event.types";
import { PaymentsService } from "../../payments/payments.service";
import { BookingStatus } from "../../common/constants/booking-status.enum";

@Injectable()
export class BookingListeners {
  private readonly logger = new Logger(BookingListeners.name);

  constructor(
    private readonly chatService: ChatService,
    private readonly notificationsService: NotificationsService,
    private readonly mailService: MailService,
    private readonly sseService: SseService,
    private readonly prisma: PrismaService,
    private readonly paymentsService: PaymentsService,
  ) {}

  @OnEvent(BOOKING_EVENTS.CREATED)
  async handleBookingCreated(event: BookingCreatedEvent) {
    const { booking } = event;
    this.logger.log(`Handling booking.created for booking: ${booking.id}`);

    try {
      await this.chatService.createChat(booking.id).catch(err => 
        this.logger.error(`Failed to create chat for booking ${booking.id}: ${err.message}`)
      );

      if (booking.nanny_id) {
        await this.notificationsService.createNotification(
          booking.nanny_id,
          "New Booking",
          `You have a new booking confirmed for ${booking.start_time.toDateString()}.`,
          "success",
        ).catch(err => 
          this.logger.error(`Failed to notify nanny for booking ${booking.id}: ${err.message}`)
        );
      }

      await this.notificationsService.createNotification(
        booking.parent_id,
        "Booking Confirmed!",
        `Your booking for ${booking.start_time.toDateString()} is confirmed.`,
        "success",
      ).catch(err => 
        this.logger.error(`Failed to notify parent for booking ${booking.id}: ${err.message}`)
      );

      this.sendConfirmationEmails(booking);

      this.sseService.emitToUsers(
        [booking.nanny_id, booking.parent_id].filter(Boolean) as string[],
        {
          type: SSE_EVENTS.BOOKING_CREATED,
          data: booking,
          timestamp: new Date().toISOString(),
        }
      );
    } catch (error) {
      this.logger.error(`Error in handleBookingCreated: ${error.message}`);
    }
  }

  @OnEvent(BOOKING_EVENTS.STARTED)
  async handleBookingStarted(event: BookingStartedEvent) {
    const { booking } = event;
    if (booking.parent_id) {
      await this.notificationsService.createNotification(
        booking.parent_id,
        "Booking Started",
        `The nanny has started the booking.`,
        "info",
      ).catch(err => this.logger.error(`Failed to notify parent: ${err.message}`));

      this.sseService.emitToUser(booking.parent_id, {
        type: SSE_EVENTS.BOOKING_STARTED,
        data: booking,
        timestamp: new Date().toISOString(),
      });
    }
  }

  @OnEvent(BOOKING_EVENTS.COMPLETED)
  async handleBookingCompleted(event: BookingCompletedEvent) {
    const { booking, totalAmount } = event;
    
    // 1. Payment Update (Decoupled from BookingsService core logic)
    const existingPayment = await this.prisma.payments.findFirst({
      where: { booking_id: booking.id }
    });

    if (existingPayment && existingPayment.status === "captured") {
      await this.paymentsService.updatePaymentStatus(
        existingPayment.id,
        "pending_release",
        "bookings:booking_completed",
        { booking_id: booking.id },
      ).catch(err => this.logger.error(`Failed to update payment status: ${err.message}`));
    } else if (!existingPayment) {
      await this.prisma.payments.create({
        data: {
          booking_id: booking.id,
          amount: totalAmount,
          status: "pending_release",
          order_id: `manual_pending_${booking.id}_${Date.now()}`,
          provider: "manual_pending",
        },
      }).catch(err => this.logger.error(`Failed to create manual payment: ${err.message}`));
    }

    // 2. Notifications
    await this.notificationsService.createNotification(
      booking.parent_id,
      "Booking Completed",
      `The booking has been completed. Total amount: ₹${totalAmount.toFixed(2)}. Please leave a review!`,
      "success",
    ).catch(err => this.logger.error(`Failed to notify parent: ${err.message}`));

    if (booking.nanny_id) {
      await this.notificationsService.createNotification(
        booking.nanny_id,
        "Booking Completed",
        `Great job! The booking is complete. Earnings: ₹${totalAmount.toFixed(2)}.`,
        "success",
      ).catch(err => this.logger.error(`Failed to notify nanny: ${err.message}`));
    }

    // 3. SSE
    this.sseService.emitToUsers(
      [booking.parent_id, booking.nanny_id].filter(Boolean) as string[],
      {
        type: SSE_EVENTS.BOOKING_COMPLETED,
        data: { ...booking, totalAmount },
        timestamp: new Date().toISOString(),
      }
    );
  }

  @OnEvent(BOOKING_EVENTS.CANCELLED)
  async handleBookingCancelled(event: BookingCancelledEvent) {
    const { booking, reason, cancelledByUserId } = event;
    
    const [parentUser, nannyUser] = await Promise.all([
      this.prisma.users.findUnique({ where: { id: booking.parent_id }, include: { profiles: true } }),
      booking.nanny_id ? this.prisma.users.findUnique({ where: { id: booking.nanny_id }, include: { profiles: true } }) : null,
    ]);

    const parentName = `${parentUser?.profiles?.first_name || ""} ${parentUser?.profiles?.last_name || ""}`.trim() || "Parent";
    const nannyName = `${nannyUser?.profiles?.first_name || ""} ${nannyUser?.profiles?.last_name || ""}`.trim() || "Nanny";
    const bookingDate = booking.start_time ? booking.start_time.toLocaleDateString() : "Scheduled Date";

    // Notify Nanny if Parent cancelled
    if (booking.nanny_id && cancelledByUserId === booking.parent_id) {
      await this.notificationsService.createNotification(
        booking.nanny_id,
        "Booking Cancelled",
        `The booking has been cancelled by the parent. Reason: ${reason || "No reason provided"}.`,
        "warning",
      );

      if (nannyUser?.email) {
        this.mailService.sendCancellationEmail(nannyUser.email, nannyName, "nanny", {
          date: bookingDate,
          reason: reason || "No reason provided",
          otherPartyName: parentName,
          cancelledBy: "parent",
        }).catch(err => this.logger.error(`Email fail: ${err.message}`));
      }
    }

    // Notify Parent if Nanny cancelled
    if (cancelledByUserId === booking.nanny_id) {
      await this.notificationsService.notifyNannyCancellationToParent(
        booking.parent_id,
        booking.id,
        true, // assuming true here as service does trigger re-matching
        reason,
      );

      if (parentUser?.email) {
        this.mailService.sendCancellationEmail(parentUser.email, parentName, "parent", {
          date: bookingDate,
          reason: reason || "No reason provided",
          otherPartyName: nannyName,
          cancelledBy: "nanny",
        }).catch(err => this.logger.error(`Email fail: ${err.message}`));
      }
    }

    // System-driven cancellation (auto-expiry / no-show sweep) has no acting user,
    // so neither branch above fires — notify both parties explicitly.
    if (!cancelledByUserId) {
      const title = booking.status === BookingStatus.EXPIRED ? "Booking expired" : "Booking cancelled";
      const message = `Your booking on ${bookingDate} was ${booking.status === BookingStatus.EXPIRED ? "automatically expired" : "cancelled"}. Reason: ${reason || "No reason provided"}.`;

      await this.notificationsService
        .createNotification(booking.parent_id, title, message, "warning", "booking", booking.id)
        .catch((err) => this.logger.error(`Failed to notify parent of system cancellation: ${err.message}`));

      if (booking.nanny_id) {
        await this.notificationsService
          .createNotification(booking.nanny_id, title, message, "warning", "booking", booking.id)
          .catch((err) => this.logger.error(`Failed to notify nanny of system cancellation: ${err.message}`));
      }
    }

    // Always delete chat on cancellation
    await this.chatService.deleteChatByBookingId(booking.id).catch(err =>
      this.logger.error(`Failed to delete chat for cancelled booking ${booking.id}: ${err.message}`)
    );
  }

  @OnEvent(BOOKING_EVENTS.RESCHEDULED)
  async handleBookingRescheduled(event: BookingRescheduledEvent) {
    const { booking, oldBooking } = event;
    const nannyProfile = (booking as any).users_bookings_nanny_idTousers?.profiles;
    const nannyName = nannyProfile
      ? `${nannyProfile.first_name} ${nannyProfile.last_name}`
      : "the nanny";

    const startTimeStr = new Date(booking.start_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    if (booking.nanny_id) {
      await this.notificationsService.createNotification(
        booking.nanny_id,
        "Booking Rescheduled",
        `A booking has been rescheduled to ${new Date(booking.start_time).toLocaleDateString()} at ${startTimeStr}.`,
        "info",
      ).catch(err => this.logger.error(`Failed to notify nanny: ${err.message}`));
    }

    await this.notificationsService.createNotification(
      booking.parent_id,
      "Booking Rescheduled",
      `Your booking ${nannyProfile ? `with ${nannyName}` : "request"} has been successfully rescheduled to ${new Date(booking.start_time).toLocaleDateString()} at ${startTimeStr}.`,
      "success",
    ).catch(err => this.logger.error(`Failed to notify parent: ${err.message}`));

    // Emit SSE
    this.sseService.emitToUsers(
      [booking.parent_id, booking.nanny_id].filter(Boolean) as string[],
      {
        type: SSE_EVENTS.BOOKING_RESCHEDULED,
        data: booking,
        timestamp: new Date().toISOString(),
      }
    );
  }

  private async sendConfirmationEmails(booking: any) {
    try {
      const [parent, nanny] = await Promise.all([
        this.prisma.users.findUnique({
          where: { id: booking.parent_id },
          include: { profiles: true },
        }),
        booking.nanny_id ? this.prisma.users.findUnique({
          where: { id: booking.nanny_id },
          include: { profiles: true },
        }) : null,
      ]);

      if (parent && nanny) {
        const parentName = `${parent.profiles?.first_name || ""} ${parent.profiles?.last_name || ""}`.trim() || "Parent";
        const nannyName = `${nanny.profiles?.first_name || ""} ${nanny.profiles?.last_name || ""}`.trim() || "Nanny";

        const bookingDetails = {
          date: booking.start_time.toISOString().split("T")[0],
          time: booking.start_time.toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          }),
          duration: booking.end_time
            ? Math.round((booking.end_time.getTime() - booking.start_time.getTime()) / (1000 * 60 * 60))
            : 0,
          location: parent.profiles?.address || "Location specified in profile",
        };

        this.mailService.sendBookingConfirmationEmail(parent.email, parentName, "parent", {
          ...bookingDetails,
          otherPartyName: nannyName,
        }).catch(err => this.logger.error(`Email fail: ${err.message}`));

        this.mailService.sendBookingConfirmationEmail(nanny.email, nannyName, "nanny", {
          ...bookingDetails,
          otherPartyName: parentName,
        }).catch(err => this.logger.error(`Email fail: ${err.message}`));
      }
    } catch (error) {
      this.logger.error(`Error sending emails: ${error.message}`);
    }
  }
}
