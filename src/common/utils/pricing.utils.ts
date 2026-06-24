// ─── Pricing Mode ────────────────────────────────────────────────────────────
// 'standard'                  → use service rate card + optional discount tier
// 'custom_rate_plus_discount' → use admin-set hourly rate + optional discount tier
// 'custom_override'           → bypass all calculation, use a fixed final price
export type PricingMode =
  | 'standard'
  | 'custom_rate_plus_discount'
  | 'custom_override';

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
  /** Discount % from the discount tier (0 if none) */
  discountPercent: number;
  /** Only used when pricingMode = 'custom_rate_plus_discount' */
  customHourlyRate?: number;
  /** Only used when pricingMode = 'custom_override' */
  customFinalPrice?: number;
}

// ─── Output ───────────────────────────────────────────────────────────────────
export interface PriceBreakdown {
  pricingMode: PricingMode;
  baseHourlyRate: number | null;
  hoursPerWeek: number | null;
  totalHours: number | null;
  grossAmount: number | null;
  discountPercent: number;
  discountAmount: number | null;
  finalAmount: number;
  customPriceApplied: boolean;
}

/**
 * Pure pricing calculation function.
 * No DB calls. No side effects. Call at quote-time and at billing-time.
 *
 * Caller is responsible for resolving `baseHourlyRate` from the correct rate
 * card according to the booking's `price_lock_mode`.
 */
export function calculatePrice(input: PriceInput): PriceBreakdown {
  const {
    pricingMode,
    baseHourlyRate,
    hoursPerDay,
    daysPerWeek,
    weeksInCycle,
    discountPercent,
    customHourlyRate,
    customFinalPrice,
  } = input;

  // ── custom_override: bypass everything ────────────────────────────────────
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
      grossAmount: null,
      discountPercent: 0,
      discountAmount: null,
      finalAmount: round2(customFinalPrice),
      customPriceApplied: true,
    };
  }

  // ── Resolve the effective hourly rate ─────────────────────────────────────
  const effectiveRate =
    pricingMode === 'custom_rate_plus_discount'
      ? (customHourlyRate ?? baseHourlyRate)
      : baseHourlyRate;

  // ── Step 2: compute gross ─────────────────────────────────────────────────
  const hoursPerWeek = hoursPerDay * daysPerWeek;
  const totalHours = hoursPerWeek * weeksInCycle;
  const grossAmount = effectiveRate * totalHours;

  // ── Step 3: apply discount (same in standard AND custom_rate_plus_discount)
  const discountAmount = (grossAmount * discountPercent) / 100;
  const finalAmount = grossAmount - discountAmount;

  return {
    pricingMode,
    baseHourlyRate: effectiveRate,
    hoursPerWeek,
    totalHours,
    grossAmount: round2(grossAmount),
    discountPercent,
    discountAmount: round2(discountAmount),
    finalAmount: round2(finalAmount),
    customPriceApplied: pricingMode === 'custom_rate_plus_discount',
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
