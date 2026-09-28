-- AlterTable: car photos sent with a reply (OutboundAttachment[] JSON, null = none).
-- Additive and nullable — no backfill needed, covered by the table's existing grants.
ALTER TABLE "outbound_messages" ADD COLUMN "attachments" JSONB;
