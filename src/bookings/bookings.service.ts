import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Inject,
  forwardRef,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { PricingUtils } from "../common/utils/pricing.utils";
import { ChatService } from "../chat/chat.service";
import { NotificationsService } from "../notifications/notifications.service";
import { RequestsService } from "../requests/requests.service";
import { SseService } from "../sse/sse.service";
import { SSE_EVENTS } from "../events/sse-event.types";
import { MailService } from "../mail/mail.service";
import { TimeUtils } from "../common/utils/time.utils";
import { PaymentsService } from "../payments/payments.service";

@Injectable()
export class BookingsService {
  constructor(
    private prisma: PrismaService,
    private chatService: ChatService,
    private notificationsService: NotificationsService,
    private requestsService: RequestsService,
    private sseService: SseService,
    private mailService: MailService,
    @Inject(forwardRef(() => PaymentsService))
    private paymentsService: PaymentsService,
  ) { }


  /*
  async createBooking(
    jobId: string | undefined,
    parentId: string,
    nannyId: string,
    date?: string,
    startTime?: string,
    endTime?: string,
  ) {
    // Validate nanny verification
    const nanny = await this.prisma.users.findUnique({
      where: { id: nannyId },
      include: { profiles: true }
    });

    if (!nanny) throw new NotFoundException("Nanny not found");

    if (nanny.role !== 'nanny') throw new BadRequestException("Selected user is not a nanny");

    if (nanny.identity_verification_status !== 'verified') {
      throw new BadRequestException("Cannot book an unverified nanny");
    }

    let finalStartTime: Date | undefined;
    let finalEndTime: Date | undefined;

    // 1. If explicit date and times are provided, use them
    if (date && startTime && endTime) {
      finalStartTime = TimeUtils.combineDateAndTime(date, startTime);
      finalEndTime = TimeUtils.combineDateAndTime(date, endTime);

      if (finalEndTime < finalStartTime) {
        // Handle overnight booking: if end time is earlier than start time, it's the next day
        finalEndTime = new Date(finalEndTime.getTime() + 24 * 60 * 60 * 1000);
      }
    }

    // 2. If no explicit time, try to get from Job
    if (!finalStartTime && jobId) {
      const job = await this.prisma.jobs.findUnique({ where: { id: jobId } });
      if (!job) {
        throw new NotFoundException("Job not found");
      }
      finalStartTime = job.date;
      // Job doesn't have end time in schema currently, so we leave it null or calculate if duration existed
    }

    // 3. Validate that we have a start time
    if (!finalStartTime) {
      throw new BadRequestException(
        "Date and Start time are required for direct bookings (or provide a valid Job ID)",
      );
    }

    // Create booking with initial status CONFIRMED
    const booking = await this.prisma.bookings.create({
      data: {
        job_id: jobId,
        parent_id: parentId,
        nanny_id: nannyId,
        status: "CONFIRMED",
        start_time: finalStartTime,
        end_time: finalEndTime,
      },
    });

    // Create a chat for this booking
    await this.chatService.createChat(booking.id);

    // Notify Nanny
    await this.notificationsService.createNotification(
      nannyId,
      "New Booking",
      `You have a new booking confirmed for ${finalStartTime.toDateString()}.`,
      "success",
    );

    // Notify Parent
    await this.notificationsService.createNotification(
      parentId,
      "Booking Confirmed!",
      `Your booking for ${finalStartTime.toDateString()} is confirmed.`,
      "success",
    );

    // Send Confirmation Emails (Outside the core logic but within the function context)
    const parent = await this.prisma.users.findUnique({
      where: { id: parentId },
      include: { profiles: true }
    });

    if (parent && nanny) {
      const parentName = `${parent.profiles?.first_name || ''} ${parent.profiles?.last_name || ''}`.trim() || 'Parent';
      const nannyName = `${nanny.profiles?.first_name || ''} ${nanny.profiles?.last_name || ''}`.trim() || 'Nanny';

      const bookingDetails = {
        date: finalStartTime.toISOString().split('T')[0],
        time: finalStartTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        duration: finalEndTime ? Math.round((finalEndTime.getTime() - finalStartTime.getTime()) / (1000 * 60 * 60)) : 0,
        location: parent.profiles?.address || 'Location specified in profile',
      };

      // Email to Parent
      this.mailService.sendBookingConfirmationEmail(
        parent.email,
        parentName,
        'parent',
        { ...bookingDetails, otherPartyName: nannyName }
      ).catch(err => console.error("Failed to send direct booking parent email", err));

      // Email to Nanny
      this.mailService.sendBookingConfirmationEmail(
        nanny.email,
        nannyName,
        'nanny',
        { ...bookingDetails, otherPartyName: parentName }
      ).catch(err => console.error("Failed to send direct booking nanny email", err));
    }

    // Emit SSE event to both parties
    const bookingCreatedEvent = {
      type: SSE_EVENTS.BOOKING_CREATED,
      data: booking,
      timestamp: new Date().toISOString(),
    };
    this.sseService.emitToUsers([nannyId, parentId], bookingCreatedEvent);

    return booking;
  }
  */


