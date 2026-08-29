import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import {
  BOOKING_EVENTS,
  BookingStartedEvent,
  BookingCompletedEvent,
  BookingCancelledEvent,
  BookingAutoCompletedEvent,
} from "../bookings/events/booking.events";
import { AttendanceService } from "./attendance.service";

/**
 * Attendance's write path into the booking lifecycle.
 *
 * Deliberately a listener rather than calls inside `BookingsService`: check-in,
 * check-out and cancellation are the moments the caregiver is standing at a
 * door with the app open, and a failure to write a statistic must not be able to
 * stop any of them. Every handler is also fully guarded, so a bad row cannot
 * take down the emitter's other subscribers.
 */
@Injectable()
export class AttendanceListeners {
  private readonly logger = new Logger(AttendanceListeners.name);

  constructor(private readonly attendance: AttendanceService) {}

  @OnEvent(BOOKING_EVENTS.STARTED)
  async handleStarted(event: BookingStartedEvent) {
    await this.attendance
      .recordCheckIn(event.booking)
      .catch((err) => this.warn("check-in", event.booking.id, err));
  }

  @OnEvent(BOOKING_EVENTS.COMPLETED)
  async handleCompleted(event: BookingCompletedEvent) {
    await this.attendance
      .recordCheckOut(event.booking)
      .catch((err) => this.warn("check-out", event.booking.id, err));
  }

  @OnEvent(BOOKING_EVENTS.CANCELLED)
  async handleCancelled(event: BookingCancelledEvent) {
    const { booking, cancelledByUserId, reason } = event;

    // Only the caregiver's own cancellations are hers to answer for. Parent and
    // admin cancellations, and the system's own expiries, pass through
    // unrecorded — she was available for all of them.
    if (!cancelledByUserId || cancelledByUserId !== booking.nanny_id) return;

    // A no-show *report* also arrives here as a CANCELLED event, with the
    // reporter as the actor. When the caregiver is the one reporting — the
    // family never opened the door — the actor check above reads her as the
    // canceller, and until this guard she was recorded with a LATE_CANCEL for
    // a session she travelled to and stood outside of. `reportNoShow` tags the
    // booking `noshow` inside the same transaction that cancels it, so the tag
    // is always visible by the time the event fires.
    if (booking.tags?.includes("noshow")) return;

    await this.attendance
      .recordNannyCancellation(booking, reason)
      .catch((err) => this.warn("cancellation", booking.id, err));
  }

  /**
   * The session ran past its limit and the system closed it. The care happened —
   * this is a missed check-out, not a missed session, and it is weighted as the
   * paperwork lapse it is.
   */
  @OnEvent(BOOKING_EVENTS.AUTO_COMPLETED)
  async handleAutoCompleted(event: BookingAutoCompletedEvent) {
    await this.attendance
      .recordMissedCheckOut(event.booking)
      .catch((err) => this.warn("missed check-out", event.booking.id, err));
  }

  private warn(what: string, bookingId: string, err: unknown) {
    this.logger.warn(
      `Failed to record ${what} attendance for booking ${bookingId}: ${(err as Error)?.message}`,
    );
  }
}
