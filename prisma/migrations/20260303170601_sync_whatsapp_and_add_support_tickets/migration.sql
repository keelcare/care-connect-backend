/*
  Warnings:

  - A unique constraint covering the columns `[request_id]` on the table `bookings` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "WhatsAppConversationStatus" AS ENUM ('ACTIVE', 'COMPLETED');

-- CreateEnum
CREATE TYPE "WhatsAppConversationStep" AS ENUM ('WELCOME', 'COLLECT_NAME', 'COLLECT_PHONE', 'COLLECT_EMAIL', 'COLLECT_CATEGORY', 'COLLECT_ENQUIRY', 'COMPLETED');

-- CreateEnum
CREATE TYPE "WhatsAppEnquiryStatus" AS ENUM ('NEW', 'CONTACTED', 'CLOSED');

-- CreateEnum
CREATE TYPE "WhatsAppMessageDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateTable
CREATE TABLE "support_tickets" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "ticket_number" VARCHAR(50) NOT NULL,
    "user_id" UUID NOT NULL,
    "role" VARCHAR(50) NOT NULL,
    "subject" VARCHAR(255) NOT NULL,
    "description" TEXT NOT NULL,
    "category" VARCHAR(50) NOT NULL,
    "priority" VARCHAR(20) NOT NULL DEFAULT 'medium',
    "status" VARCHAR(50) NOT NULL DEFAULT 'open',
    "admin_notes" TEXT,
    "resolved_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_conversations" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "phone_number" VARCHAR(20) NOT NULL,
    "name" VARCHAR(255),
    "current_step" "WhatsAppConversationStep" NOT NULL DEFAULT 'WELCOME',
    "status" "WhatsAppConversationStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "whatsapp_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_enquiries" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "name" VARCHAR(255) NOT NULL,
    "phone_number" VARCHAR(20) NOT NULL,
    "email" VARCHAR(255),
    "category" VARCHAR(100) NOT NULL,
    "message" TEXT NOT NULL,
    "status" "WhatsAppEnquiryStatus" NOT NULL DEFAULT 'NEW',
    "assigned_to" UUID,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "whatsapp_enquiries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_messages" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "phone_number" VARCHAR(20) NOT NULL,
    "direction" "WhatsAppMessageDirection" NOT NULL,
    "message_body" TEXT NOT NULL,
    "message_id" VARCHAR(255),
    "raw_payload" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "whatsapp_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "support_tickets_ticket_number_key" ON "support_tickets"("ticket_number");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_conversations_phone_number_key" ON "whatsapp_conversations"("phone_number");

-- CreateIndex
CREATE INDEX "whatsapp_conversations_phone_number_idx" ON "whatsapp_conversations"("phone_number");

-- CreateIndex
CREATE INDEX "whatsapp_enquiries_phone_number_idx" ON "whatsapp_enquiries"("phone_number");

-- CreateIndex
CREATE INDEX "whatsapp_enquiries_status_idx" ON "whatsapp_enquiries"("status");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_messages_message_id_key" ON "whatsapp_messages"("message_id");

-- CreateIndex
CREATE INDEX "whatsapp_messages_phone_number_idx" ON "whatsapp_messages"("phone_number");

-- CreateIndex
CREATE UNIQUE INDEX "bookings_request_id_key" ON "bookings"("request_id");

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "whatsapp_enquiries" ADD CONSTRAINT "whatsapp_enquiries_assigned_to_fkey" FOREIGN KEY ("assigned_to") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
