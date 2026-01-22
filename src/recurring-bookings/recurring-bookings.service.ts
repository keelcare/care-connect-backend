import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { Cron, CronExpression } from "@nestjs/schedule";

@Injectable()
export class RecurringBookingsService {
    constructor(private prisma: PrismaService) { }

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
        const where = role === "parent" ? { parent_id: userId } : { nanny_id: userId };
        const recurring = await this.prisma.recurring_bookings.findMany({
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

        return recurring.map(r => {
            const nannyProfile = r.users_recurring_bookings_nanny_idTousers?.profiles;
            const parentProfile = r.users_recurring_bookings_parent_idTousers?.profiles;
            return {
                ...r,
                nanny_name: nannyProfile ? `${nannyProfile.first_name} ${nannyProfile.last_name}` : "Nanny",
                parent_name: parentProfile ? `${parentProfile.first_name} ${parentProfile.last_name}` : "Parent",
            };
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

        const nannyProfile = recurring.users_recurring_bookings_nanny_idTousers?.profiles;
        const parentProfile = recurring.users_recurring_bookings_parent_idTousers?.profiles;

        return {
            ...recurring,
            nanny_name: nannyProfile ? `${nannyProfile.first_name} ${nannyProfile.last_name}` : "Nanny",
            parent_name: parentProfile ? `${parentProfile.first_name} ${parentProfile.last_name}` : "Parent",
        };
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

        const today = new Date();
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);

        for (const recurring of activeRecurring) {
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
                // Check if booking already exists for this date
                const existingBooking = await this.prisma.bookings.findFirst({
                    where: {
                        recurring_booking_id: recurring.id,
                        start_time: {
                            gte: new Date(tomorrow.setHours(0, 0, 0, 0)),
                            lt: new Date(tomorrow.setHours(23, 59, 59, 999)),
                        },
                    },
                });

                if (!existingBooking) {
                    // Create booking
                    const [hours, minutes] = recurring.start_time.split(":").map(Number);
                    const startTime = new Date(tomorrow);
                    startTime.setHours(hours, minutes, 0, 0);

                    await this.prisma.bookings.create({
                        data: {
                            parent_id: recurring.parent_id,
                            nanny_id: recurring.nanny_id,
                            recurring_booking_id: recurring.id,
                            start_time: startTime,
                            status: "CONFIRMED",
                        },
                    });

                    console.log(`Created booking for recurring ${recurring.id} on ${tomorrow.toDateString()}`);
                }
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
                SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6,
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
