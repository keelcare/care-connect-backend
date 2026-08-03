-- Plan-level staffing: the caregiver is assigned to the recurring plan itself,
-- not re-derived from whichever child bookings happened to exist at assign time.
ALTER TABLE "recurring_service_requests" ADD COLUMN "nanny_id" UUID;

ALTER TABLE "recurring_service_requests"
  ADD CONSTRAINT "recurring_service_requests_nanny_id_fkey"
  FOREIGN KEY ("nanny_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

CREATE INDEX "recurring_service_requests_nanny_id_idx" ON "recurring_service_requests"("nanny_id");

-- Backfill from existing staffed plans so already-assigned plans keep their
-- caregiver. Picks the nanny serving the most non-cancelled sessions; ties break
-- on the earliest session, which is the original assignee.
UPDATE "recurring_service_requests" r
SET "nanny_id" = pick."nanny_id"
FROM (
  SELECT DISTINCT ON (b."recurring_request_id")
         b."recurring_request_id",
         b."nanny_id",
         COUNT(*)              AS session_count,
         MIN(b."start_time")   AS first_session
  FROM "bookings" b
  WHERE b."recurring_request_id" IS NOT NULL
    AND b."nanny_id" IS NOT NULL
    AND b."status" <> 'CANCELLED'
  GROUP BY b."recurring_request_id", b."nanny_id"
  ORDER BY b."recurring_request_id", session_count DESC, first_session ASC
) pick
WHERE r."id" = pick."recurring_request_id";
