import {
  RAZORPAY_MIN_AMOUNT_PAISE,
  RAZORPAY_PAISE_MULTIPLIER,
} from '../constants/constants';
import { TimeUtils } from './time.utils';

// ─── Pricing Mode ────────────────────────────────────────────────────────────
// 'standard'        → use the service rate card
// 'custom_rate'     → use an admin-set hourly rate
// 'custom_override' → bypass rate resolution, use a fixed subtotal
export type PricingMode = 'standard' | 'custom_rate' | 'custom_override';

// ─── Price Lock Mode ──────────────────────────────────────────────────────────
// 'locked'        → base rate pinned to rate card effective at booking.created_at
// 'follow_current'→ base rate re-resolved from the current rate card each cycle
export type PriceLockMode = 'locked' | 'follow_current';

/**
 * Weeks billed per monthly cycle. A "5 days a week" plan means 5 sessions every
 * week, so a one-month cycle is 20 sessions — not 5. Every caller that turns a
 * weekly schedule into a monthly price must go through `weeksInCycleFor` so the
 * quote, the snapshot and the admin ledger can never disagree about this factor.
 */
export const WEEKS_PER_MONTH = 4;

/** Weeks in one billing cycle: a one-time booking is a single session, not a week. */
export function weeksInCycleFor(planType?: string | null): number {
  return !planType || planType === 'ONE_TIME' ? 1 : WEEKS_PER_MONTH;
}

/** A schedule can only repeat on the seven days that exist. */
const clampDays = (n: number) => Math.min(7, Math.max(1, Math.round(n)));

// ─── Natural monthly cycles ───────────────────────────────────────────────────
//
// A "month" of a plan is the calendar month that follows its start date, not a
// flat 28 days: a plan starting 1 Aug runs to 31 Aug, one starting 4 Sep runs to
// 3 Oct. February is a shorter month and August a longer one, and the schedule
// says so.
//
// The *price* is deliberately not derived from this. A cycle is billed at the
// flat `WEEKS_PER_MONTH` monthly figure however many dates the calendar happens
// to yield, so a parent pays the same every month and a long month is simply a
// month with more sessions in it. Keep the two apart: `cycleWindow` answers "what
// is scheduled", `weeksInCycleFor` answers "what is charged".

/**
 * The half-open date window `[start, end)` covered by cycle `cycleNumber`
 * (1-based) of a plan that began on `planStart`.
 *
 * Anchored on the plan's start date rather than on calendar month boundaries, so
 * cycle 2 of a plan that began on the 4th starts on the 4th. `TimeUtils.addMonths`
 * clamps a day that the target month doesn't have (31 Jan + 1 month → 28 Feb).
 */
export function cycleWindow(
  planStart: Date | string,
  cycleNumber: number,
): { start: Date; end: Date } {
  const anchor = new Date(planStart);
  const index = Math.max(1, Math.round(cycleNumber)) - 1;
  return {
    start: index === 0 ? anchor : TimeUtils.addMonths(anchor, index),
    end: TimeUtils.addMonths(anchor, index + 1),
  };
}

/** Weekday name → `Date.getDay()` index, matching the pattern JSON parents send. */
const DAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/**
 * How many sessions a recurrence pattern actually produces between two dates,
 * counted off the real calendar. `end` is exclusive.
 *
 * This is what the progress bar and the "N scheduled" label must use. The old
 * `daysPerWeek × 4 × months` was a billing factor borrowed as a session count,
 * which is why a six-day plan always read "24" no matter how long the month was
 * and disagreed with the rows generation had actually written.
 */
export function countSessionsBetween(
  start: Date,
  end: Date,
  recurrenceType: string,
  pattern: unknown,
): number {
  const p = (pattern ?? {}) as { days?: unknown; dates?: unknown };

  const weekdays =
    Array.isArray(p.days)
      ? p.days.map((d) => DAY_INDEX[String(d)]).filter((d) => d !== undefined)
      : [];
  const monthDates = Array.isArray(p.dates) ? p.dates.map(Number) : [];

  const matches =
    recurrenceType === 'SPECIFIC_DATES'
      ? (d: Date) => monthDates.includes(d.getDate())
      : (d: Date) => weekdays.includes(d.getDay());

  if (recurrenceType === 'SPECIFIC_DATES' ? monthDates.length === 0 : weekdays.length === 0) {
    return 0;
  }

  // Iterate at midday so a DST shift can never move a date onto the day before.
  const cursor = new Date(start);
  cursor.setHours(12, 0, 0, 0);
  const limit = new Date(end);
  limit.setHours(12, 0, 0, 0);

  let count = 0;
  while (cursor < limit) {
    if (matches(cursor)) count++;
    cursor.setDate(cursor.getDate() + 1);
  }
  return count;
}

