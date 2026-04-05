-- CreateEnum
CREATE TYPE "child_profile_type" AS ENUM ('STANDARD', 'SPECIAL_NEEDS');

-- CreateEnum
CREATE TYPE "gender" AS ENUM ('MALE', 'FEMALE', 'OTHER');

-- AlterTable
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "actual_end_time" TIMESTAMPTZ(6),
ADD COLUMN IF NOT EXISTS "actual_start_time" TIMESTAMPTZ(6),
ADD COLUMN IF NOT EXISTS "last_rescheduled_at" TIMESTAMPTZ(6),
ADD COLUMN IF NOT EXISTS "original_end_time" TIMESTAMPTZ(6),
ADD COLUMN IF NOT EXISTS "original_start_time" TIMESTAMPTZ(6),
ADD COLUMN IF NOT EXISTS "reschedule_count" INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "nanny_details" ADD COLUMN IF NOT EXISTS "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "service_requests" ADD COLUMN IF NOT EXISTS "category" VARCHAR(50);

-- CreateTable
CREATE TABLE IF NOT EXISTS "revoked_tokens" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "token" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "revoked_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "children" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "parent_id" UUID NOT NULL,
    "first_name" VARCHAR(100) NOT NULL,
    "last_name" VARCHAR(100) NOT NULL,
    "dob" DATE NOT NULL,
    "gender" "gender" NOT NULL,
    "profile_type" "child_profile_type" NOT NULL DEFAULT 'STANDARD',
    "allergies" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "dietary_notes" TEXT,
    "diagnosis" TEXT,
    "care_instructions" TEXT,
    "emergency_contact" JSONB,
    "school_details" JSONB,
    "learning_goals" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "children_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "booking_children" (
    "booking_id" UUID NOT NULL,
    "child_id" UUID NOT NULL,

    CONSTRAINT "booking_children_pkey" PRIMARY KEY ("booking_id","child_id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "services" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "name" VARCHAR(100) NOT NULL,
    "hourly_rate" DECIMAL(10,2) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "services_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "revoked_tokens_token_key" ON "revoked_tokens"("token");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "revoked_tokens_token_idx" ON "revoked_tokens"("token");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "revoked_tokens_expires_at_idx" ON "revoked_tokens"("expires_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "children_parent_id_idx" ON "children"("parent_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "services_name_key" ON "services"("name");

-- AddForeignKey
DO $$ BEGIN
 ALTER TABLE "children" ADD CONSTRAINT "children_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

-- AddForeignKey
DO $$ BEGIN
 ALTER TABLE "booking_children" ADD CONSTRAINT "booking_children_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

-- AddForeignKey
DO $$ BEGIN
 ALTER TABLE "booking_children" ADD CONSTRAINT "booking_children_child_id_fkey" FOREIGN KEY ("child_id") REFERENCES "children"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
