import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { TimeUtils } from "../common/utils/time.utils";
import { BookingStatus } from "../common/constants/booking-status.enum";

@Injectable()
export class AvailabilityService {
  private readonly logger = new Logger(AvailabilityService.name);

  constructor(private prisma: PrismaService) {}

  async createBlock(nannyId: string, data: any) {
    return this.prisma.availability_blocks.create({
      data: {
        nanny_id: nannyId,
        start_time: new Date(data.startTime),
        end_time: new Date(data.endTime),
        is_recurring: data.isRecurring || false,
        recurrence_pattern: data.recurrencePattern,
        reason: data.reason,
      },
    });
  }

  async findAll(nannyId: string) {
    return this.prisma.availability_blocks.findMany({
      where: { nanny_id: nannyId },
      orderBy: { start_time: "asc" },
    });
  }

  async delete(id: string) {
    return this.prisma.availability_blocks.delete({
      where: { id },
    });
  }

  private static readonly DAY_NAMES = [
    "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
  ];

  /**
   * Bucket recent service requests by weekday + time-of-day to surface which
   * slots see the most demand. Normalized against the busiest bucket so the
   * top slot is always ~100%.
   */
  async getDemandForecast(nannyId: string) {
    const nannyDetails = await this.prisma.nanny_details.findUnique({
      where: { user_id: nannyId },
      select: { categories: true },
    });

    const since = new Date();
    since.setDate(since.getDate() - 90);

    const requests = await this.prisma.service_requests.findMany({
      where: {
        created_at: { gte: since },
        ...(nannyDetails?.categories?.length
          ? { category: { in: nannyDetails.categories } }
          : {}),
      },
      select: { date: true, start_time: true },
    });

    const periods: { label: string; startHour: number; endHour: number }[] = [
      { label: "Mornings", startHour: 6, endHour: 12 },
      { label: "Afternoons", startHour: 12, endHour: 17 },
      { label: "Evenings", startHour: 17, endHour: 21 },
      { label: "Nights", startHour: 21, endHour: 6 },
    ];

    const bucketCounts = new Map<string, number>();

    for (const req of requests) {
      const day = new Date(req.date).getDay();
      const hour = new Date(req.start_time).getUTCHours();
      const period = periods.find((p) =>
        p.startHour < p.endHour
          ? hour >= p.startHour && hour < p.endHour
          : hour >= p.startHour || hour < p.endHour,
      );
      if (!period) continue;
      const key = `${day}:${period.label}`;
      bucketCounts.set(key, (bucketCounts.get(key) || 0) + 1);
    }

    if (bucketCounts.size === 0) {
      return { slots: [], sampleSize: 0, windowDays: 90 };
    }

    const maxCount = Math.max(...bucketCounts.values());

    const slots = Array.from(bucketCounts.entries())
      .map(([key, count]) => {
        const [dayStr, periodLabel] = key.split(":");
        const dayName = AvailabilityService.DAY_NAMES[Number(dayStr)];
        return {
          label: `${dayName} ${periodLabel}`,
          count,
          pct: Math.round((count / maxCount) * 100),
        };
      })
      .sort((a, b) => b.count - a.count);

    return { slots, sampleSize: requests.length, windowDays: 90 };
  }

  /**
   * Unified check: Is the nanny free for a specific time slot?
   * Checks both explicit 'availability_blocks' and existing 'bookings'.
   */
  async isNannyAvailable(
    nannyId: string,
    startTime: Date,
    endTime: Date,
  ): Promise<boolean> {
    // 1. Check for overlapping explicit blocks (Unavailable time)
    const blocks = await this.prisma.availability_blocks.findMany({
      where: { nanny_id: nannyId },
    });

    for (const block of blocks) {
      if (block.is_recurring && block.recurrence_pattern) {
        if (this.matchesRecurringPattern(startTime, endTime, block)) {
          return false;
        }
      } else {
        // Non-recurring block check
        if (
          TimeUtils.isOverlapping(
            startTime,
            endTime,
            block.start_time,
            block.end_time,
          )
        ) {
          return false;
        }
      }
    }

    // 2. Check for overlapping CONFIRMED bookings
    const bookings = await this.prisma.bookings.findFirst({
      where: {
        nanny_id: nannyId,
        status: { in: [BookingStatus.CONFIRMED, BookingStatus.IN_PROGRESS, BookingStatus.REQUESTED] },
        AND: [{ start_time: { lt: endTime } }, { end_time: { gt: startTime } }],
      },
    });

    if (bookings) {
      this.logger.debug(`Nanny ${nannyId} is busy with booking ${bookings.id}`);
      return false;
    }

    return true;
  }

