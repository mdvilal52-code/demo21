-- CreateEnum
CREATE TYPE "ConversationStage" AS ENUM ('NEW', 'AWAITING_BOOKING_CONFIRMATION', 'COLLECTING_VEHICLE', 'COLLECTING_DETAILS', 'COMPLETE');

-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "stage" "ConversationStage" NOT NULL DEFAULT 'NEW';

-- CreateIndex
CREATE INDEX "conversations_tenantId_channel_customerRef_idx" ON "conversations"("tenantId", "channel", "customerRef");
