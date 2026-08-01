-- 1. Seed the platform commission rate.
--
-- Both the caregiver earnings screen and the admin revenue ledger resolve the rate
-- from this row. With no row, `getCommissionConfig()` reports 0% / unconfigured and
-- caregivers are quoted a payout of 100% of their fee. 5 is the rate the business
-- operates on today; an admin can change it from the dashboard afterwards.
--
-- ON CONFLICT DO NOTHING: if an admin has already set a rate, that wins.
INSERT INTO "system_settings" ("key", "value")
VALUES ('platform_commission_percent', '{"percent": 5}'::jsonb)
ON CONFLICT ("key") DO NOTHING;

-- 2. Backfill the caregiver on completion-placeholder payouts.
--
-- `handleBookingCompleted` used to write these rows without `nanny_id`. Every
-- caregiver-facing earnings query filtered on that column, so those payouts accrued
-- to nobody while the admin payout list (which resolves the caregiver through the
-- booking) showed them as owed. The listener now sets it; this fixes history.
UPDATE "payments" p
SET "nanny_id" = b."nanny_id"
FROM "bookings" b
WHERE p."booking_id" = b."id"
  AND p."nanny_id" IS NULL
  AND b."nanny_id" IS NOT NULL;
