import { attendance_event_type } from "@prisma/client";

/**
 * Attendance policy. Every threshold and weight the system judges a caregiver on
 * lives here — nothing downstream should hard-code a number of its own.
 *
 * The model is deliberately *rate-based* rather than a running tally of demerits:
 * a caregiver serving thirty sessions a month would otherwise accumulate more
 * absolute penalty than one serving five for the same standard of reliability.
 * Each settled session contributes one unit of exposure and some fraction of
 * credit; the score is the ratio.
 */

// ─── Timing thresholds ──────────────────────────────────────────────────────

/** Arrive within this of the slot start and it is simply on time. */
export const ON_TIME_GRACE_MINUTES = 10;

/**
 * Beyond the grace window but within this, it is late. Past it, the arrival is
 * late enough that the family's morning was materially disrupted, and it is
 * scored harder.
 */
export const LATE_THRESHOLD_MINUTES = 30;

/**
 * No check-in by slot start + this = no-show.
 *
 * Deliberately equal to LATE_THRESHOLD_MINUTES: the point past which an arrival
 * stops being salvageable is the same point at which the family needs to be told
 * nobody is coming. The sweeper records the fact and alerts; it does **not**
 * change booking status — `checkExpiredBookings` already owns that transition at
 * its own (much longer) horizon, and two writers on one status field is how
 * bookings end up in states nobody can explain.
 */
export const NO_SHOW_AFTER_MINUTES = 30;

/** Checking out more than this before the scheduled end is an early departure. */
export const EARLY_DEPARTURE_MINUTES = 15;

/**
 * Cancellation notice window. Matches the 24h the cancellation-fee logic in
 * `BookingsService.cancelBooking` already uses — one notion of "short notice"
 * across money and attendance, or the two will eventually disagree in front of a
 * caregiver disputing both.
 */
export const SHORT_NOTICE_CANCEL_HOURS = 24;

/**
 * Continuous time outside the geofence before it counts as a breach. Short
 * absences are ordinary care — the school gate, the pharmacy, a walk with the
 * child — and flagging them would make the signal worthless.
 */
export const GEOFENCE_BREACH_MINUTES = 10;

/** Minimum spacing between breach events on one session, so one long absence is one event. */
export const GEOFENCE_BREACH_COOLDOWN_MINUTES = 30;

/**
 * How much of the tolerance window the position trail is allowed to be missing
 * before a breach can still be recorded.
 *
 * The app publishes every ten seconds, so a genuine ten-minute absence leaves a
 * dense trail. A single distant fix after a gap does not — it says the phone
 * resurfaced somewhere else, not that the caregiver stood outside for ten
 * minutes, and the two must not be recorded as the same thing.
 */
export const GEOFENCE_TRAIL_SLACK_MINUTES = 2;

/**
 * A session under way with no heartbeat for this long is treated as the caregiver
 * having gone dark. Generous, because patchy mobile data in a client's home is
 * not misconduct — this is meant to catch the app being killed for a whole
 * session, not a lift ride through a basement.
 */
export const STALE_PRESENCE_MINUTES = 20;

// ─── Scoring ────────────────────────────────────────────────────────────────

/** Rolling window the score is computed over. */
export const SCORE_WINDOW_DAYS = 60;

/**
 * Settled sessions needed in the window before a score is published at all.
 * Below this a single bad day swings the number by twenty points, which reads as
 * a verdict when it is really noise.
 */
export const MIN_SESSIONS_FOR_SCORE = 5;

/**
 * Credit per session outcome, and the deductions modifiers apply.
 *
 * A no-show is negative rather than zero on purpose: it is worse than the session
 * never having existed, because a family was left without care and with no notice
 * to arrange any.
 */
export const SCORE_WEIGHTS: Record<attendance_event_type, number> = {
  CHECK_IN: 1.0,
  // Overwritten per-event by `lateArrivalWeight` — this is the >LATE_THRESHOLD floor.
  LATE_CHECK_IN: 0.6,
  CHECK_OUT: 0,
  EARLY_CHECK_OUT: -0.2,
  MISSED_CHECK_OUT: -0.1,
  NO_SHOW: -0.5,
  LATE_CANCEL: 0,
  ADVANCE_CANCEL: 0.5,
  GEOFENCE_BREACH: -0.2,
  OFFLINE_DURING_SESSION: -0.2,
};

/** Credit for an arrival that missed the grace window. */
export function lateArrivalWeight(minutesLate: number): number {
  return minutesLate <= LATE_THRESHOLD_MINUTES ? 0.8 : SCORE_WEIGHTS.LATE_CHECK_IN;
}

/**
 * The events that settle a session — exactly one per booking, forming the score's
 * denominator. Modifiers subtract from the numerator without inflating exposure,
 * so a caregiver cannot dilute a breach by working more.
 */
export const SESSION_OUTCOME_TYPES: attendance_event_type[] = [
  "CHECK_IN",
  "LATE_CHECK_IN",
  "NO_SHOW",
  "LATE_CANCEL",
  "ADVANCE_CANCEL",
];

/**
 * Events recorded at most once per booking. Their `dedupe_key` is set, which
 * makes re-running any sweeper or replaying any event a no-op at the database
 * level rather than a duplicate row someone has to reconcile later.
 */
export const ONCE_PER_BOOKING_TYPES: attendance_event_type[] = [
  ...SESSION_OUTCOME_TYPES,
  "CHECK_OUT",
  "EARLY_CHECK_OUT",
  "MISSED_CHECK_OUT",
  "OFFLINE_DURING_SESSION",
];

// ─── Bands ──────────────────────────────────────────────────────────────────

export type AttendanceBand =
  | "EXCELLENT"
  | "GOOD"
  | "NEEDS_IMPROVEMENT"
  | "AT_RISK"
  | "INSUFFICIENT_DATA";

export const BAND_THRESHOLDS = {
  EXCELLENT: 90,
  GOOD: 75,
  NEEDS_IMPROVEMENT: 60,
} as const;

export function bandForScore(
  score: number | null,
  sessionsCounted: number,
): AttendanceBand {
  if (score === null || sessionsCounted < MIN_SESSIONS_FOR_SCORE) {
    return "INSUFFICIENT_DATA";
  }
  if (score >= BAND_THRESHOLDS.EXCELLENT) return "EXCELLENT";
  if (score >= BAND_THRESHOLDS.GOOD) return "GOOD";
  if (score >= BAND_THRESHOLDS.NEEDS_IMPROVEMENT) return "NEEDS_IMPROVEMENT";
  return "AT_RISK";
}

/**
 * Booking statuses that mean the *family* did not turn up or called it off. A
 * caregiver who travelled to a door nobody opened must not be marked absent for
 * it, so these suppress attendance recording entirely.
 */
export const PARENT_FAULT_STATUSES = ["PARENT_NO_SHOW"];

/** Human-readable one-liners, surfaced in the partner app's attendance timeline. */
export const EVENT_LABELS: Record<attendance_event_type, string> = {
  CHECK_IN: "Checked in on time",
  LATE_CHECK_IN: "Checked in late",
  CHECK_OUT: "Checked out",
  EARLY_CHECK_OUT: "Left before the scheduled end",
  MISSED_CHECK_OUT: "Session closed automatically — no check-out",
  NO_SHOW: "Did not attend",
  LATE_CANCEL: "Cancelled at short notice",
  ADVANCE_CANCEL: "Cancelled in advance",
  GEOFENCE_BREACH: "Away from the care location during the session",
  OFFLINE_DURING_SESSION: "App offline during the session",
};
