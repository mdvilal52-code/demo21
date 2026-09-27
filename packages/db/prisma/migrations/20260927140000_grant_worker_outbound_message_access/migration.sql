-- The email resend sweep (apps/worker/src/jobs/emailResendSweep.ts) reads
-- FAILED email messages and updates their status/claim — the same narrow,
-- explicit, never-auto-granted worker posture `..._add_security_engine` and
-- `..._add_workflow_engine_crm` established for every other worker-touched
-- table. This grant was missed when the resend feature's own migrations
-- (`..._add_outbound_message_delivery_status`, `..._add_outbound_message_
-- subject_and_claim`) added the columns the sweep depends on.
GRANT SELECT, UPDATE ON "outbound_messages" TO ai_concierge_worker;
