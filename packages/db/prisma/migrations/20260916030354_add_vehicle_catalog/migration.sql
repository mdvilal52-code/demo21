-- CreateEnum
CREATE TYPE "VehicleCategory" AS ENUM ('SEDAN', 'SUV', 'COUPE', 'CONVERTIBLE', 'SPORTS', 'VAN');

-- CreateEnum
CREATE TYPE "LuxuryTier" AS ENUM ('PREMIUM', 'LUXURY', 'ULTRA_LUXURY');

-- CreateEnum
CREATE TYPE "Transmission" AS ENUM ('AUTOMATIC', 'MANUAL');

-- CreateEnum
CREATE TYPE "VehicleAvailabilityStatus" AS ENUM ('AVAILABLE', 'UNAVAILABLE', 'MAINTENANCE');

-- CreateEnum
CREATE TYPE "VehicleDeterminationStatus" AS ENUM ('RESOLVED', 'NEEDS_CLARIFICATION', 'UNSUPPORTED');

-- CreateTable
CREATE TABLE "vehicles" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "make" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "category" "VehicleCategory" NOT NULL,
    "luxuryTier" "LuxuryTier" NOT NULL,
    "seats" INTEGER NOT NULL,
    "luggage" INTEGER NOT NULL,
    "transmission" "Transmission" NOT NULL,
    "availabilityStatus" "VehicleAvailabilityStatus" NOT NULL DEFAULT 'AVAILABLE',
    "pricingProfile" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vehicles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_determinations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "resolvedVehicleId" TEXT,
    "status" "VehicleDeterminationStatus" NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "ambiguities" JSONB NOT NULL,
    "validationErrors" JSONB NOT NULL,
    "alternatives" JSONB NOT NULL,
    "flags" JSONB NOT NULL,
    "modelMetadata" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vehicle_determinations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "vehicles_tenantId_idx" ON "vehicles"("tenantId");

-- CreateIndex
CREATE INDEX "vehicles_tenantId_category_idx" ON "vehicles"("tenantId", "category");

-- CreateIndex
CREATE UNIQUE INDEX "vehicles_tenantId_make_model_key" ON "vehicles"("tenantId", "make", "model");

-- CreateIndex
CREATE INDEX "vehicle_determinations_tenantId_idx" ON "vehicle_determinations"("tenantId");

-- CreateIndex
CREATE INDEX "vehicle_determinations_messageId_idx" ON "vehicle_determinations"("messageId");

-- AddForeignKey
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_determinations" ADD CONSTRAINT "vehicle_determinations_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_determinations" ADD CONSTRAINT "vehicle_determinations_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "messages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_determinations" ADD CONSTRAINT "vehicle_determinations_resolvedVehicleId_fkey" FOREIGN KEY ("resolvedVehicleId") REFERENCES "vehicles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
