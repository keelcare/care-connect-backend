-- Support ticket ops fields: ownership (assigned_admin_id), SLA first-response
-- timer (first_response_at), and post-resolution CSAT (csat_rating/csat_comment).
ALTER TABLE "support_tickets" ADD COLUMN "assigned_admin_id" UUID;
ALTER TABLE "support_tickets" ADD COLUMN "first_response_at" TIMESTAMPTZ(6);
ALTER TABLE "support_tickets" ADD COLUMN "csat_rating" INTEGER;
ALTER TABLE "support_tickets" ADD COLUMN "csat_comment" TEXT;

CREATE INDEX "support_tickets_assigned_admin_id_idx" ON "support_tickets"("assigned_admin_id");
