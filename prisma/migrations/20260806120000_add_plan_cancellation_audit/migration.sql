-- Cancellation audit for recurring plans.
--
-- Cancelling a plan used to void every future session outright. It now retains
-- the sessions the parent had already paid for, so the moment of cancellation
-- needs a record: why, when, and how many sessions were owed at that instant.
--
-- `sessions_entitled_at_cancellation` is frozen rather than derived because
-- entitlement reads current installment status — a refund issued afterwards
-- would otherwise retroactively shrink a number already promised to the parent.

ALTER TABLE "recurring_service_requests"
  ADD COLUMN IF NOT EXISTS "cancellation_reason" TEXT,
  ADD COLUMN IF NOT EXISTS "cancelled_at" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "sessions_entitled_at_cancellation" INTEGER;
