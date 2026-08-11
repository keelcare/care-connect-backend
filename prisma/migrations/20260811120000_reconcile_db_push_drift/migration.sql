-- Reconcile the migration history with the schema.
--
-- Several models reached the dev and prod databases through `prisma db push`,
-- which writes DDL straight to the database and records nothing here. The
-- history therefore could not rebuild the schema: `rate_cards`, `addresses`,
-- `nanny_onboarding_details`, `payment_plans`, `price_snapshots`,
-- `recurring_service_requests`, `call_sessions`, `booking_status_log` and the
-- two attendance tables had no CREATE TABLE anywhere, and `services` was still
-- the pre-rate-card shape. A `migrate reset` died on the first migration that
-- touched one of them.
--
-- This migration carries that whole drift. Every statement is guarded, because
-- it has to be correct in two very different situations:
--
--   * a fresh replay (`migrate reset`), where none of this exists yet and the
--     statements do the real work;
--   * an existing database (prod, and any dev already db-pushed), where all of
--     it exists already and every statement must be a no-op.
--
-- FK and enum guards use the DO/EXCEPTION pattern already used by
-- 20260213213340_baseline_and_add_services, since Postgres has no
-- ADD CONSTRAINT IF NOT EXISTS.
--
-- Deliberately NOT here: dropping the superseded `subscription_plans` table.
-- It holds real rows on prod and dropping it is not this migration's job — an
-- orphaned table is invisible to Prisma Client and to `migrate reset`. Only its
-- link to `payment_installments` is severed below.

-- ─── Enums ───────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE "attendance_event_type" AS ENUM ('CHECK_IN', 'LATE_CHECK_IN', 'CHECK_OUT', 'EARLY_CHECK_OUT', 'MISSED_CHECK_OUT', 'NO_SHOW', 'LATE_CANCEL', 'ADVANCE_CANCEL', 'GEOFENCE_BREACH', 'OFFLINE_DURING_SESSION');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "attendance_day_status" AS ENUM ('PRESENT', 'LATE', 'PARTIAL', 'ABSENT', 'LEAVE', 'OFF');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- ─── New tables ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "booking_status_log" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "booking_id" UUID NOT NULL,
    "from_status" VARCHAR(50),
    "to_status" VARCHAR(50) NOT NULL,
    "changed_by" UUID,
    "actor_role" VARCHAR(20),
    "reason" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "booking_status_log_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "nanny_attendance_events" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "nanny_id" UUID NOT NULL,
    "booking_id" UUID,
    "type" "attendance_event_type" NOT NULL,
    "attendance_date" DATE NOT NULL,
    "scheduled_start" TIMESTAMPTZ(6),
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "minutes_delta" INTEGER,
    "distance_meters" INTEGER,
    "score_weight" DECIMAL(4,2) NOT NULL DEFAULT 0,
    "is_session_outcome" BOOLEAN NOT NULL DEFAULT false,
    "source" VARCHAR(20) NOT NULL DEFAULT 'system',
    "notes" TEXT,
    "dedupe_key" VARCHAR(120),
    "waived_at" TIMESTAMPTZ(6),
    "waived_by" UUID,
    "waiver_reason" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "nanny_attendance_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "nanny_attendance_days" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "nanny_id" UUID NOT NULL,
    "attendance_date" DATE NOT NULL,
    "status" "attendance_day_status" NOT NULL,
    "sessions_scheduled" INTEGER NOT NULL DEFAULT 0,
    "sessions_attended" INTEGER NOT NULL DEFAULT 0,
    "sessions_late" INTEGER NOT NULL DEFAULT 0,
    "sessions_missed" INTEGER NOT NULL DEFAULT 0,
    "sessions_cancelled_by_nanny" INTEGER NOT NULL DEFAULT 0,
    "minutes_late" INTEGER NOT NULL DEFAULT 0,
    "minutes_worked" INTEGER NOT NULL DEFAULT 0,
    "override_status" "attendance_day_status",
    "override_reason" TEXT,
    "overridden_by" UUID,
    "overridden_at" TIMESTAMPTZ(6),
    "computed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "nanny_attendance_days_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "call_sessions" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "booking_id" UUID NOT NULL,
    "caller_id" UUID NOT NULL,
    "callee_id" UUID NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'RINGING',
    "started_at" TIMESTAMPTZ(6),
    "ended_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "call_sessions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "nanny_onboarding_details" (
    "user_id" UUID NOT NULL,
    "age" INTEGER,
    "gender" VARCHAR(30),
    "permanent_address" TEXT,
    "city" VARCHAR(100),
    "education_qualification" VARCHAR(50),
    "education_qualification_other" VARCHAR(255),
    "stream_subjects" TEXT,
    "shadow_teacher_experience" VARCHAR(20),
    "age_groups_worked" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "children_types_supported" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "children_types_other" VARCHAR(255),
    "academic_subjects" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "hobbies_interests" TEXT,
    "hobbies_activities_for_child" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "previous_salary" TEXT,
    "available_start_date" DATE,
    "training_agreement" BOOLEAN,
    "placement_fee_agreement" BOOLEAN,
    "police_verification_consent" BOOLEAN,
    "declaration_confirmed" BOOLEAN DEFAULT false,
    "declaration_confirmed_at" TIMESTAMPTZ(6),
    "onboarding_completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "nanny_onboarding_details_pkey" PRIMARY KEY ("user_id")
);

