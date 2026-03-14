import { BadRequestException } from "@nestjs/common";

/**
 * Unified utility for handling all date and time operations within the application.
 * Centralizes IST (+05:30) enforcement and overnight booking logic.
 */
export class TimeUtils {
  private static readonly IST_OFFSET = "+05:30";

  /**
   * Combines a date string (YYYY-MM-DD) and a time string (HH:MM) into a single IST Date object.
   */
  static combineDateAndTime(date: string | Date, time: string | Date): Date {
    try {
      if (!date || !time) {
        throw new Error("Date and Time are required");
      }

      const datePart = date instanceof Date 
        ? date.toISOString().split('T')[0] 
        : date.split('T')[0];
      
      let timePart: string;
      if (time instanceof Date) {
        timePart = time.toISOString().split('T')[1].substring(0, 5);
      } else {
        // Handle formats like "15:30" or "15:30:00"
        timePart = time.split(':').slice(0, 2).join(':');
      }

      const combined = new Date(`${datePart}T${timePart}:00${this.IST_OFFSET}`);
      
      if (isNaN(combined.getTime())) {
        throw new Error("Invalid combined date/time result");
      }
      
      return combined;
    } catch (e) {
      throw new BadRequestException(`Failed to parse date and time: ${e.message}`);
    }
  }

  /**
   * Calculates the end time based on a start time and duration in hours.
   */
  static getEndTime(startTime: Date, durationHours: number): Date {
    return new Date(startTime.getTime() + durationHours * 60 * 60 * 1000);
  }

  /**
   * Checks if two time ranges overlap.
   * Overlap exists if (StartA < EndB) AND (EndA > StartB).
   */
  static isOverlapping(startA: Date, endA: Date, startB: Date, endB: Date): boolean {
    return startA < endB && endA > startB;
  }

  /**
   * Formats a date for display (e.g., "2024-03-14").
   */
  static formatDate(date: Date): string {
    return date.toISOString().split('T')[0];
  }

  /**
   * Formats a time for display (e.g., "03:30 PM").
   */
  static formatShortTime(date: Date): string {
    return date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
      timeZone: 'Asia/Kolkata'
    });
  }

  /**
   * Returns current time in IST Date object.
   */
  static nowIST(): Date {
    const now = new Date();
    // In a real environment, we'd ensure the system clock or library handles the conversion.
    // For now, we return the standard Date object which NestJS/Prisma uses.
    return now;
  }
}