  /**
   * Checks whether a single pre-loaded availability_block overlaps with the given time window.
   * No DB access — safe to call in a tight loop after batch-loading blocks.
   * Used by triggerMatching to avoid N+1 queries.
   */
  doesBlockOverlap(
    block: { start_time: Date; end_time: Date; is_recurring: boolean; recurrence_pattern: string | null },
    startTime: Date,
    endTime: Date,
  ): boolean {
    if (block.is_recurring && block.recurrence_pattern) {
      return this.matchesRecurringPattern(startTime, endTime, block);
    }
    return TimeUtils.isOverlapping(startTime, endTime, block.start_time, block.end_time);
  }

  private matchesRecurringPattern(
    reqStart: Date,
    reqEnd: Date,
    block: any,
  ): boolean {
    const pattern = block.recurrence_pattern;
    const blockStart = new Date(block.start_time);
    const blockEnd = new Date(block.end_time);

    // If request is before the block even started existing, it's fine
    if (reqStart < blockStart) return false;

    // Daily: Every day at the same time
    if (pattern === "DAILY") {
      return this.checkTimeOverlapOnly(reqStart, reqEnd, blockStart, blockEnd);
    }

    // Weekly: e.g., WEEKLY_MON_WED_FRI
    if (pattern.startsWith("WEEKLY_")) {
      const allowedDays = pattern.replace("WEEKLY_", "").split("_");
      const dayMap: Record<string, number> = {
        SUN: 0,
        MON: 1,
        TUE: 2,
        WED: 3,
        THU: 4,
        FRI: 5,
        SAT: 6,
      };
      const reqDay = reqStart.getDay();

      const isCorrectDay = allowedDays.some((d) => dayMap[d] === reqDay);
      if (!isCorrectDay) return false;

      return this.checkTimeOverlapOnly(reqStart, reqEnd, blockStart, blockEnd);
    }

    // Monthly: e.g., MONTHLY_15_30
    if (pattern.startsWith("MONTHLY_")) {
      const allowedDates = pattern
        .replace("MONTHLY_", "")
        .split("_")
        .map(Number);
      const reqDate = reqStart.getDate();

      if (!allowedDates.includes(reqDate)) return false;

      return this.checkTimeOverlapOnly(reqStart, reqEnd, blockStart, blockEnd);
    }

    return false;
  }

  /**
   * Helper to check if two time ranges overlap, regardless of the relative date.
   * Useful for recurring patterns where only the hours/minutes matter.
   */
  private checkTimeOverlapOnly(
    reqStart: Date,
    reqEnd: Date,
    blockStart: Date,
    blockEnd: Date,
  ): boolean {
    // Normalize both to the same base date to compare only TIME parts
    const baseDate = "2000-01-01";
    const rS = new Date(`${baseDate}T${reqStart.toISOString().split("T")[1]}`);
    const rE = new Date(`${baseDate}T${reqEnd.toISOString().split("T")[1]}`);
    const bS = new Date(
      `${baseDate}T${blockStart.toISOString().split("T")[1]}`,
    );
    const bE = new Date(`${baseDate}T${blockEnd.toISOString().split("T")[1]}`);

    // Handle overnight blocks in normalized time (if end < start)
    if (bE < bS) bE.setDate(bE.getDate() + 1);
    if (rE < rS) rE.setDate(rE.getDate() + 1);

    return TimeUtils.isOverlapping(rS, rE, bS, bE);
  }
}
