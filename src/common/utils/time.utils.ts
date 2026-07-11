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

      let datePart: string;
      if (date instanceof Date) {
        // Shift to IST temporarily to safely extract the local YYYY-MM-DD
        const istDate = new Date(date.getTime() + (5 * 60 + 30) * 60 * 1000);
        datePart = istDate.toISOString().split("T")[0];
      } else {
        datePart = date.split("T")[0];
      }

      let timePart: string;
      if (time instanceof Date) {
        // Shift to IST temporarily to safely extract the local HH:mm
        const istTime = new Date(time.getTime() + (5 * 60 + 30) * 60 * 1000);
        timePart = istTime.toISOString().split("T")[1].substring(0, 5);
      } else {
        // Handle formats like "15:30" or "15:30:00"
        timePart = time.split(":").slice(0, 2).join(":");
      }

      const combined = new Date(`${datePart}T${timePart}:00${this.IST_OFFSET}`);

      if (isNaN(combined.getTime())) {
        throw new Error("Invalid combined date/time result");
      }

      return combined;
    } catch (e) {
      throw new BadRequestException(
        `Failed to parse date and time: ${e.message}`,
      );
    }
  }

  /**
   * Calculates the end time based on a start time and duration in hours.
   */
  static getEndTime(startTime: Date, durationHours: number): Date {
    return new Date(startTime.getTime() + durationHours * 60 * 60 * 1000);
  }

  /**
   * Safely adds months to a date without overflowing the day of the month.
   * e.g. Jan 31 + 1 month -> Feb 28 (or 29), not Mar 3.
   */
  static addMonths(date: Date, months: number): Date {
    const result = new Date(date);
    const expectedMonth = (result.getMonth() + months) % 12;
    result.setMonth(result.getMonth() + months);
    
    // If the month overflowed past the expected month (due to differing days in months),
    // set it to the last day of the expected month.
    if (result.getMonth() !== (expectedMonth >= 0 ? expectedMonth : expectedMonth + 12)) {
      result.setDate(0);
    }
    return result;
  }

  /**
   * Checks if two time ranges overlap.
   * Overlap exists if (StartA < EndB) AND (EndA > StartB).
   */
  static isOverlapping(
    startA: Date,
    endA: Date,
    startB: Date,
    endB: Date,
  ): boolean {
    return startA < endB && endA > startB;
  }

  /**
   * Formats a date for display (e.g., "2024-03-14").
   */
  static formatDate(date: Date): string {
    return date.toISOString().split("T")[0];
  }

  /**
   * Formats a time for display (e.g., "03:30 PM").
   */
  static formatShortTime(date: Date): string {
    return date.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
      timeZone: "Asia/Kolkata",
    });
  }

  /**
   * Returns current time as a Date object.
   * All database fields use Timestamptz, so absolute Date comparisons are timezone-safe.
   */
  static nowIST(): Date {
    return new Date();
  }

  /**
   * Start/end of the IST calendar day containing `ref`.
   *
   * date-fns `startOfDay` works in the *server's* timezone, which is UTC in
   * production — so a "today" window built with it actually spans 05:30 IST today
   * to 05:29 IST tomorrow, and drops early-morning IST sessions from the day they
   * belong to. Bookings are IST wall-clock instants (see combineDateAndTime), so
   * any day bucketing must be done in IST.
   */
  static startOfDayIST(ref: Date = new Date()): Date {
    const istDate = new Date(ref.getTime() + (5 * 60 + 30) * 60 * 1000);
    const day = istDate.toISOString().split("T")[0];
    return new Date(`${day}T00:00:00${this.IST_OFFSET}`);
  }

  static endOfDayIST(ref: Date = new Date()): Date {
    const istDate = new Date(ref.getTime() + (5 * 60 + 30) * 60 * 1000);
    const day = istDate.toISOString().split("T")[0];
    return new Date(`${day}T23:59:59.999${this.IST_OFFSET}`);
  }
}