  async getBookingById(id: string) {
    // ... (existing code) ...
    const booking = await this.prisma.bookings.findUnique({
      where: { id },
      include: {
        jobs: true,
        users_bookings_parent_idTousers: {
          select: {
            id: true,
            profiles: true,
          },
        },
        users_bookings_nanny_idTousers: {
          select: {
            id: true,
            profiles: true,
            nanny_details: true,
          },
        },
        service_requests: true,
      },
    });

    if (!booking) {
      throw new NotFoundException("Booking not found");
    }

    const nannyProfile = booking.users_bookings_nanny_idTousers?.profiles;
    const parentProfile = booking.users_bookings_parent_idTousers?.profiles;

    const durationHours =
      booking.start_time && booking.end_time
        ? (new Date(booking.end_time).getTime() - new Date(booking.start_time).getTime()) / (1000 * 60 * 60)
        : 0;

    const service = await this.prisma.services.findUnique({
      where: { name: booking.service_requests?.category || 'CC' }
    });
    const hourlyRate = Number(service?.hourly_rate || 500);

    const { totalAmount } = PricingUtils.calculateTotal(
      hourlyRate,
      (durationHours > 0 ? durationHours : Number(booking.service_requests?.duration_hours || 0)),
      Number(booking.service_requests?.['discount_percentage'] || 0),
      Number(booking.service_requests?.['plan_duration_months'] || 1),
      booking.service_requests?.['plan_type'] || 'ONE_TIME'
    );

    return {
      ...booking,
      hourly_rate: hourlyRate,
      total_amount: totalAmount,
      title: (booking.jobs?.title || (booking.service_requests ? `Care for ${booking.service_requests.num_children} ${Number(booking.service_requests.num_children) === 1 ? 'Child' : 'Children'}` : 'Care Service')) + (nannyProfile ? ` with ${nannyProfile.first_name} ${nannyProfile.last_name}` : ''),
      nanny_name: nannyProfile
        ? `${nannyProfile.first_name} ${nannyProfile.last_name}`
        : "Pending Assignment",
      parent_name: parentProfile
        ? `${parentProfile.first_name} ${parentProfile.last_name}`
        : "Parent",
    };
  }


