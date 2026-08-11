-- Reconcile the db-push drift that LATER MIGRATIONS DEPEND ON.
--
-- Companion to 20260811120000_reconcile_db_push_drift, which carries the rest.
-- The split is not cosmetic: the objects below were created by `prisma db push`
-- and never recorded here, yet migrations from 20260705 onwards read and alter
-- them. A single catch-up migration at the end of the history is therefore too
-- late — the replay dies long before reaching it. This fragment runs first and
-- creates only what the intervening migrations need:
--
--   20260705120000  flat-rate backfill        -> rate_cards
--   20260709120000  addresses backfill        -> profiles.location_address
--   20260710120000  GST + discount removal    -> price_snapshots, payment_plans,
--                                                bookings.pricing_mode
--   20260803120000  days_per_week backfill    -> recurring_service_requests
--   20260803140000  payment_installments      -> price_snapshots, payment_plans
--
-- Tables are created in their shape AS OF THIS POINT IN HISTORY, not their final
-- shape. `price_snapshots` in particular is created without its GST columns,
-- because 20260710120000 adds those with a bare ADD COLUMN that would collide.
-- Likewise `recurring_service_requests` omits `nanny_id` (added unguarded by
-- 20260803150000), `days_per_week`, and the cancellation-audit columns.
--
-- Every statement is guarded so this is a complete no-op on prod and on any dev
-- database that was already db-pushed.

-- ─── Columns later migrations read ───────────────────────────────────────────

-- Read by the 20260709120000 addresses backfill.
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "location_address" TEXT;

-- `pricing_mode` is rewritten by 20260710120000; the rest of the pricing layer
-- arrived in the same db push and is kept with it.
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "pricing_mode" VARCHAR(50) NOT NULL DEFAULT 'standard';
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "price_lock_mode" VARCHAR(50) NOT NULL DEFAULT 'locked';
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "custom_hourly_rate" DECIMAL(10,2);
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "custom_final_price" DECIMAL(12,2);
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "hours_per_day" DECIMAL(4,2);
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "days_per_week" INTEGER;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "plan_duration_months" INTEGER NOT NULL DEFAULT 1;
-- Read by the 20260803150000 staffing backfill.
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "recurring_request_id" UUID;

-- ─── Tables later migrations read ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "rate_cards" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "service_id" UUID NOT NULL,
    "hourly_rate" DECIMAL(10,2) NOT NULL,
    "effective_from" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effective_to" TIMESTAMPTZ(6),
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rate_cards_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "payment_plans" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "booking_id" UUID NOT NULL,
    "total_cycles" INTEGER NOT NULL,
    "cycles_completed" INTEGER NOT NULL DEFAULT 0,
    "start_date" TIMESTAMPTZ(6) NOT NULL,
    "next_due_date" TIMESTAMPTZ(6) NOT NULL,
    "status" VARCHAR(50) NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_plans_pkey" PRIMARY KEY ("id")
);

-- Pre-GST shape. `subtotal_amount`, `gst_percent_used` and `gst_amount` are
-- added by 20260710120000 and must NOT appear here.
CREATE TABLE IF NOT EXISTS "price_snapshots" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "booking_id" UUID NOT NULL,
    "payment_plan_id" UUID,
    "payment_id" UUID,
    "cycle_number" INTEGER NOT NULL,
    "base_hourly_rate_used" DECIMAL(10,2) NOT NULL,
    "discount_percent_used" DECIMAL(5,2) NOT NULL,
    "hours_billed" DECIMAL(8,2) NOT NULL,
    "custom_price_applied" BOOLEAN NOT NULL DEFAULT false,
    "final_amount" DECIMAL(12,2) NOT NULL,
    "calculation_breakdown" JSONB NOT NULL,
    "razorpay_payment_id" VARCHAR(255),
    "status" VARCHAR(50) NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "price_snapshots_pkey" PRIMARY KEY ("id")
);

-- Without `nanny_id` (20260803150000), `days_per_week` (20260803120000) or the
-- cancellation-audit columns (20260806120000).
CREATE TABLE IF NOT EXISTS "recurring_service_requests" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "parent_id" UUID NOT NULL,
    "recurrence_type" VARCHAR(50) NOT NULL,
    "recurrence_pattern" JSONB NOT NULL,
    "start_time" TIME(6) NOT NULL,
    "duration_hours" DECIMAL(4,2) NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE,
    "num_children" INTEGER NOT NULL,
    "children_ages" JSONB,
    "special_requirements" TEXT,
    "location_lat" DECIMAL(10,8) NOT NULL,
    "location_lng" DECIMAL(11,8) NOT NULL,
    "status" VARCHAR(50) NOT NULL DEFAULT 'active',
    "required_skills" TEXT[],
    "category" VARCHAR(50),
    "plan_duration_months" INTEGER DEFAULT 1,
    "plan_type" VARCHAR(50),
    "sessions_per_month" INTEGER,
    "max_hourly_rate" DECIMAL(10,2),
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recurring_service_requests_pkey" PRIMARY KEY ("id")
);

