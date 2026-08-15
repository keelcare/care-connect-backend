-- Caregiver payouts: the outbound half of the money flow.
--
-- Until now "releasing a payout" only stamped `payments.released_at` and an admin
-- moved the money by hand, off-platform. Nothing recorded where it went, whether it
-- arrived, or what to do when it bounced. These three tables give a transfer a
-- destination, a life cycle, and a link back to the specific care that earned it.
--
-- Two partial unique indexes below carry almost all of the safety in this feature.
-- They are the reason a caregiver cannot be paid twice for the same session and
-- cannot be stranded without a payout destination. Read their comments before
-- changing anything here.

-- ─── Destination ─────────────────────────────────────────────────────────────
-- One row mirrors one RazorpayX fund account. Fund accounts are immutable there —
-- changing bank details means creating a new one — so this table is
-- append-and-archive rather than update-in-place. A payout settled six months ago
-- keeps pointing at exactly the account it was sent to.
--
-- No full account number. RazorpayX holds it against the fund account id and a
-- payout addresses the fund account, so storing it here would buy nothing and risk
-- everything. Last four plus IFSC is what the caregiver and support actually need.
CREATE TABLE IF NOT EXISTS "nanny_payout_accounts" (
  "id"                       UUID         NOT NULL DEFAULT uuid_generate_v4(),
  "nanny_id"                 UUID         NOT NULL,
  "account_type"             VARCHAR(20)  NOT NULL,
  "beneficiary_name"         VARCHAR(255) NOT NULL,
  "account_number_last4"     VARCHAR(4),
  "ifsc"                     VARCHAR(20),
  "vpa_address"              VARCHAR(255),
  "razorpay_contact_id"      VARCHAR(255),
  "razorpay_fund_account_id" VARCHAR(255),
  "status"                   VARCHAR(30)  NOT NULL DEFAULT 'pending_review',
  "rejection_reason"         TEXT,
  "reviewed_by"              UUID,
  "reviewed_at"              TIMESTAMPTZ(6),
  "created_at"               TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"               TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "nanny_payout_accounts_pkey" PRIMARY KEY ("id")
);

-- At most one `pending_review` AND one `active` row per caregiver — not one row
-- overall. The distinction matters: if submitting new bank details archived the
-- active account immediately, a rejected change would leave her with no way to be
-- paid until she resubmitted. This way the account she is currently paid into
-- survives until a replacement is actually approved.
CREATE UNIQUE INDEX IF NOT EXISTS "nanny_payout_accounts_one_per_status"
  ON "nanny_payout_accounts" ("nanny_id", "status")
  WHERE "status" IN ('pending_review', 'active');

CREATE INDEX IF NOT EXISTS "nanny_payout_accounts_nanny_id_status_idx"
  ON "nanny_payout_accounts" ("nanny_id", "status");
CREATE INDEX IF NOT EXISTS "nanny_payout_accounts_status_created_at_idx"
  ON "nanny_payout_accounts" ("status", "created_at");