CREATE TABLE IF NOT EXISTS "addresses" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "user_id" UUID NOT NULL,
    "label" VARCHAR(50) NOT NULL DEFAULT 'Home',
    "address" TEXT NOT NULL,
    "lat" DECIMAL(10,8) NOT NULL,
    "lng" DECIMAL(11,8) NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "addresses_pkey" PRIMARY KEY ("id")
);

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

CREATE TABLE IF NOT EXISTS "price_snapshots" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "booking_id" UUID NOT NULL,
    "payment_plan_id" UUID,
    "payment_id" UUID,
    "cycle_number" INTEGER NOT NULL,
    "base_hourly_rate_used" DECIMAL(10,2) NOT NULL,
    "discount_percent_used" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "hours_billed" DECIMAL(8,2) NOT NULL,
    "custom_price_applied" BOOLEAN NOT NULL DEFAULT false,
    "subtotal_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "gst_percent_used" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "gst_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "final_amount" DECIMAL(12,2) NOT NULL,
    "calculation_breakdown" JSONB NOT NULL,
    "razorpay_payment_id" VARCHAR(255),
    "status" VARCHAR(50) NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "price_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "recurring_service_requests" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "parent_id" UUID NOT NULL,
    "nanny_id" UUID,
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
    "days_per_week" INTEGER,
    "max_hourly_rate" DECIMAL(10,2),
    "cancellation_reason" TEXT,
    "cancelled_at" TIMESTAMPTZ(6),
    "sessions_entitled_at_cancellation" INTEGER,
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recurring_service_requests_pkey" PRIMARY KEY ("id")
);

-- ─── Column drift on existing tables ─────────────────────────────────────────

ALTER TABLE "assignments" ADD COLUMN IF NOT EXISTS "booking_id" UUID;
ALTER TABLE "assignments" ALTER COLUMN "request_id" DROP NOT NULL;

ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "custom_final_price" DECIMAL(12,2);
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "custom_hourly_rate" DECIMAL(10,2);
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "days_per_week" INTEGER;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "hours_per_day" DECIMAL(4,2);
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "plan_duration_months" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "price_lock_mode" VARCHAR(50) NOT NULL DEFAULT 'locked';
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "pricing_mode" VARCHAR(50) NOT NULL DEFAULT 'standard';
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "recurring_request_id" UUID;

ALTER TABLE "children" ADD COLUMN IF NOT EXISTS "deleted_at" TIMESTAMPTZ(6);
ALTER TABLE "children" ADD COLUMN IF NOT EXISTS "metadata" JSONB;

ALTER TABLE "nanny_details" ADD COLUMN IF NOT EXISTS "attendance_score" DECIMAL(5,2);
ALTER TABLE "nanny_details" ADD COLUMN IF NOT EXISTS "attendance_sessions" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "nanny_details" ADD COLUMN IF NOT EXISTS "attendance_updated_at" TIMESTAMPTZ(6);
ALTER TABLE "nanny_details" ADD COLUMN IF NOT EXISTS "last_seen_at" TIMESTAMPTZ(6);

ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "released_at" TIMESTAMPTZ(6);
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "released_by" UUID;

ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "location_address" TEXT;

ALTER TABLE "service_requests" DROP COLUMN IF EXISTS "discount_percentage";
ALTER TABLE "service_requests" ADD COLUMN IF NOT EXISTS "days_per_week" INTEGER;

