// ─── Pricing Mode ────────────────────────────────────────────────────────────
// 'standard'        → use the service rate card
// 'custom_rate'     → use an admin-set hourly rate
// 'custom_override' → bypass rate resolution, use a fixed subtotal
export type PricingMode = 'standard' | 'custom_rate' | 'custom_override';

// ─── Price Lock Mode ──────────────────────────────────────────────────────────
// 'locked'        → base rate pinned to rate card effective at booking.created_at
// 'follow_current'→ base rate re-resolved from the current rate card each cycle
export type PriceLockMode = 'locked' | 'follow_current';

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
