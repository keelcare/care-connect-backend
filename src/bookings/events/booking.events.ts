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

export const BOOKING_EVENTS = {
  CREATED: "booking.created",
  STARTED: "booking.started",
  COMPLETED: "booking.completed",
  CANCELLED: "booking.cancelled",
  RESCHEDULED: "booking.rescheduled",
};
