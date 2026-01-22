import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class AvailabilityService {
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

  // Check if nanny is available at a specific time
  async isAvailable(
    nannyId: string,
    startTime: Date,
    endTime: Date,
  ): Promise<boolean> {
    const blocks = await this.prisma.availability_blocks.findMany({
      where: {
        nanny_id: nannyId,
        OR: [
          // Block overlaps with requested time
          {
            start_time: { lte: endTime },
            end_time: { gte: startTime },
          },
        ],
      },
    });

    // If any blocks found, nanny is not available
    if (blocks.length > 0) {
      // Check for recurring blocks
      for (const block of blocks) {
        if (block.is_recurring && block.recurrence_pattern) {
          if (
            this.matchesRecurringPattern(startTime, block.recurrence_pattern)
          ) {
            return false;
          }
        } else {
          // Non-recurring block already overlaps
          return false;
        }
      }
    }

    return true;
  }

  private matchesRecurringPattern(date: Date, pattern: string): boolean {
    const dayOfWeek = date.getDay();
    const dayOfMonth = date.getDate();

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

    if (pattern.startsWith("MONTHLY_")) {
      const dates = pattern.replace("MONTHLY_", "").split("_").map(Number);
      return dates.includes(dayOfMonth);
    }

    if (pattern === "DAILY") {
      return true;
    }

    return false;
  }
}
