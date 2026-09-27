-- Email retry/resend: a send that the channel could not deliver was, until
-- now, silently dropped (nothing persisted, nothing to retry). Every
-- existing row was only ever created on a successful send, so `status`
-- defaults to 'SENT' for them; a new failed attempt is persisted with
-- 'FAILED' so it becomes visible to staff and eligible for the automatic
-- resend sweep.
ALTER TABLE "outbound_messages" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'SENT';
ALTER TABLE "outbound_messages" ADD COLUMN "deliveryError" TEXT;
ALTER TABLE "outbound_messages" ADD COLUMN "retryCount" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "outbound_messages_status_idx" ON "outbound_messages"("status");
