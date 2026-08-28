import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import {
  Prisma,
  attendance_event_type,
  attendance_day_status,
  bookings,
} from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";
import { GeoUtils } from "../common/utils/geo.utils";
import {
  ON_TIME_GRACE_MINUTES,
  LATE_THRESHOLD_MINUTES,
  EARLY_DEPARTURE_MINUTES,
  SHORT_NOTICE_CANCEL_HOURS,
  GEOFENCE_BREACH_MINUTES,
  GEOFENCE_BREACH_COOLDOWN_MINUTES,
  GEOFENCE_TRAIL_SLACK_MINUTES,
  SCORE_WEIGHTS,
  SCORE_WINDOW_DAYS,
  MIN_SESSIONS_FOR_SCORE,
  SESSION_OUTCOME_TYPES,
  ONCE_PER_BOOKING_TYPES,
  PARENT_FAULT_STATUSES,
  EVENT_LABELS,
  lateArrivalWeight,
  bandForScore,
} from "./attendance.constants";

/** A Date at UTC midnight of the IST calendar day containing `ref` — the shape a `@db.Date` column stores. */
export function istDateOnly(ref: Date = new Date()): Date {
  const shifted = new Date(ref.getTime() + (5 * 60 + 30) * 60 * 1000);
  return new Date(`${shifted.toISOString().split("T")[0]}T00:00:00.000Z`);
}

const MINUTE_MS = 60 * 1000;
const minutesBetween = (a: Date, b: Date) =>
  Math.round((a.getTime() - b.getTime()) / MINUTE_MS);

interface RecordOptions {
  bookingId?: string | null;
  attendanceDate?: Date;
  scheduledStart?: Date | null;
  occurredAt?: Date;
  minutesDelta?: number | null;
  distanceMeters?: number | null;
  weight?: number;
  source?: "app" | "system" | "admin";
  notes?: string;
  metadata?: Prisma.InputJsonValue;
}

/**
 * Records and reads caregiver attendance.
 *
 * Writes are driven by booking lifecycle events rather than called from
 * `BookingsService`, so attendance can never be the reason a check-in fails —
 * every recording path swallows its own errors and logs. An attendance row is a
 * description of what happened; it must not get a vote in whether it happens.
 */
