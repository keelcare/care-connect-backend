price service redesign

The core principle
Never store a "price." Store the inputs that produced a price, and snapshot the result at the moment it mattered (booking creation, each billing cycle).
The bug in "store prices as constants" isn't that constants are bad — it's that there's only one number, with no audit trail and no room for a booking-specific override that needs to coexist with rate cards, discount tiers, and price changes happening independently and asynchronously over a plan's lifetime.
So you need four layers, kept strictly separate:
1. Rate Cards       → what does this service cost, by default, right now?
2. Discount Tiers    → what % off applies for committing to a duration?
3. Price Overrides   → did a human manually set something for this specific booking?
4. Price Snapshots   → what was actually calculated/charged, frozen in time?
Layers 1–3 are inputs that can change at any time. Layer 4 is immutable history. Almost every pricing bug comes from conflating "current configured price" with "the price someone is actually being charged."

Schema
┌─────────────────────┐
│ services             │  child_care | shadow_teacher | elder_care
├─────────────────────┤
│ id                   │
│ name                 │
│ slug                 │
└─────────────────────┘

┌─────────────────────────────┐
│ rate_cards                   │  versioned base rates — never updated in place
├─────────────────────────────┤
│ id                            │
│ service_id (FK)               │
│ hourly_rate                   │
│ effective_from                │
│ effective_to (null = current) │
│ created_by                    │
└─────────────────────────────┘

┌─────────────────────────────┐
│ discount_tiers                │  monthly / 6mo / yearly
├─────────────────────────────┤
│ id                             │
│ code            'monthly' | 'half_yearly' | 'yearly'
│ duration_months                │
│ discount_percent                │
│ active                         │
└─────────────────────────────┘

┌─────────────────────────────────┐
│ bookings                          │
├─────────────────────────────────┤
│ id                                 │
│ customer_id                        │
│ service_id (FK)                    │
│ hours_per_day, days_per_week/dates │
│ num_children                       │
│ discount_tier_id (FK, nullable)    │
│ pricing_mode      'standard' | 'custom_override' | 'custom_rate_plus_discount'
│ custom_hourly_rate  (nullable)     │  used if mode = custom_rate_plus_discount
│ custom_final_price  (nullable)     │  used if mode = custom_override
│ price_lock_mode   'locked' | 'follow_current'   ← your 3rd answer, per booking
│ status                              │
│ created_at                          │
└─────────────────────────────────┘

┌──────────────────────────────────┐
│ payment_plans                       │  the Razorpay subscription wrapper
├──────────────────────────────────┤
│ id                                   │
│ booking_id (FK)                      │
│ discount_tier_id (FK)                │
│ total_cycles      (e.g. 6 for 6mo)   │
│ razorpay_subscription_id             │
│ status                               │
└──────────────────────────────────┘

┌──────────────────────────────────┐
│ price_snapshots                     │  IMMUTABLE — one per cycle/charge
├──────────────────────────────────┤
│ id                                   │
│ booking_id (FK)                      │
│ payment_plan_id (FK, nullable)       │
│ cycle_number                         │
│ base_hourly_rate_used                │  copied, not referenced
│ discount_percent_used                │
│ hours_billed                         │
│ custom_price_applied (bool)          │
│ final_amount                         │
│ calculation_breakdown (JSON)         │  the full "show your work" object
│ razorpay_payment_id                  │
│ created_at                           │
└──────────────────────────────────┘
Key decisions baked into this:

rate_cards is append-only and time-versioned, not a single row you overwrite. This is what gives you "price could be ever-changing" without breaking history. You always query "the rate effective at time X."
pricing_mode on the booking directly encodes your answer #1 — both override and rate-plus-discount are first-class, not bolted on.
price_lock_mode per booking directly encodes your answer #3 — some customers locked, some floating, decided at plan creation, not globally.
price_snapshots is the only table you ever show as "what they paid." Nothing else is a source of truth for historical charges.


The calculation engine (the actual logic)
This should be one pure function, independent of your DB and API layer, callable both at quote-time (modal preview) and at charge-time (cron job hitting Razorpay each cycle).
pythondef calculate_price(
    service_id,
    hours_per_week,
    weeks_in_cycle,
    pricing_mode,        # 'standard' | 'custom_override' | 'custom_rate_plus_discount'
    custom_hourly_rate=None,
    custom_final_price=None,
    discount_tier=None,
    rate_card_as_of=None # datetime — None = use current
) -> PriceBreakdown:

    breakdown = {}

    # Step 1: resolve base hourly rate
    if pricing_mode == 'custom_override':
        # skip everything, return final price directly
        return PriceBreakdown(
            final_amount=custom_final_price,
            base_rate=None,
            discount_applied=None,
            mode='custom_override'
        )

    base_rate = (
        custom_hourly_rate
        if pricing_mode == 'custom_rate_plus_discount'
        else get_effective_rate_card(service_id, as_of=rate_card_as_of).hourly_rate
    )

    # Step 2: compute gross
    total_hours = hours_per_week * weeks_in_cycle
    gross = base_rate * total_hours

    # Step 3: apply discount tier (applies in both standard AND custom_rate_plus_discount)
    discount_pct = discount_tier.discount_percent if discount_tier else 0
    final = gross * (1 - discount_pct / 100)

    return PriceBreakdown(
        final_amount=round(final, 2),
        base_rate=base_rate,
        gross_amount=gross,
        discount_percent=discount_pct,
        total_hours=total_hours,
        mode=pricing_mode
    )
The critical property: this function is called twice for every paid cycle — once to show the price in the modal (using current/preview rate), and once to generate the snapshot when Razorpay actually charges. The snapshot call is what gets written to price_snapshots, with rate_card_as_of pinned according to the booking's price_lock_mode:
pythonrate_card_as_of = booking.created_at if booking.price_lock_mode == 'locked' else now()
That one line is your entire answer to "what happens when prices change mid-plan" — and it's a per-booking decision, exactly as you wanted.

How the monthly Razorpay billing loop uses this

Cron/scheduler finds payment_plans due for next cycle.
For each, calls calculate_price(...) with that booking's stored inputs + rate_card_as_of resolved per its lock mode.
Writes result to price_snapshots before calling Razorpay (so you have a record even if the charge fails).
Charges Razorpay for final_amount.
Updates the snapshot row with razorpay_payment_id and status.

This also gives you a natural retry/reconciliation point — if a charge fails, you re-attempt against the same snapshot, you don't recalculate (which protects against rate changes happening between attempt 1 and attempt 2).

Why this avoids the trap you're in now
Problem you describedHow this solves itPrices stored as constantsrate_cards is versioned, queried by effective date, never hardcodedCustom price per bookingpricing_mode + custom_final_price/custom_hourly_rate on the booking, handled explicitly in the engine, not as a hacky if-statement at checkoutDiscount auto-applies on custom priceEncoded as custom_rate_plus_discount mode — discount logic runs the same way regardless of where the base rate came fromPlans need to survive price changes differently per customerprice_lock_mode per booking, resolved at calculation time via rate_card_as_of"Ever changing" pricesNothing is mutated in place; everything is versioned or snapshotted