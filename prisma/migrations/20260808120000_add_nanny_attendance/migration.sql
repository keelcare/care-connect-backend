-- Caregiver attendance.
--
-- Attendance is measured per committed session, not per calendar day: a caregiver
-- is rostered onto a plan at a fixed address, so time spent "online" says nothing
-- about whether a child was cared for. The verifiable facts are the geofenced
-- check-in `startBooking` already enforces, the check-out, and the GPS trail in
-- between — `nanny_attendance_events` is the durable record of those, and
-- `nanny_attendance_days` the roll-up the partner calendar and admin roster read.
--
-- `score_weight` is frozen per row rather than resolved from policy at read time,
-- mirroring how `price_snapshots` freezes its GST rate: retuning the attendance
-- policy must not retroactively rewrite the record someone was judged on.

CREATE TYPE "attendance_event_type" AS ENUM (
  'CHECK_IN',
  'LATE_CHECK_IN',
  'CHECK_OUT',
  'EARLY_CHECK_OUT',
  'MISSED_CHECK_OUT',
  'NO_SHOW',
  'LATE_CANCEL',
  'ADVANCE_CANCEL',
  'GEOFENCE_BREACH',
  'OFFLINE_DURING_SESSION'
);

CREATE TYPE "attendance_day_status" AS ENUM (
  'PRESENT',
  'LATE',
  'PARTIAL',
  'ABSENT',
  'LEAVE',
  'OFF'
);

CREATE TABLE "nanny_attendance_events" (
  "id"                 UUID NOT NULL DEFAULT uuid_generate_v4(),
  "nanny_id"           UUID NOT NULL,
  "booking_id"         UUID,
  "type"               "attendance_event_type" NOT NULL,
  "attendance_date"    DATE NOT NULL,
  "scheduled_start"    TIMESTAMPTZ(6),
  "occurred_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "minutes_delta"      INTEGER,
  "distance_meters"    INTEGER,
  "score_weight"       DECIMAL(4,2) NOT NULL DEFAULT 0,
  "is_session_outcome" BOOLEAN NOT NULL DEFAULT false,
  "source"             VARCHAR(20) NOT NULL DEFAULT 'system',
  "notes"              TEXT,
  "dedupe_key"         VARCHAR(120),
  "waived_at"          TIMESTAMPTZ(6),
  "waived_by"          UUID,
  "waiver_reason"      TEXT,
  "metadata"           JSONB,
  "created_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT "nanny_attendance_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "nanny_attendance_events_nanny_id_fkey"
    FOREIGN KEY ("nanny_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "nanny_attendance_events_booking_id_fkey"
    FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "nanny_attendance_events_waived_by_fkey"
    FOREIGN KEY ("waived_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION
);

-- One `<booking_id>:<type>` per once-per-session event. NULLs do not collide in a
-- Postgres unique index, so the repeatable events (geofence breaches) simply leave
-- the key null and share the column — no partial index required.
CREATE UNIQUE INDEX "nanny_attendance_events_dedupe_key_key"
  ON "nanny_attendance_events"("dedupe_key");
CREATE INDEX "nanny_attendance_events_nanny_id_attendance_date_idx"
  ON "nanny_attendance_events"("nanny_id", "attendance_date");
CREATE INDEX "nanny_attendance_events_nanny_id_occurred_at_idx"
  ON "nanny_attendance_events"("nanny_id", "occurred_at");
CREATE INDEX "nanny_attendance_events_booking_id_idx"
  ON "nanny_attendance_events"("booking_id");

CREATE TABLE "nanny_attendance_days" (
  "id"                          UUID NOT NULL DEFAULT uuid_generate_v4(),
  "nanny_id"                    UUID NOT NULL,
  "attendance_date"             DATE NOT NULL,
  "status"                      "attendance_day_status" NOT NULL,
  "sessions_scheduled"          INTEGER NOT NULL DEFAULT 0,
  "sessions_attended"           INTEGER NOT NULL DEFAULT 0,
  "sessions_late"               INTEGER NOT NULL DEFAULT 0,
  "sessions_missed"             INTEGER NOT NULL DEFAULT 0,
  "sessions_cancelled_by_nanny" INTEGER NOT NULL DEFAULT 0,
  "minutes_late"                INTEGER NOT NULL DEFAULT 0,
  "minutes_worked"              INTEGER NOT NULL DEFAULT 0,
  "override_status"             "attendance_day_status",
  "override_reason"             TEXT,
  "overridden_by"               UUID,
  "overridden_at"               TIMESTAMPTZ(6),
  "computed_at"                 TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT "nanny_attendance_days_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "nanny_attendance_days_nanny_id_fkey"
    FOREIGN KEY ("nanny_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "nanny_attendance_days_overridden_by_fkey"
    FOREIGN KEY ("overridden_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX "nanny_attendance_days_nanny_id_attendance_date_key"
  ON "nanny_attendance_days"("nanny_id", "attendance_date");
CREATE INDEX "nanny_attendance_days_attendance_date_status_idx"
  ON "nanny_attendance_days"("attendance_date", "status");

-- Denormalised score on the profile, so matching and admin ranking read one
-- number instead of replaying the event log — the trade-off `acceptance_rate`
-- already makes. `last_seen_at` backs the presence heartbeat; presence only ever
-- counts against attendance while a session is actually under way.
ALTER TABLE "nanny_details"
  ADD COLUMN IF NOT EXISTS "attendance_score" DECIMAL(5,2),
  ADD COLUMN IF NOT EXISTS "attendance_sessions" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "attendance_updated_at" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "last_seen_at" TIMESTAMPTZ(6);

-- The geofence-breach detector scans a session's recent pings on every outside
-- position report. `location_updates` had no index at all, so that scan would be
-- a sequential read of the whole tracking history.
CREATE INDEX IF NOT EXISTS "location_updates_booking_id_timestamp_idx"
  ON "location_updates"("booking_id", "timestamp");