  async getBookingsByParent(parentId: string) {
    const bookings = await this.prisma.bookings.findMany({
      where: { parent_id: parentId },
      include: {
        users_bookings_nanny_idTousers: {
          select: {
            id: true,
            profiles: true,
            nanny_details: true,
          },
        },
        jobs: true,
        service_requests: {
          include: {
            assignments: {
              where: { status: { in: ["pending", "accepted"] } },
              include: { users: { include: { profiles: true, nanny_details: true } } },
            },
          }
        },
      },
      orderBy: { created_at: "desc" },
    });

    const allServices = await this.prisma.services.findMany();
    const serviceMap = Object.fromEntries(allServices.map(s => [s.name, Number(s.hourly_rate)]));

    return bookings.map((booking) => {
      const nannyProfile = booking.users_bookings_nanny_idTousers?.profiles;
      const rate = serviceMap[booking.service_requests?.category as string] || 500;
      const hours = (booking.start_time && booking.end_time)
        ? (new Date(booking.end_time).getTime() - new Date(booking.start_time).getTime()) / (1000 * 60 * 60)
        : Number(booking.service_requests?.duration_hours || 0);

      const { totalAmount } = PricingUtils.calculateTotal(
        rate,
        hours,
        Number(booking.service_requests?.['discount_percentage'] || 0),
        Number(booking.service_requests?.['plan_duration_months'] || 1),
        booking.service_requests?.['plan_type'] || 'ONE_TIME'
      );

      return {
        ...booking,
        hourly_rate: rate,
        total_amount: totalAmount,
        title: (booking.jobs?.title || (booking.service_requests ? `Care for ${booking.service_requests.num_children} ${Number(booking.service_requests.num_children) === 1 ? 'Child' : 'Children'}` : 'Care Service')) + (nannyProfile ? ` with ${nannyProfile.first_name} ${nannyProfile.last_name}` : ''),
        nanny_name: nannyProfile
          ? `${nannyProfile.first_name} ${nannyProfile.last_name}`
          : "Pending Assignment",
        nanny_profile: nannyProfile,
      };
    });
  }

  async getBookingsByNanny(nannyId: string) {
    const bookings = await this.prisma.bookings.findMany({
      where: { nanny_id: nannyId },
      include: {
        users_bookings_parent_idTousers: {
          select: {
            id: true,
            profiles: true,
          },
        },
        jobs: true,
        service_requests: true,
      },
      orderBy: { created_at: "desc" },
    });

    const allServices = await this.prisma.services.findMany();
    const serviceMap = Object.fromEntries(allServices.map(s => [s.name, Number(s.hourly_rate)]));

    return bookings.map(booking => {
      const rate = serviceMap[booking.service_requests?.category as string] || 500;
      const hours = (booking.start_time && booking.end_time)
        ? (new Date(booking.end_time).getTime() - new Date(booking.start_time).getTime()) / (1000 * 60 * 60)
        : Number(booking.service_requests?.duration_hours || 0);

      const { totalAmount } = PricingUtils.calculateTotal(
        rate,
        hours,
        Number(booking.service_requests?.['discount_percentage'] || 0),
        Number(booking.service_requests?.['plan_duration_months'] || 1),
        booking.service_requests?.['plan_type'] || 'ONE_TIME'
      );

      const parentProfile = booking.users_bookings_parent_idTousers?.profiles;

      return {
        ...booking,
        hourly_rate: rate,
        total_amount: totalAmount,
        title: (booking.jobs?.title || (booking.service_requests ? `Care for ${booking.service_requests.num_children} ${Number(booking.service_requests.num_children) === 1 ? 'Child' : 'Children'}` : 'Care Service')) + (parentProfile ? ` for ${parentProfile.first_name}` : ''),
      };
    });
  }

  async startBooking(id: string) {
    const booking = await this.prisma.bookings.findUnique({ where: { id } });
    if (!booking) throw new NotFoundException("Booking not found");
    if (booking.status !== "CONFIRMED") {
      throw new BadRequestException("Booking must be CONFIRMED to start");
    }

    const updatedBooking = await this.prisma.bookings.update({
      where: { id },
      data: {
        status: "IN_PROGRESS",
        actual_start_time: new Date(), // Use actual_start_time instead of overwriting start_time
      },
    });

    // Notify Parent
    await this.notificationsService.createNotification(
      booking.parent_id,
      "Booking Started",
      `The nanny has started the booking.`,
      "info",
    );

    // Emit SSE
    this.sseService.emitToUser(booking.parent_id, {
      type: SSE_EVENTS.BOOKING_STARTED,
      data: updatedBooking,
      timestamp: new Date().toISOString(),
    });

    return updatedBooking;
  }

