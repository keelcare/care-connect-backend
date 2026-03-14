-- CreateTable
CREATE TABLE "payment_audit_log" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "payment_id" UUID NOT NULL,
    "order_id" VARCHAR(255) NOT NULL,
    "from_status" VARCHAR(50),
    "to_status" VARCHAR(50) NOT NULL,
    "triggered_by" VARCHAR(100) NOT NULL,
    "razorpay_payment_id" VARCHAR(255),
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "payment_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payment_audit_log_order_id_idx" ON "payment_audit_log"("order_id");
CREATE INDEX "payment_audit_log_payment_id_idx" ON "payment_audit_log"("payment_id");

-- AddForeignKey
ALTER TABLE "payment_audit_log"
ADD CONSTRAINT "payment_audit_log_payment_id_fkey"
FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
