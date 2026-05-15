/**
 * Central constants for business-critical thresholds used across the application.
 * Dev A must import from this file rather than define their own inline constants.
 */

/** Matching & availability radius in kilometres */
export const MATCHING_RADIUS_KM = 15;

/**
 * Nanny assignment response window in milliseconds.
 * A nanny has this long to accept/reject before the system moves to the next candidate.
 */
export const ASSIGNMENT_RESPONSE_DEADLINE_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Booking auto-expiry thresholds for the `checkExpiredBookings` cron.
 * Bookings that never started and exceed this age are auto-expired.
 */
export const BOOKING_UNSTARTED_EXPIRY_HOURS = 4;
export const BOOKING_UNSTARTED_EXPIRY_MS = BOOKING_UNSTARTED_EXPIRY_HOURS * 60 * 60 * 1000;

/**
 * Bookings that have been IN_PROGRESS longer than this are auto-completed.
 */
export const BOOKING_IN_PROGRESS_MAX_HOURS = 8;
export const BOOKING_IN_PROGRESS_MAX_MS = BOOKING_IN_PROGRESS_MAX_HOURS * 60 * 60 * 1000;

/**
 * Razorpay requires payments in the smallest currency unit (paise for INR).
 * Multiply rupees by this factor when creating Razorpay orders.
 */
export const RAZORPAY_PAISE_MULTIPLIER = 100;

/**
 * Minimum Razorpay order amount in paise (₹1).
 */
export const RAZORPAY_MIN_AMOUNT_PAISE = 100;

/**
 * Duration in hours after which a progress report is due from a nanny after booking completion.
 */
export const PROGRESS_REPORT_DUE_HOURS = 24;