/**
 * Sessions across a plan's whole term, summed cycle by cycle so each month
 * contributes the number of dates that month really has.
 *
 * Only the current cycle is ever generated into `bookings`, so this cannot be a
 * row count — a six-month plan would otherwise report itself as "0 of 24".
 */
export function countSessionsInTerm(
  planStart: Date | string,
  planMonths: number,
  recurrenceType: string,
  pattern: unknown,
): number {
  const months = Math.max(1, Math.round(planMonths || 1));
  let total = 0;
  for (let cycle = 1; cycle <= months; cycle++) {
    const { start, end } = cycleWindow(planStart, cycle);
    total += countSessionsBetween(start, end, recurrenceType, pattern);
  }
  return total;
}

/**
 * How many days a week a booking runs — the factor that was silently missing
 * from every recurring quote, which is why an hour a day priced as `99 × 4`
 * regardless of how many days the parent had selected.
 *
 * Resolved in order of how directly the source states it: the explicit column
 * first, then the weekday list the parent actually tapped, and only then the
 * legacy `sessions_per_month` (kept for rows written before `days_per_week`
 * existed — it is a lossy reverse-derivation, never a preferred source).
 */
export function resolveDaysPerWeek(source: {
  planType?: string | null;
  daysPerWeek?: number | null;
  recurrencePattern?: unknown;
  sessionsPerMonth?: number | null;
}): number {
  // A one-time booking is one session on one date; a weekday list is meaningless.
  if (!source.planType || source.planType === 'ONE_TIME') return 1;

  if (source.daysPerWeek != null && Number.isFinite(Number(source.daysPerWeek))) {
    return clampDays(Number(source.daysPerWeek));
  }

  const days = (source.recurrencePattern as { days?: unknown } | null)?.days;
  if (Array.isArray(days) && days.length > 0) return clampDays(days.length);

  if (source.sessionsPerMonth != null && Number.isFinite(Number(source.sessionsPerMonth))) {
    return clampDays(Number(source.sessionsPerMonth) / WEEKS_PER_MONTH);
  }

  return 1;
}

// ─── Split payments ───────────────────────────────────────────────────────────
//
// A subscription cycle is charged as an advance half at checkout and a balance
// half a fixed number of days later. One-time bookings are never split — there is
// no ongoing relationship to spread the cost across.

/** Share of a cycle taken at checkout. Fixed by policy, not configurable. */
export const ADVANCE_PAYMENT_PERCENT = 50;

/** Halves per split cycle. Named so the arithmetic below reads as intent. */
export const SPLIT_INSTALMENT_COUNT = 2;

/**
 * Whether a cycle of this size and plan type should be split.
 *
 * `finalAmount` matters because Razorpay rejects orders under ₹1: a cycle small
 * enough that its balance half would fall below the floor must be charged whole,
 * or the second half could never be collected at all.
 */
export function isSplittable(
  planType: string | null | undefined,
  finalAmount: number,
  enabled: boolean,
): boolean {
  if (!enabled) return false;
  if (!planType || planType === 'ONE_TIME') return false;
  if (!Number.isFinite(finalAmount) || finalAmount <= 0) return false;

  const paise = Math.round(finalAmount * RAZORPAY_PAISE_MULTIPLIER);
  return paise >= SPLIT_INSTALMENT_COUNT * RAZORPAY_MIN_AMOUNT_PAISE;
}

/**
 * Divide an amount into `count` parts that sum back to it *exactly*.
 *
 * Split in paise rather than by halving a float, and give the remainder to the
 * first part: the advance is charged today against a live checkout, so a stray
 * paisa is collected rather than left to fall due on a balance we might never
 * be able to bill.
 */
