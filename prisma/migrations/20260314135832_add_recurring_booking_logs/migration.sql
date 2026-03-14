-- CreateTable
CREATE TABLE "recurring_booking_logs" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "recurring_booking_id" UUID NOT NULL,
    "booking_date" DATE NOT NULL,
    "status" VARCHAR(50) NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recurring_booking_logs_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "recurring_booking_logs" ADD CONSTRAINT "recurring_booking_logs_recurring_booking_id_fkey" FOREIGN KEY ("recurring_booking_id") REFERENCES "recurring_bookings"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
