/**
 * Canonical shape for every Server-Sent Event emitted by CareConnect.
 * All events MUST conform to this structure so the frontend can route them generically.
 */
export interface SseEvent<T = any> {
  /** Dot-namespaced event type, e.g. "booking:created" */
  type: string;
  /** Payload — varies per event type */
  data: T;
  /** ISO-8601 UTC timestamp of when the event was emitted */
  timestamp: string;
}

/**
 * All recognised SSE event type strings.
 * Use these constants on both emission (services) and subscription (frontend).
 */
export const SSE_EVENTS = {
  // ─── Notifications ───────────────────────────────────────────────
  NOTIFICATION: "notification",

  // ─── Bookings ─────────────────────────────────────────────────────
  BOOKING_CREATED: "booking:created",
  BOOKING_UPDATED: "booking:updated",
  BOOKING_STARTED: "booking:started",
  BOOKING_COMPLETED: "booking:completed",
  BOOKING_CANCELLED: "booking:cancelled",
  BOOKING_RESCHEDULED: "booking:rescheduled",

  // ─── Assignments ──────────────────────────────────────────────────
  ASSIGNMENT_CREATED: "assignment:created",
  ASSIGNMENT_ACCEPTED: "assignment:accepted",
  ASSIGNMENT_REJECTED: "assignment:rejected",

  // ─── Service Requests ─────────────────────────────────────────────
  REQUEST_CREATED: "request:created",
  REQUEST_MATCHED: "request:matched",
  REQUEST_CANCELLED: "request:cancelled",
} as const;

export type SseEventType = (typeof SSE_EVENTS)[keyof typeof SSE_EVENTS];