export function splitAmount(total: number, count = SPLIT_INSTALMENT_COUNT): number[] {
  if (count < 1) throw new Error('splitAmount requires at least one part');

  const totalPaise = Math.round(total * RAZORPAY_PAISE_MULTIPLIER);
  const base = Math.floor(totalPaise / count);
  const remainder = totalPaise - base * count;

  return Array.from({ length: count }, (_, i) =>
    (base + (i === 0 ? remainder : 0)) / RAZORPAY_PAISE_MULTIPLIER,
  );
}

/**
 * Split `total` across parts sized in proportion to `weights`, summing back to it
 * exactly. Used to apportion the subtotal and GST lines across installments once
 * a matching fee has made the halves uneven — deriving them by ratio at read time
 * instead would let rounding re-state a settled caregiver payout.
 *
 * The remainder lands on the first part, matching `splitAmount`.
 */
export function apportion(total: number, weights: number[]): number[] {
  const totalPaise = Math.round(total * RAZORPAY_PAISE_MULTIPLIER);
  const weightSum = weights.reduce((a, b) => a + b, 0);

  if (weightSum <= 0) return splitAmount(total, weights.length);

  const parts = weights.map((w) => Math.floor((totalPaise * w) / weightSum));
  parts[0] += totalPaise - parts.reduce((a, b) => a + b, 0);

  return parts.map((p) => p / RAZORPAY_PAISE_MULTIPLIER);
}

// ─── Matching fee ─────────────────────────────────────────────────────────────

/** What an installment row is collecting. Mirrors `payment_installments.kind`. */
export type InstalmentKind = 'cycle' | 'matching_fee';

export interface PlannedInstalment {
  kind: InstalmentKind;
  amount: number;
  /** True for anything payable on sight; false for the deferred balance. */
  dueNow: boolean;
}

/**
 * How a cycle is collected, once the matching fee is taken into account.
 *
 * The fee is **carved out of** the cycle total, never added to it: the parent's
 * all-in cost is identical whether the fee is on or off, it is just the first
 * thing they pay. So the amounts always sum back to `total` exactly.
 *
 * For a splittable cycle with a fee, that means three rows — the fee and the
 * remainder of the advance, both due immediately, then the balance:
 *
 *     total 10,000, fee 500  →  500 (fee, now) + 4,500 (advance, now) + 5,000 (balance)
 *
 * The advance half is still 50% of the cycle; the fee is simply part of it. If the
 * fee is large enough to swallow the whole advance the remainder row is dropped
 * rather than written as zero — Razorpay cannot charge ₹0, and a permanently
 * unpayable row would keep the cycle open forever.
 */
export function planInstalments(
  total: number,
  opts: { splittable: boolean; matchingFee?: number },
): PlannedInstalment[] {
  const fee = Math.min(
    Math.max(0, Math.round((opts.matchingFee ?? 0) * RAZORPAY_PAISE_MULTIPLIER)),
    Math.round(total * RAZORPAY_PAISE_MULTIPLIER),
  );
  const totalPaise = Math.round(total * RAZORPAY_PAISE_MULTIPLIER);
  const toRupees = (paise: number) => paise / RAZORPAY_PAISE_MULTIPLIER;

  // Anything below the gateway floor cannot be its own charge, so it stays folded
  // into the row beside it instead of becoming a row nothing can settle.
  const chargeable = (paise: number) => paise >= RAZORPAY_MIN_AMOUNT_PAISE;

  if (!opts.splittable) {
    if (!chargeable(fee) || !chargeable(totalPaise - fee)) {
      return [{ kind: 'cycle', amount: total, dueNow: true }];
    }
    return [
      { kind: 'matching_fee', amount: toRupees(fee), dueNow: true },
      { kind: 'cycle', amount: toRupees(totalPaise - fee), dueNow: true },
    ];
  }

  // Split in paise off the total, so advance + balance reconcile to the cent
  // regardless of what the fee does to the first half.
  const [advance, balance] = splitAmount(total).map((n) =>
    Math.round(n * RAZORPAY_PAISE_MULTIPLIER),
  );

  if (!chargeable(fee)) {
    return [
      { kind: 'cycle', amount: toRupees(advance), dueNow: true },
      { kind: 'cycle', amount: toRupees(balance), dueNow: false },
    ];
  }

  const advanceRemainder = advance - fee;
  if (!chargeable(advanceRemainder)) {
    // The fee covers the advance outright. Whatever it doesn't cover joins the
    // balance rather than becoming an uncollectable sliver.
    return [
      { kind: 'matching_fee', amount: toRupees(fee), dueNow: true },
      { kind: 'cycle', amount: toRupees(totalPaise - fee), dueNow: false },
    ];
  }

  return [
    { kind: 'matching_fee', amount: toRupees(fee), dueNow: true },
    { kind: 'cycle', amount: toRupees(advanceRemainder), dueNow: true },
    { kind: 'cycle', amount: toRupees(balance), dueNow: false },
  ];
}

