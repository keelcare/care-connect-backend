import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CreateRecurringRequestDto, RecurrenceType } from "./dto/create-recurring-request.dto";
import { TimeUtils } from "../common/utils/time.utils";
import { resolveDaysPerWeek, WEEKS_PER_MONTH } from "../common/utils/pricing.utils";
import { PricingEngineService } from "../common/pricing.service";
import { AddressesService } from "../addresses/addresses.service";
import { NotificationsService } from "../notifications/notifications.service";

@Injectable()
export class RecurringRequestsService {
  private readonly logger = new Logger(RecurringRequestsService.name);

  constructor(
    private prisma: PrismaService,
    private addressesService: AddressesService,
    private notificationsService: NotificationsService,
    private pricingService: PricingEngineService,
  ) {}

  /**
   * Helper to generate a list of dates based on recurrence pattern
   */
  public generateDates(
    startDateStr: string | Date,
    endDateStr: string | Date | undefined,
    recurrenceType: RecurrenceType,
    pattern: any,
    maxMonths: number = 1 // Generate bookings for up to 1 month by default
  ): Date[] {
    const dates: Date[] = [];
    const start = new Date(startDateStr);
    
    // Default end date is 3 months from start if not provided
    let end = endDateStr ? new Date(endDateStr) : TimeUtils.addMonths(start, maxMonths);

    // Limit generation to max 6 months to prevent massive DB inserts at once
    const maxEnd = TimeUtils.addMonths(start, 6);
    if (end > maxEnd) {
      end = maxEnd;
    }

    const current = new Date(start);
    
    // Normalize hours to prevent timezone shift issues during day iteration
    current.setHours(12, 0, 0, 0); 
    end.setHours(23, 59, 59, 999);

    if (recurrenceType === RecurrenceType.WEEKLY) {
      const targetDays: string[] = pattern.days || [];
      const dayMap: Record<string, number> = {
        "Sun": 0, "Mon": 1, "Tue": 2, "Wed": 3, "Thu": 4, "Fri": 5, "Sat": 6
      };
      const targetInts = targetDays.map(d => dayMap[d]).filter(d => d !== undefined);

      while (current <= end) {
        if (targetInts.includes(current.getDay())) {
          dates.push(new Date(current));
        }
        current.setDate(current.getDate() + 1);
      }
    } else if (recurrenceType === RecurrenceType.SPECIFIC_DATES) {
      const targetDates: number[] = pattern.dates || [];
      while (current <= end) {
        if (targetDates.includes(current.getDate())) {
          dates.push(new Date(current));
        }
        current.setDate(current.getDate() + 1);
      }
    }

    return dates;
  }

  async create(parentId: string, dto: CreateRecurringRequestDto) {
    this.logger.log(`Parent ${parentId} creating recurring request`);

    // 1. Get the sessions' location — the address the parent picked, else their
    // default saved address, falling back to the legacy profiles.lat/lng.
    const selectedAddress = await this.addressesService.resolveForUser(
      parentId,
      dto.address_id,
    );
    const parent = await this.prisma.users.findUnique({
      where: { id: parentId },
      include: { profiles: true },
    });

    if (!parent || !parent.profiles) {
      throw new NotFoundException("Parent profile not found");
    }

    const lat = selectedAddress?.lat ?? parent.profiles.lat;
    const lng = selectedAddress?.lng ?? parent.profiles.lng;
    if (!lat || !lng) {
      throw new BadRequestException(
        "Add a saved address before requesting a caregiver.",
      );
    }

    const generatedDates = this.generateDates(
      dto.start_date,
      dto.end_date,
      dto.recurrence_type,
      dto.recurrence_pattern,
      1 // Only generate the first month upfront to keep transaction fast
    );

    if (generatedDates.length === 0) {
      throw new BadRequestException("The recurrence pattern yielded no valid dates.");
    }

    // The weekday list the parent tapped is what the plan costs: rate × hours per
    // day × these days × 4 weeks × plan months. Stored on both the plan and each
    // booking so pricing never has to re-parse the pattern JSON.
    const daysPerWeek = resolveDaysPerWeek({
      planType: dto.plan_type || "MONTHLY",
      daysPerWeek: dto.days_per_week,
      recurrencePattern: dto.recurrence_pattern,
      sessionsPerMonth: dto.sessions_per_month,
    });

    // Convert start time string to DateTime for schema
    const startTimeObj = TimeUtils.combineDateAndTime(dto.start_date, dto.start_time);

    // 2. Transaction to create the master request and all daily bookings
    const result = await this.prisma.$transaction(async (tx) => {
      const recurringReq = await tx.recurring_service_requests.create({
        data: {
          parent_id: parentId,
          // A plan is only "active" once a nanny is assigned to its bookings
          // (see AdminService.manualAssign). Until then it is pending — the column
          // default of "active" would otherwise show every brand-new plan as live.
          status: "pending",
          recurrence_type: dto.recurrence_type,
          recurrence_pattern: dto.recurrence_pattern,
          start_date: new Date(dto.start_date),
          end_date: dto.end_date ? new Date(dto.end_date) : null,
          start_time: startTimeObj,
          duration_hours: dto.duration_hours,
          num_children: dto.num_children,
          children_ages: dto.children_ages || [],
          special_requirements: dto.special_requirements,
          required_skills: dto.required_skills || [],
          category: dto.category,
          plan_duration_months: dto.plan_duration_months,
          plan_type: dto.plan_type,
          sessions_per_month: dto.sessions_per_month,
          days_per_week: daysPerWeek,
          max_hourly_rate: dto.max_hourly_rate,
          location_lat: lat,
          location_lng: lng,
        },
      });

      // Prepare bookings
      const bookingsData = generatedDates.map(date => {
        const startTimestamp = TimeUtils.combineDateAndTime(
          date.toISOString().split("T")[0],
          dto.start_time
        );
        const endTimestamp = TimeUtils.getEndTime(startTimestamp, dto.duration_hours);

        return {
          parent_id: parentId,
          recurring_request_id: recurringReq.id,
          status: "requested",
          start_time: startTimestamp,
          end_time: endTimestamp,
          tags: ["recurring", `category:${dto.category}`],
          hours_per_day: dto.duration_hours,
          days_per_week: daysPerWeek,
          plan_duration_months: dto.plan_duration_months || 1,
        };
      });

      // Need to create bookings individually if we want to link children
      // Executing them concurrently with Promise.all to speed up the transaction
      const createdBookings = await Promise.all(
        bookingsData.map(async (bookingData) => {
          const booking = await tx.bookings.create({
            data: bookingData
          });
          
          if (dto.child_ids && dto.child_ids.length > 0) {
            await tx.booking_children.createMany({
              data: dto.child_ids.map(childId => ({
                booking_id: booking.id,
                child_id: childId
              }))
            });
          }
          return booking;
        })
      );

      return { recurringReq, generatedBookingsCount: createdBookings.length };
    }, {
      timeout: 20000, // Increase timeout to 20s for bulk inserts
      maxWait: 5000,
    });

    return result;
  }

