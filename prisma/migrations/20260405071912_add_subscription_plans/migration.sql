/*
  Warnings:

  - You are about to drop the column `max_hourly_rate` on the `service_requests` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "service_requests" DROP COLUMN "max_hourly_rate",
ADD COLUMN     "discount_percentage" DECIMAL(5,2) DEFAULT 0,
ADD COLUMN     "plan_duration_months" INTEGER DEFAULT 1,
ADD COLUMN     "plan_type" VARCHAR(50);

-- CreateTable
CREATE TABLE "payment_installments" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "booking_id" UUID NOT NULL,
    "subscription_plan_id" UUID,
    "installment_no" INTEGER NOT NULL,
    "amount_due" DECIMAL(12,2) NOT NULL,
    "due_date" TIMESTAMPTZ(6) NOT NULL,
    "status" VARCHAR(50) NOT NULL DEFAULT 'pending',
    "payment_id" UUID,
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_installments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_plans" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "request_id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "parent_id" UUID NOT NULL,
    "status" VARCHAR(50) NOT NULL DEFAULT 'active',
    "total_months" INTEGER NOT NULL,
    "monthly_amount" DECIMAL(12,2) NOT NULL,
    "start_date" TIMESTAMPTZ(6) NOT NULL,
    "next_due_date" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscription_plans_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payment_installments_booking_id_idx" ON "payment_installments"("booking_id");

-- CreateIndex
CREATE INDEX "payment_installments_subscription_plan_id_idx" ON "payment_installments"("subscription_plan_id");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_plans_request_id_key" ON "subscription_plans"("request_id");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_plans_booking_id_key" ON "subscription_plans"("booking_id");

-- CreateIndex
CREATE INDEX "subscription_plans_parent_id_idx" ON "subscription_plans"("parent_id");

-- AddForeignKey
ALTER TABLE "payment_installments" ADD CONSTRAINT "payment_installments_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "payment_installments" ADD CONSTRAINT "payment_installments_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "payment_installments" ADD CONSTRAINT "payment_installments_subscription_plan_id_fkey" FOREIGN KEY ("subscription_plan_id") REFERENCES "subscription_plans"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "subscription_plans" ADD CONSTRAINT "subscription_plans_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "service_requests"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "subscription_plans" ADD CONSTRAINT "subscription_plans_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "subscription_plans" ADD CONSTRAINT "subscription_plans_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
