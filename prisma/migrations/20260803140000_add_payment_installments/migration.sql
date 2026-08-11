-- Split payments: one row per amount actually sent to the gateway. A cycle is
-- normally an advance half charged at checkout plus a balance half due a fixed
-- number of days after the advance is paid.

CREATE TABLE IF NOT EXISTS "payment_installments" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "booking_id" UUID NOT NULL,
    "price_snapshot_id" UUID NOT NULL,
    "payment_plan_id" UUID,
    "cycle_number" INTEGER NOT NULL,
    "installment_no" INTEGER NOT NULL,
    "total_installments" INTEGER NOT NULL DEFAULT 1,
    "amount" DECIMAL(12,2) NOT NULL,
    "subtotal_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "gst_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "due_date" TIMESTAMPTZ(6),
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "payment_id" UUID,
    "paid_at" TIMESTAMPTZ(6),
    "last_reminded_at" TIMESTAMPTZ(6),
    "reminder_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_installments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "payment_installments_price_snapshot_id_installment_no_key"
    ON "payment_installments"("price_snapshot_id", "installment_no");
CREATE INDEX IF NOT EXISTS "payment_installments_booking_id_idx" ON "payment_installments"("booking_id");
CREATE INDEX IF NOT EXISTS "payment_installments_status_due_date_idx" ON "payment_installments"("status", "due_date");
CREATE INDEX IF NOT EXISTS "payment_installments_payment_id_idx" ON "payment_installments"("payment_id");

-- Guarded: `payment_installments_booking_id_fkey` and `..._payment_id_fkey`
-- already exist from 20260405071912, which created this table for the
-- superseded subscription_plans model. Bare ADD CONSTRAINTs here made the
-- migration unreplayable on any database that had that table.
DO $$ BEGIN
 ALTER TABLE "payment_installments" ADD CONSTRAINT "payment_installments_booking_id_fkey"
    FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "payment_installments" ADD CONSTRAINT "payment_installments_price_snapshot_id_fkey"
    FOREIGN KEY ("price_snapshot_id") REFERENCES "price_snapshots"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "payment_installments" ADD CONSTRAINT "payment_installments_payment_plan_id_fkey"
    FOREIGN KEY ("payment_plan_id") REFERENCES "payment_plans"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "payment_installments" ADD CONSTRAINT "payment_installments_payment_id_fkey"
    FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- ── Backfill ────────────────────────────────────────────────────────────────
-- Every existing snapshot becomes a single 1-of-1 installment so that "every
-- snapshot has at least one installment" holds from the moment this lands, and
-- no read path ever meets a snapshot with none. In-flight cycles are deliberately
-- NOT retro-split: splitting starts at the next snapshot taken.
INSERT INTO "payment_installments" (
    "booking_id", "price_snapshot_id", "payment_plan_id", "cycle_number",
    "installment_no", "total_installments",
    "amount", "subtotal_amount", "gst_amount",
    "due_date", "status", "payment_id", "paid_at"
)
SELECT
    s."booking_id",
    s."id",
    s."payment_plan_id",
    s."cycle_number",
    1,
    1,
    s."final_amount",
    s."subtotal_amount",
    s."gst_amount",
    s."created_at",
    -- A 'failed' snapshot is a charge attempt that did not land; the money is
    -- still owed, so it backfills as pending and stays retryable.
    CASE WHEN s."status" = 'charged' THEN 'paid' ELSE 'pending' END,
    s."payment_id",
    CASE WHEN s."status" = 'charged' THEN COALESCE(p."created_at", s."created_at") ELSE NULL END
FROM "price_snapshots" s
LEFT JOIN "payments" p ON p."id" = s."payment_id"
ON CONFLICT ("price_snapshot_id", "installment_no") DO NOTHING;
