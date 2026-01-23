/*
  Warnings:

  - A unique constraint covering the columns `[order_id]` on the table `payments` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[payment_id]` on the table `payments` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[transaction_id]` on the table `payments` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `order_id` to the `payments` table without a default value. This is not possible if the table is not empty.
  - Made the column `booking_id` on table `payments` required. This step will fail if there are existing NULL values in that column.

*/
-- DropForeignKey
ALTER TABLE "payments" DROP CONSTRAINT "payments_booking_id_fkey";

-- AlterTable
ALTER TABLE "bookings" ADD COLUMN     "cancellation_fee" DECIMAL(10,2),
ADD COLUMN     "cancellation_fee_status" VARCHAR(50),
ADD COLUMN     "cancellation_reason" TEXT,
ADD COLUMN     "care_location_lat" DECIMAL(10,8),
ADD COLUMN     "care_location_lng" DECIMAL(11,8),
ADD COLUMN     "geofence_radius" INTEGER DEFAULT 100,
ADD COLUMN     "is_review_prompted" BOOLEAN DEFAULT false,
ADD COLUMN     "recurring_booking_id" UUID;

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "currency" VARCHAR(10) NOT NULL DEFAULT 'inr',
ADD COLUMN     "error_code" TEXT,
ADD COLUMN     "error_description" TEXT,
ADD COLUMN     "order_id" VARCHAR(255) NOT NULL,
ADD COLUMN     "payment_id" VARCHAR(255),
ADD COLUMN     "provider" TEXT NOT NULL DEFAULT 'razorpay',
ADD COLUMN     "refund_id" TEXT,
ADD COLUMN     "signature" TEXT,
ADD COLUMN     "updated_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
ALTER COLUMN "booking_id" SET NOT NULL,
ALTER COLUMN "amount" SET DATA TYPE DECIMAL(12,2);

-- AlterTable
ALTER TABLE "reviews" ADD COLUMN     "is_approved" BOOLEAN DEFAULT true,
ADD COLUMN     "moderation_status" VARCHAR(50) DEFAULT 'approved';

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "ban_reason" TEXT,
ADD COLUMN     "identity_verification_status" VARCHAR(50) DEFAULT 'unverified',
ADD COLUMN     "is_active" BOOLEAN DEFAULT true,
ADD COLUMN     "refresh_token_hash" VARCHAR(255),
ADD COLUMN     "verification_rejection_reason" TEXT;

-- CreateTable
CREATE TABLE "disputes" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "booking_id" UUID NOT NULL,
    "raised_by" UUID NOT NULL,
    "reason" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "status" VARCHAR(50) NOT NULL DEFAULT 'open',
    "resolution" TEXT,
    "resolved_by" UUID,
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "disputes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_settings" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "key" VARCHAR(255) NOT NULL,
    "value" JSONB NOT NULL,
    "updated_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "system_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "favorite_nannies" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "parent_id" UUID NOT NULL,
    "nanny_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "favorite_nannies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "location_updates" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "booking_id" UUID NOT NULL,
    "nanny_id" UUID NOT NULL,
    "lat" DECIMAL(10,8) NOT NULL,
    "lng" DECIMAL(11,8) NOT NULL,
    "timestamp" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "location_updates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "matching_feedback" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "request_id" UUID NOT NULL,
    "nanny_id" UUID NOT NULL,
    "was_successful" BOOLEAN NOT NULL,
    "feedback_data" JSONB,
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "matching_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recurring_bookings" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "parent_id" UUID NOT NULL,
    "nanny_id" UUID NOT NULL,
    "recurrence_pattern" VARCHAR(100) NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE,
    "start_time" VARCHAR(10) NOT NULL,
    "duration_hours" DECIMAL(4,2) NOT NULL,
    "num_children" INTEGER NOT NULL,
    "children_ages" JSONB,
    "special_requirements" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recurring_bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "availability_blocks" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "nanny_id" UUID NOT NULL,
    "start_time" TIMESTAMPTZ(6) NOT NULL,
    "end_time" TIMESTAMPTZ(6) NOT NULL,
    "is_recurring" BOOLEAN NOT NULL DEFAULT false,
    "recurrence_pattern" VARCHAR(100),
    "reason" TEXT,
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "availability_blocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity_documents" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "user_id" UUID NOT NULL,
    "type" VARCHAR(50) NOT NULL,
    "id_number" VARCHAR(50) NOT NULL,
    "file_path" TEXT NOT NULL,
    "uploaded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "identity_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification_attempts" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "user_id" UUID NOT NULL,
    "type" VARCHAR(50) NOT NULL,
    "id_number" VARCHAR(50) NOT NULL,
    "file_path" TEXT NOT NULL,
    "uploaded_at" TIMESTAMPTZ(6) NOT NULL,
    "archived_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" VARCHAR(50),
    "rejection_reason" TEXT,

    CONSTRAINT "verification_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "system_settings_key_key" ON "system_settings"("key");

-- CreateIndex
CREATE UNIQUE INDEX "favorite_nannies_parent_id_nanny_id_key" ON "favorite_nannies"("parent_id", "nanny_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_order_id_key" ON "payments"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_payment_id_key" ON "payments"("payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_transaction_id_key" ON "payments"("transaction_id");

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_recurring_booking_id_fkey" FOREIGN KEY ("recurring_booking_id") REFERENCES "recurring_bookings"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_raised_by_fkey" FOREIGN KEY ("raised_by") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_resolved_by_fkey" FOREIGN KEY ("resolved_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "favorite_nannies" ADD CONSTRAINT "favorite_nannies_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "favorite_nannies" ADD CONSTRAINT "favorite_nannies_nanny_id_fkey" FOREIGN KEY ("nanny_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "location_updates" ADD CONSTRAINT "location_updates_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "location_updates" ADD CONSTRAINT "location_updates_nanny_id_fkey" FOREIGN KEY ("nanny_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "matching_feedback" ADD CONSTRAINT "matching_feedback_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "service_requests"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "matching_feedback" ADD CONSTRAINT "matching_feedback_nanny_id_fkey" FOREIGN KEY ("nanny_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "recurring_bookings" ADD CONSTRAINT "recurring_bookings_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "recurring_bookings" ADD CONSTRAINT "recurring_bookings_nanny_id_fkey" FOREIGN KEY ("nanny_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "availability_blocks" ADD CONSTRAINT "availability_blocks_nanny_id_fkey" FOREIGN KEY ("nanny_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "identity_documents" ADD CONSTRAINT "identity_documents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "verification_attempts" ADD CONSTRAINT "verification_attempts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
