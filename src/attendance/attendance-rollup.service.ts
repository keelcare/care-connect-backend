import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { attendance_day_status } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";
import { AttendanceService, istDateOnly } from "./attendance.service";
import { BookingStatus } from "../common/constants/booking-status.enum";
import {
  NO_SHOW_AFTER_MINUTES,
  STALE_PRESENCE_MINUTES,
  SCORE_WINDOW_DAYS,
  MIN_SESSIONS_FOR_SCORE,
  BAND_THRESHOLDS,
} from "./attendance.constants";

const MINUTE_MS = 60 * 1000;
const IST_OFFSET_MS = (5 * 60 + 30) * MINUTE_MS;

/**
 * Start/end of the IST calendar day a `@db.Date` value denotes, as absolute
 * instants. `attendance_date` is stored at UTC midnight of the IST day, so the
 * real window it covers begins 5h30 *before* that.
 */
function istDayBounds(attendanceDate: Date) {
  const start = new Date(attendanceDate.getTime() - IST_OFFSET_MS);
  return { start, end: new Date(start.getTime() + 24 * 60 * MINUTE_MS) };
}

/**
 * Everything that observes attendance on a clock rather than in reaction to an
 * event: the no-show sweep, the offline-during-session check, and the roll-up
 * that turns the event log into day records and a published score.
 *
 * Crons live in this module rather than in `TasksService` because they only need
 * this module's collaborators, and because `TasksService` is already wired into
 * `BookingsModule` — adding attendance there would drag a fourth dependency
 * through a module that has nothing to do with it.
 */
@Injectable()
export class AttendanceRollupService {
  private readonly logger = new Logger(AttendanceRollupService.name);

  constructor(
    private prisma: PrismaService,
    private attendance: AttendanceService,
    private notifications: NotificationsService,
  ) {}

  // ─── No-show sweep ────────────────────────────────────────────────────────

  /**
   * Flag sessions that should have started and did not.
   *
   * Runs every five minutes so the family hears about it in minutes rather than
   * at the end of the slot. Bounded below by the existing four-hour auto-expiry
   * horizon: past that `checkExpiredBookings` has already moved the booking on,
   * and re-reading those rows every five minutes forever buys nothing.
   */
  @Cron("0 */5 * * * *")
  async sweepNoShows() {
    const now = new Date();
    const cutoff = new Date(now.getTime() - NO_SHOW_AFTER_MINUTES * MINUTE_MS);
    const floor = new Date(now.getTime() - 6 * 60 * MINUTE_MS);

    try {
      const candidates = await this.prisma.bookings.findMany({
        where: {
          status: BookingStatus.CONFIRMED,
          actual_start_time: null,
          nanny_id: { not: null },
          start_time: { lte: cutoff, gte: floor },
        },
      });

      let flagged = 0;
      for (const booking of candidates) {
        const event = await this.attendance.recordNoShow(booking);
        if (event) flagged += 1;
      }
      if (flagged > 0) {
        this.logger.warn(`Flagged ${flagged} session(s) as no-shows`);
      }
    } catch (err) {
      this.logger.error(
        `No-show sweep failed: ${(err as Error)?.message}`,
        (err as Error)?.stack,
      );
    }
  }

  /**
   * Sessions under way whose caregiver has gone dark — app killed, or presence
   * switched off mid-shift.
   *
   * Only ever evaluated inside a live session. Being offline with nothing
   * rostered is time off, not absence, and treating it otherwise would turn the
   * score into a measure of how long someone leaves an app open.
   */
  @Cron("0 */5 * * * *")
  async sweepOfflineDuringSessions() {
    const staleBefore = new Date(
      Date.now() - STALE_PRESENCE_MINUTES * MINUTE_MS,
    );

    try {
      const live = await this.prisma.bookings.findMany({
        where: { status: BookingStatus.IN_PROGRESS, nanny_id: { not: null } },
        select: {
          id: true,
          nanny_id: true,
          start_time: true,
          status: true,
          actual_start_time: true,
        },
      });
      if (live.length === 0) return;

      const details = await this.prisma.nanny_details.findMany({
        where: { user_id: { in: live.map((b) => b.nanny_id!) } },
        select: { user_id: true, last_seen_at: true, is_available_now: true },
      });
      const byNanny = new Map(details.map((d) => [d.user_id, d]));

      for (const booking of live) {
        const detail = byNanny.get(booking.nanny_id!);
        if (!detail) continue;

        // Give the session itself the same grace as the heartbeat, so a check-in
        // followed immediately by this sweep is not read as an absence.
        const startedAt = booking.actual_start_time;
        if (startedAt && startedAt > staleBefore) continue;

        const dark =
          detail.last_seen_at === null || detail.last_seen_at < staleBefore;
        if (!dark) continue;

        await this.attendance.recordOfflineDuringSession(
          booking,
          detail.last_seen_at,
        );
      }
    } catch (err) {
      this.logger.error(
        `Offline-during-session sweep failed: ${(err as Error)?.message}`,
        (err as Error)?.stack,
      );
    }
  }

