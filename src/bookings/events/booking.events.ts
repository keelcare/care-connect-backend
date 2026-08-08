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
 * A session the system had to close itself because it ran past its limit with no
 * check-out.
 *
 * Separate from `BookingCompletedEvent`, which is still emitted for these: that
 * event means care finished, and payments and progress reports must treat it the
 * same either way. This one means nobody closed it — a distinction only
 * attendance acts on, and folding it into the completion event would force every
 * other subscriber to learn about it.
 */
export class BookingAutoCompletedEvent {
  constructor(public readonly booking: bookings) {}
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
  AUTO_COMPLETED: "booking.auto_completed",
  CANCELLED: "booking.cancelled",
  RESCHEDULED: "booking.rescheduled",
  PLAN_WOUND_DOWN: "plan.wound_down",
};
