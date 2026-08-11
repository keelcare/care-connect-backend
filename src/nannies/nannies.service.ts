import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CreateCategoryRequestDto } from "./dto/create-category-request.dto";
import { TimeUtils } from "../common/utils/time.utils";
import { BookingStatus } from "../common/constants/booking-status.enum";
import { AttendanceService } from "../attendance/attendance.service";
import { CAREGIVER_SHARE_ONLY, EARNING_STATUSES } from "../common/payout-policy";
// Date helpers (no external dep needed)
function startOfDay(d: Date): Date { const r = new Date(d); r.setHours(0,0,0,0); return r; }
function endOfDay(d: Date): Date { const r = new Date(d); r.setHours(23,59,59,999); return r; }
function subDays(d: Date, n: number): Date { const r = new Date(d); r.setDate(r.getDate() - n); return r; }

@Injectable()
export class NanniesService {
  constructor(
    private prisma: PrismaService,
    private attendance: AttendanceService,
  ) {}

  async createCategoryRequest(userId: string, dto: CreateCategoryRequestDto) {
    // Validate categories exist
    const validServices = await this.prisma.services.findMany({
      where: {
        name: { in: dto.categories },
      },
    });

    if (validServices.length !== dto.categories.length) {
      const validNames = validServices.map((s) => s.name);
      const invalidNames = dto.categories.filter(
        (c) => !validNames.includes(c),
      );
      throw new BadRequestException(
        `Invalid categories: ${invalidNames.join(", ")}`,
      );
    }

    // Check if there is already a pending request
    const existingRequest = await this.prisma.nanny_category_requests.findFirst(
      {
        where: {
          nanny_id: userId,
          status: "pending",
        },
      },
    );

    if (existingRequest) {
      throw new BadRequestException(
        "You already have a pending category change request",
      );
    }

    try {
      return await this.prisma.nanny_category_requests.create({
        data: {
          nanny_id: userId,
          requested_categories: dto.categories,
          status: "pending",
        },
      });
    } catch (error) {
      if (error.code === "P2002") {
        throw new BadRequestException(
          "You already have a pending category change request",
        );
      }
      throw error;
    }
  }

  async cancelCategoryRequest(userId: string, requestId: string) {
    // Validate it's a UUID to prevent Prisma 500 errors
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(requestId)) {
      throw new BadRequestException("Invalid request ID format");
    }

    const request = await this.prisma.nanny_category_requests.findFirst({
      where: {
        id: requestId,
        nanny_id: userId,
      },
    });

    if (!request) {
      throw new NotFoundException("Category request not found");
    }

    if (request.status !== "pending") {
      throw new BadRequestException(
        `Cannot cancel a request that is already ${request.status}`,
      );
    }