  // ─── Roll-up ──────────────────────────────────────────────────────────────

  /**
   * Keep today's roster view current for the operations team. Cheap — it only
   * touches caregivers who actually have something on today.
   */
  @Cron("0 15 * * * *")
  async rollUpToday() {
    try {
      await this.rollUpDay(istDateOnly());
    } catch (err) {
      this.logger.error(
        `Hourly attendance roll-up failed: ${(err as Error)?.message}`,
        (err as Error)?.stack,
      );
    }
  }

  /**
   * The definitive pass over yesterday, plus a score refresh.
   *
   * Pinned to IST rather than the server's clock: the whole product runs on IST
   * wall-clock slots (see `TimeUtils`), and a job that thinks the day ends at
   * 05:30 IST files every early-morning session under the wrong date.
   */
  @Cron("0 20 0 * * *", { timeZone: "Asia/Kolkata" })
  async rollUpYesterdayAndScore() {
    const yesterday = istDateOnly(new Date(Date.now() - 24 * 60 * MINUTE_MS));
    try {
      const days = await this.rollUpDay(yesterday);
      const scored = await this.refreshAllScores();
      this.logger.log(
        `Attendance roll-up for ${yesterday.toISOString().slice(0, 10)}: ${days} day record(s), ${scored} score(s) refreshed`,
      );
    } catch (err) {
      this.logger.error(
        `Nightly attendance roll-up failed: ${(err as Error)?.message}`,
        (err as Error)?.stack,
      );
    }
  }

  /**
   * Rebuild every caregiver's day record for one IST day.
   *
   * Idempotent by construction: it derives from bookings and events and upserts,
   * so it can be re-run for any past date after a correction without producing a
   * different answer than the original pass would have.
   */
  async rollUpDay(attendanceDate: Date): Promise<number> {
    const { start, end } = istDayBounds(attendanceDate);

    const [bookings, events] = await Promise.all([
      this.prisma.bookings.findMany({
        where: { nanny_id: { not: null }, start_time: { gte: start, lt: end } },
        select: {
          id: true,
          nanny_id: true,
          status: true,
          actual_start_time: true,
          actual_end_time: true,
        },
      }),
      this.prisma.nanny_attendance_events.findMany({
        where: { attendance_date: attendanceDate, waived_at: null },
        select: {
          nanny_id: true,
          booking_id: true,
          type: true,
          minutes_delta: true,
          is_session_outcome: true,
        },
      }),
    ]);

    const nannyIds = new Set<string>([
      ...bookings.map((b) => b.nanny_id!),
      ...events.map((e) => e.nanny_id),
    ]);
    if (nannyIds.size === 0) return 0;

    // A day fully covered by a block the caregiver set in advance is leave, not
    // absence — `availability_blocks` is already how time off is declared, so
    // attendance reads it rather than inventing a second place to record it.
    const blocks = await this.prisma.availability_blocks.findMany({
      where: {
        nanny_id: { in: [...nannyIds] },
        start_time: { lte: start },
        end_time: { gte: end },
      },
      select: { nanny_id: true },
    });
    const onLeave = new Set(blocks.map((b) => b.nanny_id));

    for (const nannyId of nannyIds) {
      const myBookings = bookings.filter((b) => b.nanny_id === nannyId);
      const myEvents = events.filter((e) => e.nanny_id === nannyId);
      const count = (type: string) =>
        myEvents.filter((e) => e.type === type).length;

      const onTime = count("CHECK_IN");
      const late = count("LATE_CHECK_IN");
      const attended = onTime + late;
      const missed = count("NO_SHOW");
      const cancelled = count("LATE_CANCEL") + count("ADVANCE_CANCEL");

      // Sessions this caregiver was actually on the hook for. A booking the
      // parent cancelled leaves no outcome event behind and drops out here, so
      // it never counts against her; one she cancelled herself carries its event
      // and stays counted.
      const accountableBookingIds = new Set(
        myEvents
          .filter((e) => e.is_session_outcome && e.booking_id)
          .map((e) => e.booking_id!),
      );
      const scheduled = myBookings.filter(
        (b) =>
          accountableBookingIds.has(b.id) ||
          [
            BookingStatus.CONFIRMED,
            BookingStatus.IN_PROGRESS,
            BookingStatus.COMPLETED,
          ].includes(b.status as BookingStatus),
      ).length;

      const minutesLate = myEvents
        .filter((e) => e.type === "LATE_CHECK_IN")
        .reduce((sum, e) => sum + Math.max(0, e.minutes_delta ?? 0), 0);

      const minutesWorked = myBookings.reduce((sum, b) => {
        if (!b.actual_start_time || !b.actual_end_time) return sum;
        return (
          sum +
          Math.max(
            0,
            Math.round(
              (b.actual_end_time.getTime() - b.actual_start_time.getTime()) /
                MINUTE_MS,
            ),
          )
        );
      }, 0);

      const status = this.deriveStatus({
        scheduled,
        attended,
        late,
        missed,
        cancelled,
        onLeave: onLeave.has(nannyId),
      });

      await this.prisma.nanny_attendance_days.upsert({
        where: {
          nanny_id_attendance_date: {
            nanny_id: nannyId,
            attendance_date: attendanceDate,
          },
        },
        create: {
          nanny_id: nannyId,
          attendance_date: attendanceDate,
          status,
          sessions_scheduled: scheduled,
          sessions_attended: attended,
          sessions_late: late,
          sessions_missed: missed,
          sessions_cancelled_by_nanny: cancelled,
          minutes_late: minutesLate,
          minutes_worked: minutesWorked,
        },
        update: {
          // `override_status` is deliberately untouched: a recompute must not
          // quietly reverse a decision an admin made with context this job
          // does not have.
          status,
          sessions_scheduled: scheduled,
          sessions_attended: attended,
          sessions_late: late,
          sessions_missed: missed,
          sessions_cancelled_by_nanny: cancelled,
          minutes_late: minutesLate,
          minutes_worked: minutesWorked,
          computed_at: new Date(),
        },
      });
    }

    return nannyIds.size;
  }