  async handleNoShow(id: string, reason: string = "Parent No-Show") {
    const booking = await this.prisma.bookings.findUnique({ where: { id } });
    if (!booking) throw new NotFoundException("Booking not found");

    const updatedBooking = await this.prisma.bookings.update({
      where: { id },
      data: {
        status: booking.status === "CONFIRMED" ? "EXPIRED" : "PARENT_NO_SHOW", // Adaptive status
        cancellation_reason: reason,
      },
    });

    // Notify relevant parties
    await this.notificationsService.createNotification(
      booking.parent_id,
      "Booking Status Updated",
      `Your booking was marked as: ${updatedBooking.status}`,
      "info",
    );

    return updatedBooking;
  }

  async completeBooking(id: string) {
    const booking = await this.prisma.bookings.findUnique({
      where: { id },
      include: {
        users_bookings_nanny_idTousers: {
          include: { nanny_details: true },
        },
        service_requests: true,
        payments: true,
      },
    });
    if (!booking) throw new NotFoundException("Booking not found");

    // Handle idempotency/double-clicks gracefully
    if (booking.status === "COMPLETED") {
      return booking;
    }

    if (booking.status !== "IN_PROGRESS") {
      throw new BadRequestException(`Booking must be IN_PROGRESS to complete. Current status: ${booking.status}`);
    }

    // Safety checks to prevent 500 errors
    if (!booking.start_time || !booking.end_time) {
      throw new BadRequestException("Booking has no scheduled start or end time recorded.");
    }

    if (!booking.users_bookings_nanny_idTousers) {
      throw new BadRequestException("Booking has no assigned nanny.");
    }

    const actualEndTime = new Date();
    const startTime = booking.start_time;
    const endTime = booking.end_time;

    // Calculate duration based on original scheduled times
    const durationHours =
      (endTime.getTime() - startTime.getTime()) / (1000 * 60 * 60);

    const service = await this.prisma.services.findUnique({
      where: { name: booking.service_requests?.category || 'CC' }
    });
    const hourlyRate = Number(service?.hourly_rate || 500);
    const totalAmount = durationHours * hourlyRate;

    const updatedBooking = await this.prisma.bookings.update({
      where: { id },
      data: {
        status: "COMPLETED",
        actual_end_time: actualEndTime, // Use actual_end_time instead of overwriting end_time
        is_review_prompted: true,
      },
    });

    // 2. Handle Payment: Update existing or create pending_release
    // Check if any payment already exists for this booking (could be captured from a subscription)
    const existingPayment = booking.payments?.[0];

    if (existingPayment) {
      if (existingPayment.status === 'captured') {
        // Parent already paid, now it's "pending_release" to the nanny
        await this.paymentsService.updatePaymentStatus(
          existingPayment.id,
          "pending_release",
          "bookings:booking_completed",
          { booking_id: id }
        );
      }
      // If payment is already pending_release or other, keep it as is
    } else {
      // No payment found, create a manual pending_release record
      await this.prisma.payments.create({
        data: {
          booking_id: id,
          amount: totalAmount,
          status: "pending_release",
          order_id: `manual_pending_${id}_${Date.now()}`,
          provider: "manual_pending",
        },
      });
    }

    // Notify Parent
    await this.notificationsService.createNotification(
      booking.parent_id,
      "Booking Completed",
      `The booking has been completed. Total amount: ₹${totalAmount.toFixed(2)}. Please leave a review!`,
      "success",
    );

    // Notify Nanny
    await this.notificationsService.createNotification(
      booking.nanny_id,
      "Booking Completed",
      `Great job! The booking is complete. Earnings: ₹${totalAmount.toFixed(2)}.`,
      "success",
    );

    // Emit SSE
    const completedEvent = {
      type: SSE_EVENTS.BOOKING_COMPLETED,
      data: { ...updatedBooking, totalAmount },
      timestamp: new Date().toISOString(),
    };
    this.sseService.emitToUsers([booking.parent_id, booking.nanny_id].filter(Boolean) as string[], completedEvent);

    return updatedBooking;
  }


