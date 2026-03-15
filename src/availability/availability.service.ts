import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { TimeUtils } from "../common/utils/time.utils";

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
        if (TimeUtils.isOverlapping(startTime, endTime, block.start_time, block.end_time)) {
          return false;
        }
      }
    }

    // 2. Check for overlapping CONFIRMED bookings
    const bookings = await this.prisma.bookings.findFirst({
      where: {
        nanny_id: nannyId,
        status: "CONFIRMED",
        AND: [
          { start_time: { lt: endTime } },
          { end_time: { gt: startTime } },
        ],
      },
    });

    if (bookings) {
      this.logger.debug(`Nanny ${nannyId} is busy with booking ${bookings.id}`);
      return false;
    }

    return true;
  }

  private matchesRecurringPattern(reqStart: Date, reqEnd: Date, block: any): boolean {
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
      const dayMap: Record<string, number> = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };
      const reqDay = reqStart.getDay();
      
      const isCorrectDay = allowedDays.some(d => dayMap[d] === reqDay);
      if (!isCorrectDay) return false;

      return this.checkTimeOverlapOnly(reqStart, reqEnd, blockStart, blockEnd);
    }

    // Monthly: e.g., MONTHLY_15_30
    if (pattern.startsWith("MONTHLY_")) {
      const allowedDates = pattern.replace("MONTHLY_", "").split("_").map(Number);
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
  private checkTimeOverlapOnly(reqStart: Date, reqEnd: Date, blockStart: Date, blockEnd: Date): boolean {
    // Normalize both to the same base date to compare only TIME parts
    const baseDate = "2000-01-01";
    const rS = new Date(`${baseDate}T${reqStart.toISOString().split('T')[1]}`);
    const rE = new Date(`${baseDate}T${reqEnd.toISOString().split('T')[1]}`);
    const bS = new Date(`${baseDate}T${blockStart.toISOString().split('T')[1]}`);
    const bE = new Date(`${baseDate}T${blockEnd.toISOString().split('T')[1]}`);

    // Handle overnight blocks in normalized time (if end < start)
    if (bE < bS) bE.setDate(bE.getDate() + 1);
    if (rE < rS) rE.setDate(rE.getDate() + 1);

    return TimeUtils.isOverlapping(rS, rE, bS, bE);
  }
}
