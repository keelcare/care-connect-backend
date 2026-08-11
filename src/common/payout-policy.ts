import { Prisma } from "@prisma/client";
import {
  BookingStatus,
  MANUAL_PENDING_PROVIDER,
  PaymentStatus,
} from "../constants";

/**
 * The single definition of what a caregiver is owed, shared by the caregiver-facing
 * earnings endpoints and the admin revenue ledger.
 *
 * These two read the same rows for different audiences, so any rule that lives in
 * only one of them shows a caregiver a number the admin ledger contradicts. Every
 * such rule belongs here.
 */

/**
 * A payment counts toward a caregiver's earnings once the money is collected or owed:
 *   - `captured`        — parent paid; the booking has not been completed yet.
 *   - `pending_release` — booking completed, payout accruing. Includes the
 *                         `manual_pending` placeholder written when a booking
 *                         completes with no charge attached.
 *
 * `created` is excluded: those are checkouts a parent opened and abandoned, so
 * counting them would build earnings out of an unpaid cart. `failed` and `refunded`
 * are excluded for the same reason — no money settled.
 */
export const EARNING_STATUSES = [
  PaymentStatus.CAPTURED,
  PaymentStatus.PENDING_RELEASE,
];

/**
 * A cancellation fee is a `payments` row with no price snapshot that is not a
 * completion placeholder, and `getParentTransactions` already classifies rows this
 * way. Cancellation no longer writes such a row at all — the fee is recorded on the
 * booking as `cancellation_fee_status: "owed"` and only becomes a `payments` row
 * when the parent actually settles it — but historical rows keep this shape, so the
 * classification stays.
 *
 * It carries no caregiver share: it is a charge for a booking that never happened,
 * so there is no service fee to split. Both sides must exclude it, otherwise the
 * admin ledger accrues a payout the caregiver's app will never show.
 *
 * NOTE: this is a policy decision, not a derived fact. If the business decides a
 * caregiver is compensated for a late cancellation, change it here and both sides
 * move together.
 */
export const CAREGIVER_SHARE_ONLY: Prisma.paymentsWhereInput = {
  OR: [
    { provider: MANUAL_PENDING_PROVIDER },
    { price_snapshots: { some: {} } },
    // A split cycle's halves link to their instalment, not to the snapshot — the
    // snapshot's payment_id can only hold one id. Without this arm the half that
    // does not hold it is read as a cancellation fee and drops out of caregiver
    // earnings and the revenue ledger entirely.
    { payment_installments: { some: {} } },
  ],
  // The matching fee is NOT excluded, and the reason is arithmetic rather than
  // policy. `createPriceSnapshot` deducts the fee from the first cycle
  // (`netTotal = finalAmount - feeCredit`) instead of adding it on top, so the
  // parent's total for a placement is `fee + reduced cycle 1 + later cycles` —
  // exactly the headline price. Dropping the fee row here therefore did not
  // withhold a platform charge from the caregiver, it shrank her first cycle by
  // the fee amount and paid her nothing back for it. Counting the row restores
  // the cycle to its gross value; it cannot double-count, because the money it
  // represents was subtracted from the cycle it is being added back to.
  //
  // Attribution still runs through the booking (see `caregiverEarningsWhere`), so
  // a fee raised before anyone was assigned simply accrues to nobody until the
  // match is made — which is the same booking whose first cycle carries the
  // deduction.
};

/**
 * Every payment carrying a share for one caregiver.
 *
 * Attribution runs through the booking rather than `payments.nanny_id`: that column
 * was historically left null on completion placeholders and is never set on
 * cancellation fees, so filtering on it silently drops real earnings. The booking
 * always knows who worked.
 */
export function caregiverEarningsWhere(nannyId: string): Prisma.paymentsWhereInput {
  return {
    bookings: { nanny_id: nannyId },
    status: { in: EARNING_STATUSES },
    ...CAREGIVER_SHARE_ONLY,
  };
}

/**
 * The pre-tax service fee a payment represents — the base every caregiver share and
 * platform margin is taken from.
 *
 * GST is stripped first: it is collected on behalf of the government and is nobody's
 * income. It is frozen on the price snapshot at charge time, so a later change to the
 * GST flag never re-states a historical payout. Rows with no snapshot (the completion
 * placeholder) store a bare total and are treated as GST-free.
 */
