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
import { BookingStatusLogService } from "./booking-status-log.service";
import { GeoUtils } from "../common/utils/geo.utils";
import { EventEmitter2 } from "@nestjs/event-emitter";
import {
  BOOKING_EVENTS,
  BookingCreatedEvent,
  BookingStartedEvent,
  BookingCompletedEvent,
  BookingCancelledEvent,
  BookingRescheduledEvent,
  BookingAutoCompletedEvent,
} from "./events/booking.events";
import { BookingStatus } from "../constants";
import { PricingEngineService } from "../common/pricing.service";
import { resolveDaysPerWeek } from "../common/utils/pricing.utils";
import { RequestsService } from "../requests/requests.service";
import { SSE_EVENTS } from "../events/sse-event.types";
import { ProgressReportsService } from "../progress-reports/progress-reports.service";
import {
  BOOKING_UNSTARTED_EXPIRY_MS,
  BOOKING_IN_PROGRESS_MAX_MS,
  PROGRESS_REPORT_DUE_HOURS,
} from "../common/constants/constants";
import {
  MANUAL_PENDING_PROVIDER,
  PaymentStatus,
  INSTALMENT_PAID,
  INSTALMENT_PENDING,
  INSTALMENT_VOID,
  CANCELLATION_FEE_NONE,
  CANCELLATION_FEE_OWED,
} from "../constants";
import { MATCHING_FEE_KIND } from "../common/pricing.service";
import { round2 } from "../common/payout-policy";
import { Prisma } from "@prisma/client";

/**
 * Payment state as the parent understands it. `partially_paid` is a split cycle
 * whose advance has been captured while its balance is still outstanding — real
 * money has arrived, but the booking is not settled.
 */
