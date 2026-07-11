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
import { AddressesService } from "../addresses/addresses.service";
import { NotificationsService } from "../notifications/notifications.service";

@Injectable()
export class RecurringRequestsService {
  private readonly logger = new Logger(RecurringRequestsService.name);

  constructor(
    private prisma: PrismaService,
    private addressesService: AddressesService,
    private notificationsService: NotificationsService,
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
          days_per_week: dto.sessions_per_month 
            ? Math.max(1, Math.round(dto.sessions_per_month / 4)) 
            : (dto.recurrence_type === 'weekly' ? (dto.recurrence_pattern.days?.length || 1) : 1),
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
        bookings: {
          where: { status: { not: "CANCELLED" } },
          orderBy: { start_time: 'asc' },
          select: {
            start_time: true,
            nanny_id: true,
            users_bookings_nanny_idTousers: {
              select: {
                id: true,
                profiles: {
                  select: { first_name: true, last_name: true, profile_image_url: true },
                },
              },
            },
          },
        }
      },
      orderBy: { created_at: "desc" },
    });

    // Current base hourly rate per category so each series can quote a price.
    const rateByCategory = new Map<string, number>();
    const categories = [...new Set(requests.map((r) => r.category ?? "CC"))];
    for (const category of categories) {
      const service = await this.prisma.services.findFirst({
        where: { OR: [{ name: category }, { slug: category.toLowerCase() }] },
        include: {
          rate_cards: {
            where: { effective_to: null },
            orderBy: { effective_from: "desc" },
            take: 1,
          },
        },
      });
      const rate = service?.rate_cards?.[0]?.hourly_rate;
      if (rate != null) rateByCategory.set(category, Number(rate));
    }

    const now = new Date();
    return requests.map(req => {
      const { bookings, _count, ...rest } = req;
      const upcoming = bookings.find((b) => b.start_time >= now) ?? null;
      const withNanny = bookings.find((b) => b.nanny_id) ?? null;
      const hourlyRate = rateByCategory.get(req.category ?? "CC") ?? null;
      const estimatedTotal =
        hourlyRate != null
          ? Math.round(hourlyRate * Number(req.duration_hours) * _count.bookings * 100) / 100
          : null;

      return {
        ...rest,
        status: this.effectiveStatus(rest.status, !!withNanny),
        start_time_formatted: TimeUtils.formatShortTime(req.start_time),
        total_bookings: _count.bookings,
        next_upcoming_date: upcoming ? upcoming.start_time : null,
        nanny: withNanny?.users_bookings_nanny_idTousers ?? null,
        hourly_rate: hourlyRate,
        estimated_total: estimatedTotal,
      };
    });
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

  async findOne(id: string) {
    const req = await this.prisma.recurring_service_requests.findUnique({
      where: { id },
      include: {
        _count: {
          select: { bookings: { where: { status: { not: "CANCELLED" } } } }
        }
      }
    });

    if (!req) throw new NotFoundException("Recurring request not found");

    const assigned = await this.prisma.bookings.findFirst({
      where: { recurring_request_id: id, status: { not: "CANCELLED" }, nanny_id: { not: null } },
      select: { id: true },
    });

    return {
      ...req,
      status: this.effectiveStatus(req.status, !!assigned),
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
        data: { status: "cancelled", updated_at: now },
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

  async findBookingsForRequest(id: string, page: number = 1, limit: number = 10) {
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
