-- AlterTable
ALTER TABLE "notifications" ADD COLUMN     "category" VARCHAR(50),
ADD COLUMN     "related_id" UUID;