  async cancelBooking(id: string, reason?: string, cancelledByUserId?: string) {
    const booking = await this.prisma.bookings.findUnique({
      where: { id },
      include: {
        users_bookings_nanny_idTousers: {
          include: { profiles: true, nanny_details: true },
        },
        users_bookings_parent_idTousers: {
          include: { profiles: true },
        },
        service_requests: true,
      },
    });
    if (!booking) throw new NotFoundException("Booking not found");

    if (["COMPLETED", "CANCELLED"].includes(booking.status)) {
      throw new BadRequestException(
        "Cannot cancel a completed or already cancelled booking",
      );
    }

    // Special Handling: Random Assignment Nanny Cancellation
    if (
      cancelledByUserId &&
      booking.nanny_id === cancelledByUserId &&
      booking.request_id
    ) {
      console.log(`Nanny cancelled random assignment booking ${id}. Triggering re-match.`);

      // 1. Find the active assignment (accepted)
      const assignment = await this.prisma.assignments.findFirst({
        where: {
          request_id: booking.request_id,
          nanny_id: booking.nanny_id,
          status: 'accepted'
        }
      });

      if (assignment) {
        await this.prisma.assignments.update({
          where: { id: assignment.id },
          data: {
            status: 'rejected',
            rejection_reason: `Cancelled after booking: ${reason}`,
            responded_at: new Date()
          }
        });
      }

      // 2. Revert Booking to Pending and Cleanup Chat
      const updatedBooking = await this.prisma.bookings.update({
        where: { id },
        data: {
          status: "requested",
          nanny_id: null,
          cancellation_reason: `Previous Nanny Cancelled: ${reason}`,
        },
      });

      await this.chatService.deleteChatByBookingId(id);

      // 3. Update Service Request (set back to pending from assigned)
      await this.prisma.service_requests.update({
        where: { id: booking.request_id },
        data: { status: 'pending', current_assignment_id: null }
      });

      // 4. Trigger Re-matching
      this.requestsService.triggerMatching(booking.request_id).catch(err => {
        console.error("Failed to re-trigger matching", err);
      });

      await this.notificationsService.notifyNannyCancellationToParent(
        booking.parent_id,
        booking.id,
        true, // willRematch = true
        reason,
      );

      return updatedBooking;
    }

    // Special Handling: Parent Cancellation
    if (cancelledByUserId && booking.parent_id === cancelledByUserId) {
      console.log(`Parent cancelled booking ${id}.`);

      // 1. If there's an associated service request, cancel it too
      if (booking.request_id) {
        await this.prisma.service_requests.update({
          where: { id: booking.request_id },
          data: { status: 'CANCELLED' }
        });

        // Also cancel any pending/accepted assignment for this request
        await this.prisma.assignments.updateMany({
          where: { request_id: booking.request_id, status: { in: ['pending', 'accepted'] } },
          data: { status: 'cancelled', responded_at: new Date() }
        });
      }

      // 2. Proceed to standard cancellation (status, fees, notifications)
    }

    // Standard Cancellation Logic

    // Calculate Cancellation Fee
    let cancellationFee = 0;
    let feeStatus = "no_fee";

    const now = new Date();
    const startTime = booking.start_time;
    if (startTime) {
      const hoursUntilStart =
        (startTime.getTime() - now.getTime()) / (1000 * 60 * 60);

      if (hoursUntilStart < 24 && booking.service_requests) {
        const service = await this.prisma.services.findUnique({
          where: { name: booking.service_requests.category || 'CC' }
        });
        const hourlyRate = Number(service?.hourly_rate || 500);

        cancellationFee = hourlyRate;
        feeStatus = "pending";
      }
    }

    const updatedBooking = await this.prisma.bookings.update({
      where: { id },
      data: {
        status: "CANCELLED",
        cancellation_reason: reason,
        cancellation_fee: cancellationFee,
        cancellation_fee_status: feeStatus,
      },
    });

    // Notify both parties
    try {
      const parentUser = booking.users_bookings_parent_idTousers;
      const nannyUser = booking.users_bookings_nanny_idTousers;
      const parentName = `${parentUser?.profiles?.first_name || ''} ${parentUser?.profiles?.last_name || ''}`.trim() || 'Parent';
      const nannyName = `${nannyUser?.profiles?.first_name || ''} ${nannyUser?.profiles?.last_name || ''}`.trim() || 'Nanny';
      const bookingDate = booking.start_time ? booking.start_time.toLocaleDateString() : 'Scheduled Date';

      if (booking.nanny_id) {
        // If parent cancelled, notify nanny. If nanny cancelled herself, she knows.
        if (cancelledByUserId === booking.parent_id) {
          await this.notificationsService.createNotification(
            booking.nanny_id,
            "Booking Cancelled",
            `The booking has been cancelled by the parent. Reason: ${reason || "No reason provided"}.`,
            "warning",
          );

          // Send email to Nanny Since Parent Cancelled
          if (nannyUser?.email) {
            this.mailService.sendCancellationEmail(
              nannyUser.email,
              nannyName,
              'nanny',
              {
                date: bookingDate,
                reason: reason || 'No reason provided',
                otherPartyName: parentName,
                cancelledBy: 'parent',
              }
            ).catch(err => console.error("Failed to send cancellation email to nanny", err));
          }
        }
      }

      // Notify parent if nanny cancelled
      if (cancelledByUserId === booking.nanny_id) {
        await this.notificationsService.notifyNannyCancellationToParent(
          booking.parent_id,
          booking.id,
          false, // willRematch = false
          reason,
        );

        // Send email to Parent Since Nanny Cancelled
        if (parentUser?.email) {
          this.mailService.sendCancellationEmail(
            parentUser.email,
            parentName,
            'parent',
            {
              date: bookingDate,
              reason: reason || 'No reason provided',
              otherPartyName: nannyName,
              cancelledBy: 'nanny',
            }
          ).catch(err => console.error("Failed to send cancellation email to parent", err));
        }
      } else if (cancelledByUserId && cancelledByUserId !== booking.parent_id) {
        // Some other cancellation (admin?)
        if (booking.parent_id) {
          await this.notificationsService.createNotification(
            booking.parent_id,
            "Booking Cancelled",
            `Your booking has been cancelled.${cancellationFee > 0 ? ` A cancellation fee of ₹${cancellationFee} applies.` : ""}`,
            "warning",
          );
        }
      }
    } catch (error) {
      console.error("Failed to send cancellation notification:", error);
      // Don't fail the request if notification fails, the booking is already cancelled
    }

    // Emit SSE cancellation event to both parties
    const cancelledEvent = {
      type: SSE_EVENTS.BOOKING_CANCELLED,
      data: { ...updatedBooking, cancellation_reason: reason },
      timestamp: new Date().toISOString(),
    };
    const recipients = [booking.parent_id, booking.nanny_id].filter(Boolean) as string[];
    this.sseService.emitToUsers(recipients, cancelledEvent);

    return updatedBooking;
  }

