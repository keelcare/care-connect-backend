-- Distinguishes the one-off matching fee from an ordinary share of a cycle's
-- price. Every existing row is a cycle share, which is exactly the default, so
-- this backfills without a data migration.
ALTER TABLE "payment_installments"
  ADD COLUMN IF NOT EXISTS "kind" VARCHAR(20) NOT NULL DEFAULT 'cycle';

-- Read paths look up "has this booking already been charged a matching fee?"
-- before carving another one out; without this that is a full scan of the table.
CREATE INDEX IF NOT EXISTS "payment_installments_kind_booking_id_idx"
  ON "payment_installments" ("kind", "booking_id");
