-- Add GST to price snapshots, and remove the discount system.
--
-- Invariant this migration must preserve: no historical charge changes.
-- `final_amount` is never touched. Existing rows were charged with no tax, so
-- they backfill to subtotal_amount = final_amount and gst_amount = 0.
-- `discount_percent_used` is deliberately KEPT so already-charged cycles still
-- report the discount that was applied to them at the time.

-- ─── 1. GST columns on price_snapshots ──────────────────────────────────────
ALTER TABLE "price_snapshots"
  ADD COLUMN "subtotal_amount"  DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN "gst_percent_used" DECIMAL(5,2)  NOT NULL DEFAULT 0,
  ADD COLUMN "gst_amount"       DECIMAL(12,2) NOT NULL DEFAULT 0;

-- Backfill: every pre-existing charge was tax-free, so the subtotal is the total.
UPDATE "price_snapshots" SET "subtotal_amount" = "final_amount";

-- New rows always write this explicitly; the default keeps history honest.
ALTER TABLE "price_snapshots" ALTER COLUMN "discount_percent_used" SET DEFAULT 0;

-- ─── 2. Retire the 'custom_rate_plus_discount' pricing mode ─────────────────
-- With discounts gone the mode is just a custom rate. Rename before dropping
-- the tier tables so no booking is left referencing a concept that no longer exists.
UPDATE "bookings"
  SET "pricing_mode" = 'custom_rate'
  WHERE "pricing_mode" = 'custom_rate_plus_discount';

-- ─── 3. Drop the discount system ────────────────────────────────────────────
ALTER TABLE "bookings"      DROP CONSTRAINT IF EXISTS "bookings_discount_tier_id_fkey";
ALTER TABLE "payment_plans" DROP CONSTRAINT IF EXISTS "payment_plans_discount_tier_id_fkey";

ALTER TABLE "bookings"      DROP COLUMN IF EXISTS "discount_tier_id";
ALTER TABLE "payment_plans" DROP COLUMN IF EXISTS "discount_tier_id";

-- Legacy free-form per-request discount. Was already dead: calculateCost accepted
-- it and never forwarded it to the calculator, so it never affected any price.
ALTER TABLE "service_requests" DROP COLUMN IF EXISTS "discount_percentage";

DROP TABLE IF EXISTS "discount_tiers";
