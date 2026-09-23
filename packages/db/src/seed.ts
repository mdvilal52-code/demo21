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
  category: 'SUV' | 'SEDAN' | 'COUPE' | 'CONVERTIBLE' | 'VAN';
  luxuryTier: 'LUXURY' | 'ULTRA_LUXURY';
  seats: number;
  luggage: number;
  transmission: 'AUTOMATIC' | 'MANUAL';
  pricingProfile: { currency: string; dailyRate: number };
}

const STARTER_FLEET: SeedVehicle[] = [
  {
    make: 'Lamborghini',
    model: 'Urus',
    category: 'SUV',
    luxuryTier: 'ULTRA_LUXURY',
    seats: 5,
    luggage: 4,
    transmission: 'AUTOMATIC',
    pricingProfile: { currency: 'AED', dailyRate: 3500 },
  },
  {
    make: 'Land Rover',
    model: 'Range Rover',
    category: 'SUV',
    luxuryTier: 'LUXURY',
    seats: 5,
    luggage: 5,
    transmission: 'AUTOMATIC',
    pricingProfile: { currency: 'AED', dailyRate: 1800 },
  },
];

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
      await prisma.vehicle.upsert({
        where: { tenantId_make_model: { tenantId, make, model } },
        update: {},
        create: {
          tenantId,
          make,
          model,
          category: vehicle.category,
          luxuryTier: vehicle.luxuryTier,
          seats: vehicle.seats,
          luggage: vehicle.luggage,
          transmission: vehicle.transmission,
          pricingProfile: vehicle.pricingProfile,
        },
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
