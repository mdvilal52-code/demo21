-- Human worker replies: a staff member can answer an escalated customer from
-- the admin dashboard. The reply is stored as an outbound message with
-- source = 'HUMAN'; this column records which staff user wrote it.
ALTER TABLE "outbound_messages" ADD COLUMN "authorUserId" TEXT;
