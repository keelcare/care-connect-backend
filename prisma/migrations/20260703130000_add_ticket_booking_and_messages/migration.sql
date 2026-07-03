-- Booking-linked support tickets + per-ticket conversation thread.
-- Written to match DDL already applied to the dev database this session; kept
-- idempotent so `migrate deploy` is safe against environments with prior drift.

-- 1. Link a support ticket to an (optional) booking.
ALTER TABLE "support_tickets" ADD COLUMN IF NOT EXISTS "booking_id" uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'support_tickets_booking_id_fkey'
  ) THEN
    ALTER TABLE "support_tickets"
      ADD CONSTRAINT "support_tickets_booking_id_fkey"
      FOREIGN KEY ("booking_id") REFERENCES "bookings"("id")
      ON DELETE SET NULL ON UPDATE NO ACTION;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "support_tickets_booking_id_idx" ON "support_tickets"("booking_id");

-- 2. Per-ticket conversation between the raiser and admin.
CREATE TABLE IF NOT EXISTS "support_ticket_messages" (
  "id"         uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "ticket_id"  uuid NOT NULL,
  "sender_id"  uuid,
  "is_admin"   boolean NOT NULL DEFAULT false,
  "content"    text NOT NULL,
  "created_at" timestamptz DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'support_ticket_messages_ticket_id_fkey'
  ) THEN
    ALTER TABLE "support_ticket_messages"
      ADD CONSTRAINT "support_ticket_messages_ticket_id_fkey"
      FOREIGN KEY ("ticket_id") REFERENCES "support_tickets"("id")
      ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'support_ticket_messages_sender_id_fkey'
  ) THEN
    ALTER TABLE "support_ticket_messages"
      ADD CONSTRAINT "support_ticket_messages_sender_id_fkey"
      FOREIGN KEY ("sender_id") REFERENCES "users"("id")
      ON DELETE SET NULL ON UPDATE NO ACTION;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "support_ticket_messages_ticket_id_idx" ON "support_ticket_messages"("ticket_id");
