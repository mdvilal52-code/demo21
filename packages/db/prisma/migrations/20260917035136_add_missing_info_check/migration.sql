-- CreateEnum
CREATE TYPE "MissingInfoStatus" AS ENUM ('COMPLETE', 'NEEDS_INFO', 'EXPIRED', 'NOT_APPLICABLE');

-- CreateTable
CREATE TABLE "missing_info_checks" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "status" "MissingInfoStatus" NOT NULL,
    "collected" JSONB NOT NULL,
    "missingFields" JSONB NOT NULL,
    "clarificationPrompt" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "flags" JSONB NOT NULL,
    "modelMetadata" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "missing_info_checks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "missing_info_checks_tenantId_idx" ON "missing_info_checks"("tenantId");

-- CreateIndex
CREATE INDEX "missing_info_checks_messageId_idx" ON "missing_info_checks"("messageId");

-- AddForeignKey
ALTER TABLE "missing_info_checks" ADD CONSTRAINT "missing_info_checks_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "missing_info_checks" ADD CONSTRAINT "missing_info_checks_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "messages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
