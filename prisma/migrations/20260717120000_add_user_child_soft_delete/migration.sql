-- 30-day soft delete for accounts and child profiles.
-- users.deleted_at:  account is deactivated (is_active=false) with PII retained
--   but locked; the daily cleanup cron purges rows older than 30 days.
-- users.deletion_notice_sent_at:  guards the DPDP 48-hour pre-erasure notice so
--   a pending-deletion user is not notified repeatedly.
-- children.deleted_at:  child is hidden from all reads for 30 days (recoverable
--   from "Recently removed"), then hard-deleted by the cron.
-- All application reads filter deleted_at IS NULL.
ALTER TABLE "users" ADD COLUMN "deleted_at" TIMESTAMPTZ(6);
ALTER TABLE "users" ADD COLUMN "deletion_notice_sent_at" TIMESTAMPTZ(6);
ALTER TABLE "children" ADD COLUMN "deleted_at" TIMESTAMPTZ(6);
