-- CreateEnum
CREATE TYPE "report_input_type" AS ENUM ('TEXT', 'RATING', 'YES_NO', 'MULTI_CHOICE');

-- CreateEnum
CREATE TYPE "report_status" AS ENUM ('PENDING', 'SUBMITTED', 'OVERDUE');

-- AlterTable
ALTER TABLE "identity_documents" ADD COLUMN     "supabase_storage_path" VARCHAR(500);

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "nanny_id" UUID;

-- AlterTable
ALTER TABLE "profiles" ADD COLUMN     "onboarding_completed" BOOLEAN DEFAULT false;

-- AlterTable
ALTER TABLE "reviews" ADD COLUMN     "reviewer_role" VARCHAR(50);

-- AlterTable
ALTER TABLE "service_requests" ADD COLUMN     "max_hourly_rate" DECIMAL(10,2),
ADD COLUMN     "sessions_per_month" INTEGER;

-- AlterTable
ALTER TABLE "verification_attempts" ADD COLUMN     "supabase_storage_path" VARCHAR(500);

-- CreateTable
CREATE TABLE "admin_audit_log" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "admin_id" UUID NOT NULL,
    "action" VARCHAR(100) NOT NULL,
    "target_type" VARCHAR(50) NOT NULL,
    "target_id" UUID,
    "metadata" JSONB,
    "ip_address" VARCHAR(45),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_consents" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "user_id" UUID NOT NULL,
    "purpose" VARCHAR(100) NOT NULL,
    "version" VARCHAR(20) NOT NULL,
    "consented_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip_address" VARCHAR(45),

    CONSTRAINT "user_consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "progress_reports" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "booking_id" UUID NOT NULL,
    "nanny_id" UUID NOT NULL,
    "child_id" UUID,
    "template_id" UUID NOT NULL,
    "status" "report_status" NOT NULL DEFAULT 'PENDING',
    "personal_remark" TEXT,
    "due_at" TIMESTAMPTZ(6) NOT NULL,
    "submitted_at" TIMESTAMPTZ(6),
    "escalated" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "progress_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_answers" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "report_id" UUID NOT NULL,
    "question_id" UUID NOT NULL,
    "answer_text" TEXT,
    "answer_rating" INTEGER,
    "answer_choices" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "report_answers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_template_questions" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "template_id" UUID NOT NULL,
    "question_text" TEXT NOT NULL,
    "input_type" "report_input_type" NOT NULL,
    "options" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "is_required" BOOLEAN NOT NULL DEFAULT true,
    "display_order" INTEGER NOT NULL,

    CONSTRAINT "report_template_questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_templates" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "version" SERIAL NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "admin_audit_log_admin_id_idx" ON "admin_audit_log"("admin_id");

-- CreateIndex
CREATE INDEX "admin_audit_log_created_at_idx" ON "admin_audit_log"("created_at");

-- CreateIndex
CREATE INDEX "admin_audit_log_action_idx" ON "admin_audit_log"("action");

-- CreateIndex
CREATE INDEX "user_consents_user_id_idx" ON "user_consents"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "progress_reports_booking_id_key" ON "progress_reports"("booking_id");

-- CreateIndex
CREATE INDEX "progress_reports_booking_id_idx" ON "progress_reports"("booking_id");

-- CreateIndex
CREATE INDEX "progress_reports_nanny_id_idx" ON "progress_reports"("nanny_id");

-- CreateIndex
CREATE INDEX "report_answers_report_id_idx" ON "report_answers"("report_id");

-- CreateIndex
CREATE INDEX "report_template_questions_template_id_idx" ON "report_template_questions"("template_id");

-- CreateIndex
CREATE UNIQUE INDEX "report_templates_version_key" ON "report_templates"("version");

-- CreateIndex
CREATE INDEX "assignments_request_id_status_idx" ON "assignments"("request_id", "status");

-- CreateIndex
CREATE INDEX "bookings_parent_id_status_idx" ON "bookings"("parent_id", "status");

-- CreateIndex
CREATE INDEX "bookings_nanny_id_status_idx" ON "bookings"("nanny_id", "status");

-- CreateIndex
CREATE INDEX "bookings_start_time_status_idx" ON "bookings"("start_time", "status");

-- CreateIndex
CREATE INDEX "notifications_user_id_is_read_idx" ON "notifications"("user_id", "is_read");

-- CreateIndex
CREATE INDEX "reviews_reviewee_id_idx" ON "reviews"("reviewee_id");

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_nanny_id_fkey" FOREIGN KEY ("nanny_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "admin_audit_log" ADD CONSTRAINT "admin_audit_log_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "user_consents" ADD CONSTRAINT "user_consents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "progress_reports" ADD CONSTRAINT "progress_reports_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "progress_reports" ADD CONSTRAINT "progress_reports_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "report_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_answers" ADD CONSTRAINT "report_answers_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "progress_reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_template_questions" ADD CONSTRAINT "report_template_questions_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "report_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
