import { Prisma } from "@prisma/client";
import { MANUAL_PENDING_PROVIDER, PaymentStatus } from "../constants";

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
 * completion placeholder — `chargeCancellationFee` writes exactly that shape, and
 * `getParentTransactions` already classifies rows this way.
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
  ],
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
}): number {
  const gross = Number(payment.amount);
  const gst = payment.price_snapshots.reduce((sum, s) => sum + Number(s.gst_amount), 0);
  return gross - gst;
}

/** Money is only ever reported to 2dp; float drift must never leak into a payout. */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
