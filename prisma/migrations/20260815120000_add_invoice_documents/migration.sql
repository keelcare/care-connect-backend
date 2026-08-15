-- Persist the documents instead of re-deriving them.
--
-- Invoices were rendered live from whatever `payment_installments` rows existed
-- at read time, under a number stamped on the booking. For a single-month
-- booking that is stable. For a plan it is not: every cycle of a plan hangs off
-- one anchor booking and cycles open monthly, so `KL-2026-0001` showed one total
-- in September and a larger one in November — and shrank again when cancellation
-- voided a row. A family could hold two different PDFs both claiming to be the
-- same invoice.
--
-- The fix is to issue a tax invoice at *capture* and freeze it. Nothing is ever
-- invoiced that has not been paid, so no later event can invalidate a document;
-- credit notes become the exception (refunds, corrections) rather than routine.

-- ─── Numbering ───────────────────────────────────────────────────────────────
-- Replaces the single global `invoice_number_seq`. GST wants a serial that is
-- unique and consecutive within a financial year, credit notes need their own
-- series, and a counter incremented inside the issuing transaction does not burn
-- a number when that transaction rolls back.
CREATE TABLE IF NOT EXISTS "document_series" (
  "kind"           VARCHAR(24) NOT NULL,
  "financial_year" INTEGER     NOT NULL,
  "next_value"     INTEGER     NOT NULL DEFAULT 1,
  "updated_at"     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "document_series_pkey" PRIMARY KEY ("kind", "financial_year")
);

-- Seed the invoice series past everything the old sequence ever handed out, so
-- no number can be issued twice. Dynamic because a plain reference to a missing
-- sequence fails at parse time, not at execution — the guard would never run.
-- `last_value` only counts as consumed once `is_called` is set.
DO $$
DECLARE
  seq_next INTEGER := 1;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relkind = 'S' AND relname = 'invoice_number_seq') THEN
    EXECUTE 'SELECT CASE WHEN is_called THEN last_value + 1 ELSE last_value END FROM invoice_number_seq'
      INTO seq_next;
  END IF;

  INSERT INTO "document_series" ("kind", "financial_year", "next_value")
  VALUES (
    'invoice',
    EXTRACT(YEAR FROM (now() AT TIME ZONE 'Asia/Kolkata'))::int,
    GREATEST(COALESCE(seq_next, 1), 1)
  )
  ON CONFLICT ("kind", "financial_year") DO NOTHING;
END $$;

