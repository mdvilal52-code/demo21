-- CreateEnum
CREATE TYPE "UnitStatus" AS ENUM ('ACTIVE', 'MAINTENANCE', 'RETIRED');

-- CreateEnum
CREATE TYPE "InventoryStatus" AS ENUM ('AVAILABLE', 'HELD', 'BOOKED', 'UNAVAILABLE', 'MAINTENANCE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "HoldStatus" AS ENUM ('ACTIVE', 'CONFIRMED', 'RELEASED', 'EXPIRED');

-- CreateTable
CREATE TABLE "vehicle_units" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "unitRef" TEXT NOT NULL,
    "status" "UnitStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vehicle_units_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "availability_holds" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "pickupAt" TIMESTAMP(3) NOT NULL,
    "returnAt" TIMESTAMP(3) NOT NULL,
    "status" "HoldStatus" NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "releaseReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "availability_holds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "availability_checks" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "pickupAt" TIMESTAMP(3) NOT NULL,
    "returnAt" TIMESTAMP(3) NOT NULL,
    "status" "InventoryStatus" NOT NULL,
    "holdId" TEXT,
    "source" TEXT NOT NULL,
    "reason" TEXT,
    "retryable" BOOLEAN NOT NULL DEFAULT false,
    "modelMetadata" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "availability_checks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "vehicle_units_tenantId_vehicleId_idx" ON "vehicle_units"("tenantId", "vehicleId");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_units_tenantId_vehicleId_unitRef_key" ON "vehicle_units"("tenantId", "vehicleId", "unitRef");

-- CreateIndex
CREATE INDEX "availability_holds_tenantId_vehicleId_status_idx" ON "availability_holds"("tenantId", "vehicleId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "availability_holds_tenantId_idempotencyKey_key" ON "availability_holds"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "availability_checks_tenantId_idx" ON "availability_checks"("tenantId");

-- CreateIndex
CREATE INDEX "availability_checks_messageId_idx" ON "availability_checks"("messageId");

-- AddForeignKey
ALTER TABLE "vehicle_units" ADD CONSTRAINT "vehicle_units_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_units" ADD CONSTRAINT "vehicle_units_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "availability_holds" ADD CONSTRAINT "availability_holds_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "availability_holds" ADD CONSTRAINT "availability_holds_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "availability_checks" ADD CONSTRAINT "availability_checks_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "availability_checks" ADD CONSTRAINT "availability_checks_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "messages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "availability_checks" ADD CONSTRAINT "availability_checks_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
