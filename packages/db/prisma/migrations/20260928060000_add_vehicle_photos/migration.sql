-- CreateTable
CREATE TABLE "vehicle_photos" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "caption" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vehicle_photos_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "vehicle_photos_tenantId_vehicleId_sortOrder_idx" ON "vehicle_photos"("tenantId", "vehicleId", "sortOrder");

-- AddForeignKey
ALTER TABLE "vehicle_photos" ADD CONSTRAINT "vehicle_photos_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vehicle_photos" ADD CONSTRAINT "vehicle_photos_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Row Level Security — same tenant_isolation shape every other tenant-scoped table has.
ALTER TABLE "vehicle_photos" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "vehicle_photos" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "vehicle_photos"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

-- Least privilege: the API role manages photos (including removing a wrong one); the worker never touches them.
GRANT SELECT, INSERT, UPDATE, DELETE ON "vehicle_photos" TO ai_concierge_api;
