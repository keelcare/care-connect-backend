-- Call sessions: one row per WebRTC call attempt between a booking's parent and nanny
CREATE TABLE "call_sessions" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "booking_id" UUID NOT NULL,
    "caller_id" UUID NOT NULL,
    "callee_id" UUID NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'RINGING',
    "started_at" TIMESTAMPTZ(6),
    "ended_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "call_sessions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "call_sessions_booking_id_idx" ON "call_sessions"("booking_id");

ALTER TABLE "call_sessions" ADD CONSTRAINT "call_sessions_booking_id_fkey"
    FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- Route push delivery per platform: 'ios' = raw APNs token, 'android' = FCM registration token
ALTER TABLE "users" ADD COLUMN "push_platform" VARCHAR(10);
