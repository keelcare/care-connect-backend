-- AlterTable
ALTER TABLE "nanny_details" ADD COLUMN     "categories" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "nanny_category_requests" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "nanny_id" UUID NOT NULL,
    "requested_categories" TEXT[],
    "status" VARCHAR(50) NOT NULL DEFAULT 'pending',
    "admin_notes" TEXT,
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "nanny_category_requests_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "nanny_category_requests" ADD CONSTRAINT "nanny_category_requests_nanny_id_fkey" FOREIGN KEY ("nanny_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
