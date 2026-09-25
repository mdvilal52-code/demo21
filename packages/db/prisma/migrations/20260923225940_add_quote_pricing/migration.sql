-- CreateEnum
CREATE TYPE "QuoteStatus" AS ENUM ('ISSUED', 'PENDING_REVIEW');

-- CreateTable
CREATE TABLE "quotes" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "QuoteStatus" NOT NULL,
    "currency" TEXT NOT NULL,
    "lineItems" JSONB NOT NULL,
    "taxes" JSONB NOT NULL,
    "fees" JSONB NOT NULL,
    "discounts" JSONB NOT NULL,
    "deposit" JSONB NOT NULL,
    "total" JSONB NOT NULL,
    "validUntil" TIMESTAMP(3) NOT NULL,
    "pricingVersion" TEXT NOT NULL,
    "requiresHumanReview" BOOLEAN NOT NULL,
    "reviewReasons" JSONB NOT NULL,
    "integrityHash" TEXT NOT NULL,
    "modelMetadata" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quotes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "quotes_tenantId_conversationId_idx" ON "quotes"("tenantId", "conversationId");

-- CreateIndex
CREATE UNIQUE INDEX "quotes_tenantId_quoteId_version_key" ON "quotes"("tenantId", "quoteId", "version");

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "messages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
