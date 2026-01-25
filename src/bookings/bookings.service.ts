import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { ChatService } from "../chat/chat.service";
import { NotificationsService } from "../notifications/notifications.service";
import { RequestsService } from "../requests/requests.service";

@Injectable()
export class BookingsService {
  constructor(
    private prisma: PrismaService,
    private chatService: ChatService,
    private notificationsService: NotificationsService,
    private requestsService: RequestsService,
  ) { }


  async createBooking(
    jobId: string | undefined,
    parentId: string,
    nannyId: string,
    date?: string,
    startTime?: string,
    endTime?: string,
  ) {
    let finalStartTime: Date | undefined;
    let finalEndTime: Date | undefined;

    // 1. If explicit date and times are provided, use them
    if (date && startTime && endTime) {
      // Combine date and time strings (e.g., "2025-11-24" + "T" + "15:30" + ":00")
      // Ensure time format is HH:MM or HH:MM:SS
      const formatTime = (t: string) => (t.length === 5 ? `${t}:00` : t);

      finalStartTime = new Date(`${date}T${formatTime(startTime)}`);
      finalEndTime = new Date(`${date}T${formatTime(endTime)}`);

      if (isNaN(finalStartTime.getTime()) || isNaN(finalEndTime.getTime())) {
        throw new BadRequestException("Invalid date or time format");
      }

      // Handle overnight bookings: if end time is before start time, it must be the next day
      if (finalEndTime < finalStartTime) {
        finalEndTime.setDate(finalEndTime.getDate() + 1);
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
      "Booking Confirmed",
      `Your booking has been successfully created.`,
      "success",
    );

    return booking;
  }


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

    return {
      ...booking,
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
        service_requests: true,
      },
      orderBy: { created_at: "desc" },
    });

    return bookings.map((booking) => {
      const nannyProfile = booking.users_bookings_nanny_idTousers?.profiles;
      return {
        ...booking,
        title: (booking.jobs?.title || (booking.service_requests ? `Care for ${booking.service_requests.num_children} ${Number(booking.service_requests.num_children) === 1 ? 'Child' : 'Children'}` : 'Care Service')) + (nannyProfile ? ` with ${nannyProfile.first_name} ${nannyProfile.last_name}` : ''),
        nanny_name: nannyProfile
          ? `${nannyProfile.first_name} ${nannyProfile.last_name}`
          : "Pending Assignment",
        nanny_profile: nannyProfile,
      };
    });
  }

  async getBookingsByNanny(nannyId: string) {
    return this.prisma.bookings.findMany({
      where: { nanny_id: nannyId },
      include: {
        users_bookings_parent_idTousers: {
          select: {
            id: true,
            profiles: true,
          },
        },
        jobs: true,
      },
      orderBy: { created_at: "desc" },
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

    return updatedBooking;
  }

  async completeBooking(id: string) {
    const booking = await this.prisma.bookings.findUnique({
      where: { id },
      include: {
        users_bookings_nanny_idTousers: {
          include: { nanny_details: true },
        },
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

    const hourlyRate = Number(
      booking.users_bookings_nanny_idTousers.nanny_details?.hourly_rate || 0,
    );
    const totalAmount = durationHours * hourlyRate;

    const updatedBooking = await this.prisma.bookings.update({
      where: { id },
      data: {
        status: "COMPLETED",
        actual_end_time: actualEndTime, // Use actual_end_time instead of overwriting end_time
        is_review_prompted: true,
      },
    });

    // Create Payment Record (Pending Release)
    // In a real flow, checking out triggers the Razorpay Order.
    // Here we create a placeholder record that will be updated or replaced when the parent initiates payment.
    await this.prisma.payments.create({
      data: {
        booking_id: id,
        amount: totalAmount,
        status: "pending_release",
        order_id: `pending_${id}_${Date.now()}`, // Placeholder until parent initiates actual payment flow
        provider: "manual_pending",
      },
    });

    // Notify Parent
    await this.notificationsService.createNotification(
      booking.parent_id,
      "Booking Completed",
      `The booking has been completed. Total amount: $${totalAmount.toFixed(2)}. Please leave a review!`,
      "success",
    );

    // Notify Nanny
    await this.notificationsService.createNotification(
      booking.nanny_id,
      "Booking Completed",
      `Great job! The booking is complete. Earnings: $${totalAmount.toFixed(2)}.`,
      "success",
    );

    return updatedBooking;
  }


  async cancelBooking(id: string, reason?: string, cancelledByUserId?: string) {
    const booking = await this.prisma.bookings.findUnique({
      where: { id },
      include: {
        users_bookings_nanny_idTousers: {
          include: { nanny_details: true },
        },
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

      await this.notificationsService.createNotification(
        booking.parent_id,
        "Nanny Cancelled - Re-matching",
        `The assigned nanny had to cancel. We are looking for a new match immediately.`,
        "warning",
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

      if (hoursUntilStart < 24 && booking.users_bookings_nanny_idTousers) {
        const hourlyRate = Number(
          booking.users_bookings_nanny_idTousers.nanny_details?.hourly_rate || 0,
        );
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
    if (booking.nanny_id) {
      await this.notificationsService.createNotification(
        booking.nanny_id,
        "Booking Cancelled",
        `The booking has been cancelled by the parent. Reason: ${reason || "No reason provided"}.`,
        "warning",
      );
    }

    // Only notify parent if it WASN'T the parent who cancelled (avoid double info)
    if (cancelledByUserId !== booking.parent_id) {
      await this.notificationsService.createNotification(
        booking.parent_id,
        "Booking Cancelled",
        `Your booking has been cancelled.${cancellationFee > 0 ? ` A cancellation fee of $${cancellationFee} applies.` : ""}`,
        "warning",
      );
    }

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
        service_requests: true,
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
}
