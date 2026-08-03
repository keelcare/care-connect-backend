import {
  RAZORPAY_MIN_AMOUNT_PAISE,
  RAZORPAY_PAISE_MULTIPLIER,
} from '../constants/constants';

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