ALTER TABLE "support_tickets" ADD COLUMN IF NOT EXISTS "assigned_admin_id" UUID;
ALTER TABLE "support_tickets" ADD COLUMN IF NOT EXISTS "csat_comment" TEXT;
ALTER TABLE "support_tickets" ADD COLUMN IF NOT EXISTS "csat_rating" INTEGER;
ALTER TABLE "support_tickets" ADD COLUMN IF NOT EXISTS "first_response_at" TIMESTAMPTZ(6);

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "deleted_at" TIMESTAMPTZ(6);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "deletion_notice_sent_at" TIMESTAMPTZ(6);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "push_platform" VARCHAR(10);

-- `services` loses its inline rate to the append-only `rate_cards` table and
-- gains the slug the API addresses it by. The NOT NULL slug is safe on a fresh
-- replay (no rows yet) and skipped entirely where the column already exists.
ALTER TABLE "services" DROP COLUMN IF EXISTS "hourly_rate";
ALTER TABLE "services" DROP COLUMN IF EXISTS "updated_at";
ALTER TABLE "services" ADD COLUMN IF NOT EXISTS "slug" VARCHAR(100) NOT NULL;

-- ─── payment_installments: re-shaped around price_snapshots ──────────────────

ALTER TABLE "payment_installments" DROP CONSTRAINT IF EXISTS "payment_installments_subscription_plan_id_fkey";
DROP INDEX IF EXISTS "payment_installments_subscription_plan_id_idx";
ALTER TABLE "payment_installments" DROP COLUMN IF EXISTS "amount_due";
ALTER TABLE "payment_installments" DROP COLUMN IF EXISTS "subscription_plan_id";
ALTER TABLE "payment_installments" ADD COLUMN IF NOT EXISTS "amount" DECIMAL(12,2) NOT NULL;
ALTER TABLE "payment_installments" ADD COLUMN IF NOT EXISTS "cycle_number" INTEGER NOT NULL;
ALTER TABLE "payment_installments" ADD COLUMN IF NOT EXISTS "gst_amount" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "payment_installments" ADD COLUMN IF NOT EXISTS "kind" VARCHAR(20) NOT NULL DEFAULT 'cycle';
ALTER TABLE "payment_installments" ADD COLUMN IF NOT EXISTS "last_reminded_at" TIMESTAMPTZ(6);
ALTER TABLE "payment_installments" ADD COLUMN IF NOT EXISTS "paid_at" TIMESTAMPTZ(6);
ALTER TABLE "payment_installments" ADD COLUMN IF NOT EXISTS "payment_plan_id" UUID;
ALTER TABLE "payment_installments" ADD COLUMN IF NOT EXISTS "price_snapshot_id" UUID NOT NULL;
ALTER TABLE "payment_installments" ADD COLUMN IF NOT EXISTS "reminder_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "payment_installments" ADD COLUMN IF NOT EXISTS "subtotal_amount" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "payment_installments" ADD COLUMN IF NOT EXISTS "total_installments" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "payment_installments" ALTER COLUMN "due_date" DROP NOT NULL;
ALTER TABLE "payment_installments" ALTER COLUMN "status" SET DATA TYPE VARCHAR(20);
ALTER TABLE "payment_installments" ALTER COLUMN "created_at" SET NOT NULL;
ALTER TABLE "payment_installments" ALTER COLUMN "updated_at" SET NOT NULL;