  private deriveStatus(input: {
    scheduled: number;
    attended: number;
    late: number;
    missed: number;
    cancelled: number;
    onLeave: boolean;
  }): attendance_day_status {
    const { scheduled, attended, late, missed, cancelled, onLeave } = input;

    if (scheduled === 0) return onLeave ? "LEAVE" : "OFF";
    if (attended === 0) return "ABSENT";
    if (missed > 0 || cancelled > 0 || attended < scheduled) return "PARTIAL";
    return late > 0 ? "LATE" : "PRESENT";
  }

  // ─── Score refresh ────────────────────────────────────────────────────────

  /**
   * Recompute every caregiver with activity in the scoring window, and warn the
   * ones who have just crossed into the at-risk band.
   */
  async refreshAllScores(): Promise<number> {
    const since = new Date(
      Date.now() - SCORE_WINDOW_DAYS * 24 * 60 * MINUTE_MS,
    );
    const active = await this.prisma.nanny_attendance_events.groupBy({
      by: ["nanny_id"],
      where: { occurred_at: { gte: since } },
    });

    let refreshed = 0;
    for (const { nanny_id } of active) {
      const before = await this.prisma.nanny_details.findUnique({
        where: { user_id: nanny_id },
        select: { attendance_score: true },
      });
      const { score, sessions } = await this.attendance.refreshScore(nanny_id);
      refreshed += 1;

      const wasAtRisk =
        before?.attendance_score !== null &&
        before?.attendance_score !== undefined &&
        Number(before.attendance_score) < BAND_THRESHOLDS.NEEDS_IMPROVEMENT;
      const nowAtRisk =
        score !== null &&
        sessions >= MIN_SESSIONS_FOR_SCORE &&
        score < BAND_THRESHOLDS.NEEDS_IMPROVEMENT;

      // Only on the crossing. A caregiver already in the band does not need the
      // same message every night — that is how notifications stop being read.
      if (nowAtRisk && !wasAtRisk) {
        await this.notifications
          .createNotification(
            nanny_id,
            "Your attendance needs attention",
            `Your attendance score is ${score}. Missed and late sessions affect how often you are matched with families — please get in touch if something is making it hard to attend.`,
            "warning",
            "attendance",
          )
          .catch(() => undefined);
      }
    }

    return refreshed;
  }
}
