-- Make consent records provable, per-subject, and withdrawable (DPDPA 2023).
--
-- `user_consents` existed but held only "who consented to what, when". Two things
-- were missing to make it do the job the Act asks of it:
--
--  1. There was no way to *withdraw*. DPDPA s.6(4)-(6) requires withdrawal to be
--     as easy as giving consent, and requires processing to stop once withdrawn.
--     Withdrawal is recorded as a timestamp on the original grant rather than by
--     deleting the row, because the grant is the evidence that processing was
--     lawful while it lasted — deleting it would destroy the audit trail the
--     table exists to provide.
--
--  2. There was no way to say what a consent was *about*. A parent consenting
--     under s.9 consents to the processing of a specific child's data, and a
--     single account can hold several children. Without a subject, "this parent
--     consented to child data" cannot be tied to the child it covers, and
--     revoking for one child would be indistinguishable from revoking for all.
--
-- All three columns are nullable: every existing row is a still-valid grant with
-- no subject, which is exactly what NULL means here. No backfill required.

ALTER TABLE "user_consents"
  ADD COLUMN "withdrawn_at" TIMESTAMPTZ(6),
  ADD COLUMN "subject_type" VARCHAR(50),
  ADD COLUMN "subject_id"   UUID,
  ADD COLUMN "metadata"     JSONB;

-- Reading "is this consent currently in force?" filters user + purpose and
-- discards withdrawn rows; reading "what was consented for this child?" filters
-- by subject. Both are on the request path for child creation and the privacy
-- screen, so both get an index.
CREATE INDEX "user_consents_user_id_purpose_idx" ON "user_consents"("user_id", "purpose");
CREATE INDEX "user_consents_subject_id_idx"      ON "user_consents"("subject_id");