export function preTaxServiceFee(payment: {
  amount: Prisma.Decimal | number;
  price_snapshots: { gst_amount: Prisma.Decimal | number }[];
  payment_installments?: { gst_amount: Prisma.Decimal | number }[];
}): number {
  const gross = Number(payment.amount);

  // Prefer the instalment's own frozen GST. A half-cycle payment carries half the
  // gross, so stripping the *cycle's* GST would understate the fee — and turn it
  // negative on a small cycle. Both figures are frozen at charge time, so neither
  // is re-derived by ratio here: a later rounding or rate change must never
  // re-state a settled payout.
  const instalments = payment.payment_installments;
  if (instalments?.length) {
    return gross - instalments.reduce((sum, i) => sum + Number(i.gst_amount), 0);
  }

  const gst = payment.price_snapshots.reduce((sum, s) => sum + Number(s.gst_amount), 0);
  return gross - gst;
}

/** Money is only ever reported to 2dp; float drift must never leak into a payout. */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ─── Projected earnings ──────────────────────────────────────────────────────
//
// A caregiver's projection is *booked work only*: what she has already earned this
// period, plus her share of the sessions still on her calendar before it ends. It
// is never a run-rate extrapolation. This is someone's income — every rupee shown
// has to be traceable to a real row an admin can also see, and a forecast that
// quietly invents money is worse than no projection at all.

/**
 * Work that counts as booked. `CONFIRMED` is a session both sides have committed
 * to; `IN_PROGRESS` is one being worked right now. `REQUESTED` is excluded — an
 * unaccepted request is a hope, not a booking, and the parent may never confirm it.
 */
export const PROJECTABLE_STATUSES = [
  BookingStatus.CONFIRMED,
  BookingStatus.IN_PROGRESS,
];

/**
 * Sessions scheduled to start inside `(from, to]` that can be projected.
 *
 * The `payments` exclusion is the rule that keeps a projection honest. A parent can
 * pay upfront, so a session still ahead on the calendar may *already* have a
 * captured payment sitting in the earned-so-far half of the sum. Counting the
 * booking as well would show the caregiver the same money twice. Excluding rows
 * that already carry an earning payment makes the two halves disjoint by
 * construction rather than by arithmetic that could drift.
 */
export function projectableBookingsWhere(
  nannyId: string,
  from: Date,
  to: Date,
): Prisma.bookingsWhereInput {
  return {
    nanny_id: nannyId,
    status: { in: PROJECTABLE_STATUSES },
    start_time: { gt: from, lte: to },
    NOT: { payments: { some: { status: { in: EARNING_STATUSES } } } },
  };
}

/** The booking fields a projection needs. Keeps the service's select honest. */
export type ProjectableBooking = {
  start_time: Date | null;
  end_time: Date | null;
  pricing_mode: string;
  custom_hourly_rate: Prisma.Decimal | number | null;
  price_snapshots: {
    subtotal_amount: Prisma.Decimal | number;
    hours_billed: Prisma.Decimal | number;
  }[];
};

/** Scheduled length of a session in hours, or null if it has no usable schedule. */
export function sessionHours(booking: ProjectableBooking): number | null {
  if (!booking.start_time || !booking.end_time) return null;
  const hours =
    (new Date(booking.end_time).getTime() - new Date(booking.start_time).getTime()) /
    3_600_000;
  return hours > 0 ? hours : null;
}

/**
 * The pre-tax service fee a scheduled session is expected to produce, or `null`
 * when it cannot be valued honestly.
 *
 * GST never enters: we build the pre-tax base directly, the same base
 * `preTaxServiceFee` recovers from a payment that has already settled.
 *
 * Rate resolution, most authoritative first:
 *   1. An existing price snapshot for this booking — what the booking was actually
 *      priced at. Its implied hourly rate already reflects every custom rate and
 *      override applied at charge time.
 *   2. `custom_rate` → the admin-set hourly rate on the booking.
 *   3. `standard`    → `standardHourlyRate`, which the caller resolves from the rate
 *      card honouring `price_lock_mode`, so a locked booking projects at the rate it
 *      was locked to rather than at today's.
 *
 * `custom_override` with no snapshot returns null. `custom_final_price` is a
 * whole-cycle subtotal with no per-session meaning, and splitting it by hours would
 * invent a rate that was never agreed. Omitting the session under-projects, which
 * is the safe direction to be wrong in.
 */
export function preTaxBookingValue(
  booking: ProjectableBooking,
  standardHourlyRate: number | null,
): number | null {
  const hours = sessionHours(booking);
  if (hours == null) return null;

  const snapshot = booking.price_snapshots[0];
  if (snapshot) {
    const billed = Number(snapshot.hours_billed);
    if (billed > 0) {
      return round2((Number(snapshot.subtotal_amount) / billed) * hours);
    }
  }

  if (booking.pricing_mode === "custom_rate" && booking.custom_hourly_rate != null) {
    return round2(Number(booking.custom_hourly_rate) * hours);
  }

  if (booking.pricing_mode === "standard" && standardHourlyRate != null) {
    return round2(standardHourlyRate * hours);
  }

  return null;
}
