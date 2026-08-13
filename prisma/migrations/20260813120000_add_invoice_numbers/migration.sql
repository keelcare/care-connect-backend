-- Invoices are numbered from a dedicated sequence rather than derived from the
-- installment id: a document a family quotes back at us (and that has to stand up
-- to a tax audit) needs a short, ordered, human-readable reference, which a hash
-- of a uuid is not.
--
-- The number is allocated lazily, on the first download, so the (many) installments
-- nobody ever asks an invoice for never burn one. The sequence is global rather
-- than per-year — the year in the rendered number is presentation only, and
-- restarting the counter annually would break the unique index.
CREATE SEQUENCE IF NOT EXISTS invoice_number_seq START 1;

ALTER TABLE "payment_installments"
  ADD COLUMN IF NOT EXISTS "invoice_number" VARCHAR(32),
  ADD COLUMN IF NOT EXISTS "invoice_issued_at" TIMESTAMPTZ;

-- Two concurrent first-downloads of the same installment must not mint two
-- numbers; the conditional UPDATE in InvoiceNumberService plus this index is what
-- makes the loser of that race fall back to the winner's number.
CREATE UNIQUE INDEX IF NOT EXISTS "payment_installments_invoice_number_key"
  ON "payment_installments" ("invoice_number");
