-- An invoice covers a billing group, not a single capture.
--
-- Issuing one invoice per captured instalment was right about immutability and
-- wrong about what a family bought. A booking with a matching fee and a session
-- fee got two documents — ₹249 and ₹543 — and neither showed the ₹792 actually
-- paid, which is the exact complaint the per-instalment scheme was retired for
-- in the first place. The fee is carved *out of* cycle 1 rather than charged on
-- top of it, so it belongs on cycle 1's invoice.
--
-- The unit is now (booking, cycle), with cycle 0's matching fee folded into
-- cycle 1, and the invoice is issued once every instalment in that group is
-- captured. A group's membership is fixed before any of it can be paid, so the
-- document is still frozen at issue and can never grow.

-- Tax invoices issued under the per-capture rule. This feature has not shipped,
-- so nobody holds one of these; the group rule will reissue them correctly on
-- the next capture or on the nightly reconciliation sweep. Legacy rows are left
-- untouched — those numbers are on documents families really do hold.
DELETE FROM "invoices" WHERE "kind" = 'tax_invoice';

-- Legacy rows are display-only: they exist so an already-quoted number still
-- resolves. Clearing the group columns keeps them out of the new uniqueness
-- rule, which matters because one booking can legitimately have two of them
-- (an advance and a balance each numbered under the old scheme).
UPDATE "invoices"
SET "cycle_number" = NULL, "price_snapshot_id" = NULL
WHERE "kind" = 'legacy';

-- `installment_id` no longer identifies an invoice — a group has several — so it
-- keeps only its provenance role and loses the unique index that made it the
-- idempotency key.
DROP INDEX IF EXISTS "invoices_installment_id_key";
CREATE INDEX IF NOT EXISTS "invoices_installment_id_idx" ON "invoices" ("installment_id");

-- The replacement guarantee: one invoice per booking per cycle per kind.
CREATE UNIQUE INDEX IF NOT EXISTS "invoices_booking_id_cycle_number_kind_key"
  ON "invoices" ("booking_id", "cycle_number", "kind");
