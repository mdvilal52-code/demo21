-- CreateEnum
CREATE TYPE "AlternativeRecommendationStatus" AS ENUM ('ALTERNATIVES_FOUND', 'NO_ALTERNATIVES');

-- CreateTable
CREATE TABLE "alternative_recommendations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "requestedVehicleId" TEXT NOT NULL,
    "status" "AlternativeRecommendationStatus" NOT NULL,
    "primary" JSONB,
    "secondary" JSONB,
    "consideredCount" INTEGER NOT NULL,
    "modelMetadata" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alternative_recommendations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "alternative_recommendations_tenantId_idx" ON "alternative_recommendations"("tenantId");

-- CreateIndex
CREATE INDEX "alternative_recommendations_messageId_idx" ON "alternative_recommendations"("messageId");

-- AddForeignKey
ALTER TABLE "alternative_recommendations" ADD CONSTRAINT "alternative_recommendations_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alternative_recommendations" ADD CONSTRAINT "alternative_recommendations_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "messages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alternative_recommendations" ADD CONSTRAINT "alternative_recommendations_requestedVehicleId_fkey" FOREIGN KEY ("requestedVehicleId") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