// ─── Input ────────────────────────────────────────────────────────────────────
export interface PriceInput {
  pricingMode: PricingMode;
  /** Pre-resolved hourly rate from the correct rate card (caller handles lock mode) */
  baseHourlyRate: number;
  /** Hours per day (e.g. 4) */
  hoursPerDay: number;
  /** Days per week (e.g. 5) */
  daysPerWeek: number;
  /** Number of weeks in this billing cycle (typically 4 for monthly) */
  weeksInCycle: number;
  /**
   * GST rate to add on top of the subtotal. Pass 0 to charge no tax — this
   * function is deliberately unaware of the GST_ENABLED flag so it stays pure
   * and the caller owns the policy decision.
   */
  gstPercent: number;
  /** Only used when pricingMode = 'custom_rate' */
  customHourlyRate?: number;
  /** Only used when pricingMode = 'custom_override' — treated as the subtotal */
  customFinalPrice?: number;
}

// ─── Output ───────────────────────────────────────────────────────────────────
export interface PriceBreakdown {
  pricingMode: PricingMode;
  baseHourlyRate: number | null;
  hoursPerWeek: number | null;
  totalHours: number | null;
  /** Pre-tax amount. Null only when it carries no meaning (it never is today). */
  subtotalAmount: number;
  gstPercent: number;
  gstAmount: number;
  /** subtotalAmount + gstAmount — the amount actually charged. */
  finalAmount: number;
  customPriceApplied: boolean;
}

/**
 * Pure pricing calculation function.
 * No DB calls. No side effects. Call at quote-time and at billing-time.
 *
 * Caller is responsible for resolving `baseHourlyRate` from the correct rate
 * card according to the booking's `price_lock_mode`, and for deciding the
 * effective `gstPercent`.
 */
export function calculatePrice(input: PriceInput): PriceBreakdown {
  const {
    pricingMode,
    baseHourlyRate,
    hoursPerDay,
    daysPerWeek,
    weeksInCycle,
    gstPercent,
    customHourlyRate,
    customFinalPrice,
  } = input;

  // ── custom_override: skip rate resolution, but GST still applies ──────────
  // Tax is statutory. It does not depend on how the base price was arrived at,
  // so an admin-set price is the subtotal, not the final amount.
  if (pricingMode === 'custom_override') {
    if (customFinalPrice == null) {
      throw new Error(
        'custom_override requires customFinalPrice to be set on the booking',
      );
    }
    return {
      pricingMode,
      baseHourlyRate: null,
      hoursPerWeek: null,
      totalHours: null,
      ...applyGst(customFinalPrice, gstPercent),
      customPriceApplied: true,
    };
  }

  // ── Resolve the effective hourly rate ─────────────────────────────────────
  const effectiveRate =
    pricingMode === 'custom_rate'
      ? (customHourlyRate ?? baseHourlyRate)
      : baseHourlyRate;

  // ── Compute the pre-tax subtotal ──────────────────────────────────────────
  const hoursPerWeek = hoursPerDay * daysPerWeek;
  const totalHours = hoursPerWeek * weeksInCycle;
  const subtotal = effectiveRate * totalHours;

  return {
    pricingMode,
    baseHourlyRate: effectiveRate,
    hoursPerWeek,
    totalHours,
    ...applyGst(subtotal, gstPercent),
    customPriceApplied: pricingMode === 'custom_rate',
  };
}

/**
 * Round the subtotal before taxing it, so the GST line the customer sees is
 * exactly `subtotalAmount × gstPercent` and the three numbers always reconcile.
 */
function applyGst(rawSubtotal: number, gstPercent: number) {
  const subtotalAmount = round2(rawSubtotal);
  const gstAmount = round2((subtotalAmount * gstPercent) / 100);
  return {
    subtotalAmount,
    gstPercent,
    gstAmount,
    finalAmount: round2(subtotalAmount + gstAmount),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