-- ─── The transfer ────────────────────────────────────────────────────────────
-- Written before RazorpayX is called, so a request that dies mid-flight leaves a
-- row to reconcile instead of an untracked transfer. `idempotency_key` is generated
-- with the row and replayed on every retry: RazorpayX returns the original payout
-- rather than creating a second one.
CREATE TABLE IF NOT EXISTS "nanny_payouts" (
  "id"                       UUID           NOT NULL DEFAULT uuid_generate_v4(),
  "nanny_id"                 UUID           NOT NULL,
  "payout_account_id"        UUID,
  "amount"                   DECIMAL(12, 2) NOT NULL,
  "currency"                 VARCHAR(10)    NOT NULL DEFAULT 'INR',
  "status"                   VARCHAR(30)    NOT NULL DEFAULT 'created',
  "provider"                 VARCHAR(30)    NOT NULL DEFAULT 'razorpayx',
  "razorpay_payout_id"       VARCHAR(255),
  "razorpay_fund_account_id" VARCHAR(255),
  "idempotency_key"          VARCHAR(64)    NOT NULL,
  "reference_id"             VARCHAR(64),
  "mode"                     VARCHAR(10),
  "utr"                      VARCHAR(64),
  "fees"                     DECIMAL(12, 2),
  "tax"                      DECIMAL(12, 2),
  "failure_reason"           TEXT,
  "notes"                    TEXT,
  "initiated_by"             UUID,
  "processed_at"             TIMESTAMPTZ(6),
  "created_at"               TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"               TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "nanny_payouts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "nanny_payouts_razorpay_payout_id_key"
  ON "nanny_payouts" ("razorpay_payout_id");
CREATE UNIQUE INDEX IF NOT EXISTS "nanny_payouts_idempotency_key_key"
  ON "nanny_payouts" ("idempotency_key");
CREATE INDEX IF NOT EXISTS "nanny_payouts_nanny_id_status_idx"
  ON "nanny_payouts" ("nanny_id", "status");
CREATE INDEX IF NOT EXISTS "nanny_payouts_status_created_at_idx"
  ON "nanny_payouts" ("status", "created_at");

-- ─── What the transfer settles ───────────────────────────────────────────────
-- `amount` and `commission_percent` are frozen at release time, the same principle
-- `price_snapshots` applies to GST: changing the platform rate tomorrow must not
-- re-state a payout that already left the bank.
CREATE TABLE IF NOT EXISTS "nanny_payout_items" (
  "id"                 UUID           NOT NULL DEFAULT uuid_generate_v4(),
  "payout_id"          UUID           NOT NULL,
  "payment_id"         UUID           NOT NULL,
  "amount"             DECIMAL(12, 2) NOT NULL,
  "gross_amount"       DECIMAL(12, 2) NOT NULL,
  "commission_percent" DECIMAL(5, 2)  NOT NULL,
  "voided_at"          TIMESTAMPTZ(6),
  "created_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "nanny_payout_items_pkey" PRIMARY KEY ("id")
);

-- The no-double-pay guarantee, and the reason it is an index rather than a check in
-- application code: a payment can appear in many payout items over time, but in only
-- ONE that has not been voided. A failed or reversed payout stamps `voided_at`,
-- which keeps the audit trail intact while freeing the payment to be released again.
-- Two concurrent release requests for the same caregiver cannot both win — the
-- second hits this index and rolls back.
CREATE UNIQUE INDEX IF NOT EXISTS "nanny_payout_items_live_payment"
  ON "nanny_payout_items" ("payment_id")
  WHERE "voided_at" IS NULL;

CREATE INDEX IF NOT EXISTS "nanny_payout_items_payout_id_idx"
  ON "nanny_payout_items" ("payout_id");
CREATE INDEX IF NOT EXISTS "nanny_payout_items_payment_id_idx"
  ON "nanny_payout_items" ("payment_id");

-- ─── Foreign keys ────────────────────────────────────────────────────────────
-- The caregiver on a payout is NO ACTION rather than CASCADE: a settled transfer is
-- a financial record and must outlive an account deletion, which is a soft delete
-- here anyway.
ALTER TABLE "nanny_payout_accounts"
  ADD CONSTRAINT "nanny_payout_accounts_nanny_id_fkey"
  FOREIGN KEY ("nanny_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "nanny_payout_accounts"
  ADD CONSTRAINT "nanny_payout_accounts_reviewed_by_fkey"
  FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

ALTER TABLE "nanny_payouts"
  ADD CONSTRAINT "nanny_payouts_nanny_id_fkey"
  FOREIGN KEY ("nanny_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "nanny_payouts"
  ADD CONSTRAINT "nanny_payouts_payout_account_id_fkey"
  FOREIGN KEY ("payout_account_id") REFERENCES "nanny_payout_accounts"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
ALTER TABLE "nanny_payouts"
  ADD CONSTRAINT "nanny_payouts_initiated_by_fkey"
  FOREIGN KEY ("initiated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

ALTER TABLE "nanny_payout_items"
  ADD CONSTRAINT "nanny_payout_items_payout_id_fkey"
  FOREIGN KEY ("payout_id") REFERENCES "nanny_payouts"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "nanny_payout_items"
  ADD CONSTRAINT "nanny_payout_items_payment_id_fkey"
  FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
