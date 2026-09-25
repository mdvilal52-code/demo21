-- CreateEnum
CREATE TYPE "EligibilityDecisionStatus" AS ENUM ('ELIGIBLE', 'INELIGIBLE', 'NEEDS_HUMAN_REVIEW');

-- CreateEnum
CREATE TYPE "EligibilityExceptionType" AS ENUM ('VIP', 'NATIONALITY_OVERRIDE', 'AGE_OVERRIDE', 'MANUAL_GRANT');

-- CreateEnum
CREATE TYPE "EligibilityRiskLevel" AS ENUM ('LOW', 'HIGH');

-- CreateTable
CREATE TABLE "eligibility_policies" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "rules" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "eligibility_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "eligibility_exceptions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "type" "EligibilityExceptionType" NOT NULL,
    "scopeCustomerRef" TEXT,
    "scopeNationality" TEXT,
    "waivedCategories" TEXT[],
    "riskLevel" "EligibilityRiskLevel" NOT NULL,
    "reason" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "eligibility_exceptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "eligibility_decisions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "status" "EligibilityDecisionStatus" NOT NULL,
    "ruleResults" JSONB NOT NULL,
    "exceptionsApplied" JSONB NOT NULL,
    "policyConflicts" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "policyVersion" INTEGER NOT NULL,
    "flags" JSONB NOT NULL,
    "modelMetadata" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "eligibility_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "eligibility_policies_tenantId_active_idx" ON "eligibility_policies"("tenantId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "eligibility_policies_tenantId_version_key" ON "eligibility_policies"("tenantId", "version");

-- CreateIndex
CREATE INDEX "eligibility_exceptions_tenantId_idx" ON "eligibility_exceptions"("tenantId");

-- CreateIndex
CREATE INDEX "eligibility_exceptions_tenantId_scopeCustomerRef_idx" ON "eligibility_exceptions"("tenantId", "scopeCustomerRef");

-- CreateIndex
CREATE INDEX "eligibility_exceptions_tenantId_scopeNationality_idx" ON "eligibility_exceptions"("tenantId", "scopeNationality");

-- CreateIndex
CREATE INDEX "eligibility_decisions_tenantId_idx" ON "eligibility_decisions"("tenantId");

-- CreateIndex
CREATE INDEX "eligibility_decisions_messageId_idx" ON "eligibility_decisions"("messageId");

-- AddForeignKey
ALTER TABLE "eligibility_policies" ADD CONSTRAINT "eligibility_policies_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eligibility_exceptions" ADD CONSTRAINT "eligibility_exceptions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eligibility_decisions" ADD CONSTRAINT "eligibility_decisions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eligibility_decisions" ADD CONSTRAINT "eligibility_decisions_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "messages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eligibility_decisions" ADD CONSTRAINT "eligibility_decisions_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "eligibility_policies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
