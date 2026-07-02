import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Inject,
  forwardRef,
  Logger,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { Pagination, paginate } from "../common/utils/pagination.util";
import { TimeUtils } from "../common/utils/time.utils";
import { PaymentsService } from "../payments/payments.service";
import { GeoUtils } from "../common/utils/geo.utils";
import { EventEmitter2 } from "@nestjs/event-emitter";
import {
  BOOKING_EVENTS,
  BookingCreatedEvent,
  BookingStartedEvent,
  BookingCompletedEvent,
  BookingCancelledEvent,
  BookingRescheduledEvent,
} from "./events/booking.events";
import { BookingStatus } from "../constants";
import { PricingEngineService } from "../common/pricing.service";
import { RequestsService } from "../requests/requests.service";
import { SSE_EVENTS } from "../events/sse-event.types";
import { ProgressReportsService } from "../progress-reports/progress-reports.service";
import {
  BOOKING_UNSTARTED_EXPIRY_MS,
  BOOKING_IN_PROGRESS_MAX_MS,
  PROGRESS_REPORT_DUE_HOURS,
} from "../common/constants/constants";
import { Prisma } from "@prisma/client";


@Injectable()
export class BookingsService {
  private readonly logger = new Logger(BookingsService.name);
  constructor(
    private prisma: PrismaService,
    private requestsService: RequestsService,
    private eventEmitter: EventEmitter2,
    private pricingService: PricingEngineService,
    @Inject(forwardRef(() => PaymentsService))
    private paymentsService: PaymentsService,
    @Inject(forwardRef(() => ProgressReportsService))
    private progressReportsService: ProgressReportsService,
  ) { }

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
      include: { profiles: true },
    });

    if (!nanny) throw new NotFoundException("Nanny not found");

    if (nanny.role !== "nanny")
      throw new BadRequestException("Selected user is not a nanny");

    // Validate nanny verification status
    if (nanny.identity_verification_status !== "verified") {
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
        status: BookingStatus.CONFIRMED,
        start_time: finalStartTime,
        end_time: finalEndTime,
      },
    });

    // Emit event - side effects (Chat, Notifications, Mail, SSE) are handled by listeners
    this.eventEmitter.emit(BOOKING_EVENTS.CREATED, new BookingCreatedEvent(booking));

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

    const durationHours =
      booking.start_time && booking.end_time
        ? (new Date(booking.end_time).getTime() -
          new Date(booking.start_time).getTime()) /
        (1000 * 60 * 60)
        : 0;

    const { totalAmount, appliedRate } = await this.pricingService.calculateCost(
      booking.service_requests?.category || "CC",
      durationHours > 0
        ? durationHours
        : Number(booking.service_requests?.duration_hours || 0),
      Number(booking.service_requests?.["discount_percentage"] || 0),
      Number(booking.service_requests?.["plan_duration_months"] || 1),
      booking.service_requests?.["plan_type"] || "ONE_TIME",
      booking.service_requests?.["sessions_per_month"] || 1,
    );

    return {
      ...booking,
      hourly_rate: appliedRate,
      total_amount: totalAmount,
      title:
        (booking.jobs?.title ||
          (booking.service_requests
            ? `Care for ${booking.service_requests.num_children} ${Number(booking.service_requests.num_children) === 1 ? "Child" : "Children"}`
            : "Care Service")) +
        (nannyProfile
          ? ` with ${nannyProfile.first_name} ${nannyProfile.last_name}`
          : ""),
      nanny_name: nannyProfile
        ? `${nannyProfile.first_name} ${nannyProfile.last_name}`
        : "Pending Assignment",
      parent_name: parentProfile
        ? `${parentProfile.first_name} ${parentProfile.last_name}`
        : "Parent",
    };
  }

  async getBookingsByParent(parentId: string, pagination?: Pagination) {
    const bookings = await this.prisma.bookings.findMany({
      where: { parent_id: parentId },
      ...paginate(pagination),
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
              include: {
                users: { include: { profiles: true, nanny_details: true } },
              },
            },
          },
        },
      },
      orderBy: { created_at: "desc" },
    });

    const enrichedBookings = await Promise.all(bookings.map(async (booking) => {
      const nanny = booking.users_bookings_nanny_idTousers;
      const nannyProfile = nanny?.profiles;

      const hours =
        booking.start_time && booking.end_time
          ? (new Date(booking.end_time).getTime() -
            new Date(booking.start_time).getTime()) /
          (1000 * 60 * 60)
          : Number(booking.service_requests?.duration_hours || 0);

      const { totalAmount, appliedRate } = await this.pricingService.calculateCost(
        booking.service_requests?.category || "CC",
        hours,
        Number(booking.service_requests?.["discount_percentage"] || 0),
        Number(booking.service_requests?.["plan_duration_months"] || 1),
        booking.service_requests?.["plan_type"] || "ONE_TIME",
        booking.service_requests?.["sessions_per_month"],
      );

      return {
        ...booking,
        hourly_rate: appliedRate,
        total_amount: totalAmount,
        title:
          (booking.jobs?.title ||
            (booking.service_requests
              ? `Care for ${booking.service_requests.num_children} ${Number(booking.service_requests.num_children) === 1 ? "Child" : "Children"}`
              : "Care Service")) +
          (nannyProfile
            ? ` with ${nannyProfile.first_name} ${nannyProfile.last_name}`
            : ""),
        nanny_name: nannyProfile
          ? `${nannyProfile.first_name} ${nannyProfile.last_name}`
          : "Pending Assignment",
        // Flatten the relationship for the frontend
        nanny: nanny ? {
          ...nanny,
          profiles: nannyProfile,
        } : null,
      };
    }));

    return enrichedBookings;
  }

  async getBookingsByNanny(nannyId: string, pagination?: Pagination) {
    const bookings = await this.prisma.bookings.findMany({
      where: { nanny_id: nannyId },
      ...paginate(pagination),
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

    const enrichedBookings = await Promise.all(bookings.map(async (booking) => {
      const hours =
        booking.start_time && booking.end_time
          ? (new Date(booking.end_time).getTime() -
            new Date(booking.start_time).getTime()) /
          (1000 * 60 * 60)
          : Number(booking.service_requests?.duration_hours || 0);

      const { totalAmount, appliedRate } = await this.pricingService.calculateCost(
        booking.service_requests?.category || "CC",
        hours,
        Number(booking.service_requests?.["discount_percentage"] || 0),
        Number(booking.service_requests?.["plan_duration_months"] || 1),
        booking.service_requests?.["plan_type"] || "ONE_TIME",
        booking.service_requests?.["sessions_per_month"],
      );

      const parentProfile = booking.users_bookings_parent_idTousers?.profiles;

      return {
        ...booking,
        hourly_rate: appliedRate,
        total_amount: totalAmount,
        title:
          (booking.jobs?.title ||
            (booking.service_requests
              ? `Care for ${booking.service_requests.num_children} ${Number(booking.service_requests.num_children) === 1 ? "Child" : "Children"}`
              : "Care Service")) +
          (parentProfile ? ` for ${parentProfile.first_name}` : ""),
      };
    }));

    return enrichedBookings;
  }

  async startBooking(id: string, nannyLat?: number, nannyLng?: number) {
    const booking = await this.prisma.bookings.findUnique({ where: { id } });
    if (!booking) throw new NotFoundException("Booking not found");
    if (booking.status !== BookingStatus.CONFIRMED) {
      throw new BadRequestException("Booking must be CONFIRMED to start");
    }

    // Geofence Validation
    if (
      booking.care_location_lat != null &&
      booking.care_location_lng != null
    ) {
      if (nannyLat == null || nannyLng == null) {
        throw new BadRequestException("Location coordinates are required to start this booking.");
      }

      const distance = GeoUtils.getDistanceInMeters(
        nannyLat,
        nannyLng,
        Number(booking.care_location_lat),
        Number(booking.care_location_lng)
      );

      const geofenceRadius = booking.geofence_radius || 100;

      if (distance > geofenceRadius) {
        throw new BadRequestException(`You must be within ${geofenceRadius} meters of the job location to start. You are currently ${Math.round(distance)} meters away.`);
      }
    }

    const updatedBooking = await this.prisma.bookings.update({
      where: { id },
      data: {
        status: BookingStatus.IN_PROGRESS,
        actual_start_time: new Date(), // Use actual_start_time instead of overwriting start_time
      },
    });

    this.eventEmitter.emit(BOOKING_EVENTS.STARTED, new BookingStartedEvent(updatedBooking));

    return updatedBooking;
  }

  async handleNoShow(id: string, reason: string = "Parent No-Show") {
    const booking = await this.prisma.bookings.findUnique({ where: { id } });
    if (!booking) throw new NotFoundException("Booking not found");

    const updatedBooking = await this.prisma.bookings.update({
      where: { id },
      data: {
        status: booking.status === BookingStatus.CONFIRMED ? BookingStatus.EXPIRED : BookingStatus.PARENT_NO_SHOW, // Adaptive status
        cancellation_reason: reason,
      },
    });

    this.eventEmitter.emit(
      BOOKING_EVENTS.CANCELLED,
      new BookingCancelledEvent(updatedBooking, reason),
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
    if (booking.status === BookingStatus.COMPLETED) {
      return booking;
    }

    if (booking.status !== BookingStatus.IN_PROGRESS) {
      throw new BadRequestException(
        `Booking must be IN_PROGRESS to complete. Current status: ${booking.status}`,
      );
    }

    // Safety checks to prevent 500 errors
    if (!booking.start_time || !booking.end_time) {
      throw new BadRequestException(
        "Booking has no scheduled start or end time recorded.",
      );
    }

    if (!booking.users_bookings_nanny_idTousers) {
      throw new BadRequestException("Booking has no assigned nanny.");
    }

    const actualEndTime = new Date();
    const startTime = booking.start_time;
    const endTime = booking.end_time;

    const durationHours = (endTime.getTime() - startTime.getTime()) / (1000 * 60 * 60);

    const { totalAmount } = await this.pricingService.calculateCost(
      booking.service_requests?.category || "CC",
      durationHours
    );

    const updatedBooking = await this.prisma.bookings.update({
      where: { id },
      data: {
        status: BookingStatus.COMPLETED,
        actual_end_time: actualEndTime, // Use actual_end_time instead of overwriting end_time
        is_review_prompted: true,
      },
    });

    this.eventEmitter.emit(BOOKING_EVENTS.COMPLETED, new BookingCompletedEvent(updatedBooking, totalAmount));

    // Auto-generate progress report for nanny (fire-and-forget, don't block completion)
    if (booking.nanny_id) {
      this.progressReportsService.generateReportForBooking(id).catch((err) =>
        this.logger.error(`Failed to generate progress report for booking ${id}`, err),
      );
    }

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

    if ([BookingStatus.COMPLETED, BookingStatus.CANCELLED].includes(booking.status as BookingStatus)) {
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
      this.logger.log(`Nanny cancelled random assignment booking ${id}. Triggering re-match.`);

      // 1. Find the active assignment (accepted)
      const assignment = await this.prisma.assignments.findFirst({
        where: {
          request_id: booking.request_id,
          nanny_id: booking.nanny_id,
          status: "accepted",
        },
      });

      if (assignment) {
        await this.prisma.assignments.update({
          where: { id: assignment.id },
          data: {
            status: "rejected",
            rejection_reason: `Cancelled after booking: ${reason}`,
            responded_at: new Date(),
          },
        });
      }

      // 2. Revert Booking to Pending and Cleanup Chat
      const updatedBooking = await this.prisma.bookings.update({
        where: { id },
        data: {
          status: BookingStatus.REQUESTED,
          nanny_id: null,
          cancellation_reason: `Previous Nanny Cancelled: ${reason}`,
        },
      });

      // Chat deletion will be handled by the listener on CANCELLED event

      // 3. Update Service Request (set back to pending from assigned)
      await this.prisma.service_requests.update({
        where: { id: booking.request_id },
        data: { status: "pending", current_assignment_id: null },
      });

      // 4. Trigger Re-matching
      this.requestsService.triggerMatching(booking.request_id).catch((err) => {
        this.logger.error("Failed to re-trigger matching after nanny cancellation", err);
      });

      this.eventEmitter.emit(
        BOOKING_EVENTS.CANCELLED,
        new BookingCancelledEvent(updatedBooking, reason, cancelledByUserId),
      );

      return updatedBooking;
    }

    // Special Handling: Parent Cancellation
    if (cancelledByUserId && booking.parent_id === cancelledByUserId) {
      this.logger.log(`Parent cancelled booking ${id}.`);

      // 1. If there's an associated service request, cancel it too
      if (booking.request_id) {
        await this.prisma.service_requests.update({
          where: { id: booking.request_id },
          data: { status: "CANCELLED" },
        });

        // Also cancel any pending/accepted assignment for this request
        await this.prisma.assignments.updateMany({
          where: {
            request_id: booking.request_id,
            status: { in: ["pending", "accepted"] },
          },
          data: { status: "cancelled", responded_at: new Date() },
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
        const { appliedRate: hourlyRate } = await this.pricingService.calculateCost(
          booking.service_requests.category || "CC",
          1
        );

        cancellationFee = hourlyRate;
        feeStatus = "pending";

        // Trigger cancellation fee charge
        const chargeResult = await this.paymentsService.chargeCancellationFee(id, cancellationFee);
        if (chargeResult.success) {
          feeStatus = "charged";
        }
      }
    }

    const updatedBooking = await this.prisma.bookings.update({
      where: { id },
      data: {
        status: BookingStatus.CANCELLED,
        cancellation_reason: reason,
        cancellation_fee: cancellationFee,
        cancellation_fee_status: feeStatus,
      },
    });

    this.eventEmitter.emit(BOOKING_EVENTS.CANCELLED, new BookingCancelledEvent(updatedBooking, reason, cancelledByUserId));

    return updatedBooking;
  }

  async getActiveBookings(userId: string, role: "parent" | "nanny") {
    const whereClause =
      role === "parent" ? { parent_id: userId } : { nanny_id: userId };
  const bookings = await this.prisma.bookings.findMany({
    where: {
      ...whereClause,
      status: {
        in: [BookingStatus.REQUESTED, "pending", "accepted", BookingStatus.CONFIRMED, BookingStatus.IN_PROGRESS],
      },
    },
    include: {
      jobs: true,
      users_bookings_nanny_idTousers: {
        select: {
          id: true,
          profiles: true,
          nanny_details: true,
        },
      },
      users_bookings_parent_idTousers: {
        select: {
          id: true,
          profiles: true,
        },
      },
      service_requests: {
        include: {
          assignments: {
            where: { status: { in: ["pending", "accepted"] } },
            include: {
              users: { include: { profiles: true, nanny_details: true } },
            },
          },
        },
      },
    },
  });

  return bookings.map((b) => {
    const nannyProfile = b.users_bookings_nanny_idTousers?.profiles;
    const parentProfile = b.users_bookings_parent_idTousers?.profiles;

    return {
      ...b,
      title:
        (b.jobs?.title ||
          (b.service_requests
            ? `Care for ${b.service_requests.num_children} ${Number(b.service_requests.num_children) === 1 ? "Child" : "Children"}`
            : "Care Service")) +
        (nannyProfile
          ? ` with ${nannyProfile.first_name} ${nannyProfile.last_name}`
          : ""),
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
  const unstartedCutoff = new Date(now.getTime() - BOOKING_UNSTARTED_EXPIRY_MS);
  const inProgressCutoff = new Date(now.getTime() - BOOKING_IN_PROGRESS_MAX_MS);

  // 1. Handle Unstarted Bookings (CONFIRMED -> EXPIRED)
  const unstartedBookings = await this.prisma.bookings.findMany({
    where: {
      status: { in: [BookingStatus.CONFIRMED, BookingStatus.REQUESTED] },
      start_time: { lt: unstartedCutoff },
    },
  });

  for (const booking of unstartedBookings) {
    await this.handleNoShow(
      booking.id,
      "System Auto-expiration: Booking never started",
    );
  }

  // 2. Handle Stuck In-Progress (IN_PROGRESS -> COMPLETED)
  const stuckBookings = await this.prisma.bookings.findMany({
    where: {
      status: BookingStatus.IN_PROGRESS,
      end_time: { lt: inProgressCutoff },
    },
  });
  for (const booking of stuckBookings) {
    try {
      // Tag as auto-completed first, then run the pipeline
      await this.prisma.bookings.update({
        where: { id: booking.id },
        data: {
          tags: { push: "auto-completed" },
          actual_end_time: now,
        },
      });
      // completeBooking handles payments, notifications, and SSE
      await this.completeBooking(booking.id);
    } catch (err) {
      this.logger.error(`Failed to auto-complete booking ${booking.id}: ${err.message}`);
      // Fallback: at minimum mark it completed in DB
      await this.prisma.bookings.update({
        where: { id: booking.id },
        data: { status: BookingStatus.COMPLETED, actual_end_time: now },
      });
    }
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

  if (booking.status !== BookingStatus.CONFIRMED) {
    throw new BadRequestException(
      "Only confirmed bookings can be reported as a no-show.",
    );
  }

  if (
    booking.parent_id !== reportingUserId &&
    booking.nanny_id !== reportingUserId
  ) {
    throw new ForbiddenException("Not authorized to report on this booking.");
  }

  const isNannyReporting = booking.nanny_id === reportingUserId;
  const noShowTag = isNannyReporting ? "parent_noshow" : "nanny_noshow";

  const updatedBooking = await this.prisma.bookings.update({
    where: { id },
    data: {
      status: BookingStatus.CANCELLED,
      cancellation_reason: `Reported No-Show by ${isNannyReporting ? "Nanny" : "Parent"}: ${reason}`,
      tags: { push: ["noshow", noShowTag] },
    },
  });

  // Notify the other party
  const notifiedUserId = isNannyReporting
    ? booking.parent_id
    : booking.nanny_id;
  if (notifiedUserId) {
    this.eventEmitter.emit(
      BOOKING_EVENTS.CANCELLED,
      new BookingCancelledEvent(updatedBooking, reason, reportingUserId),
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
  // BookingStatus.REQUESTED = "requested" (lowercase) — the uppercase "REQUESTED" string was
  // never written to the DB, so including it was a no-op bug. Enum covers both cases correctly.
  if (![BookingStatus.CONFIRMED, BookingStatus.REQUESTED].includes(booking.status as BookingStatus)) {
    throw new BadRequestException(
      "Only confirmed or requested bookings can be rescheduled",
    );
  }

  // 4. Parse and validate new date/time
  const newStartDateTime = TimeUtils.combineDateAndTime(newDate, newStartTime);
  const newEndDateTime = TimeUtils.combineDateAndTime(newDate, newEndTime);

  if (isNaN(newStartDateTime.getTime()) || isNaN(newEndDateTime.getTime())) {
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
  const updateData: Prisma.bookingsUpdateInput = {
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
      const durationHours =
        (newEndDateTime.getTime() - newStartDateTime.getTime()) /
        (1000 * 60 * 60);

      await tx.service_requests.update({
        where: { id: booking.request_id },
        data: {
          date: TimeUtils.combineDateAndTime(newDate, "00:00"),
          start_time: newStartDateTime,
          duration_hours: durationHours,
          status: booking.status === BookingStatus.CONFIRMED ? "accepted" : "pending",
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
    this.logger.log(`Re-triggering matching for rescheduled booking ${id} (Request ${booking.request_id})`);
    this.requestsService.triggerMatching(booking.request_id).catch((err) => {
      this.logger.error("Failed to re-trigger matching after reschedule", err);
    });
  }

  this.eventEmitter.emit(
    BOOKING_EVENTS.RESCHEDULED,
    new BookingRescheduledEvent(updatedBooking, booking),
  );

  return updatedBooking;
}
}
