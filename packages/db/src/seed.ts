// Idempotent production seed: the default tenant, the starter fleet
// (Phase 3 spec — Lamborghini Urus + Range Rover), and a default Step 5
// eligibility policy. Migrations only create the schema; a brand-new
// database has no rows, and DEFAULT_TENANT_ID has no Tenant to reference
// until this runs once. Safe to re-run on every deploy — every write here
// is an upsert (the eligibility policy is versioned/append-only by design,
// so re-running this only creates version 1 once, never a new version on
// every deploy — see the `existingPolicy` guard below).
import type { EligibilityPolicyRules } from '@ai-concierge/domain';
import {
  createEligibilityPolicyVersion,
  createPrismaClient,
  findActiveEligibilityPolicy,
  normalizeVehicleName,
} from './index.js';

interface SeedVehicle {
  make: string;
  model: string;
  color: string;
  category: 'SUV' | 'SEDAN' | 'COUPE' | 'CONVERTIBLE' | 'SPORTS' | 'VAN';
  luxuryTier: 'PREMIUM' | 'LUXURY' | 'ULTRA_LUXURY';
  seats: number;
  luggage: number;
  transmission: 'AUTOMATIC' | 'MANUAL';
  pricingProfile: { currency: string; dailyRate: number };
  /** A neutral, clearly-generic placeholder — swap for a real licensed photo (or the admin fleet-photo-upload feature) before this ever faces a real customer. */
  photoUrl: string;
  /** Phase 6 — how many physical units of this class the starter fleet owns. */
  unitCount: number;
}

function placeholderPhoto(make: string, model: string, color: string): string {
  const label = encodeURIComponent(`${make} ${model}\n${color}`);
  return `https://placehold.co/800x450/1a1a1a/ffffff?text=${label}`;
}

/**
 * A broad, market-popular Dubai luxury-rental catalog — most models offered
 * in a couple of colours as distinct catalog rows (see `Vehicle.color`'s
 * schema comment), so a customer naming a colour narrows to a specific
 * listing the same way naming an exact model already does. Every photoUrl is
 * a plain, clearly-labelled placeholder (`placeholderPhoto`) — no real
 * manufacturer photo is downloaded or embedded here; replace with a licensed
 * image (or the fleet photo-upload feature) before this reaches a real
 * customer.
 */
const STARTER_FLEET: SeedVehicle[] = (
  [
    ['Lamborghini', 'Urus', 'SUV', 'ULTRA_LUXURY', 5, 4, 'AUTOMATIC', 3500, ['Black', 'White']],
    ['Land Rover', 'Range Rover', 'SUV', 'LUXURY', 5, 5, 'AUTOMATIC', 1800, ['White', 'Black']],
    ['Land Rover', 'Range Rover Sport', 'SUV', 'LUXURY', 5, 4, 'AUTOMATIC', 1600, ['Grey']],
    ['BMW', 'X5', 'SUV', 'LUXURY', 5, 5, 'AUTOMATIC', 1200, ['Black', 'White']],
    ['BMW', 'X7', 'SUV', 'LUXURY', 7, 5, 'AUTOMATIC', 1600, ['Black']],
    ['BMW', 'M5', 'SEDAN', 'LUXURY', 5, 4, 'AUTOMATIC', 1400, ['Blue']],
    ['Mercedes-Benz', 'G63 AMG', 'SUV', 'ULTRA_LUXURY', 5, 4, 'AUTOMATIC', 3200, ['Black', 'White']],
    ['Mercedes-Benz', 'S-Class', 'SEDAN', 'ULTRA_LUXURY', 5, 5, 'AUTOMATIC', 2200, ['Black', 'Silver']],
    ['Mercedes-Benz', 'GLE', 'SUV', 'LUXURY', 5, 5, 'AUTOMATIC', 1300, ['White']],
    ['Porsche', 'Cayenne', 'SUV', 'LUXURY', 5, 4, 'AUTOMATIC', 1700, ['Black', 'Grey']],
    ['Porsche', '911', 'COUPE', 'ULTRA_LUXURY', 4, 2, 'AUTOMATIC', 2500, ['Red', 'Black']],
    ['Porsche', 'Panamera', 'SEDAN', 'LUXURY', 5, 4, 'AUTOMATIC', 1900, ['Black']],
    ['Rolls-Royce', 'Cullinan', 'SUV', 'ULTRA_LUXURY', 5, 4, 'AUTOMATIC', 6500, ['Black', 'White']],
    ['Rolls-Royce', 'Ghost', 'SEDAN', 'ULTRA_LUXURY', 5, 4, 'AUTOMATIC', 5500, ['Black']],
    ['Bentley', 'Bentayga', 'SUV', 'ULTRA_LUXURY', 5, 4, 'AUTOMATIC', 3800, ['Green']],
    ['Bentley', 'Continental GT', 'COUPE', 'ULTRA_LUXURY', 4, 3, 'AUTOMATIC', 3600, ['Silver']],
    ['Ferrari', '488 Spider', 'CONVERTIBLE', 'ULTRA_LUXURY', 2, 2, 'AUTOMATIC', 4500, ['Red']],
    ['Ferrari', 'Roma', 'COUPE', 'ULTRA_LUXURY', 4, 2, 'AUTOMATIC', 4000, ['Red', 'Black']],
    ['Audi', 'Q8', 'SUV', 'LUXURY', 5, 5, 'AUTOMATIC', 1200, ['Grey']],
    ['Audi', 'RS Q8', 'SUV', 'ULTRA_LUXURY', 5, 5, 'AUTOMATIC', 2100, ['Black']],
    ['Maserati', 'Levante', 'SUV', 'LUXURY', 5, 4, 'AUTOMATIC', 1500, ['White']],
    ['Maserati', 'Ghibli', 'SEDAN', 'LUXURY', 5, 4, 'AUTOMATIC', 1300, ['Blue']],
    ['McLaren', '720S', 'COUPE', 'ULTRA_LUXURY', 2, 2, 'AUTOMATIC', 5000, ['Orange']],
    ['Aston Martin', 'DBX', 'SUV', 'ULTRA_LUXURY', 5, 4, 'AUTOMATIC', 3000, ['Green', 'Black']],
    ['Tesla', 'Model X', 'SUV', 'LUXURY', 6, 4, 'AUTOMATIC', 1400, ['White', 'Black']],
    ['Nissan', 'Patrol', 'SUV', 'PREMIUM', 7, 5, 'AUTOMATIC', 900, ['White']],
    ['Chevrolet', 'Camaro', 'COUPE', 'PREMIUM', 4, 2, 'AUTOMATIC', 700, ['Yellow']],
    ['Chevrolet', 'Corvette', 'SPORTS', 'LUXURY', 2, 2, 'AUTOMATIC', 1100, ['Red']],
    ['Ford', 'Mustang', 'CONVERTIBLE', 'PREMIUM', 4, 2, 'AUTOMATIC', 800, ['Blue', 'Black']],
    ['Toyota', 'Land Cruiser', 'SUV', 'PREMIUM', 7, 5, 'AUTOMATIC', 850, ['Beige']],
  ] as const
).flatMap(
  ([make, model, category, luxuryTier, seats, luggage, transmission, dailyRate, colors]) =>
    colors.map((color) => ({
      make,
      model,
      color,
      category,
      luxuryTier,
      seats,
      luggage,
      transmission,
      pricingProfile: { currency: 'AED', dailyRate },
      photoUrl: placeholderPhoto(make, model, color),
      unitCount: 2,
    })),
);