  async getActiveBookings(userId: string, role: "parent" | "nanny") {
    const whereClause =
      role === "parent" ? { parent_id: userId } : { nanny_id: userId };
    const bookings = await this.prisma.bookings.findMany({
      where: {
        ...whereClause,
        status: {
          in: ["requested", "pending", "accepted", "CONFIRMED", "IN_PROGRESS"],
        },
      },
      include: {
        jobs: true,
        users_bookings_nanny_idTousers: {
          select: {
            id: true,
            profiles: true,
            nanny_details: true
          }
        },
        users_bookings_parent_idTousers: {
          select: {
            id: true,
            profiles: true
          }
        },
        service_requests: {
          include: {
            assignments: {
              where: { status: { in: ["pending", "accepted"] } },
              include: { users: { include: { profiles: true, nanny_details: true } } },
            },
          }
        },
      },
    });

    return bookings.map((b) => {
      const nannyProfile = b.users_bookings_nanny_idTousers?.profiles;
      const parentProfile = b.users_bookings_parent_idTousers?.profiles;

      return {
        ...b,
        title: (b.jobs?.title || (b.service_requests ? `Care for ${b.service_requests.num_children} ${Number(b.service_requests.num_children) === 1 ? 'Child' : 'Children'}` : 'Care Service')) + (nannyProfile ? ` with ${nannyProfile.first_name} ${nannyProfile.last_name}` : ''),
        nanny_name: nannyProfile
          ? `${nannyProfile.first_name} ${nannyProfile.last_name}`
          : "Pending Assignment",
        parent_name: parentProfile
          ? `${parentProfile.first_name} ${parentProfile.last_name}`
          : "Parent",
      };
    });
  }
  async checkExpiredBookings() {
    const now = TimeUtils.nowIST();
    const unstartedCutoff = new Date(now.getTime() - 4 * 60 * 60 * 1000);
    const inProgressCutoff = new Date(now.getTime() - 8 * 60 * 60 * 1000);

    // 1. Handle Unstarted Bookings (CONFIRMED -> EXPIRED)
    const unstartedBookings = await this.prisma.bookings.findMany({
      where: {
        status: { in: ["CONFIRMED", "requested"] },
        start_time: { lt: unstartedCutoff },
      },
    });

    for (const booking of unstartedBookings) {
      await this.handleNoShow(booking.id, "System Auto-expiration: Booking never started");
    }

    // 2. Handle Stuck In-Progress (IN_PROGRESS -> COMPLETED)
    const stuckBookings = await this.prisma.bookings.findMany({
      where: {
        status: "IN_PROGRESS",
        end_time: { lt: inProgressCutoff },
      },
    });
    for (const booking of stuckBookings) {
      await this.prisma.bookings.update({
        where: { id: booking.id },
        data: {
          status: "COMPLETED",
          actual_end_time: now,
          tags: ["auto-completed"],
        },
      });
    }

    return {
      expired: unstartedBookings.length,
      autoCompleted: stuckBookings.length,
    };
  }

