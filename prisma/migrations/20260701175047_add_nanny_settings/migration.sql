ALTER TABLE "nanny_details"
  ADD COLUMN IF NOT EXISTS "auto_accept_bookings" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "default_start_time" VARCHAR(5),
  ADD COLUMN IF NOT EXISTS "default_end_time" VARCHAR(5);
