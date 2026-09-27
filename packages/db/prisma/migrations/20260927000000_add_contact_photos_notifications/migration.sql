-- Customer contact details captured from chat (email/phone) for automatic
-- quote / hand-over notifications.
ALTER TABLE "customers" ADD COLUMN "email" TEXT;
ALTER TABLE "customers" ADD COLUMN "phone" TEXT;

-- Photos attached to a concierge reply.
ALTER TABLE "outbound_messages" ADD COLUMN "attachments" JSONB;

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

-- CreateTable
CREATE TABLE "notification_deliveries" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "conversationId" TEXT,
    "kind" TEXT NOT NULL,
    "subjectKey" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "providerRef" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "vehicle_photos_tenantId_vehicleId_sortOrder_idx" ON "vehicle_photos"("tenantId", "vehicleId", "sortOrder");

-- CreateIndex
CREATE INDEX "notification_deliveries_tenantId_conversationId_idx" ON "notification_deliveries"("tenantId", "conversationId");

-- The same notification is only ever SENT once (a NOT_CONFIGURED/FAILED attempt may be retried later).
CREATE UNIQUE INDEX "notification_deliveries_sent_once_idx"
  ON "notification_deliveries"("tenantId", "kind", "subjectKey", "channel")
  WHERE "status" = 'SENT';

-- AddForeignKey
ALTER TABLE "vehicle_photos" ADD CONSTRAINT "vehicle_photos_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vehicle_photos" ADD CONSTRAINT "vehicle_photos_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Row Level Security — same tenant_isolation shape every other tenant-scoped table has.
ALTER TABLE "vehicle_photos" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "vehicle_photos" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "vehicle_photos"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "notification_deliveries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notification_deliveries" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "notification_deliveries"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

-- Least privilege: the API role manages photos (including removing a wrong one)
-- and records delivery attempts (never deletes them).
GRANT SELECT, INSERT, UPDATE, DELETE ON "vehicle_photos" TO ai_concierge_api;
GRANT SELECT, INSERT ON "notification_deliveries" TO ai_concierge_api;
