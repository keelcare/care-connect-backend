import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CreateRecurringRequestDto, RecurrenceType } from "./dto/create-recurring-request.dto";
import { TimeUtils } from "../common/utils/time.utils";

@Injectable()
export class RecurringRequestsService {
  private readonly logger = new Logger(RecurringRequestsService.name);

  constructor(private prisma: PrismaService) {}

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

    // 1. Get parent profile for location
    const parent = await this.prisma.users.findUnique({
      where: { id: parentId },
      include: { profiles: true },
    });

    if (!parent || !parent.profiles) {
      throw new NotFoundException("Parent profile not found");
    }

    if (!parent.profiles.lat || !parent.profiles.lng) {
      throw new BadRequestException(
        "Parent profile incomplete. Address and location required.",
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
          location_lat: parent.profiles.lat,
          location_lng: parent.profiles.lng,
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
          where: { start_time: { gte: new Date() }, status: { not: "CANCELLED" } },
          orderBy: { start_time: 'asc' },
          take: 1,
          select: { start_time: true }
        }
      },
      orderBy: { created_at: "desc" },
    });

    return requests.map(req => {
      const { bookings, _count, ...rest } = req;
      return {
        ...rest,
        start_time_formatted: TimeUtils.formatShortTime(req.start_time),
        total_bookings: _count.bookings,
        next_upcoming_date: bookings.length > 0 ? bookings[0].start_time : null
      };
    });
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
    return {
      ...req,
      start_time_formatted: TimeUtils.formatShortTime(req.start_time)
    };
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
