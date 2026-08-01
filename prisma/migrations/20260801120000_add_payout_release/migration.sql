-- Payout settlement tracking. A `pending_release` payment with a null
-- `released_at` is an outstanding payout obligation to the caregiver.
ALTER TABLE "payments" ADD COLUMN "released_at" TIMESTAMPTZ(6);
ALTER TABLE "payments" ADD COLUMN "released_by" UUID;

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_released_by_fkey"
  FOREIGN KEY ("released_by") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE NO ACTION;

CREATE INDEX "payments_status_released_at_idx" ON "payments"("status", "released_at");