  async reportNoShow(id: string, reportingUserId: string, reason: string) {
    const booking = await this.prisma.bookings.findUnique({
      where: { id },
    });

    if (!booking) throw new NotFoundException("Booking not found");

    if (booking.status !== "CONFIRMED") {
      throw new BadRequestException("Only confirmed bookings can be reported as a no-show.");
    }

    if (booking.parent_id !== reportingUserId && booking.nanny_id !== reportingUserId) {
      throw new ForbiddenException("Not authorized to report on this booking.");
    }

    const isNannyReporting = booking.nanny_id === reportingUserId;
    const noShowTag = isNannyReporting ? "parent_noshow" : "nanny_noshow";

    const updatedBooking = await this.prisma.bookings.update({
      where: { id },
      data: {
        status: "CANCELLED",
        cancellation_reason: `Reported No-Show by ${isNannyReporting ? 'Nanny' : 'Parent'}: ${reason}`,
        tags: ["noshow", noShowTag],
      },
    });

    // Notify the other party
    const notifiedUserId = isNannyReporting ? booking.parent_id : booking.nanny_id;
    if (notifiedUserId) {
      await this.notificationsService.createNotification(
        notifiedUserId,
        "Booking Cancelled (No-Show Reported)",
        `The other party reported a no-show for this booking. Reason: ${reason}`,
        "warning"
      );
    }

    return updatedBooking;
  }