    return this.prisma.nanny_category_requests.delete({
      where: { id: requestId },
    });
  }

  async getMyCategoryRequest(userId: string) {
    return this.prisma.nanny_category_requests.findFirst({
      where: {
        nanny_id: userId,
        status: "pending",
      },
      orderBy: {
        created_at: "desc",
      },
    });
  }

  async getMyCategoryRequestsHistory(userId: string) {
    return this.prisma.nanny_category_requests.findMany({
      where: {
        nanny_id: userId,
      },
      orderBy: {
        created_at: "desc",
      },
    });
  }

  // ─── Dashboard summary ───────────────────────────────────────────

  async getDashboardSummary(nannyId: string) {
    const todayStart = TimeUtils.startOfDayIST();
    const todayEnd = TimeUtils.endOfDayIST();

    // Today's bookings, plus any session currently under way. A session that began
    // before today's window (an overnight or long booking) is still what the nanny
    // is doing right now, so it must not fall off the dashboard.
    const todayBookings = await this.prisma.bookings.findMany({
      where: {
        nanny_id: nannyId,
        status: { not: "CANCELLED" },
        OR: [
          { start_time: { gte: todayStart, lte: todayEnd } },
          { status: BookingStatus.IN_PROGRESS },
        ],
      },
      include: {
        service_requests: { select: { category: true, num_children: true } },
        users_bookings_parent_idTousers: { include: { profiles: true } },
      },
      orderBy: { start_time: "asc" },
    }) as any[];

    const completedToday = todayBookings.filter((b) => b.status === "COMPLETED").length;
    const pendingToday = todayBookings.filter((b) =>
      ["CONFIRMED", "IN_PROGRESS", "ASSIGNED", "ACCEPTED"].includes(b.status ?? ""),
    ).length;

    /**
     * The dashboard reads the same ledger as the earnings screen, through the same
     * policy — a caregiver must not see one figure on the home tab and another on
     * `/earnings`. In particular this counts `pending_release` (completing a booking
     * flips its captured payment straight into it, so filtering on `captured` alone
     * showed ₹0 for every job the moment it was done) and includes the matching fee,
     * which is deducted from the first cycle and so is part of what she is owed.
     */
    const earningsOn = (bookingIds: string[]) => ({
      booking_id: { in: bookingIds },
      status: { in: EARNING_STATUSES },
      ...CAREGIVER_SHARE_ONLY,
    });

    // Today's earnings (earning payments for today's completed bookings)
    const todayBookingIds = todayBookings
      .filter((b) => b.status === "COMPLETED")
      .map((b) => b.id);

    const todayEarningsAgg = await this.prisma.payments.aggregate({
      where: earningsOn(todayBookingIds),
      _sum: { amount: true },
    });
    const todayEarnings = Number(todayEarningsAgg._sum.amount || 0);

    // Same day last week comparison
    const lastWeekStart = startOfDay(subDays(new Date(), 7));
    const lastWeekEnd = endOfDay(subDays(new Date(), 7));
    const lastWeekBookingIds = (
      await this.prisma.bookings.findMany({
        where: {
          nanny_id: nannyId,
          start_time: { gte: lastWeekStart, lte: lastWeekEnd },
          status: "COMPLETED",
        },
        select: { id: true },
      })
    ).map((b) => b.id);

    const lastWeekEarningsAgg = await this.prisma.payments.aggregate({
      where: earningsOn(lastWeekBookingIds),
      _sum: { amount: true },
    });
    const lastWeekEarnings = Number(lastWeekEarningsAgg._sum.amount || 0);

    const earningsChange =
      lastWeekEarnings > 0
        ? Math.round(((todayEarnings - lastWeekEarnings) / lastWeekEarnings) * 100)
        : null;

    // Weekly revenue trend (last 7 days)
    const weeklyTrend: { date: string; amount: number }[] = [];
    for (let i = 6; i >= 0; i--) {
      const day = subDays(new Date(), i);
      const dayStart = startOfDay(day);
      const dayEnd = endOfDay(day);

      const dayBookingIds = (
        await this.prisma.bookings.findMany({
          where: {
            nanny_id: nannyId,
            start_time: { gte: dayStart, lte: dayEnd },
            status: "COMPLETED",
          },
          select: { id: true },
        })
      ).map((b) => b.id);

      const dayEarnings = await this.prisma.payments.aggregate({
        where: earningsOn(dayBookingIds),
        _sum: { amount: true },
      });

      weeklyTrend.push({
        date: day.toISOString().slice(0, 10),
        amount: Number(dayEarnings._sum.amount || 0),
      });
    }

    return {
      todayEarnings,
      earningsChange,
      completedToday,
      pendingToday,
      weeklyTrend,
      todaySchedule: todayBookings.map((b) => ({
        id: b.id,
        status: b.status,
        startTime: b.start_time,
        endTime: b.end_time,
        category: b.service_requests?.category ?? "CC",
        numChildren: b.service_requests?.num_children ?? 1,
        parentName: b.users_bookings_parent_idTousers?.profiles
          ? `${(b.users_bookings_parent_idTousers.profiles as any).first_name ?? ""} ${(b.users_bookings_parent_idTousers.profiles as any).last_name ?? ""}`.trim()
          : "Client",
        location: (b.service_requests as any)?.location?.address ?? null,
      })),
    };
  }

  // ─── Performance overview ────────────────────────────────────────

  async getPerformance(nannyId: string) {
    const reviews = await this.prisma.reviews.findMany({
      where: { reviewee_id: nannyId, is_approved: true },
      include: {
        users_reviews_reviewer_idTousers: { select: { profiles: true } },
        bookings: { select: { service_requests: { select: { category: true } } } },
      },
      orderBy: { created_at: "desc" },
    });

    const totalReviews = reviews.length;
    const averageRating =
      totalReviews > 0
        ? Math.round((reviews.reduce((s, r) => s + (r.rating ?? 0), 0) / totalReviews) * 10) / 10
        : 0;

    // Completion rate: completed / (completed + cancelled) for all bookings
    const [completedCount, cancelledCount] = await Promise.all([
      this.prisma.bookings.count({ where: { nanny_id: nannyId, status: "COMPLETED" } }),
      this.prisma.bookings.count({ where: { nanny_id: nannyId, status: "CANCELLED" } }),
    ]);
    const completionRate =
      completedCount + cancelledCount > 0
        ? Math.round((completedCount / (completedCount + cancelledCount)) * 100)
        : 100;

    // Sentiment breakdown from review ratings
    const positive = reviews.filter((r) => (r.rating ?? 0) >= 4).length;
    const neutral = reviews.filter((r) => (r.rating ?? 0) === 3).length;
    const negative = reviews.filter((r) => (r.rating ?? 0) <= 2).length;

    // Punctuality is measured, not inferred. It used to be derived from the
    // average rating, which meant a caregiver could be marked punctual for being
    // well-liked and late for a bad review about something else entirely — the
    // attendance record now supplies the real figure, and the old derivation
    // survives only as a fallback for caregivers without enough sessions yet.
    const attendance = await this.attendance.getSummary(nannyId);
    const punctualityScore =
      attendance.punctuality.onTimeRate ??
      Math.min(100, Math.round((averageRating / 5) * 100 * 1.02));
    const expertiseScore = Math.min(100, Math.round((averageRating / 5) * 100 * 0.98));
    const professionalismScore = Math.min(100, completionRate);

    const recentReviews = reviews.slice(0, 5).map((r) => {
      const reviewer = r.users_reviews_reviewer_idTousers;
      const profile = reviewer?.profiles as any;
      return {
        id: r.id,
        rating: r.rating ?? 0,
        comment: r.comment ?? "",
        createdAt: r.created_at,
        reviewerName: profile
          ? `${profile.first_name ?? ""} ${profile.last_name ?? ""}`.trim()
          : "Client",
        reviewerInitials: profile?.first_name
          ? `${profile.first_name[0]}${profile.last_name?.[0] ?? ""}`.toUpperCase()
          : "C",
        category: (r.bookings?.service_requests as any)?.category ?? "CC",
      };
    });

    return {
      averageRating,
      totalReviews,
      completionRate,
      punctualityScore,
      expertiseScore,
      professionalismScore,
      sentiment: {
        positive: totalReviews > 0 ? Math.round((positive / totalReviews) * 100) : 0,
        neutral: totalReviews > 0 ? Math.round((neutral / totalReviews) * 100) : 0,
        negative: totalReviews > 0 ? Math.round((negative / totalReviews) * 100) : 0,
      },
      attendance: {
        score: attendance.score,
        band: attendance.band,
        windowDays: attendance.windowDays,
        sessionsCounted: attendance.sessionsCounted,
        onTimeRate: attendance.punctuality.onTimeRate,
        noShows: attendance.sessions.noShows,
        lateCancellations: attendance.sessions.lateCancellations,
        currentStreak: attendance.days.currentStreak,
      },
      recentReviews,
    };
  }

  /**
   * Presence heartbeat from the partner app.
   *
   * `is_available_now` already gated matching; what was missing was any record of
   * *when* it was last true, which is what lets the attendance sweeps tell a
   * caregiver who switched off from one whose app was killed mid-session. Going
   * offline is never itself an absence — it only counts while a session is
   * actually running.
   */
  async updatePresence(nannyId: string, online: boolean) {
    return this.prisma.nanny_details.update({
      where: { user_id: nannyId },
      data: { is_available_now: online, last_seen_at: new Date() },
      select: { is_available_now: true, last_seen_at: true },
    });
  }

  /** Liveness ping. Touches `last_seen_at` without changing the caregiver's stated availability. */
  async recordHeartbeat(nannyId: string) {
    await this.prisma.nanny_details.updateMany({
      where: { user_id: nannyId },
      data: { last_seen_at: new Date() },
    });
    return { ok: true, at: new Date() };
  }

  async getSettings(nannyId: string) {
    const details = await this.prisma.nanny_details.findUnique({
      where: { user_id: nannyId },
      select: {
        auto_accept_bookings: true,
        default_start_time: true,
        default_end_time: true,
      },
    });

    if (!details) throw new NotFoundException("Nanny profile not found");

    return details;
  }

  async updateSettings(
    nannyId: string,
    dto: {
      auto_accept_bookings?: boolean;
      default_start_time?: string | null;
      default_end_time?: string | null;
    },
  ) {
    const timePattern = /^([01]\d|2[0-3]):([0-5]\d)$/;
    if (dto.default_start_time && !timePattern.test(dto.default_start_time)) {
      throw new BadRequestException("default_start_time must be in HH:MM format");
    }
    if (dto.default_end_time && !timePattern.test(dto.default_end_time)) {
      throw new BadRequestException("default_end_time must be in HH:MM format");
    }
    if (
      dto.default_start_time &&
      dto.default_end_time &&
      dto.default_end_time <= dto.default_start_time
    ) {
      throw new BadRequestException("default_end_time must be after default_start_time");
    }

    return this.prisma.nanny_details.update({
      where: { user_id: nannyId },
      data: {
        ...(dto.auto_accept_bookings !== undefined && {
          auto_accept_bookings: dto.auto_accept_bookings,
        }),
        ...(dto.default_start_time !== undefined && {
          default_start_time: dto.default_start_time,
        }),
        ...(dto.default_end_time !== undefined && {
          default_end_time: dto.default_end_time,
        }),
      },
      select: {
        auto_accept_bookings: true,
        default_start_time: true,
        default_end_time: true,
      },
    });
  }
}