-- ─── payment_installments: re-shaped around price_snapshots ──────────────────
--
-- 20260405071912 created this table for the `subscription_plans` billing model.
-- The db push that replaced that model with `payment_plans` / `price_snapshots`
-- reshaped it in place, so 20260803140000's `CREATE TABLE IF NOT EXISTS` finds
-- the table already there, skips it, and then indexes a column that only the
-- push ever added. The reshape has to happen here instead.
--
-- Columns only: the indexes and foreign keys are left to 20260803140000, which
-- adds them itself. `kind` is left to 20260803160000.

ALTER TABLE "payment_installments" DROP CONSTRAINT IF EXISTS "payment_installments_subscription_plan_id_fkey";
DROP INDEX IF EXISTS "payment_installments_subscription_plan_id_idx";
ALTER TABLE "payment_installments" DROP COLUMN IF EXISTS "subscription_plan_id";
ALTER TABLE "payment_installments" DROP COLUMN IF EXISTS "amount_due";

ALTER TABLE "payment_installments" ADD COLUMN IF NOT EXISTS "price_snapshot_id" UUID NOT NULL;
ALTER TABLE "payment_installments" ADD COLUMN IF NOT EXISTS "payment_plan_id" UUID;
ALTER TABLE "payment_installments" ADD COLUMN IF NOT EXISTS "cycle_number" INTEGER NOT NULL;
ALTER TABLE "payment_installments" ADD COLUMN IF NOT EXISTS "total_installments" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "payment_installments" ADD COLUMN IF NOT EXISTS "amount" DECIMAL(12,2) NOT NULL;
ALTER TABLE "payment_installments" ADD COLUMN IF NOT EXISTS "subtotal_amount" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "payment_installments" ADD COLUMN IF NOT EXISTS "gst_amount" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "payment_installments" ADD COLUMN IF NOT EXISTS "paid_at" TIMESTAMPTZ(6);
ALTER TABLE "payment_installments" ADD COLUMN IF NOT EXISTS "last_reminded_at" TIMESTAMPTZ(6);
ALTER TABLE "payment_installments" ADD COLUMN IF NOT EXISTS "reminder_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "payment_installments" ALTER COLUMN "due_date" DROP NOT NULL;
ALTER TABLE "payment_installments" ALTER COLUMN "status" SET DATA TYPE VARCHAR(20);
ALTER TABLE "payment_installments" ALTER COLUMN "created_at" SET NOT NULL;
ALTER TABLE "payment_installments" ALTER COLUMN "updated_at" SET NOT NULL;

-- ─── Indexes ─────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS "rate_cards_service_id_effective_from_idx" ON "rate_cards"("service_id", "effective_from");
CREATE UNIQUE INDEX IF NOT EXISTS "payment_plans_booking_id_key" ON "payment_plans"("booking_id");
CREATE INDEX IF NOT EXISTS "payment_plans_status_next_due_date_idx" ON "payment_plans"("status", "next_due_date");
CREATE INDEX IF NOT EXISTS "price_snapshots_booking_id_idx" ON "price_snapshots"("booking_id");
CREATE INDEX IF NOT EXISTS "price_snapshots_payment_plan_id_idx" ON "price_snapshots"("payment_plan_id");
CREATE INDEX IF NOT EXISTS "price_snapshots_status_idx" ON "price_snapshots"("status");

-- ─── Foreign keys ────────────────────────────────────────────────────────────

DO $$ BEGIN
 ALTER TABLE "rate_cards" ADD CONSTRAINT "rate_cards_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "rate_cards" ADD CONSTRAINT "rate_cards_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "payment_plans" ADD CONSTRAINT "payment_plans_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "price_snapshots" ADD CONSTRAINT "price_snapshots_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "price_snapshots" ADD CONSTRAINT "price_snapshots_payment_plan_id_fkey" FOREIGN KEY ("payment_plan_id") REFERENCES "payment_plans"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "price_snapshots" ADD CONSTRAINT "price_snapshots_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "recurring_service_requests" ADD CONSTRAINT "recurring_service_requests_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "bookings" ADD CONSTRAINT "bookings_recurring_request_id_fkey" FOREIGN KEY ("recurring_request_id") REFERENCES "recurring_service_requests"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
