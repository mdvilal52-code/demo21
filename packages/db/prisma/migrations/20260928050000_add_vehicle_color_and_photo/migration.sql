-- AlterTable: add colour (backfilled, then required) and an optional reference photo
ALTER TABLE "vehicles" ADD COLUMN "color" TEXT;
ALTER TABLE "vehicles" ADD COLUMN "photoUrl" TEXT;

-- Backfill the starter fleet's existing rows with a real colour before making the column required.
UPDATE "vehicles" SET "color" = 'Black' WHERE "make" = 'Lamborghini' AND "model" = 'Urus' AND "color" IS NULL;
UPDATE "vehicles" SET "color" = 'White' WHERE "make" = 'Land Rover' AND "model" = 'Range Rover' AND "color" IS NULL;
-- Any other pre-existing row (a tenant's own custom vehicle) gets an explicit, honest default rather than a guess.
UPDATE "vehicles" SET "color" = 'Unspecified' WHERE "color" IS NULL;

ALTER TABLE "vehicles" ALTER COLUMN "color" SET NOT NULL;

-- DropIndex
DROP INDEX "vehicles_tenantId_make_model_key";

-- CreateIndex: a customer naming a colour now identifies one specific catalog row, same as an exact model already does.
CREATE UNIQUE INDEX "vehicles_tenantId_make_model_color_key" ON "vehicles"("tenantId", "make", "model", "color");
