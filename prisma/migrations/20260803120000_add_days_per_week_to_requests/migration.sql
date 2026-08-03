-- Days a week a schedule runs. Recurring plans were priced without this factor,
-- so a monthly plan cost the same whether the parent picked one weekday or five.
ALTER TABLE "service_requests" ADD COLUMN IF NOT EXISTS "days_per_week" INTEGER;
ALTER TABLE "recurring_service_requests" ADD COLUMN IF NOT EXISTS "days_per_week" INTEGER;

-- Backfill from the weekday list the parent actually picked. `jsonb_array_length`
-- would throw on a `specific_dates` pattern with no `days` key, hence the guard.
UPDATE "recurring_service_requests"
SET "days_per_week" = LEAST(7, GREATEST(1, jsonb_array_length("recurrence_pattern"->'days')))
WHERE "days_per_week" IS NULL
  AND jsonb_typeof("recurrence_pattern"->'days') = 'array'
  AND jsonb_array_length("recurrence_pattern"->'days') > 0;

-- Older rows only recorded sessions_per_month; recover the weekly figure from it.
UPDATE "recurring_service_requests"
SET "days_per_week" = LEAST(7, GREATEST(1, ROUND("sessions_per_month" / 4.0)))
WHERE "days_per_week" IS NULL AND "sessions_per_month" IS NOT NULL;

UPDATE "service_requests"
SET "days_per_week" = LEAST(7, GREATEST(1, ROUND("sessions_per_month" / 4.0)))
WHERE "days_per_week" IS NULL AND "sessions_per_month" IS NOT NULL;

-- One-time requests are a single session by definition.
UPDATE "service_requests"
SET "days_per_week" = 1
WHERE "days_per_week" IS NULL AND ("plan_type" IS NULL OR "plan_type" = 'ONE_TIME');
