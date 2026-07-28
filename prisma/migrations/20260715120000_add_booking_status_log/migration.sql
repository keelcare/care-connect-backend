-- Booking status history: one row per booking status transition, the per-booking
-- audit trail payments already have via payment_audit_log. One-off bookings kept
-- only the latest updated_at, so prior states were lost. Append-only.
CREATE TABLE "booking_status_log" (
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

CREATE INDEX "booking_status_log_booking_id_idx" ON "booking_status_log"("booking_id");

CREATE INDEX "booking_status_log_created_at_idx" ON "booking_status_log"("created_at");

ALTER TABLE "booking_status_log" ADD CONSTRAINT "booking_status_log_booking_id_fkey"
    FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