-- ─── Indexes ─────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS "booking_status_log_booking_id_idx" ON "booking_status_log"("booking_id");
CREATE INDEX IF NOT EXISTS "booking_status_log_created_at_idx" ON "booking_status_log"("created_at");
CREATE UNIQUE INDEX IF NOT EXISTS "nanny_attendance_events_dedupe_key_key" ON "nanny_attendance_events"("dedupe_key");
CREATE INDEX IF NOT EXISTS "nanny_attendance_events_nanny_id_attendance_date_idx" ON "nanny_attendance_events"("nanny_id", "attendance_date");
CREATE INDEX IF NOT EXISTS "nanny_attendance_events_nanny_id_occurred_at_idx" ON "nanny_attendance_events"("nanny_id", "occurred_at");
CREATE INDEX IF NOT EXISTS "nanny_attendance_events_booking_id_idx" ON "nanny_attendance_events"("booking_id");
CREATE INDEX IF NOT EXISTS "nanny_attendance_days_attendance_date_status_idx" ON "nanny_attendance_days"("attendance_date", "status");
CREATE UNIQUE INDEX IF NOT EXISTS "nanny_attendance_days_nanny_id_attendance_date_key" ON "nanny_attendance_days"("nanny_id", "attendance_date");
CREATE INDEX IF NOT EXISTS "call_sessions_booking_id_idx" ON "call_sessions"("booking_id");
CREATE INDEX IF NOT EXISTS "addresses_user_id_idx" ON "addresses"("user_id");
CREATE INDEX IF NOT EXISTS "rate_cards_service_id_effective_from_idx" ON "rate_cards"("service_id", "effective_from");
CREATE UNIQUE INDEX IF NOT EXISTS "payment_plans_booking_id_key" ON "payment_plans"("booking_id");
CREATE INDEX IF NOT EXISTS "payment_plans_status_next_due_date_idx" ON "payment_plans"("status", "next_due_date");
CREATE INDEX IF NOT EXISTS "price_snapshots_booking_id_idx" ON "price_snapshots"("booking_id");
CREATE INDEX IF NOT EXISTS "price_snapshots_payment_plan_id_idx" ON "price_snapshots"("payment_plan_id");
CREATE INDEX IF NOT EXISTS "price_snapshots_status_idx" ON "price_snapshots"("status");
CREATE INDEX IF NOT EXISTS "recurring_service_requests_nanny_id_idx" ON "recurring_service_requests"("nanny_id");
CREATE INDEX IF NOT EXISTS "assignments_booking_id_status_idx" ON "assignments"("booking_id", "status");
CREATE UNIQUE INDEX IF NOT EXISTS "assignments_booking_id_nanny_id_key" ON "assignments"("booking_id", "nanny_id");
CREATE INDEX IF NOT EXISTS "payment_installments_status_due_date_idx" ON "payment_installments"("status", "due_date");
CREATE INDEX IF NOT EXISTS "payment_installments_payment_id_idx" ON "payment_installments"("payment_id");
CREATE INDEX IF NOT EXISTS "payment_installments_kind_booking_id_idx" ON "payment_installments"("kind", "booking_id");
CREATE UNIQUE INDEX IF NOT EXISTS "payment_installments_price_snapshot_id_installment_no_key" ON "payment_installments"("price_snapshot_id", "installment_no");
CREATE INDEX IF NOT EXISTS "payments_status_released_at_idx" ON "payments"("status", "released_at");
CREATE UNIQUE INDEX IF NOT EXISTS "services_slug_key" ON "services"("slug");
CREATE INDEX IF NOT EXISTS "support_tickets_assigned_admin_id_idx" ON "support_tickets"("assigned_admin_id");

-- ─── Foreign keys ────────────────────────────────────────────────────────────

DO $$ BEGIN
 ALTER TABLE "bookings" ADD CONSTRAINT "bookings_recurring_request_id_fkey" FOREIGN KEY ("recurring_request_id") REFERENCES "recurring_service_requests"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "booking_status_log" ADD CONSTRAINT "booking_status_log_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "nanny_attendance_events" ADD CONSTRAINT "nanny_attendance_events_nanny_id_fkey" FOREIGN KEY ("nanny_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "nanny_attendance_events" ADD CONSTRAINT "nanny_attendance_events_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "nanny_attendance_events" ADD CONSTRAINT "nanny_attendance_events_waived_by_fkey" FOREIGN KEY ("waived_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "nanny_attendance_days" ADD CONSTRAINT "nanny_attendance_days_nanny_id_fkey" FOREIGN KEY ("nanny_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "nanny_attendance_days" ADD CONSTRAINT "nanny_attendance_days_overridden_by_fkey" FOREIGN KEY ("overridden_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "call_sessions" ADD CONSTRAINT "call_sessions_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "nanny_onboarding_details" ADD CONSTRAINT "nanny_onboarding_details_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "assignments" ADD CONSTRAINT "assignments_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "payments" ADD CONSTRAINT "payments_released_by_fkey" FOREIGN KEY ("released_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "addresses" ADD CONSTRAINT "addresses_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

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
 ALTER TABLE "payment_installments" ADD CONSTRAINT "payment_installments_price_snapshot_id_fkey" FOREIGN KEY ("price_snapshot_id") REFERENCES "price_snapshots"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "payment_installments" ADD CONSTRAINT "payment_installments_payment_plan_id_fkey" FOREIGN KEY ("payment_plan_id") REFERENCES "payment_plans"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "recurring_service_requests" ADD CONSTRAINT "recurring_service_requests_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "recurring_service_requests" ADD CONSTRAINT "recurring_service_requests_nanny_id_fkey" FOREIGN KEY ("nanny_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