  async rescheduleBooking(
    id: string,
    newDate: string,
    newStartTime: string,
    newEndTime: string,
    userId: string,
  ) {
    // 1. Fetch the booking
    const booking = await this.prisma.bookings.findUnique({
      where: { id },
      include: {
        users_bookings_nanny_idTousers: {
          include: { nanny_details: true, profiles: true },
        },
        users_bookings_parent_idTousers: {
          include: { profiles: true },
        },
      },
    });

    if (!booking) {
      throw new NotFoundException("Booking not found");
    }

    // 2. Authorization check - only parent can reschedule
    if (booking.parent_id !== userId) {
      throw new BadRequestException(
        "Only the parent can reschedule this booking",
      );
    }

    // 3. Status validation
    if (!["CONFIRMED", "REQUESTED", "requested"].includes(booking.status)) {
      throw new BadRequestException(
        "Only confirmed or requested bookings can be rescheduled",
      );
    }

    // 4. Parse and validate new date/time
    const formatTime = (t: string) => (t.length === 5 ? `${t}:00` : t);
    const newStartDateTime = new Date(
      `${newDate}T${formatTime(newStartTime)}+05:30`, // Explicitly Enforce IST
    );
    const newEndDateTime = new Date(
      `${newDate}T${formatTime(newEndTime)}+05:30`, // Explicitly Enforce IST
    );

    if (
      isNaN(newStartDateTime.getTime()) ||
      isNaN(newEndDateTime.getTime())
    ) {
      throw new BadRequestException("Invalid date or time format");
    }

    // Handle overnight bookings
    if (newEndDateTime < newStartDateTime) {
      newEndDateTime.setDate(newEndDateTime.getDate() + 1);
    }

    // 5. Prevent rescheduling to past
    if (newStartDateTime < new Date()) {
      throw new BadRequestException("Cannot reschedule to a past date/time");
    }

    // 6. Store original times if this is the first reschedule
    const updateData: any = {
      start_time: newStartDateTime,
      end_time: newEndDateTime,
      reschedule_count: (booking.reschedule_count || 0) + 1,
      last_rescheduled_at: new Date(),
    };

    if (!booking.original_start_time) {
      updateData.original_start_time = booking.start_time;
      updateData.original_end_time = booking.end_time;
    }

    // 7. Update the booking and associated service request
    const updatedBooking = await this.prisma.$transaction(async (tx) => {
      // a. Update service_request if it exists
      if (booking.request_id) {
        const durationHours = (newEndDateTime.getTime() - newStartDateTime.getTime()) / (1000 * 60 * 60);

        await tx.service_requests.update({
          where: { id: booking.request_id },
          data: {
            date: new Date(`${newDate}T00:00:00+05:30`),
            start_time: newStartDateTime,
            duration_hours: durationHours,
            status: booking.status === "CONFIRMED" ? "accepted" : "pending",
          },
        });
      }

      // b. Update the booking
      return tx.bookings.update({
        where: { id },
        data: updateData,
      });
    });

    // 8. Trigger re-matching if no nanny is assigned
    if (booking.request_id && !updatedBooking.nanny_id) {
      console.log(`Re-triggering matching for rescheduled booking ${id} (Request ${booking.request_id})`);
      this.requestsService.triggerMatching(booking.request_id).catch(err => {
        console.error("Failed to re-trigger matching after reschedule", err);
      });
    }

    // 9. Send notifications
    const nannyProfile = booking.users_bookings_nanny_idTousers?.profiles;
    const nannyName = nannyProfile
      ? `${nannyProfile.first_name} ${nannyProfile.last_name}`
      : "the nanny";

    if (booking.nanny_id) {
      await this.notificationsService.createNotification(
        booking.nanny_id,
        "Booking Rescheduled",
        `A booking has been rescheduled to ${newStartDateTime.toLocaleDateString()} at ${newStartTime}.`,
        "info",
      );
    }

    await this.notificationsService.createNotification(
      booking.parent_id,
      "Booking Rescheduled",
      `Your booking ${nannyProfile ? `with ${nannyName}` : "request"} has been successfully rescheduled to ${newStartDateTime.toLocaleDateString()} at ${newStartTime}.`,
      "success",
    );

    // Emit SSE
    const rescheduledEvent = {
      type: SSE_EVENTS.BOOKING_RESCHEDULED,
      data: updatedBooking,
      timestamp: new Date().toISOString(),
    };
    const rescheduledRecipients = [booking.parent_id, booking.nanny_id].filter(Boolean) as string[];
    this.sseService.emitToUsers(rescheduledRecipients, rescheduledEvent);

    return updatedBooking;
  }
}
