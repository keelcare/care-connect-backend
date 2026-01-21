import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { ChatService } from "../chat/chat.service";
import { NotificationsService } from "../notifications/notifications.service";

@Injectable()
export class BookingsService {
  constructor(
    private prisma: PrismaService,
    private chatService: ChatService,
    private notificationsService: NotificationsService,
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
      "success"
    );

    // Notify Parent
    await this.notificationsService.createNotification(
      parentId,
      "Booking Confirmed",
      `Your booking has been successfully created.`,
      "success"
    );

    return booking;
  }

  async getBookingById(id: string) {
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
      },
    });

    if (!booking) {
      throw new NotFoundException("Booking not found");
    }

    return booking;
  }

  async getBookingsByParent(parentId: string) {
    const bookings = await this.prisma.bookings.findMany({
      where: { parent_id: parentId },
      include: {
        users_bookings_nanny_idTousers: {
          select: {
            id: true,
            profiles: true,
          },
        },
        jobs: true,
      },
      orderBy: { created_at: "desc" },
    });

    return bookings.map((booking) => ({
      ...booking,
      nanny_name: booking.users_bookings_nanny_idTousers?.profiles
        ? `${booking.users_bookings_nanny_idTousers.profiles.first_name} ${booking.users_bookings_nanny_idTousers.profiles.last_name}`
        : "Nanny",
      nanny_profile: booking.users_bookings_nanny_idTousers?.profiles,
    }));
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
        start_time: new Date(), // Update actual start time
      },
    });

    // Notify Parent
    await this.notificationsService.createNotification(
      booking.parent_id,
      "Booking Started",
      `The nanny has started the booking.`,
      "info"
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
    if (booking.status !== "IN_PROGRESS") {
      throw new BadRequestException("Booking must be IN_PROGRESS to complete");
    }

    const endTime = new Date();
    const startTime = booking.start_time;
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
        end_time: endTime,
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

  async cancelBooking(id: string, reason?: string) {
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

    // Calculate Cancellation Fee
    // Rule: If cancelled < 24 hours before start, fee = 1 hour rate
    let cancellationFee = 0;
    let feeStatus = "no_fee";

    const now = new Date();
    const startTime = booking.start_time;
    const hoursUntilStart =
      (startTime.getTime() - now.getTime()) / (1000 * 60 * 60);

    if (hoursUntilStart < 24) {
      const hourlyRate = Number(
        booking.users_bookings_nanny_idTousers.nanny_details?.hourly_rate || 0,
      );
      cancellationFee = hourlyRate;
      feeStatus = "pending";
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
    await this.notificationsService.createNotification(
      booking.nanny_id,
      "Booking Cancelled",
      `The booking has been cancelled. Reason: ${reason || "No reason provided"}.`,
      "warning",
    );
    await this.notificationsService.createNotification(
      booking.parent_id,
      "Booking Cancelled",
      `The booking has been cancelled.${cancellationFee > 0 ? ` A cancellation fee of $${cancellationFee} applies.` : ""}`,
      "warning",
    );

    return updatedBooking;
  }

  async getActiveBookings(userId: string, role: "parent" | "nanny") {
    const whereClause =
      role === "parent" ? { parent_id: userId } : { nanny_id: userId };
    const bookings = await this.prisma.bookings.findMany({
      where: {
        ...whereClause,
        status: {
          in: ["CONFIRMED", "IN_PROGRESS"],
        },
      },
      include: {
        jobs: true,
        users_bookings_nanny_idTousers:
          role === "parent" ? { select: { profiles: true } } : undefined,
        users_bookings_parent_idTousers:
          role === "nanny" ? { select: { profiles: true } } : undefined,
      },
    });

    return bookings.map((b) => {
      const nannyProfile = b.users_bookings_nanny_idTousers?.profiles;
      const parentProfile = b.users_bookings_parent_idTousers?.profiles;

      return {
        ...b,
        nanny_name: nannyProfile
          ? `${nannyProfile.first_name} ${nannyProfile.last_name}`
          : role === "parent" ? "Nanny" : undefined,
        parent_name: parentProfile
          ? `${parentProfile.first_name} ${parentProfile.last_name}`
          : role === "nanny" ? "Parent" : undefined,
      };
    });
  }
}
