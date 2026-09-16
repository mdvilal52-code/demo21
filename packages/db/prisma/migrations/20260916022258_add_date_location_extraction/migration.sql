-- CreateEnum
CREATE TYPE "LocationType" AS ENUM ('AIRPORT', 'HOTEL', 'LANDMARK', 'ADDRESS', 'CITY_AREA', 'UNKNOWN');

-- CreateTable
CREATE TABLE "date_location_extractions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "pickupDate" TIMESTAMP(3),
    "returnDate" TIMESTAMP(3),
    "timezone" TEXT,
    "pickupLocation" JSONB,
    "dropoffLocation" JSONB,
    "locationType" "LocationType",
    "confidence" DOUBLE PRECISION NOT NULL,
    "ambiguities" JSONB NOT NULL,
    "validationErrors" JSONB NOT NULL,
    "flags" JSONB NOT NULL,
    "modelMetadata" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "date_location_extractions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "date_location_extractions_tenantId_idx" ON "date_location_extractions"("tenantId");

-- CreateIndex
CREATE INDEX "date_location_extractions_messageId_idx" ON "date_location_extractions"("messageId");

-- AddForeignKey
ALTER TABLE "date_location_extractions" ADD CONSTRAINT "date_location_extractions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "date_location_extractions" ADD CONSTRAINT "date_location_extractions_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "messages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
