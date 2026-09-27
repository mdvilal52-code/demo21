-- `subject`: recovers the real email subject on resend instead of a generic
-- fallback, which would otherwise break the customer's mail thread.
-- `claimedAt`: an atomic claim so the automatic resend sweep and a
-- staff-triggered resend can never both act on the same FAILED row at once.
ALTER TABLE "outbound_messages" ADD COLUMN "subject" TEXT;
ALTER TABLE "outbound_messages" ADD COLUMN "claimedAt" TIMESTAMP(3);