/**
 * Sensible Dubai-luxury-rental defaults — every threshold/list here is
 * exactly what a tenant would later reconfigure via the (not-yet-built,
 * Phase 7) admin Settings page; nothing about these numbers is hardcoded
 * into the rule logic itself (packages/ai/src/step5).
 */
const DEFAULT_ELIGIBILITY_POLICY: EligibilityPolicyRules = {
  minAge: 21,
  minAgeByLuxuryTier: { ULTRA_LUXURY: 25 },
  requiredLicenseTypes: ['UAE', 'GCC', 'IDP'],
  passportRequired: true,
  nationalityRules: {
    blockedNationalities: [],
    allowedNationalitiesOnly: [],
  },
  vehicleRestrictions: {},
  restrictedCities: [],
  driverRequirements: {
    maxAdditionalDrivers: 2,
    additionalDriverMinAge: 21,
    additionalDriversRequireValidLicense: true,
  },
};

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  const tenantId = process.env.DEFAULT_TENANT_ID;
  if (!databaseUrl || !tenantId) {
    throw new Error('DATABASE_URL and DEFAULT_TENANT_ID must both be set to run the seed');
  }

  const prisma = createPrismaClient(databaseUrl);
  try {
    await prisma.tenant.upsert({
      where: { id: tenantId },
      update: {},
      create: { id: tenantId, name: 'Default Tenant' },
    });

    for (const vehicle of STARTER_FLEET) {
      const make = normalizeVehicleName(vehicle.make);
      const model = normalizeVehicleName(vehicle.model);
      const row = await prisma.vehicle.upsert({
        where: { tenantId_make_model_color: { tenantId, make, model, color: vehicle.color } },
        update: {},
        create: {
          tenantId,
          make,
          model,
          color: vehicle.color,
          category: vehicle.category,
          luxuryTier: vehicle.luxuryTier,
          seats: vehicle.seats,
          luggage: vehicle.luggage,
          transmission: vehicle.transmission,
          pricingProfile: vehicle.pricingProfile,
          photoUrl: vehicle.photoUrl,
        },
      });

      // Phase 6 — real, countable physical inventory for this catalog entry.
      await prisma.vehicleUnit.createMany({
        data: Array.from({ length: vehicle.unitCount }, (_, index) => ({
          tenantId,
          vehicleId: row.id,
          unitRef: `${make}-${model}-${vehicle.color}-${String(index + 1).padStart(2, '0')}`.replace(
            /\s+/g,
            '-',
          ),
          status: 'ACTIVE' as const,
        })),
        skipDuplicates: true,
      });
    }

    const existingPolicy = await findActiveEligibilityPolicy(prisma, tenantId);
    if (!existingPolicy) {
      await createEligibilityPolicyVersion(prisma, { tenantId, rules: DEFAULT_ELIGIBILITY_POLICY });
    }

    console.error(
      `Seed complete: tenant ${tenantId}, ${STARTER_FLEET.length} vehicle(s) ensured, eligibility policy ${
        existingPolicy ? 'already present' : 'created'
      }.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error('Seed failed', error);
  process.exit(1);
});
