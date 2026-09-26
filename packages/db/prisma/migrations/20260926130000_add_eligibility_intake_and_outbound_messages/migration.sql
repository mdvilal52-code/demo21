-- Automatic Steps 5-8 chaining: (1) the customer-claimed driver details Step 5
-- needs, collected over chat, and (2) a record of what the concierge itself
-- sent back. See docs/PHASE-16.md.

-- CreateTable
CREATE TABLE "eligibility_intakes" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "dateOfBirthEnc" TEXT,
    "nationality" TEXT,
    "licenseType" TEXT,
    "hasValidLicense" BOOLEAN,
    "passportProvided" BOOLEAN,
    "askedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "eligibility_intakes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbound_messages" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbound_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "eligibility_intakes_conversationId_key" ON "eligibility_intakes"("conversationId");

-- CreateIndex
CREATE INDEX "eligibility_intakes_tenantId_idx" ON "eligibility_intakes"("tenantId");

-- CreateIndex
CREATE INDEX "outbound_messages_conversationId_createdAt_idx" ON "outbound_messages"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "outbound_messages_tenantId_idx" ON "outbound_messages"("tenantId");

-- AddForeignKey
ALTER TABLE "eligibility_intakes" ADD CONSTRAINT "eligibility_intakes_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eligibility_intakes" ADD CONSTRAINT "eligibility_intakes_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Row Level Security — same tenant_isolation shape every other tenant-scoped
-- table has (see `..._add_security_engine`).
ALTER TABLE "eligibility_intakes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "eligibility_intakes" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "eligibility_intakes"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "outbound_messages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "outbound_messages" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "outbound_messages"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

-- Least-privilege grants: the API role reads/writes both (no DELETE — a
-- customer's intake and the record of what they were told are never removed
-- by application code). The worker does not touch either.
GRANT SELECT, INSERT, UPDATE ON "eligibility_intakes", "outbound_messages" TO ai_concierge_api;
