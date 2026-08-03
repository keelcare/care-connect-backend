/**
 * Calendar period boundaries for the caregiver earnings screen.
 *
 * Two things this file exists to get right:
 *
 * 1. **Calendar, not trailing.** The app's tabs say "This Week" and "This Month",
 *    so a week is Monday–Sunday and a month is the 1st to the last day. A trailing
 *    "last 7 days" window has no future in it, which makes a projection impossible
 *    to define — there is nothing left to project into.
 *
 * 2. **India time, not server time.** The API runs on UTC infrastructure while every
 *    caregiver is in IST. Cutting days with the server's local midnight puts 05:30
 *    of each morning's earnings on the wrong day, and lands the week boundary in the
 *    middle of Sunday evening. Boundaries are therefore computed against a fixed
 *    +05:30 offset. India has no DST, so a fixed offset is exact rather than an
 *    approximation — do not "improve" this into a floating timezone library call
 *    without checking that assumption still holds.
 */

export type EarningsPeriod = "week" | "month";

/** IST is UTC+05:30 year-round. */
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

export interface PeriodWindow {
  /** First instant of the current calendar period (inclusive). */
  start: Date;
  /** Last instant of the current calendar period (inclusive). */
  end: Date;
  /** First instant of the preceding calendar period (inclusive). */
  previousStart: Date;
  /**
   * Cutoff for the preceding period, truncated to the same elapsed offset as `now`
   * is into the current one. Comparing a partial week against a *whole* previous
   * week reports a collapse in earnings every Monday morning, so the comparison is
   * like-for-like by construction.
   */
  previousEnd: Date;
  /** Calendar days in the current period: 7, or 28–31. */
  totalDays: number;
  /** Days from the period start through today, inclusive. Always >= 1. */
  elapsedDays: number;
}

/** The wall-clock date in IST, as a civil calendar triple. */
function istParts(at: Date): { year: number; month: number; day: number } {
  const shifted = new Date(at.getTime() + IST_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
  };
}

/** The instant at which the given IST civil date begins. */
function istMidnight(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month, day) - IST_OFFSET_MS);
}

/** IST weekday with Monday as 0, matching a Mon–Sun week. */
function istWeekdayMondayFirst(at: Date): number {
  const shifted = new Date(at.getTime() + IST_OFFSET_MS);
  return (shifted.getUTCDay() + 6) % 7;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Resolve the calendar window for `period` containing `now`.
 *
 * `end` is the last instant of the period, not of today — the window deliberately
 * extends into the future, because the days between now and `end` are exactly the
 * remainder a projection covers.
 */
export function resolvePeriod(period: EarningsPeriod, now: Date = new Date()): PeriodWindow {
  const { year, month, day } = istParts(now);

  let start: Date;
  let end: Date;
  let previousStart: Date;

  if (period === "week") {
    const weekday = istWeekdayMondayFirst(now);
    start = istMidnight(year, month, day - weekday);
    end = new Date(start.getTime() + 7 * DAY_MS - 1);
    previousStart = new Date(start.getTime() - 7 * DAY_MS);
  } else {
    start = istMidnight(year, month, 1);
    // Day 0 of the next month is the last day of this one, so this handles month
    // lengths and leap years without a table.
    end = new Date(istMidnight(year, month + 1, 1).getTime() - 1);
    previousStart = istMidnight(year, month - 1, 1);
  }

  const totalDays = Math.round((end.getTime() + 1 - start.getTime()) / DAY_MS);
  const elapsedMs = now.getTime() - start.getTime();

  return {
    start,
    end,
    previousStart,
    // Same elapsed distance into the previous period. Clamped to that period's own
    // end so a 31-day month compared against a 30-day one cannot borrow a day.
    previousEnd: new Date(Math.min(previousStart.getTime() + elapsedMs, start.getTime() - 1)),
    totalDays,
    elapsedDays: Math.floor(elapsedMs / DAY_MS) + 1,
  };
}

/** The IST calendar date of an instant, as `YYYY-MM-DD` — the trend point's label. */
export function istDateKey(at: Date): string {
  return new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** Start-of-day instants for every calendar day in the window, in order. */
export function daysInWindow(window: PeriodWindow): Date[] {
  const days: Date[] = [];
  for (let i = 0; i < window.totalDays; i++) {
    days.push(new Date(window.start.getTime() + i * DAY_MS));
  }
  return days;
}