  async findAllByParent(parentId: string) {
    const requests = await this.prisma.recurring_service_requests.findMany({
      where: { parent_id: parentId },
      include: {
        _count: {
          select: { bookings: { where: { status: { not: "CANCELLED" } } } }
        },
        // Only needed to find the next session — staffing now comes off the plan.
        bookings: {
          where: { status: { not: "CANCELLED" } },
          orderBy: { start_time: 'asc' },
          select: { start_time: true },
        },
        nanny: {
          select: {
            id: true,
            profiles: {
              select: { first_name: true, last_name: true, profile_image_url: true },
            },
          },
        },
      },
      orderBy: { created_at: "desc" },
    });

    const now = new Date();

    return Promise.all(
      requests.map(async (req) => {
        const { bookings, _count, nanny, ...rest } = req;
        const upcoming = bookings.find((b) => b.start_time >= now) ?? null;

        const planType = req.plan_type || "MONTHLY";
        const planMonths = Number(req.plan_duration_months || 1);
        const daysPerWeek = resolveDaysPerWeek({
          planType,
          daysPerWeek: req.days_per_week,
          recurrencePattern: req.recurrence_pattern,
          sessionsPerMonth: req.sessions_per_month,
        });

        // Priced through the engine, never re-derived here. The old sum was
        // `rate × hours × <rows generated so far>`, which is a different figure
        // entirely: generation walks a calendar month inclusive of both ends and
        // yields 22–24 dates, while the plan is sold as 4 weeks. That is why a
        // plan quoted at ₹15,840 displayed as ₹19,008.
        const { totalAmount, appliedRate } = await this.pricingService.calculateCost(
          req.category || "CC",
          Number(req.duration_hours || 0),
          planMonths,
          planType,
          daysPerWeek,
        );

        return {
          ...rest,
          status: this.effectiveStatus(rest.status, !!rest.nanny_id),
          start_time_formatted: TimeUtils.formatShortTime(req.start_time),
          /** Sessions actually on the calendar — only the first month is generated upfront. */
          total_bookings: _count.bookings,
          /**
           * Sessions the plan was sold as, across its whole term. The progress bar
           * measures against this: counting generated rows would show a six-month
           * plan as "0 of 24" when it runs to roughly 120 sessions.
           */
          total_sessions: daysPerWeek * WEEKS_PER_MONTH * planMonths,
          next_upcoming_date: upcoming ? upcoming.start_time : null,
          nanny: nanny ?? null,
          hourly_rate: appliedRate || null,
          estimated_total: totalAmount || null,
        };
      }),
    );
  }

  /**
   * "active" means a nanny is actually serving the plan. Rows created before the
   * pending-by-default fix were stored as "active" from birth (the column default),
   * so a stored "active" with no nanny on any booking is really still pending.
   * Terminal states (cancelled/completed/expired/error) are reported as-is.
   */
  private effectiveStatus(stored: string, hasNanny: boolean): string {
    if (stored !== "active") return stored;
    return hasNanny ? "active" : "pending";
  }