-- ─── Invoices ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "invoices" (
  "id"                UUID          NOT NULL DEFAULT uuid_generate_v4(),
  "number"            VARCHAR(32)   NOT NULL,
  "kind"              VARCHAR(24)   NOT NULL DEFAULT 'tax_invoice',
  "booking_id"        UUID          NOT NULL,
  "plan_id"           UUID,
  "parent_id"         UUID,
  "installment_id"    UUID,
  "price_snapshot_id" UUID,
  "cycle_number"      INTEGER,
  "period_from"       TIMESTAMPTZ,
  "period_to"         TIMESTAMPTZ,
  "subtotal_amount"   DECIMAL(12,2) NOT NULL DEFAULT 0,
  "gst_amount"        DECIMAL(12,2) NOT NULL DEFAULT 0,
  "total_amount"      DECIMAL(12,2) NOT NULL DEFAULT 0,
  "credited_amount"   DECIMAL(12,2) NOT NULL DEFAULT 0,
  "gst_registered"    BOOLEAN       NOT NULL DEFAULT false,
  "issued_at"         TIMESTAMPTZ   NOT NULL DEFAULT now(),
  "snapshot"          JSONB         NOT NULL,
  "created_at"        TIMESTAMPTZ   NOT NULL DEFAULT now(),
  "updated_at"        TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "invoices_number_key" ON "invoices" ("number");
-- The idempotency guarantee. A Razorpay webhook replaying after
-- `api:verify_payment` has already captured must not mint a second invoice.
CREATE UNIQUE INDEX IF NOT EXISTS "invoices_installment_id_key" ON "invoices" ("installment_id");
CREATE INDEX IF NOT EXISTS "invoices_parent_id_issued_at_idx" ON "invoices" ("parent_id", "issued_at");
CREATE INDEX IF NOT EXISTS "invoices_booking_id_idx" ON "invoices" ("booking_id");
CREATE INDEX IF NOT EXISTS "invoices_plan_id_idx" ON "invoices" ("plan_id");

ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_booking_id_fkey" FOREIGN KEY ("booking_id")
    REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  ADD CONSTRAINT "invoices_plan_id_fkey" FOREIGN KEY ("plan_id")
    REFERENCES "recurring_service_requests"("id") ON DELETE SET NULL ON UPDATE NO ACTION,
  ADD CONSTRAINT "invoices_installment_id_fkey" FOREIGN KEY ("installment_id")
    REFERENCES "payment_installments"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

CREATE TABLE IF NOT EXISTS "invoice_lines" (
  "id"               UUID          NOT NULL DEFAULT uuid_generate_v4(),
  "invoice_id"       UUID          NOT NULL,
  "seq"              INTEGER       NOT NULL,
  "name"             TEXT          NOT NULL,
  "description"      TEXT,
  "qty"              DECIMAL(10,2) NOT NULL DEFAULT 1,
  "unit_amount"      DECIMAL(12,2) NOT NULL DEFAULT 0,
  "subtotal_amount"  DECIMAL(12,2) NOT NULL DEFAULT 0,
  "gst_percent"      DECIMAL(5,2)  NOT NULL DEFAULT 0,
  "gst_amount"       DECIMAL(12,2) NOT NULL DEFAULT 0,
  "amount"           DECIMAL(12,2) NOT NULL DEFAULT 0,
  -- What the money on this line actually bought, in sessions. The number the
  -- whole plan-invoicing exercise exists to put in front of a parent.
  "sessions_covered" INTEGER,
  "sac_code"         VARCHAR(12),
  CONSTRAINT "invoice_lines_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "invoice_lines_invoice_id_fkey" FOREIGN KEY ("invoice_id")
    REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE NO ACTION
);
CREATE INDEX IF NOT EXISTS "invoice_lines_invoice_id_idx" ON "invoice_lines" ("invoice_id");

-- ─── Credit notes (GST s.34) ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "credit_notes" (
  "id"              UUID          NOT NULL DEFAULT uuid_generate_v4(),
  "number"          VARCHAR(32)   NOT NULL,
  "invoice_id"      UUID          NOT NULL,
  "booking_id"      UUID          NOT NULL,
  "parent_id"       UUID,
  "reason"          VARCHAR(32)   NOT NULL,
  "settlement"      VARCHAR(32)   NOT NULL DEFAULT 'refunded',
  "note"            TEXT,
  "subtotal_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "gst_amount"      DECIMAL(12,2) NOT NULL DEFAULT 0,
  "total_amount"    DECIMAL(12,2) NOT NULL DEFAULT 0,
  "refund_id"       VARCHAR(255),
  "issued_at"       TIMESTAMPTZ   NOT NULL DEFAULT now(),
  "snapshot"        JSONB         NOT NULL,
  "created_at"      TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT "credit_notes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "credit_notes_invoice_id_fkey" FOREIGN KEY ("invoice_id")
    REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "credit_notes_booking_id_fkey" FOREIGN KEY ("booking_id")
    REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE NO ACTION
);
CREATE UNIQUE INDEX IF NOT EXISTS "credit_notes_number_key" ON "credit_notes" ("number");
CREATE INDEX IF NOT EXISTS "credit_notes_invoice_id_idx" ON "credit_notes" ("invoice_id");
CREATE INDEX IF NOT EXISTS "credit_notes_parent_id_issued_at_idx" ON "credit_notes" ("parent_id", "issued_at");

CREATE TABLE IF NOT EXISTS "credit_note_lines" (
  "id"              UUID          NOT NULL DEFAULT uuid_generate_v4(),
  "credit_note_id"  UUID          NOT NULL,
  "seq"             INTEGER       NOT NULL,
  "name"            TEXT          NOT NULL,
  "description"     TEXT,
  "subtotal_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "gst_percent"     DECIMAL(5,2)  NOT NULL DEFAULT 0,
  "gst_amount"      DECIMAL(12,2) NOT NULL DEFAULT 0,
  "amount"          DECIMAL(12,2) NOT NULL DEFAULT 0,
  CONSTRAINT "credit_note_lines_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "credit_note_lines_credit_note_id_fkey" FOREIGN KEY ("credit_note_id")
    REFERENCES "credit_notes"("id") ON DELETE CASCADE ON UPDATE NO ACTION
);
CREATE INDEX IF NOT EXISTS "credit_note_lines_credit_note_id_idx" ON "credit_note_lines" ("credit_note_id");

-- ─── Plan settlements ────────────────────────────────────────────────────────
-- What a cancelled plan actually settled at. `sessions_entitled_at_cancellation`
-- already froze the headline number on the plan; this freezes the working behind
-- it and the dates of the sessions the parent keeps, which is what they ask for.
CREATE TABLE IF NOT EXISTS "plan_settlements" (
  "id"                    UUID          NOT NULL DEFAULT uuid_generate_v4(),
  "number"                VARCHAR(32)   NOT NULL,
  "plan_id"               UUID          NOT NULL,
  "parent_id"             UUID,
  "cancelled_at"          TIMESTAMPTZ   NOT NULL,
  "reason"                TEXT,
  "entitlement"           JSONB         NOT NULL,
  "sessions_entitled"     INTEGER       NOT NULL DEFAULT 0,
  "sessions_delivered"    INTEGER       NOT NULL DEFAULT 0,
  "sessions_retained"     INTEGER       NOT NULL DEFAULT 0,
  "retained_booking_ids"  UUID[]        NOT NULL DEFAULT ARRAY[]::UUID[],
  "amount_billed"         DECIMAL(12,2) NOT NULL DEFAULT 0,
  "amount_paid"           DECIMAL(12,2) NOT NULL DEFAULT 0,
  "amount_voided"         DECIMAL(12,2) NOT NULL DEFAULT 0,
  "amount_still_owed"     DECIMAL(12,2) NOT NULL DEFAULT 0,
  "matching_fee_retained" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "snapshot"              JSONB         NOT NULL,
  "created_at"            TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT "plan_settlements_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "plan_settlements_plan_id_fkey" FOREIGN KEY ("plan_id")
    REFERENCES "recurring_service_requests"("id") ON DELETE CASCADE ON UPDATE NO ACTION
);
CREATE UNIQUE INDEX IF NOT EXISTS "plan_settlements_number_key" ON "plan_settlements" ("number");
-- One settlement per plan: cancellation is idempotent, and a second row would be
-- a second answer to "what did I keep".
CREATE UNIQUE INDEX IF NOT EXISTS "plan_settlements_plan_id_key" ON "plan_settlements" ("plan_id");
CREATE INDEX IF NOT EXISTS "plan_settlements_parent_id_cancelled_at_idx"
  ON "plan_settlements" ("parent_id", "cancelled_at");

-- ─── Backfill ────────────────────────────────────────────────────────────────
-- Every number already minted under the old scheme becomes a `legacy` invoice
-- row, so a family quoting `KL-2026-0007` still resolves to something. The
-- snapshot is left empty: these documents were never frozen, so there is no
-- honest historical content to claim — the read path re-derives them from the
-- live booking exactly as it does today, and only new `tax_invoice` rows carry
-- the immutability guarantee.
INSERT INTO "invoices" (
  "number", "kind", "booking_id", "plan_id", "parent_id",
  "subtotal_amount", "gst_amount", "total_amount",
  "issued_at", "snapshot"
)
SELECT
  b."invoice_number",
  'legacy',
  b."id",
  b."recurring_request_id",
  b."parent_id",
  COALESCE(agg."subtotal", 0),
  COALESCE(agg."gst", 0),
  COALESCE(agg."total", 0),
  COALESCE(b."invoice_issued_at", now()),
  '{}'::jsonb
FROM "bookings" b
LEFT JOIN LATERAL (
  SELECT
    SUM(pi."subtotal_amount") AS "subtotal",
    SUM(pi."gst_amount")      AS "gst",
    SUM(pi."amount")          AS "total"
  FROM "payment_installments" pi
  WHERE pi."booking_id" = b."id" AND pi."status" IN ('pending', 'paid')
) agg ON TRUE
WHERE b."invoice_number" IS NOT NULL
ON CONFLICT ("number") DO NOTHING;

-- Numbers issued per-instalment before the booking became the invoice unit, and
-- not adopted by any booking. Rarer, but they are on real bank transfers.
INSERT INTO "invoices" (
  "number", "kind", "booking_id", "plan_id", "parent_id", "installment_id",
  "price_snapshot_id", "cycle_number",
  "subtotal_amount", "gst_amount", "total_amount",
  "issued_at", "snapshot"
)
SELECT
  pi."invoice_number",
  'legacy',
  pi."booking_id",
  b."recurring_request_id",
  b."parent_id",
  pi."id",
  pi."price_snapshot_id",
  pi."cycle_number",
  pi."subtotal_amount",
  pi."gst_amount",
  pi."amount",
  COALESCE(pi."invoice_issued_at", now()),
  '{}'::jsonb
FROM "payment_installments" pi
JOIN "bookings" b ON b."id" = pi."booking_id"
WHERE pi."invoice_number" IS NOT NULL
ON CONFLICT ("number") DO NOTHING;

-- Whatever the backfill inserted, the next issued number must clear it.
INSERT INTO "document_series" ("kind", "financial_year", "next_value")
SELECT
  'invoice',
  EXTRACT(YEAR FROM (now() AT TIME ZONE 'Asia/Kolkata'))::int,
  1
ON CONFLICT ("kind", "financial_year") DO NOTHING;

UPDATE "document_series" ds
SET "next_value" = GREATEST(ds."next_value", sub."high" + 1)
FROM (
  -- Trailing counter off the existing `PREFIX-YYYY-NNNN` shape. A number that
  -- does not match is ignored rather than guessed at.
  SELECT COALESCE(MAX(NULLIF(regexp_replace("number", '^.*-(\d+)$', '\1'), "number")::int), 0) AS "high"
  FROM "invoices"
  WHERE "number" ~ '^.+-\d{4}-\d+$'
) sub
WHERE ds."kind" = 'invoice';