export type PaymentStatusValue =
  | "paid"
  | "partially_paid"
  | "failed"
  | "refunded"
  | "unpaid";


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
    private bookingStatusLog: BookingStatusLogService,
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

    // 2. If a job is named, it must belong to the booking parent — an arbitrary
    // job id here previously attached someone else's job to this booking.
    if (jobId) {
      const job = await this.prisma.jobs.findUnique({ where: { id: jobId } });
      if (!job) {
        throw new NotFoundException("Job not found");
      }
      if (job.parent_id && job.parent_id !== parentId) {
        throw new ForbiddenException("This job does not belong to you");
      }
      if (!finalStartTime) {
        finalStartTime = job.date;
        // Job doesn't have end time in schema currently, so we leave it null or calculate if duration existed
      }
    }

    // 3. Validate that we have a start time
    if (!finalStartTime) {
      throw new BadRequestException(
        "Date and Start time are required for direct bookings (or provide a valid Job ID)",
      );
    }

    if (finalStartTime.getTime() < Date.now()) {
      throw new BadRequestException("Cannot create a booking in the past");
    }

    // A caregiver can only be in one place at a time. Two CONFIRMED bookings over
    // the same window were both accepted before; one of them was always going to
    // be a no-show. Bookings without an end time can't be windowed and are skipped.
    if (finalEndTime) {
      const clash = await this.prisma.bookings.findFirst({
        where: {
          nanny_id: nannyId,
          status: { in: [BookingStatus.CONFIRMED, BookingStatus.IN_PROGRESS] },
          start_time: { lt: finalEndTime },
          end_time: { gt: finalStartTime },
        },
        select: { id: true, start_time: true },
      });
      if (clash) {
        throw new BadRequestException(
          "This caregiver already has a booking that overlaps the requested time",
        );
      }
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

    await this.bookingStatusLog.writeLog(null, booking.id, null, BookingStatus.CONFIRMED, {
      changedBy: parentId,
      actorRole: "parent",
      reason: "Booking created",
    });

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

    const { totalAmount, appliedRate, subtotalAmount, gstAmount, gstPercent } =
      await this.pricingService.calculateCost(
        booking.service_requests?.category || "CC",
        durationHours > 0
          ? durationHours
          : Number(booking.service_requests?.duration_hours || 0),
        Number(booking.service_requests?.["plan_duration_months"] || 1),
        booking.service_requests?.["plan_type"] || "ONE_TIME",
        resolveDaysPerWeek({
          planType: booking.service_requests?.["plan_type"],
          daysPerWeek: booking.days_per_week,
          sessionsPerMonth: booking.service_requests?.["sessions_per_month"],
        }),
      );

    // The request only snapshots coordinates; recover the address text the
    // parent actually entered by matching them back to their saved addresses
    // (soft-deleted included — removing an address must not blank out history).
    let serviceAddress: { label: string; address: string } | null = null;
    const reqLat = booking.service_requests?.location_lat;
    const reqLng = booking.service_requests?.location_lng;
    if (reqLat != null && reqLng != null) {
      const saved = await this.prisma.addresses.findFirst({
        where: { user_id: booking.parent_id, lat: reqLat, lng: reqLng },
        orderBy: { created_at: "desc" },
        select: { label: true, address: true },
      });
      if (saved) serviceAddress = saved;
    }
    if (!serviceAddress && parentProfile?.address) {
      serviceAddress = { label: "Home", address: parentProfile.address };
    }

    // Same figures the list path quotes, from the same helper — a parent must not
    // see one amount on the card and another on the booking they tapped through to.
    const summary = (await this.instalmentSummaries([booking.id])).get(booking.id);
    const feeCredit = summary?.feeCredit ?? 0;

    return {
      ...booking,
      hourly_rate: appliedRate,
      total_amount: totalAmount,
      subtotal_amount: subtotalAmount,
      gst_amount: gstAmount,
      gst_percent: gstPercent,
      matching_fee_credit: feeCredit,
      amount_due:
        summary?.pendingCare ?? round2(Math.max(0, Number(totalAmount) - feeCredit)),
      payment_status: await this.derivePaymentStatus(booking.id),
      service_address: serviceAddress,
      service_location_lat: reqLat != null ? Number(reqLat) : null,
      service_location_lng: reqLng != null ? Number(reqLng) : null,
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
        : "Finding your match",
      parent_name: parentProfile
        ? `${parentProfile.first_name} ${parentProfile.last_name}`
        : "Parent",
    };
  }

  /**
   * Payment state of a booking as the parent understands it. There is no
   * payment_status column — the client-facing value is derived from the
   * `payments` rows. The manual_pending placeholder written on completion
   * records a payout obligation, not a charge the parent made, so it never
   * counts as paid.
   */
  async derivePaymentStatus(bookingId: string): Promise<PaymentStatusValue> {
    const [rows, summaries] = await Promise.all([
      this.prisma.payments.findMany({
        where: {
          booking_id: bookingId,
          provider: { not: MANUAL_PENDING_PROVIDER },
        },
        select: { status: true },
      }),
      this.instalmentSummaries([bookingId]),
    ]);
    return this.paymentStatusFromRows(
      rows.map((r) => r.status ?? ""),
      !!summaries.get(bookingId)?.outstanding,
    );
  }

  /**
   * What each of these bookings still owes, for both the single and the batched
   * list paths — so the two can never disagree. One query for the page.
   *
   * A booking owes money in two ways. The obvious one is a pending instalment.
   * The subtle one is a booking whose only settled instalment is the matching
   * fee: that fee is raised and charged at request time, before any caregiver
   * exists and therefore before the instalments for the care itself have been
   * raised at all. Nothing is "pending" yet, so the fee alone would otherwise
   * read as `paid` — hiding the real amount due and suppressing the prompt to
   * pay it on every booking the parent has just created.
   *
   * `feeCredit` mirrors the engine's own rule (`matchingFeeCreditFor`): the fee
   * comes off the first cycle rather than being added on top, so a quote that
   * ignored it would name a figure the parent is never actually charged.
   * `pendingCare` is that already-credited figure once the cycle has been priced,
   * and is preferred over any estimate for exactly that reason.
   */
  private async instalmentSummaries(
    bookingIds: string[],
  ): Promise<Map<string, { outstanding: boolean; feeCredit: number; pendingCare: number | null }>> {
    const summaries = new Map<
      string,
      { outstanding: boolean; feeCredit: number; pendingCare: number | null }
    >();
    if (bookingIds.length === 0) return summaries;

    const rows = await this.prisma.payment_installments.findMany({
      where: { booking_id: { in: bookingIds } },
      select: {
        booking_id: true,
        status: true,
        kind: true,
        amount: true,
        cycle_number: true,
      },
    });

    const settledCare = new Set<string>();
    const settledFee = new Set<string>();
    const at = (bookingId: string) => {
      const existing = summaries.get(bookingId);
      if (existing) return existing;
      const fresh = { outstanding: false, feeCredit: 0, pendingCare: null as number | null };
      summaries.set(bookingId, fresh);
      return fresh;
    };

    for (const row of rows) {
      if (!row.booking_id) continue;
      const summary = at(row.booking_id);
      const isFee = row.kind === MATCHING_FEE_KIND;

      if (isFee) summary.feeCredit += Number(row.amount);

      if (row.status === INSTALMENT_PENDING) {
        summary.outstanding = true;
        if (!isFee) summary.pendingCare = (summary.pendingCare ?? 0) + Number(row.amount);
      } else if (row.status === INSTALMENT_PAID) {
        (isFee ? settledFee : settledCare).add(row.booking_id);
      }
    }

    for (const bookingId of settledFee) {
      if (!settledCare.has(bookingId)) at(bookingId).outstanding = true;
    }

    // Only the first cycle carries the credit; once care has been settled the fee
    // has already been deducted and must not discount anything a second time.
    for (const bookingId of settledCare) at(bookingId).feeCredit = 0;

    return summaries;
  }

  /**
   * Order-independent: every checkout attempt inserts a `created` row, so an
   * abandoned attempt AFTER a successful charge must not flip a paid booking
   * back to unpaid. A capture anywhere in the history wins; a refund means the
   * money went back; a failure is retryable; anything else is simply unpaid.
   *
   * `hasOutstanding` is what keeps a part-paid booking honest: a split cycle's
   * advance — or a matching fee paid before the care is even priced — is a real
   * capture, but calling the booking `paid` while the rest is still owed would
   * hide the amount due from every list and suppress the prompt to pay it. See
   * `instalmentSummaries` for what counts.
   */
  private paymentStatusFromRows(
    statuses: string[],
    hasOutstanding = false,
  ): PaymentStatusValue {
    if (
      statuses.some(
        (s) => s === PaymentStatus.CAPTURED || s === PaymentStatus.PENDING_RELEASE,
      )
    ) {
      return hasOutstanding ? "partially_paid" : "paid";
    }
    if (statuses.some((s) => s === PaymentStatus.REFUNDED)) return "refunded";
    if (statuses.some((s) => s === PaymentStatus.FAILED)) return "failed";
    return "unpaid";
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
        // Cycle-billed bookings are settled per-cycle on the Payments screen,
        // not per-booking — clients need to know which billing model applies.
        payment_plans: { select: { id: true } },
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

    // Batched payment_status for the whole page — same order-independent
    // semantics as derivePaymentStatus.
    const paymentRows = await this.prisma.payments.findMany({
      where: {
        booking_id: { in: bookings.map((b) => b.id) },
        provider: { not: MANUAL_PENDING_PROVIDER },
      },
      select: { booking_id: true, status: true },
    });
    const statusesByBooking = new Map<string, string[]>();
    for (const row of paymentRows) {
      if (!row.booking_id) continue;
      const list = statusesByBooking.get(row.booking_id) ?? [];
      list.push(row.status ?? "");
      statusesByBooking.set(row.booking_id, list);
    }
    const summaries = await this.instalmentSummaries(bookings.map((b) => b.id));
    const statusOf = (bookingId: string) =>
      this.paymentStatusFromRows(
        statusesByBooking.get(bookingId) ?? [],
        !!summaries.get(bookingId)?.outstanding,
      );

    // Warm the pricing reference cache once so the fan-out below hits memory
    // rather than opening a connection per booking.
    await this.pricingService.prefetchServiceCategories(
      bookings.map((b) => b.service_requests?.category || "CC"),
    );

    const enrichedBookings = await Promise.all(bookings.map(async (booking) => {
      const nanny = booking.users_bookings_nanny_idTousers;
      const nannyProfile = nanny?.profiles;

      const hours =
        booking.start_time && booking.end_time
          ? (new Date(booking.end_time).getTime() -
            new Date(booking.start_time).getTime()) /
          (1000 * 60 * 60)
          : Number(booking.service_requests?.duration_hours || 0);

      const { totalAmount, appliedRate, subtotalAmount, gstAmount, gstPercent } =
        await this.pricingService.calculateCost(
          booking.service_requests?.category || "CC",
          hours,
          Number(booking.service_requests?.["plan_duration_months"] || 1),
          booking.service_requests?.["plan_type"] || "ONE_TIME",
          resolveDaysPerWeek({
            planType: booking.service_requests?.["plan_type"],
            daysPerWeek: booking.days_per_week,
            sessionsPerMonth: booking.service_requests?.["sessions_per_month"],
          }),
        );

      // What the parent will actually be charged next, so the prompt names the
      // figure the checkout will name. The priced instalment wins when one
      // exists — it is the engine's own arithmetic, already fee-credited and
      // split. Before the cycle is priced, the estimate carries the credit itself.
      const summary = summaries.get(booking.id);
      const feeCredit = summary?.feeCredit ?? 0;
      const amountDue =
        summary?.pendingCare ?? round2(Math.max(0, Number(totalAmount) - feeCredit));

      return {
        ...booking,
        hourly_rate: appliedRate,
        total_amount: totalAmount,
        subtotal_amount: subtotalAmount,
        gst_amount: gstAmount,
        gst_percent: gstPercent,
        /** Deducted from the first cycle, not added on top — 0 once it is spent. */
        matching_fee_credit: feeCredit,
        amount_due: amountDue,
        payment_status: statusOf(booking.id),
        has_payment_plan: !!booking.payment_plans,
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
          : "Finding your match",
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

    // Same batched derivation as the parent list. The nanny needs it too:
    // completing a job is not the same event as the parent paying for it, so
    // her app must not claim the money arrived until a payment row says so.
    const paymentRows = await this.prisma.payments.findMany({
      where: {
        booking_id: { in: bookings.map((b) => b.id) },
        provider: { not: MANUAL_PENDING_PROVIDER },
      },
      select: { booking_id: true, status: true },
    });
    const statusesByBooking = new Map<string, string[]>();
    for (const row of paymentRows) {
      if (!row.booking_id) continue;
      const list = statusesByBooking.get(row.booking_id) ?? [];
      list.push(row.status ?? "");
      statusesByBooking.set(row.booking_id, list);
    }
    const summaries = await this.instalmentSummaries(bookings.map((b) => b.id));
    const statusOf = (bookingId: string) =>
      this.paymentStatusFromRows(
        statusesByBooking.get(bookingId) ?? [],
        !!summaries.get(bookingId)?.outstanding,
      );

    await this.pricingService.prefetchServiceCategories(
      bookings.map((b) => b.service_requests?.category || "CC"),
    );

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
        Number(booking.service_requests?.["plan_duration_months"] || 1),
        booking.service_requests?.["plan_type"] || "ONE_TIME",
        resolveDaysPerWeek({
          planType: booking.service_requests?.["plan_type"],
          daysPerWeek: booking.days_per_week,
          sessionsPerMonth: booking.service_requests?.["sessions_per_month"],
        }),
      );

      const parentProfile = booking.users_bookings_parent_idTousers?.profiles;

      return {
        ...booking,
        hourly_rate: appliedRate,
        total_amount: totalAmount,
        payment_status: statusOf(booking.id),
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
    const booking = await this.prisma.bookings.findUnique({
      where: { id },
      include: { service_requests: true },
    });
    if (!booking) throw new NotFoundException("Booking not found");
    if (booking.status !== BookingStatus.CONFIRMED) {
      throw new BadRequestException("Booking must be CONFIRMED to start");
    }

    // Backfill the care location (geofence centre) from the service request the
    // first time a session starts, so live tracking and geofencing have a centre.
    if (
      (booking.care_location_lat == null ||
        booking.care_location_lng == null) &&
      booking.service_requests?.location_lat != null &&
      booking.service_requests?.location_lng != null
    ) {
      booking.care_location_lat = booking.service_requests.location_lat;
      booking.care_location_lng = booking.service_requests.location_lng;
      await this.prisma.bookings.update({
        where: { id },
        data: {
          care_location_lat: booking.service_requests.location_lat,
          care_location_lng: booking.service_requests.location_lng,
          geofence_radius: booking.geofence_radius ?? 100,
        },
      });
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

    // Claim the transition instead of assuming the status check above still holds.
    // A double-tap of "Start" fires two requests that both pass that check before
    // either write lands; an unguarded `update` let both through and emitted
    // STARTED twice. Guarding on the expected status makes exactly one win.
    const claimed = await this.prisma.bookings.updateMany({
      where: { id, status: BookingStatus.CONFIRMED },
      data: {
        status: BookingStatus.IN_PROGRESS,
        actual_start_time: new Date(), // Use actual_start_time instead of overwriting start_time
      },
    });
    if (claimed.count === 0) {
      throw new BadRequestException("Booking must be CONFIRMED to start");
    }

    const updatedBooking = await this.prisma.bookings.findUnique({ where: { id } });

    this.eventEmitter.emit(BOOKING_EVENTS.STARTED, new BookingStartedEvent(updatedBooking));

    await this.bookingStatusLog.writeLog(null, id, booking.status, BookingStatus.IN_PROGRESS, {
      changedBy: booking.nanny_id,
      actorRole: "nanny",
    });

    return updatedBooking;
  }

  /**
   * Auto-expire a booking whose start time passed without it ever starting.
   *
   * This is the *system sweep* path and its only caller is `checkExpiredBookings`.
   * A genuine, reported no-show goes through `reportNoShow` instead.
   *
   * It always writes `EXPIRED`, never `PARENT_NO_SHOW`. It used to pick between
   * them on `status === CONFIRMED`, which meant the only other status the cron
   * feeds it — `REQUESTED`, i.e. a booking **no caregiver was ever assigned to** —
   * was recorded as the *parent* failing to show up for a session that had nobody
   * to attend it. That blamed the parent in the audit trail and in the notification
   * they received, while the reason string passed in said "never started". Nothing
   * here can tell whose fault an unstarted session was, so it does not guess.
   */
  async expireUnstartedBooking(id: string, reason: string = "Booking expired") {
    const booking = await this.prisma.bookings.findUnique({ where: { id } });
    if (!booking) throw new NotFoundException("Booking not found");

    const nextStatus = BookingStatus.EXPIRED;

    // One transaction: the booking, its request and its assignments describe the
    // same fact and must not be able to disagree. Previously these were three bare
    // writes, so a failure between them left the request cancelled while the
    // booking still read CONFIRMED.
    const updatedBooking = await this.prisma.$transaction(async (tx) => {
      // Claim the transition rather than assuming it: `updateMany` with the
      // expected status makes a concurrent cancel/start win cleanly instead of
      // both sides writing.
      const claimed = await tx.bookings.updateMany({
        where: {
          id,
          status: { in: [BookingStatus.CONFIRMED, BookingStatus.REQUESTED] },
        },
        data: { status: nextStatus, cancellation_reason: reason },
      });
      if (claimed.count === 0) return null;

      // Keep the originating request in step: left as "pending" it would sit in
      // the admin manual-assignment queue (and the parent's list) forever, for a
      // slot that has already come and gone.
      if (booking.request_id) {
        await tx.service_requests.updateMany({
          where: { id: booking.request_id, status: { in: ["pending", "accepted"] } },
          data: { status: "EXPIRED" },
        });
        await tx.assignments.updateMany({
          where: {
            request_id: booking.request_id,
            status: { in: ["pending", "accepted"] },
          },
          data: { status: "expired", responded_at: new Date() },
        });
      }

      return tx.bookings.findUnique({ where: { id } });
    });

    // Someone else moved this booking first — nothing to announce.
    if (!updatedBooking) return null;

    // Emitted after commit: listeners re-read the booking, and inside the
    // transaction they would race the write they are reacting to.
    this.eventEmitter.emit(
      BOOKING_EVENTS.CANCELLED,
      new BookingCancelledEvent(updatedBooking, reason),
    );

    await this.bookingStatusLog.writeLog(null, id, booking.status, nextStatus, {
      actorRole: "system",
      reason,
    });

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

    // Same arguments as every quote path (getBookingById, the two list paths).
    // This amount funds the caregiver's manual_pending payout accrual and the
    // completion notifications — pricing it with the defaults (ONE_TIME, one
    // day/week) quoted and accrued the wrong figure for any plan booking.
    const { totalAmount } = await this.pricingService.calculateCost(
      booking.service_requests?.category || "CC",
      durationHours > 0
        ? durationHours
        : Number(booking.service_requests?.duration_hours || 0),
      Number(booking.service_requests?.["plan_duration_months"] || 1),
      booking.service_requests?.["plan_type"] || "ONE_TIME",
      resolveDaysPerWeek({
        planType: booking.service_requests?.["plan_type"],
        daysPerWeek: booking.days_per_week,
        sessionsPerMonth: booking.service_requests?.["sessions_per_month"],
      }),
    );

    // Claim IN_PROGRESS → COMPLETED atomically. The early return above only covers
    // a booking that is *already* COMPLETED; two calls racing while both still see
    // IN_PROGRESS both got past it and both wrote. That fired COMPLETED twice,
    // which re-ran `handleBookingCompleted` — duplicate parent/caregiver
    // notifications, a duplicate progress report, and duplicate payment_audit_log
    // rows. `capturePaymentSuccess` already uses this pattern to claim instalments.
    const claimed = await this.prisma.bookings.updateMany({
      where: { id, status: BookingStatus.IN_PROGRESS },
      data: {
        status: BookingStatus.COMPLETED,
        actual_end_time: actualEndTime, // Use actual_end_time instead of overwriting end_time
        is_review_prompted: true,
      },
    });
    if (claimed.count === 0) {
      // Someone else completed it between our read and this write. Their call owns
      // the side effects; return the settled row rather than duplicating them.
      return this.prisma.bookings.findUnique({ where: { id } });
    }

    const updatedBooking = await this.prisma.bookings.findUnique({ where: { id } });

    this.eventEmitter.emit(BOOKING_EVENTS.COMPLETED, new BookingCompletedEvent(updatedBooking, totalAmount));

    await this.bookingStatusLog.writeLog(null, id, booking.status, BookingStatus.COMPLETED, {
      changedBy: booking.nanny_id,
      actorRole: "nanny",
    });

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

      // One transaction: rejecting the assignment, unassigning the booking and
      // reopening the request are one fact. Half-applied, the request would be
      // reopened for matching while the booking still names the caregiver who
      // just walked away (or vice versa).
      const updatedBooking = await this.prisma.$transaction(async (tx) => {
        if (assignment) {
          await tx.assignments.update({
            where: { id: assignment.id },
            data: {
              status: "rejected",
              rejection_reason: `Cancelled after booking: ${reason}`,
              responded_at: new Date(),
            },
          });
        }

        // Revert Booking to Pending and Cleanup Chat
        const reverted = await tx.bookings.update({
          where: { id },
          data: {
            status: BookingStatus.REQUESTED,
            nanny_id: null,
            cancellation_reason: `Previous Nanny Cancelled: ${reason}`,
          },
        });

        // Chat deletion will be handled by the listener on CANCELLED event

        // Update Service Request (set back to pending from assigned)
        await tx.service_requests.update({
          where: { id: booking.request_id },
          data: { status: "pending", current_assignment_id: null },
        });

        return reverted;
      });

      // Re-matching and events only after the transaction commits — the matcher
      // reads the request it is being asked to rematch.
      this.requestsService.triggerMatching(booking.request_id).catch((err) => {
        this.logger.error("Failed to re-trigger matching after nanny cancellation", err);
      });

      this.eventEmitter.emit(
        BOOKING_EVENTS.CANCELLED,
        new BookingCancelledEvent(updatedBooking, reason, cancelledByUserId),
      );

      // This branch used to return without writing a status log, so a
      // CONFIRMED/IN_PROGRESS → REQUESTED revert with the caregiver cleared was the
      // one transition invisible in `getHistory()` — despite the log service
      // documenting that it records every transition.
      await this.bookingStatusLog.writeLog(
        null,
        id,
        booking.status,
        BookingStatus.REQUESTED,
        {
          changedBy: cancelledByUserId,
          actorRole: "nanny",
          reason: `Previous Nanny Cancelled: ${reason}`,
          metadata: { rematch_triggered: true, previous_nanny_id: booking.nanny_id },
        },
      );

      return updatedBooking;
    }

    // Special Handling: Parent Cancellation
    //
    // The request/assignment writes are deliberately NOT done here. They used to
    // be, ahead of the fee calculation below — so when `calculateCost` threw (an
    // unknown service category is enough), the request and its assignments were
    // already CANCELLED while the booking still read CONFIRMED. The parent saw an
    // error, the data disagreed with itself, and retrying re-entered the same code
    // path and threw again. They now run inside the same transaction as the
    // booking's own status write, further down.
    const isParentCancellation =
      !!cancelledByUserId && booking.parent_id === cancelledByUserId;
    if (isParentCancellation) {
      this.logger.log(`Parent cancelled booking ${id}.`);
    }

    // Standard Cancellation Logic

    // Calculate Cancellation Fee
    //
    // The fee is *recorded as owed*, never auto-charged. We hold no mandate and no
    // saved payment method for a parent, so there is nothing to debit without them
    // going through checkout. This previously called `chargeCancellationFee`, which
    // created a Razorpay *order* and then wrote a `payments` row straight to
    // `captured` ("simulating successful auto-charge") — money that never moved,
    // booked as revenue, and unrefundable because the row had no gateway payment id.
    //
    // `owed` is the honest state: the amount is on the booking, and settlement goes
    // through the ordinary createOrder → checkout → verify path once a client
    // surfaces it. See the client handoff doc for the status contract.
    let cancellationFee = 0;
    let feeStatus = CANCELLATION_FEE_NONE;

    // The fee compensates the caregiver for a slot the *parent* pulled late. A
    // cancellation by the caregiver, an admin, or the system is not the parent's
    // doing — computing the fee unconditionally here billed the parent for their
    // caregiver walking away inside the 24-hour window.
    const now = new Date();
    const startTime = booking.start_time;
    if (isParentCancellation && startTime) {
      const hoursUntilStart =
        (startTime.getTime() - now.getTime()) / (1000 * 60 * 60);

      if (hoursUntilStart < 24 && booking.service_requests) {
        const { appliedRate: hourlyRate } = await this.pricingService.calculateCost(
          booking.service_requests.category || "CC",
          1
        );

        cancellationFee = hourlyRate;
        feeStatus = CANCELLATION_FEE_OWED;
      }
    }

    // Everything that makes this booking cancelled, in one transaction. The fee is
    // computed above, before the transaction opens, so a pricing failure aborts
    // before anything has been written rather than midway through.
    const updatedBooking = await this.prisma.$transaction(async (tx) => {
      const cancelled = await tx.bookings.update({
        where: { id },
        data: {
          status: BookingStatus.CANCELLED,
          cancellation_reason: reason,
          cancellation_fee: cancellationFee,
          cancellation_fee_status: feeStatus,
        },
      });

      // Money that stopped being owed is voided, not left `pending`. The pending
      // list and the dunning cron both filter cancelled bookings out, but the
      // instalment ids stay valid — a stale checkout could still settle one, and
      // any query that forgets the booking-status filter would resurrect the
      // balance. Paid instalments are untouched: whether they are refunded is an
      // admin decision made through `refundPayment`, not a side effect of cancel.
      await tx.payment_installments.updateMany({
        where: { booking_id: id, status: INSTALMENT_PENDING },
        data: { status: INSTALMENT_VOID, updated_at: new Date() },
      });

      if (isParentCancellation && booking.request_id) {
        await tx.service_requests.update({
          where: { id: booking.request_id },
          data: { status: "CANCELLED" },
        });

        // Also cancel any pending/accepted assignment for this request
        await tx.assignments.updateMany({
          where: {
            request_id: booking.request_id,
            status: { in: ["pending", "accepted"] },
          },
          data: { status: "cancelled", responded_at: new Date() },
        });
      }

      return cancelled;
    });

    this.eventEmitter.emit(BOOKING_EVENTS.CANCELLED, new BookingCancelledEvent(updatedBooking, reason, cancelledByUserId));

    const cancelActorRole = !cancelledByUserId
      ? "system"
      : cancelledByUserId === booking.parent_id
        ? "parent"
        : cancelledByUserId === booking.nanny_id
          ? "nanny"
          : "admin";
    await this.bookingStatusLog.writeLog(null, id, booking.status, BookingStatus.CANCELLED, {
      changedBy: cancelledByUserId ?? null,
      actorRole: cancelActorRole,
      reason,
      metadata: { cancellation_fee_status: feeStatus },
    });

    return updatedBooking;
  }

  async getActiveBookings(userId: string, role: "parent" | "nanny") {
    const whereClause =
      role === "parent" ? { parent_id: userId } : { nanny_id: userId };
  const bookings = await this.prisma.bookings.findMany({
    where: {
      ...whereClause,
      // "pending"/"accepted" were also listed here. Those are `service_requests` /
      // `assignments` values — `bookings.status` is only ever a BookingStatus, so
      // they could never match anything.
      status: {
        in: [
          BookingStatus.REQUESTED,
          BookingStatus.CONFIRMED,
          BookingStatus.IN_PROGRESS,
        ],
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
        : "Finding your match",
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

  // Per-item isolation: one booking whose expiry throws must not abandon the rest
  // of the sweep until the next scheduled run.
  const expiryFailures: { bookingId: string; error: string }[] = [];
  let expired = 0;
  for (const booking of unstartedBookings) {
    try {
      const result = await this.expireUnstartedBooking(
        booking.id,
        "System Auto-expiration: Booking never started",
      );
      // null means another actor moved it between the query and the write.
      if (result) expired += 1;
    } catch (err) {
      expiryFailures.push({ bookingId: booking.id, error: err?.message ?? String(err) });
      this.logger.error(
        `Failed to expire unstarted booking ${booking.id}: ${err?.message}`,
        err?.stack,
      );
    }
  }

  // 2. Handle Stuck In-Progress (IN_PROGRESS -> COMPLETED)
  const stuckBookings = await this.prisma.bookings.findMany({
    where: {
      status: BookingStatus.IN_PROGRESS,
      end_time: { lt: inProgressCutoff },
    },
  });
  const failures: { bookingId: string; error: string }[] = [];
  let autoCompleted = 0;
  for (const booking of stuckBookings) {
    try {
      // Tag as auto-completed first, then run the pipeline. A failed attempt leaves
      // the booking IN_PROGRESS for the next sweep to retry, so the tag has to be
      // idempotent — `push` would otherwise stack a duplicate on every retry.
      const tagged = booking.tags?.includes("auto-completed")
        ? await this.prisma.bookings.update({
            where: { id: booking.id },
            data: { actual_end_time: now },
          })
        : await this.prisma.bookings.update({
            where: { id: booking.id },
            data: {
              tags: { push: "auto-completed" },
              actual_end_time: now,
            },
          });
      // completeBooking handles payments, notifications, and SSE
      await this.completeBooking(booking.id);

      // Care happened; nobody closed the session. Attendance treats that as a
      // missed check-out rather than a missed session, which it can only tell
      // apart from a normal completion via this event.
      this.eventEmitter.emit(
        BOOKING_EVENTS.AUTO_COMPLETED,
        new BookingAutoCompletedEvent(tagged),
      );
      autoCompleted += 1;
    } catch (err) {
      // Do NOT force the booking to COMPLETED here.
      //
      // `BOOKING_EVENTS.COMPLETED` is emitted only inside `completeBooking`, and it
      // is the sole trigger for `handleBookingCompleted` — the one place that writes
      // the `manual_pending` payout accrual, moves a captured payment to
      // `pending_release`, and notifies both parties. COMPLETED is terminal
      // everywhere else (`completeBooking` returns early on it, `capturePaymentSuccess`
      // refuses to promote it), so a booking written straight to COMPLETED could
      // never re-enter the billing pipeline: the caregiver would simply never be paid
      // for a session they actually worked, with a log line as the only trace.
      //
      // Leaving it IN_PROGRESS is recoverable — the next sweep retries it, and a
      // transient pricing/DB fault heals on its own. Failing loudly and repeatedly is
      // the correct outcome for "we could not bill a delivered session".
      failures.push({ bookingId: booking.id, error: err?.message ?? String(err) });
      this.logger.error(
        `Failed to auto-complete booking ${booking.id}; leaving IN_PROGRESS for retry: ${err?.message}`,
        err?.stack,
      );
      await this.bookingStatusLog.writeLog(null, booking.id, booking.status, booking.status, {
        actorRole: "system",
        reason: "Auto-completion failed; booking left IN_PROGRESS for retry",
        metadata: { error: err?.message ?? String(err) },
      });
    }
  }

  // Counts are of work that actually succeeded, not of rows attempted. Reporting
  // `stuckBookings.length` hid every failure behind a success number.
  if (failures.length || expiryFailures.length) {
    this.logger.error(
      `checkExpiredBookings finished with failures: ${expiryFailures.length} expiry, ` +
        `${failures.length} auto-completion. Auto-completion failures leave delivered ` +
        `sessions unbilled and need investigation: ` +
        `${failures.map((f) => f.bookingId).join(", ")}`,
    );
  }

  return {
    expired,
    autoCompleted,
    failed: {
      expiry: expiryFailures,
      autoCompletion: failures,
    },
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

  // Nobody has failed to show up for a session that hasn't started yet. Without
  // this, either party could "report a no-show" hours before the start time and
  // cancel the booking with a no-show on the other party's record.
  if (booking.start_time && booking.start_time.getTime() > Date.now()) {
    throw new BadRequestException(
      "A no-show can only be reported after the booking's start time.",
    );
  }

  const isNannyReporting = booking.nanny_id === reportingUserId;
  const noShowTag = isNannyReporting ? "parent_noshow" : "nanny_noshow";

  // One transaction, claimed on the expected status. The bare `update` let two
  // concurrent reports (or a report racing a start/cancel) both write — stacking
  // duplicate noshow tags and emitting CANCELLED twice. And a no-show is a
  // cancellation: like cancelBooking, it must void pending instalments and close
  // the originating request/assignments, or the balance stays collectible and the
  // request sits in the matching queue for a session that never happened.
  const updatedBooking = await this.prisma.$transaction(async (tx) => {
    const claimed = await tx.bookings.updateMany({
      where: { id, status: BookingStatus.CONFIRMED },
      data: {
        status: BookingStatus.CANCELLED,
        cancellation_reason: `Reported No-Show by ${isNannyReporting ? "Nanny" : "Parent"}: ${reason}`,
        tags: { push: ["noshow", noShowTag] },
      },
    });
    if (claimed.count === 0) return null;

    await tx.payment_installments.updateMany({
      where: { booking_id: id, status: INSTALMENT_PENDING },
      data: { status: INSTALMENT_VOID, updated_at: new Date() },
    });

    if (booking.request_id) {
      await tx.service_requests.updateMany({
        where: { id: booking.request_id, status: { in: ["pending", "accepted"] } },
        data: { status: "CANCELLED" },
      });
      await tx.assignments.updateMany({
        where: {
          request_id: booking.request_id,
          status: { in: ["pending", "accepted"] },
        },
        data: { status: "cancelled", responded_at: new Date() },
      });
    }

    return tx.bookings.findUnique({ where: { id } });
  });

  if (!updatedBooking) {
    throw new BadRequestException(
      "Only confirmed bookings can be reported as a no-show.",
    );
  }

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

  await this.bookingStatusLog.writeLog(null, id, booking.status, BookingStatus.CANCELLED, {
    changedBy: reportingUserId,
    actorRole: isNannyReporting ? "nanny" : "parent",
    reason: `No-show reported: ${reason}`,
    metadata: { noshow_tag: noShowTag },
  });

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
  const updateData: Prisma.bookingsUpdateManyMutationInput = {
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
    // Claim the reschedule on the status we validated above. The read-then-write
    // gap let a caregiver start the session between the check and this write —
    // the reschedule then silently rewrote the start/end times of an IN_PROGRESS
    // (or cancelled) booking.
    const claimed = await tx.bookings.updateMany({
      where: {
        id,
        status: { in: [BookingStatus.CONFIRMED, BookingStatus.REQUESTED] },
      },
      data: updateData,
    });
    if (claimed.count === 0) {
      throw new BadRequestException(
        "Only confirmed or requested bookings can be rescheduled",
      );
    }

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

    // b. The booking itself was written by the claim above.
    return tx.bookings.findUnique({ where: { id } });
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