  async findOne(id: string, userId: string, role: string) {
    const req = await this.prisma.recurring_service_requests.findUnique({
      where: { id },
      include: {
        _count: {
          select: { bookings: { where: { status: { not: "CANCELLED" } } } }
        },
        nanny: {
          select: {
            id: true,
            profiles: { select: { first_name: true, last_name: true, profile_image_url: true } },
          },
        },
      }
    });

    if (!req) throw new NotFoundException("Recurring request not found");
    // Scope the read to the owning parent (mirrors cancel) or an admin. Return
    // NotFound for anyone else so existence of the plan isn't leaked.
    if (req.parent_id !== userId && role !== "admin") {
      throw new NotFoundException("Recurring request not found");
    }

    return {
      ...req,
      status: this.effectiveStatus(req.status, !!req.nanny_id),
      start_time_formatted: TimeUtils.formatShortTime(req.start_time)
    };
  }

  /**
   * Parent-initiated cancellation of a whole plan. Ends the series and cancels
   * every future session that hasn't already started — sessions that are
   * completed or currently under way are left untouched (they were delivered
   * and still need to be paid/settled). Assigned nannies whose future sessions
   * were dropped are notified.
   */
  async cancel(id: string, parentId: string, reason?: string) {
    const req = await this.prisma.recurring_service_requests.findUnique({
      where: { id },
      select: { id: true, parent_id: true, status: true, category: true },
    });
    if (!req) throw new NotFoundException("Recurring request not found");
    if (req.parent_id !== parentId) {
      throw new ForbiddenException("You can only cancel your own recurring plans");
    }
    if (["cancelled", "completed", "expired"].includes(req.status)) {
      throw new BadRequestException(`This plan is already ${req.status}`);
    }

    const now = TimeUtils.nowIST();
    const cancellationReason = reason?.trim() || "Recurring plan cancelled by parent";

    // Capture who loses sessions before the rows flip to CANCELLED.
    const affected = await this.prisma.bookings.findMany({
      where: {
        recurring_request_id: id,
        start_time: { gt: now },
        status: { notIn: ["CANCELLED", "COMPLETED", "IN_PROGRESS"] },
        nanny_id: { not: null },
      },
      select: { nanny_id: true },
      distinct: ["nanny_id"],
    });

    const [, cancelledBookings] = await this.prisma.$transaction([
      this.prisma.recurring_service_requests.update({
        where: { id },
        // Release the caregiver — the plan is closed, so nothing should keep
        // generating sessions against them.
        data: { status: "cancelled", nanny_id: null, updated_at: now },
      }),
      this.prisma.bookings.updateMany({
        where: {
          recurring_request_id: id,
          start_time: { gt: now },
          status: { notIn: ["CANCELLED", "COMPLETED", "IN_PROGRESS"] },
        },
        data: { status: "CANCELLED", cancellation_reason: cancellationReason },
      }),
    ]);

    for (const { nanny_id } of affected) {
      await this.notificationsService
        .createNotification(
          nanny_id as string,
          "Recurring plan cancelled",
          "A parent has cancelled their recurring plan. The upcoming sessions assigned to you have been removed from your schedule.",
          "warning",
          "recurring_request",
          id,
        )
        .catch((err) =>
          this.logger.error(`Failed to notify nanny ${nanny_id} of plan cancellation`, err),
        );
    }

    this.logger.log(
      `Recurring request ${id} cancelled by parent ${parentId}; ${cancelledBookings.count} future sessions cancelled.`,
    );
    return { success: true, cancelledSessions: cancelledBookings.count };
  }

  async findBookingsForRequest(
    id: string,
    page: number = 1,
    limit: number = 10,
    userId?: string,
    role?: string,
  ) {
    // Scope to the owning parent (mirrors cancel) or an admin before listing
    // any bookings under the plan.
    const parent = await this.prisma.recurring_service_requests.findUnique({
      where: { id },
      select: { parent_id: true },
    });
    if (!parent) throw new NotFoundException("Recurring request not found");
    if (parent.parent_id !== userId && role !== "admin") {
      throw new NotFoundException("Recurring request not found");
    }

    const skip = (page - 1) * limit;

    const [bookings, total] = await this.prisma.$transaction([
      this.prisma.bookings.findMany({
        where: { recurring_request_id: id },
        include: {
          users_bookings_nanny_idTousers: {
            select: {
              id: true,
              profiles: { select: { first_name: true, last_name: true, profile_image_url: true } }
            }
          },
          assignments: {
            include: {
              users: { select: { id: true, profiles: { select: { first_name: true, last_name: true, profile_image_url: true } } } }
            }
          }
        },
        orderBy: { start_time: 'asc' },
        skip,
        take: limit,
      }),
      this.prisma.bookings.count({ where: { recurring_request_id: id } })
    ]);

    return {
      items: bookings,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit)
      }
    };
  }
}