@Injectable()
export class AttendanceService {
  private readonly logger = new Logger(AttendanceService.name);

  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
  ) {}

  // ─── Recording ────────────────────────────────────────────────────────────

  /**
   * Append one event.
   *
   * Once-per-booking types carry a `dedupe_key`, so a replayed event or an
   * overlapping cron run collides at the unique index instead of writing a
   * duplicate the score would then count twice.
   */
  private async record(
    nannyId: string,
    type: attendance_event_type,
    opts: RecordOptions = {},
  ) {
    const occurredAt = opts.occurredAt ?? new Date();
    const dedupeKey =
      opts.bookingId && ONCE_PER_BOOKING_TYPES.includes(type)
        ? `${opts.bookingId}:${type}`
        : null;

    try {
      return await this.prisma.nanny_attendance_events.create({
        data: {
          nanny_id: nannyId,
          booking_id: opts.bookingId ?? null,
          type,
          attendance_date:
            opts.attendanceDate ??
            istDateOnly(opts.scheduledStart ?? occurredAt),
          scheduled_start: opts.scheduledStart ?? null,
          occurred_at: occurredAt,
          minutes_delta: opts.minutesDelta ?? null,
          distance_meters: opts.distanceMeters ?? null,
          score_weight: new Prisma.Decimal(opts.weight ?? SCORE_WEIGHTS[type]),
          is_session_outcome: SESSION_OUTCOME_TYPES.includes(type),
          source: opts.source ?? "system",
          notes: opts.notes ?? null,
          dedupe_key: dedupeKey,
          metadata: opts.metadata,
        },
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        // Already recorded — the desired end state, not a failure.
        return null;
      }
      this.logger.warn(
        `Failed to record ${type} for nanny ${nannyId}${opts.bookingId ? ` on booking ${opts.bookingId}` : ""}: ${(err as Error)?.message}`,
      );
      return null;
    }
  }

  /**
   * Whether this booking's outcome is the caregiver's to answer for. A family
   * that cancelled, or that nobody was home to receive care from, must not cost
   * the caregiver a point — she made the trip either way.
   */
  private isCaregiverAccountable(
    booking: Pick<bookings, "status" | "nanny_id">,
  ) {
    if (!booking.nanny_id) return false;
    return !PARENT_FAULT_STATUSES.includes(booking.status ?? "");
  }

  /** Arrival, from `booking.started`. Geofence proof is already enforced upstream by `startBooking`. */
  async recordCheckIn(booking: bookings) {
    if (!this.isCaregiverAccountable(booking)) return;
    const scheduledStart = booking.start_time;
    const arrived = booking.actual_start_time ?? new Date();
    if (!scheduledStart) return;

    const minutesLate = minutesBetween(arrived, scheduledStart);
    const onTime = minutesLate <= ON_TIME_GRACE_MINUTES;

    await this.record(
      booking.nanny_id!,
      onTime ? "CHECK_IN" : "LATE_CHECK_IN",
      {
        bookingId: booking.id,
        scheduledStart,
        occurredAt: arrived,
        minutesDelta: minutesLate,
        weight: onTime
          ? SCORE_WEIGHTS.CHECK_IN
          : lateArrivalWeight(minutesLate),
        source: "app",
        notes: onTime
          ? undefined
          : `Arrived ${minutesLate} min after the scheduled start`,
      },
    );

    // A no-show may already have been written by the sweeper for a caregiver who
    // turned up very late. She did attend, so the harsher outcome is withdrawn
    // rather than left to sit alongside the arrival contradicting it.
    if (!onTime) await this.retractNoShow(booking.id);
  }

  /** Departure, from `booking.completed`. */
  async recordCheckOut(booking: bookings) {
    if (!this.isCaregiverAccountable(booking)) return;
    const scheduledEnd = booking.end_time;
    const left = booking.actual_end_time ?? new Date();
    if (!scheduledEnd) return;

    const minutesEarly = minutesBetween(scheduledEnd, left);
    const worked = booking.actual_start_time
      ? minutesBetween(left, booking.actual_start_time)
      : null;

    await this.record(booking.nanny_id!, "CHECK_OUT", {
      bookingId: booking.id,
      scheduledStart: booking.start_time,
      occurredAt: left,
      minutesDelta: -minutesEarly,
      source: "app",
      metadata: worked !== null ? { minutes_worked: worked } : undefined,
    });

    if (minutesEarly > EARLY_DEPARTURE_MINUTES) {
      await this.record(booking.nanny_id!, "EARLY_CHECK_OUT", {
        bookingId: booking.id,
        scheduledStart: booking.start_time,
        occurredAt: left,
        minutesDelta: -minutesEarly,
        source: "app",
        notes: `Left ${minutesEarly} min before the scheduled end`,
      });
    }
  }

  /**
   * The caregiver cancelled. Notice length decides which outcome it is — the same
   * 24h boundary the cancellation fee uses.
   */
  async recordNannyCancellation(booking: bookings, reason?: string) {
    if (!booking.nanny_id || !booking.start_time) return;

    const hoursNotice =
      (booking.start_time.getTime() - Date.now()) / (60 * MINUTE_MS);
    const shortNotice = hoursNotice < SHORT_NOTICE_CANCEL_HOURS;

    await this.record(
      booking.nanny_id,
      shortNotice ? "LATE_CANCEL" : "ADVANCE_CANCEL",
      {
        bookingId: booking.id,
        scheduledStart: booking.start_time,
        minutesDelta: Math.round(hoursNotice * 60),
        source: "app",
        notes: reason
          ? `Cancelled ${Math.max(0, Math.round(hoursNotice))}h before start: ${reason}`
          : `Cancelled ${Math.max(0, Math.round(hoursNotice))}h before start`,
      },
    );
  }

  /** The session had to be closed by the system because nobody checked out. */
  async recordMissedCheckOut(booking: bookings) {
    if (!this.isCaregiverAccountable(booking)) return;
    await this.record(booking.nanny_id!, "MISSED_CHECK_OUT", {
      bookingId: booking.id,
      scheduledStart: booking.start_time,
      notes: "Session auto-closed — no check-out was recorded",
    });
  }

  /**
   * Slot start plus the no-show window elapsed with no check-in.
   *
   * Records the fact and tells both sides; the booking's own status is left to
   * `checkExpiredBookings`, which already owns that transition.
   */
  async recordNoShow(booking: bookings) {
    if (!this.isCaregiverAccountable(booking) || !booking.start_time) return;

    const event = await this.record(booking.nanny_id!, "NO_SHOW", {
      bookingId: booking.id,
      scheduledStart: booking.start_time,
      minutesDelta: minutesBetween(new Date(), booking.start_time),
      notes: "No check-in recorded within the no-show window",
    });
    if (!event) return; // already flagged

    await Promise.all([
      this.notifications
        .createNotification(
          booking.nanny_id!,
          "Session marked as missed",
          "You have not checked in for a session that has already started. Check in now, or contact support if something has gone wrong.",
          "error",
          "attendance",
          booking.id,
        )
        .catch(() => undefined),
      booking.parent_id
        ? this.notifications
            .createNotification(
              booking.parent_id,
              "Your caregiver has not checked in",
              "We have not received a check-in for your session and our team has been alerted. We will be in touch shortly.",
              "warning",
              "attendance",
              booking.id,
            )
            .catch(() => undefined)
        : Promise.resolve(undefined),
    ]);

    return event;
  }

  /**
   * A caregiver who eventually arrives is not a no-show. Waiving rather than
   * deleting keeps the sequence of what the system believed and when, which is
   * what a later dispute actually turns on.
   */
  private async retractNoShow(bookingId: string) {
    await this.prisma.nanny_attendance_events
      .updateMany({
        where: { booking_id: bookingId, type: "NO_SHOW", waived_at: null },
        data: {
          waived_at: new Date(),
          waiver_reason: "Caregiver checked in after being flagged",
        },
      })
      .catch(() => undefined);
  }

  /** Session under way with the app dark for longer than the tolerance. */
  async recordOfflineDuringSession(
    booking: Pick<bookings, "id" | "nanny_id" | "start_time" | "status">,
    lastSeenAt: Date | null,
  ) {
    if (!booking.nanny_id) return;
    await this.record(booking.nanny_id, "OFFLINE_DURING_SESSION", {
      bookingId: booking.id,
      scheduledStart: booking.start_time,
      notes: lastSeenAt
        ? `No heartbeat since ${lastSeenAt.toISOString()} while the session was in progress`
        : "No heartbeat recorded while the session was in progress",
    });
  }

  /**
   * Called from the location gateway on every position report that lands outside
   * the fence. Most of them are nothing — the school gate, the pharmacy — so this
   * only records once the caregiver has been *continuously* outside for the
   * tolerance, and then not again for the cooldown, so one long absence is one
   * event rather than one per GPS ping.
   */
  async evaluateGeofenceBreach(
    bookingId: string,
    nannyId: string,
    careLat: number,
    careLng: number,
    radius: number,
    currentDistance: number,
  ) {
    try {
      const now = new Date();
      const cooldownStart = new Date(
        now.getTime() - GEOFENCE_BREACH_COOLDOWN_MINUTES * MINUTE_MS,
      );

      const recent = await this.prisma.nanny_attendance_events.findFirst({
        where: {
          booking_id: bookingId,
          type: "GEOFENCE_BREACH",
          occurred_at: { gte: cooldownStart },
        },
        select: { id: true },
      });
      if (recent) return;

      // Every ping since the tolerance began. If any of them was inside the
      // fence, the caregiver has not been continuously away.
      const windowStart = new Date(
        now.getTime() - GEOFENCE_BREACH_MINUTES * MINUTE_MS,
      );
      const pings = await this.prisma.location_updates.findMany({
        where: { booking_id: bookingId, timestamp: { gte: windowStart } },
        select: { lat: true, lng: true, timestamp: true },
        orderBy: { timestamp: "asc" },
      });

      // The trail has to actually cover the tolerance window before "away for ten
      // minutes" means anything. A session that only started publishing a minute
      // ago, or one whose app went quiet and has just resurfaced somewhere else,
      // gives us one distant fix and no evidence of what happened in between —
      // which is not the same as an absence, and must not be recorded as one.
      const trailAgeMs =
        pings.length > 0 ? now.getTime() - pings[0].timestamp.getTime() : 0;
      const requiredTrailMs =
        (GEOFENCE_BREACH_MINUTES - GEOFENCE_TRAIL_SLACK_MINUTES) * MINUTE_MS;
      if (pings.length < 2 || trailAgeMs < requiredTrailMs) return;

      const anyInside = pings.some(
        (p) =>
          GeoUtils.getDistanceInMeters(
            Number(p.lat),
            Number(p.lng),
            careLat,
            careLng,
          ) <= radius,
      );
      if (anyInside) return;

      const booking = await this.prisma.bookings.findUnique({
        where: { id: bookingId },
        select: { start_time: true, status: true, nanny_id: true },
      });
      if (!booking || !this.isCaregiverAccountable(booking)) return;

      await this.record(nannyId, "GEOFENCE_BREACH", {
        bookingId,
        scheduledStart: booking.start_time,
        distanceMeters: Math.round(currentDistance),
        notes: `Outside the ${radius}m care area for over ${GEOFENCE_BREACH_MINUTES} minutes (currently ${Math.round(currentDistance)}m away)`,
      });
    } catch (err) {
      this.logger.warn(
        `Geofence breach evaluation failed for booking ${bookingId}: ${(err as Error)?.message}`,
        (err as Error)?.stack,
      );
    }
  }

  // ─── Scoring ──────────────────────────────────────────────────────────────

  /**
   * Rolling score over the window: `100 × Σcredit / settled sessions`, clamped.
   *
   * Waived events are excluded outright. Weights come off the rows themselves,
   * not from current policy, so a retune moves future scores without rewriting
   * anyone's past.
   */
  async computeScore(nannyId: string, windowDays = SCORE_WINDOW_DAYS) {
    const since = new Date(Date.now() - windowDays * 24 * 60 * MINUTE_MS);

    const events = await this.prisma.nanny_attendance_events.findMany({
      where: {
        nanny_id: nannyId,
        waived_at: null,
        occurred_at: { gte: since },
      },
      select: { type: true, score_weight: true, is_session_outcome: true },
    });

    const sessions = events.filter((e) => e.is_session_outcome).length;
    if (sessions < MIN_SESSIONS_FOR_SCORE) {
      return { score: null as number | null, sessions, events: events.length };
    }

    const credit = events.reduce((sum, e) => sum + Number(e.score_weight), 0);
    const raw = (credit / sessions) * 100;
    const score = Math.max(0, Math.min(100, Math.round(raw * 10) / 10));

    return { score, sessions, events: events.length };
  }

  /** Recompute and persist the denormalised score on the caregiver's profile. */
  async refreshScore(nannyId: string) {
    const { score, sessions } = await this.computeScore(nannyId);
    await this.prisma.nanny_details
      .update({
        where: { user_id: nannyId },
        data: {
          attendance_score: score === null ? null : new Prisma.Decimal(score),
          attendance_sessions: sessions,
          attendance_updated_at: new Date(),
        },
      })
      .catch((err) =>
        this.logger.warn(
          `Could not persist attendance score for ${nannyId}: ${err?.message}`,
        ),
      );
    return { score, sessions };
  }

  // ─── Reads ────────────────────────────────────────────────────────────────

  /**
   * Headline attendance for one caregiver. Shaped for the partner app's
   * attendance card and reused verbatim by the admin view.
   */
  async getSummary(nannyId: string, windowDays = SCORE_WINDOW_DAYS) {
    const since = new Date(Date.now() - windowDays * 24 * 60 * MINUTE_MS);
    const sinceDate = istDateOnly(since);

    const [{ score, sessions }, events, days] = await Promise.all([
      this.computeScore(nannyId, windowDays),
      this.prisma.nanny_attendance_events.groupBy({
        by: ["type"],
        where: {
          nanny_id: nannyId,
          waived_at: null,
          occurred_at: { gte: since },
        },
        _count: { _all: true },
        _sum: { minutes_delta: true },
      }),
      this.prisma.nanny_attendance_days.findMany({
        where: { nanny_id: nannyId, attendance_date: { gte: sinceDate } },
        orderBy: { attendance_date: "desc" },
      }),
    ]);

    const count = (type: attendance_event_type) =>
      events.find((e) => e.type === type)?._count._all ?? 0;

    const onTime = count("CHECK_IN");
    const late = count("LATE_CHECK_IN");
    const attended = onTime + late;
    const lateMinutes =
      events.find((e) => e.type === "LATE_CHECK_IN")?._sum.minutes_delta ?? 0;

    const effective = (d: (typeof days)[number]) =>
      d.override_status ?? d.status;
    const presentDays = days.filter((d) => effective(d) === "PRESENT").length;
    const absentDays = days.filter((d) => effective(d) === "ABSENT").length;

    return {
      windowDays,
      score,
      band: bandForScore(score, sessions),
      sessionsCounted: sessions,
      minSessionsForScore: MIN_SESSIONS_FOR_SCORE,
      sessions: {
        attended,
        onTime,
        late,
        noShows: count("NO_SHOW"),
        lateCancellations: count("LATE_CANCEL"),
        advanceCancellations: count("ADVANCE_CANCEL"),
      },
      punctuality: {
        /** Share of attended sessions that started inside the grace window. */
        onTimeRate: attended > 0 ? Math.round((onTime / attended) * 100) : null,
        averageMinutesLate: late > 0 ? Math.round(lateMinutes / late) : 0,
        graceMinutes: ON_TIME_GRACE_MINUTES,
        lateThresholdMinutes: LATE_THRESHOLD_MINUTES,
      },
      conduct: {
        earlyDepartures: count("EARLY_CHECK_OUT"),
        missedCheckOuts: count("MISSED_CHECK_OUT"),
        geofenceBreaches: count("GEOFENCE_BREACH"),
        offlineDuringSession: count("OFFLINE_DURING_SESSION"),
      },
      days: {
        present: presentDays,
        absent: absentDays,
        partial: days.filter((d) => effective(d) === "PARTIAL").length,
        late: days.filter((d) => effective(d) === "LATE").length,
        leave: days.filter((d) => effective(d) === "LEAVE").length,
        /** Consecutive rostered days ending today with nothing missed. Off days don't break it. */
        currentStreak: this.currentStreak(days),
      },
    };
  }

  /**
   * Consecutive most-recent rostered days that went cleanly. `OFF` days are
   * skipped rather than counted or breaking the run — a caregiver's streak
   * should not end because a family had no session on Sunday.
   */
  private currentStreak(
    days: {
      status: attendance_day_status;
      override_status: attendance_day_status | null;
    }[],
  ) {
    let streak = 0;
    for (const day of days) {
      const status = day.override_status ?? day.status;
      if (status === "OFF" || status === "LEAVE") continue;
      if (status === "PRESENT") streak += 1;
      else break;
    }
    return streak;
  }

  /** Day-by-day records for a calendar month (`YYYY-MM`), for the app's attendance calendar. */
  async getCalendar(nannyId: string, month: string) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      throw new BadRequestException("month must be in YYYY-MM format");
    }
    const from = new Date(`${month}-01T00:00:00.000Z`);
    const to = new Date(from);
    to.setUTCMonth(to.getUTCMonth() + 1);

    const days = await this.prisma.nanny_attendance_days.findMany({
      where: { nanny_id: nannyId, attendance_date: { gte: from, lt: to } },
      orderBy: { attendance_date: "asc" },
    });

    return {
      month,
      days: days.map((d) => ({
        date: d.attendance_date.toISOString().slice(0, 10),
        status: d.override_status ?? d.status,
        derivedStatus: d.status,
        isOverridden: d.override_status !== null,
        overrideReason: d.override_reason,
        sessionsScheduled: d.sessions_scheduled,
        sessionsAttended: d.sessions_attended,
        sessionsLate: d.sessions_late,
        sessionsMissed: d.sessions_missed,
        sessionsCancelled: d.sessions_cancelled_by_nanny,
        minutesLate: d.minutes_late,
        minutesWorked: d.minutes_worked,
      })),
    };
  }

  /**
   * The event timeline. A caregiver has to be able to see exactly which facts
   * produced her score, including the ones an admin has since excused —
   * a score nobody can audit is a score nobody will accept.
   */
  async getEvents(
    nannyId: string,
    opts: { limit?: number; before?: Date; includeWaived?: boolean } = {},
  ) {
    const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
    const rows = await this.prisma.nanny_attendance_events.findMany({
      where: {
        nanny_id: nannyId,
        ...(opts.includeWaived === false ? { waived_at: null } : {}),
        ...(opts.before ? { occurred_at: { lt: opts.before } } : {}),
      },
      orderBy: { occurred_at: "desc" },
      take: limit + 1,
      include: {
        bookings: {
          select: {
            id: true,
            start_time: true,
            end_time: true,
            service_requests: { select: { category: true } },
          },
        },
      },
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    return {
      events: page.map((e) => ({
        id: e.id,
        type: e.type,
        label: EVENT_LABELS[e.type],
        date: e.attendance_date.toISOString().slice(0, 10),
        occurredAt: e.occurred_at,
        scheduledStart: e.scheduled_start,
        minutesDelta: e.minutes_delta,
        distanceMeters: e.distance_meters,
        /** Zero for waived events — what it actually contributed, not what it would have. */
        scoreWeight: e.waived_at ? 0 : Number(e.score_weight),
        countsTowardScore: e.waived_at === null,
        isSessionOutcome: e.is_session_outcome,
        notes: e.notes,
        waived: e.waived_at !== null,
        waiverReason: e.waiver_reason,
        booking: e.bookings
          ? {
              id: e.bookings.id,
              startTime: e.bookings.start_time,
              endTime: e.bookings.end_time,
              category: e.bookings.service_requests?.category ?? null,
            }
          : null,
      })),
      nextCursor: hasMore
        ? page[page.length - 1].occurred_at.toISOString()
        : null,
    };
  }

  // ─── Admin actions ────────────────────────────────────────────────────────

  /** Excuse an event, then immediately reflect it in the published score. */
  async waiveEvent(eventId: string, adminId: string, reason: string) {
    const event = await this.prisma.nanny_attendance_events.findUnique({
      where: { id: eventId },
    });
    if (!event) throw new NotFoundException("Attendance event not found");
    if (event.waived_at) return event;

    const updated = await this.prisma.nanny_attendance_events.update({
      where: { id: eventId },
      data: {
        waived_at: new Date(),
        waived_by: adminId,
        waiver_reason: reason,
      },
    });

    await this.refreshScore(event.nanny_id);
    await this.notifications
      .createNotification(
        event.nanny_id,
        "Attendance record updated",
        `"${EVENT_LABELS[event.type]}" on ${event.attendance_date.toISOString().slice(0, 10)} has been excused and no longer counts towards your score.`,
        "success",
        "attendance",
        event.booking_id ?? undefined,
      )
      .catch(() => undefined);

    return updated;
  }

  /**
   * Correct a day's status by hand — leave granted after the fact, a session the
   * office cancelled by phone. Stored alongside the derived value rather than
   * over it, so the nightly recompute never silently undoes an admin's decision
   * and both readings stay on the record.
   */
  async overrideDay(
    nannyId: string,
    date: string,
    status: attendance_day_status,
    adminId: string,
    reason: string,
  ) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new BadRequestException("date must be in YYYY-MM-DD format");
    }
    const attendanceDate = new Date(`${date}T00:00:00.000Z`);

    return this.prisma.nanny_attendance_days.upsert({
      where: {
        nanny_id_attendance_date: {
          nanny_id: nannyId,
          attendance_date: attendanceDate,
        },
      },
      create: {
        nanny_id: nannyId,
        attendance_date: attendanceDate,
        status: "OFF",
        override_status: status,
        override_reason: reason,
        overridden_by: adminId,
        overridden_at: new Date(),
      },
      update: {
        override_status: status,
        override_reason: reason,
        overridden_by: adminId,
        overridden_at: new Date(),
      },
    });
  }

  /**
   * Roster view for one IST day: who was expected, who turned up. The question an
   * operations team actually asks, and one that cannot be answered by paging
   * through caregivers one at a time.
   */
  async getDailyOverview(date: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new BadRequestException("date must be in YYYY-MM-DD format");
    }
    const attendanceDate = new Date(`${date}T00:00:00.000Z`);

    const days = await this.prisma.nanny_attendance_days.findMany({
      where: { attendance_date: attendanceDate },
      include: {
        users: {
          select: {
            id: true,
            email: true,
            profiles: {
              select: { first_name: true, last_name: true, phone: true },
            },
            nanny_details: { select: { attendance_score: true } },
          },
        },
      },
      orderBy: { status: "asc" },
    });

    const rows = days.map((d) => ({
      nannyId: d.nanny_id,
      name:
        `${d.users.profiles?.first_name ?? ""} ${d.users.profiles?.last_name ?? ""}`.trim() ||
        d.users.email,
      phone: d.users.profiles?.phone ?? null,
      status: d.override_status ?? d.status,
      attendanceScore:
        d.users.nanny_details?.attendance_score === null ||
        d.users.nanny_details?.attendance_score === undefined
          ? null
          : Number(d.users.nanny_details.attendance_score),
      sessionsScheduled: d.sessions_scheduled,
      sessionsAttended: d.sessions_attended,
      sessionsMissed: d.sessions_missed,
      minutesLate: d.minutes_late,
    }));

    const tally = (status: attendance_day_status) =>
      rows.filter((r) => r.status === status).length;

    return {
      date,
      totals: {
        rostered: rows.filter((r) => r.sessionsScheduled > 0).length,
        present: tally("PRESENT"),
        late: tally("LATE"),
        partial: tally("PARTIAL"),
        absent: tally("ABSENT"),
        leave: tally("LEAVE"),
      },
      // Absences first — the rows anyone opening this screen is looking for.
      nannies: rows.sort((a, b) => {
        const rank = {
          ABSENT: 0,
          PARTIAL: 1,
          LATE: 2,
          PRESENT: 3,
          LEAVE: 4,
          OFF: 5,
        };
        return rank[a.status] - rank[b.status];
      }),
    };
  }

  /** Caregivers whose score has fallen into the at-risk band, for admin follow-up. */
  async getAtRiskNannies(threshold = 60) {
    const rows = await this.prisma.nanny_details.findMany({
      where: {
        attendance_score: { lt: new Prisma.Decimal(threshold) },
        attendance_sessions: { gte: MIN_SESSIONS_FOR_SCORE },
      },
      select: {
        user_id: true,
        attendance_score: true,
        attendance_sessions: true,
        attendance_updated_at: true,
        users: {
          select: {
            email: true,
            profiles: {
              select: { first_name: true, last_name: true, phone: true },
            },
          },
        },
      },
      orderBy: { attendance_score: "asc" },
    });

    return rows.map((r) => ({
      nannyId: r.user_id,
      name:
        `${r.users.profiles?.first_name ?? ""} ${r.users.profiles?.last_name ?? ""}`.trim() ||
        r.users.email,
      phone: r.users.profiles?.phone ?? null,
      score: r.attendance_score === null ? null : Number(r.attendance_score),
      sessionsCounted: r.attendance_sessions,
      updatedAt: r.attendance_updated_at,
    }));
  }
}
