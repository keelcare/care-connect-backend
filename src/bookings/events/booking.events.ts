import { bookings } from "@prisma/client";

export class BookingCreatedEvent {
  constructor(public readonly booking: bookings) {}
}

export class BookingStartedEvent {
  constructor(public readonly booking: bookings) {}
}

export class BookingCompletedEvent {
  constructor(public readonly booking: bookings, public readonly totalAmount: number) {}
}

export class BookingCancelledEvent {
  constructor(
    public readonly booking: bookings,
    public readonly reason?: string,
    public readonly cancelledByUserId?: string,
  ) {}
}

export class BookingRescheduledEvent {
  constructor(
    public readonly booking: bookings,
    public readonly oldBooking: any, // To include old time info for notifications
  ) {}
}

/**
 * A recurring plan was cancelled and its unpaid-for sessions dropped in one go.
 *
 * Deliberately one event for the whole plan rather than a `BookingCancelledEvent`
 * per session: a six-month plan drops dozens of bookings at once, and the
 * per-booking handler emails both parties every time. Forty identical emails and
 * forty chat deletions is not a notification, it is an outage.
 */
export class PlanWoundDownEvent {
  constructor(
    public readonly planId: string,
    public readonly parentId: string,
    public readonly nannyId: string | null,
    /** Sessions dropped because they were never paid for. */
    public readonly cancelledBookingIds: string[],
    /** Sessions the parent had already paid for and keeps. */
    public readonly retainedCount: number,
    public readonly reason?: string,
  ) {}
}

export const BOOKING_EVENTS = {
  CREATED: "booking.created",
  STARTED: "booking.started",
  COMPLETED: "booking.completed",
  CANCELLED: "booking.cancelled",
  RESCHEDULED: "booking.rescheduled",
  PLAN_WOUND_DOWN: "plan.wound_down",
};
