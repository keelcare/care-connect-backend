import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { Cron, CronExpression } from "@nestjs/schedule";
import { TimeUtils } from "../common/utils/time.utils";

@Injectable()
export class RecurringBookingsService {
  constructor(private prisma: PrismaService) {}

  async create(parentId: string, data: any) {
    return this.prisma.recurring_bookings.create({
      data: {
        parent_id: parentId,
        nanny_id: data.nannyId,
        recurrence_pattern: data.recurrencePattern,
        start_date: new Date(data.startDate),
        end_date: data.endDate ? new Date(data.endDate) : null,
        start_time: data.startTime,
        duration_hours: data.durationHours,
        num_children: data.numChildren,
        children_ages: data.childrenAges,
        special_requirements: data.specialRequirements,
      },
    });
  }

  async findAll(userId: string, role: string) {
    const where =
      role === "parent" ? { parent_id: userId } : { nanny_id: userId };
    return this.prisma.recurring_bookings.findMany({
      where,
      include: {
        users_recurring_bookings_parent_idTousers: {
          include: { profiles: true },
        },
        users_recurring_bookings_nanny_idTousers: {
          include: { profiles: true, nanny_details: true },
        },
      },
      orderBy: { created_at: "desc" },
    });
  }

  async findOne(id: string) {
    const recurring = await this.prisma.recurring_bookings.findUnique({
      where: { id },
      include: {
        users_recurring_bookings_parent_idTousers: {
          include: { profiles: true },
        },
        users_recurring_bookings_nanny_idTousers: {
          include: { profiles: true, nanny_details: true },
        },
        bookings: true,
      },
    });
    if (!recurring) throw new NotFoundException("Recurring booking not found");
    return recurring;
  }

  async update(id: string, data: any) {
    return this.prisma.recurring_bookings.update({
      where: { id },
      data: {
        recurrence_pattern: data.recurrencePattern,
        end_date: data.endDate ? new Date(data.endDate) : undefined,
        is_active: data.isActive,
      },
    });
  }

  async delete(id: string) {
    return this.prisma.recurring_bookings.update({
      where: { id },
      data: { is_active: false },
    });
  }

  // Cron job to generate bookings from recurring patterns
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async generateRecurringBookings() {
    console.log("Running recurring bookings generation...");

    const activeRecurring = await this.prisma.recurring_bookings.findMany({
      where: { is_active: true },
    });

    const today = TimeUtils.nowIST();
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    for (const recurring of activeRecurring) {
      try {
        // Check if end_date has passed
        if (recurring.end_date && recurring.end_date < today) {
          await this.prisma.recurring_bookings.update({
            where: { id: recurring.id },
            data: { is_active: false },
          });
          continue;
        }

        // Check if tomorrow matches the recurrence pattern
        if (this.shouldCreateBooking(tomorrow, recurring.recurrence_pattern)) {
          // Calculate potential booking times
          const startTime = TimeUtils.combineDateAndTime(
            tomorrow,
            recurring.start_time,
          );
          const endTime = TimeUtils.getEndTime(
            startTime,
            Number(recurring.duration_hours),
          );

          // 1. Check for general conflicts for this nanny
          const conflict = await this.prisma.bookings.findFirst({
            where: {
              nanny_id: recurring.nanny_id,
              status: "CONFIRMED",
              AND: [
                { start_time: { lt: endTime } },
                { end_time: { gt: startTime } },
              ],
            },
          });

          if (conflict) {
            await this.prisma.recurring_booking_logs.create({
              data: {
                recurring_booking_id: recurring.id,
                booking_date: tomorrow,
                status: "CONFLICT",
                reason: `Nanny is already booked for a confirmed slot: ${conflict.start_time.toLocaleTimeString()} - ${conflict.end_time.toLocaleTimeString()}`,
              },
            });
            console.log(
              `Conflict detected for recurring ${recurring.id} on ${tomorrow.toDateString()}`,
            );
            continue;
          }

          // 2. Check if a booking FROM THIS RECURRING PATTERN already exists (Safety check)
          const existingSamePattern = await this.prisma.bookings.findFirst({
            where: {
              recurring_booking_id: recurring.id,
              start_time: {
                gte: new Date(new Date(tomorrow).setHours(0, 0, 0, 0)),
                lt: new Date(new Date(tomorrow).setHours(23, 59, 59, 999)),
              },
            },
          });

          if (existingSamePattern) {
            console.log(
              `Booking for recurring ${recurring.id} already exists for ${tomorrow.toDateString()}, skipping.`,
            );
            continue;
          }

          // Create booking
          await this.prisma.$transaction(async (tx) => {
            const booking = await tx.bookings.create({
              data: {
                parent_id: recurring.parent_id,
                nanny_id: recurring.nanny_id,
                recurring_booking_id: recurring.id,
                start_time: startTime,
                end_time: endTime,
                status: "CONFIRMED",
              },
            });

            await tx.recurring_booking_logs.create({
              data: {
                recurring_booking_id: recurring.id,
                booking_date: tomorrow,
                status: "SUCCESS",
                reason: `Successfully generated booking: ${booking.id}`,
              },
            });
          });

          console.log(
            `Created booking for recurring ${recurring.id} on ${tomorrow.toDateString()}`,
          );
        }
      } catch (error) {
        console.error(
          `Error generating booking for recurring ${recurring.id}:`,
          error,
        );
        await this.prisma.recurring_booking_logs
          .create({
            data: {
              recurring_booking_id: recurring.id,
              booking_date: tomorrow,
              status: "ERROR",
              reason: error.message || "Unknown error during generation",
            },
          })
          .catch((err) =>
            console.error("Failed to log generation error to DB", err),
          );
      }
    }
  }

  private shouldCreateBooking(date: Date, pattern: string): boolean {
    const dayOfWeek = date.getDay(); // 0 = Sunday, 1 = Monday, etc.
    const dayOfMonth = date.getDate();

    // Weekly patterns: WEEKLY_MON, WEEKLY_MON_WED_FRI, etc.
    if (pattern.startsWith("WEEKLY_")) {
      const days = pattern.replace("WEEKLY_", "").split("_");
      const dayMap: Record<string, number> = {
        SUN: 0,
        MON: 1,
        TUE: 2,
        WED: 3,
        THU: 4,
        FRI: 5,
        SAT: 6,
      };
      return days.some((day) => dayMap[day] === dayOfWeek);
    }

    // Monthly patterns: MONTHLY_1, MONTHLY_1_15, etc.
    if (pattern.startsWith("MONTHLY_")) {
      const dates = pattern.replace("MONTHLY_", "").split("_").map(Number);
      return dates.includes(dayOfMonth);
    }

    // Daily pattern
    if (pattern === "DAILY") {
      return true;
    }

    return false;
  }
}
