-- The booking, not the instalment, is the invoice unit.
--
-- Numbering per instalment produced two documents for one engagement — a
-- matching fee and a session fee — which is not how a family thinks about what
-- they paid, and not what the app should offer them. One number now covers the
-- whole booking, and every fee on it is a line item.
--
-- The instalment columns are left in place: numbers already issued from them are
-- quoted on real bank transfers, and `InvoiceNumberService` adopts an existing
-- instalment number as the booking's number so nobody's reference changes.
ALTER TABLE "bookings"
  ADD COLUMN IF NOT EXISTS "invoice_number" VARCHAR(32),
  ADD COLUMN IF NOT EXISTS "invoice_issued_at" TIMESTAMPTZ;

-- Same role as the instalment index: it is what makes the loser of a concurrent
-- first-download race fall back to the winner's number instead of minting a second.
CREATE UNIQUE INDEX IF NOT EXISTS "bookings_invoice_number_key"
  ON "bookings" ("invoice_number");
