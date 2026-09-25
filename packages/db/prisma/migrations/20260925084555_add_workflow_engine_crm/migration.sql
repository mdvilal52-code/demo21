-- CreateEnum
CREATE TYPE "JourneyState" AS ENUM ('ENQUIRY_RECEIVED', 'EXTRACTING_REQUIREMENTS', 'VEHICLE_SELECTION', 'COLLECTING_MISSING_INFO', 'ELIGIBILITY_CHECK', 'AVAILABILITY_CHECK', 'OFFERING_ALTERNATIVES', 'QUOTE_ISSUED', 'DOCUMENTS_REQUESTED', 'DOCUMENTS_VERIFYING', 'PAYMENT_INSTRUCTED', 'CRM_UPDATED', 'AWAITING_HUMAN_APPROVAL', 'CONFIRMED', 'DELIVERY_SCHEDULED', 'ON_RENTAL', 'RETURN_SCHEDULED', 'RETURNED', 'FINAL_INVOICE_ISSUED', 'FOLLOW_UP_SENT', 'CLOSED', 'ESCALATED', 'CANCELLED', 'DECLINED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "JourneyActor" AS ENUM ('AI', 'SYSTEM', 'HUMAN');

-- CreateEnum
CREATE TYPE "EscalationTier" AS ENUM ('T2', 'T3', 'T4');

-- CreateEnum
CREATE TYPE "EscalationReason" AS ENUM ('ELIGIBILITY_NEEDS_REVIEW', 'AVAILABILITY_PROVIDER_FAILURE', 'QUOTE_NEEDS_REVIEW', 'DOCUMENT_REJECTED_REPEATEDLY', 'PAYMENT_EXCEPTION', 'DAMAGE_OR_DISPUTE', 'CUSTOMER_COMPLAINT', 'MISSING_INFO_STALLED', 'AI_UNABLE_TO_PROCEED');

-- CreateEnum
CREATE TYPE "EscalationStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "EscalationResolution" AS ENUM ('APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "CustomerTimelineEventType" AS ENUM ('JOURNEY_STARTED', 'VEHICLE_RESOLVED', 'QUOTE_ISSUED', 'ESCALATED', 'ESCALATION_RESOLVED');

-- CreateTable
CREATE TABLE "journeys" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "state" "JourneyState" NOT NULL DEFAULT 'ENQUIRY_RECEIVED',
    "context" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "journeys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journey_transitions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "journeyId" TEXT NOT NULL,
    "fromState" "JourneyState",
    "toState" "JourneyState" NOT NULL,
    "actor" "JourneyActor" NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "journey_transitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "escalation_cases" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "journeyId" TEXT NOT NULL,
    "tier" "EscalationTier" NOT NULL,
    "reason" "EscalationReason" NOT NULL,
    "status" "EscalationStatus" NOT NULL DEFAULT 'OPEN',
    "detail" TEXT NOT NULL,
    "assignedToUserId" TEXT,
    "slaDueAt" TIMESTAMP(3) NOT NULL,
    "slaBreached" BOOLEAN NOT NULL DEFAULT false,
    "resolution" "EscalationResolution",
    "resolutionNote" TEXT,
    "resolvedByUserId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "escalation_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "channel" "Channel" NOT NULL,
    "customerRef" TEXT NOT NULL,
    "displayName" TEXT,
    "lastVehicleId" TEXT,
    "lastQuoteId" TEXT,
    "bookingCount" INTEGER NOT NULL DEFAULT 0,
    "lastJourneyId" TEXT,
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_timeline_events" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "journeyId" TEXT,
    "type" "CustomerTimelineEventType" NOT NULL,
    "summary" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_timeline_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "journeys_conversationId_key" ON "journeys"("conversationId");

-- CreateIndex
CREATE INDEX "journeys_tenantId_idx" ON "journeys"("tenantId");

-- CreateIndex
CREATE INDEX "journeys_tenantId_state_idx" ON "journeys"("tenantId", "state");

-- CreateIndex
CREATE INDEX "journey_transitions_tenantId_idx" ON "journey_transitions"("tenantId");

-- CreateIndex
CREATE INDEX "journey_transitions_journeyId_idx" ON "journey_transitions"("journeyId");

-- CreateIndex
CREATE INDEX "escalation_cases_tenantId_idx" ON "escalation_cases"("tenantId");

-- CreateIndex
CREATE INDEX "escalation_cases_tenantId_status_idx" ON "escalation_cases"("tenantId", "status");

-- CreateIndex
CREATE INDEX "escalation_cases_journeyId_idx" ON "escalation_cases"("journeyId");

-- CreateIndex
CREATE INDEX "customers_tenantId_idx" ON "customers"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "customers_tenantId_channel_customerRef_key" ON "customers"("tenantId", "channel", "customerRef");

-- CreateIndex
CREATE INDEX "customer_timeline_events_tenantId_idx" ON "customer_timeline_events"("tenantId");

-- CreateIndex
CREATE INDEX "customer_timeline_events_customerId_idx" ON "customer_timeline_events"("customerId");

-- AddForeignKey
ALTER TABLE "journeys" ADD CONSTRAINT "journeys_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journeys" ADD CONSTRAINT "journeys_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journey_transitions" ADD CONSTRAINT "journey_transitions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journey_transitions" ADD CONSTRAINT "journey_transitions_journeyId_fkey" FOREIGN KEY ("journeyId") REFERENCES "journeys"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "escalation_cases" ADD CONSTRAINT "escalation_cases_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "escalation_cases" ADD CONSTRAINT "escalation_cases_journeyId_fkey" FOREIGN KEY ("journeyId") REFERENCES "journeys"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "escalation_cases" ADD CONSTRAINT "escalation_cases_assignedToUserId_fkey" FOREIGN KEY ("assignedToUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_timeline_events" ADD CONSTRAINT "customer_timeline_events_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_timeline_events" ADD CONSTRAINT "customer_timeline_events_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_timeline_events" ADD CONSTRAINT "customer_timeline_events_journeyId_fkey" FOREIGN KEY ("journeyId") REFERENCES "journeys"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================================
-- Retroactive fix: `eligibility_policies`, `eligibility_exceptions`,
-- `eligibility_decisions`, `vehicle_units`, `availability_holds`,
-- `availability_checks`, `alternative_recommendations` and `quotes` were all
-- created (Steps 5-8) *before* migration `..._add_security_engine` added
-- Row Level Security + the least-privilege DB roles, so none of them ever
-- got a tenant_isolation policy, and — because `ALTER DEFAULT PRIVILEGES`
-- only applies to tables created *after* it ran — `ai_concierge_api` was
-- never GRANTed access to them either. Found auditing this migration's own
-- new tables against that one; every other tenant-scoped table already has
-- both. Fixed here rather than left for a future phase to rediscover.
-- ============================================================================

ALTER TABLE "eligibility_policies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "eligibility_policies" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "eligibility_policies"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "eligibility_exceptions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "eligibility_exceptions" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "eligibility_exceptions"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "eligibility_decisions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "eligibility_decisions" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "eligibility_decisions"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "vehicle_units" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "vehicle_units" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "vehicle_units"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "availability_holds" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "availability_holds" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "availability_holds"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "availability_checks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "availability_checks" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "availability_checks"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "alternative_recommendations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "alternative_recommendations" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "alternative_recommendations"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "quotes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "quotes" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "quotes"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT, UPDATE ON
  "eligibility_policies", "eligibility_exceptions", "eligibility_decisions",
  "vehicle_units", "availability_holds", "availability_checks",
  "alternative_recommendations", "quotes"
TO ai_concierge_api;

-- ============================================================================
-- This migration's own new tables — RLS + least-privilege grants, same
-- pattern as every table added since `..._add_security_engine`. `messages`-
-- style parent-lookup isn't needed anywhere here: every new table carries
-- its own direct tenantId column.
-- ============================================================================

ALTER TABLE "journeys" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "journeys" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "journeys"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "journey_transitions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "journey_transitions" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "journey_transitions"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "escalation_cases" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "escalation_cases" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "escalation_cases"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "customers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customers" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "customers"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "customer_timeline_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customer_timeline_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "customer_timeline_events"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

-- New tables created by the migrator role after `..._add_security_engine`'s
-- ALTER DEFAULT PRIVILEGES are already auto-granted to ai_concierge_api;
-- this GRANT is redundant but explicit (defensive — never rely solely on a
-- default-privileges rule for something a cross-tenant/least-privilege test
-- actually asserts on, see rowLevelSecurity.security.test.ts).
GRANT SELECT, INSERT, UPDATE ON
  "journeys", "journey_transitions", "escalation_cases", "customers",
  "customer_timeline_events"
TO ai_concierge_api;

-- Worker: the SLA sweep (apps/worker/src/jobs/escalationSlaSweep.ts) reads
-- open cases and flips slaBreached/status — the same narrow, explicit,
-- never-auto-granted worker posture `..._add_security_engine` established.
GRANT SELECT, UPDATE ON "escalation_cases" TO ai_concierge_worker;
GRANT SELECT ON "journeys", "tenants" TO ai_concierge_worker;
