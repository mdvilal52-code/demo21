import type {
  DriverInput,
  EligibilityCustomerInput,
  EligibilityException,
  EligibilityPolicy,
  EligibilityPolicyRules,
  Vehicle,
} from '@ai-concierge/domain';
import type { EligibilityCheckContext } from '../types.js';

/** Shared, non-`.test.ts` fixtures for Step 5's unit tests — same pattern as apps/api/src/test/fakeWhatsAppProvider.ts. */

export const NOW = new Date('2026-09-23T12:00:00.000Z');

export const URUS: Vehicle = {
  id: '11111111-1111-1111-1111-111111111111',
  make: 'Lamborghini',
  model: 'Urus',
  category: 'SUV',
  luxuryTier: 'ULTRA_LUXURY',
  seats: 5,
  luggage: 4,
  transmission: 'AUTOMATIC',
  availabilityStatus: 'AVAILABLE',
  pricingProfile: { currency: 'AED', dailyRate: 3500 },
  active: true,
};

export const RANGE_ROVER: Vehicle = {
  id: '22222222-2222-2222-2222-222222222222',
  make: 'Land Rover',
  model: 'Range Rover',
  category: 'SUV',
  luxuryTier: 'LUXURY',
  seats: 5,
  luggage: 5,
  transmission: 'AUTOMATIC',
  availabilityStatus: 'AVAILABLE',
  pricingProfile: { currency: 'AED', dailyRate: 1800 },
  active: true,
};

export function basePolicyRules(
  overrides: Partial<EligibilityPolicyRules> = {},
): EligibilityPolicyRules {
  return {
    minAge: 21,
    minAgeByLuxuryTier: {},
    requiredLicenseTypes: ['UAE', 'GCC', 'IDP'],
    passportRequired: true,
    nationalityRules: { blockedNationalities: [], allowedNationalitiesOnly: [] },
    vehicleRestrictions: {},
    restrictedCities: [],
    driverRequirements: {
      maxAdditionalDrivers: 2,
      additionalDriverMinAge: 21,
      additionalDriversRequireValidLicense: true,
    },
    ...overrides,
  };
}

export function basePolicy(overrides: Partial<EligibilityPolicyRules> = {}): EligibilityPolicy {
  return {
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    tenantId: '00000000-0000-0000-0000-000000000001',
    version: 1,
    active: true,
    rules: basePolicyRules(overrides),
  };
}

/** Age 31 as of NOW/the pickup dates used below. */
export function baseCustomer(
  overrides: Partial<EligibilityCustomerInput> = {},
): EligibilityCustomerInput {
  return {
    dateOfBirth: '1995-01-01',
    nationality: 'AE',
    licenseType: 'UAE',
    hasValidLicense: true,
    passportProvided: true,
    ...overrides,
  };
}

export function driver(overrides: Partial<DriverInput> = {}): DriverInput {
  return {
    dateOfBirth: '1995-01-01',
    nationality: 'AE',
    licenseType: 'UAE',
    hasValidLicense: true,
    ...overrides,
  };
}

export function baseContext(
  overrides: Partial<EligibilityCheckContext> = {},
): EligibilityCheckContext {
  return {
    customer: baseCustomer(),
    additionalDrivers: [],
    customerRef: 'customer-1',
    vehicle: null,
    pickupDate: '2026-10-15T06:00:00.000Z',
    returnDate: '2026-10-19T06:00:00.000Z',
    pickupLocation: null,
    dropoffLocation: null,
    now: NOW,
    ...overrides,
  };
}

export function baseException(overrides: Partial<EligibilityException> = {}): EligibilityException {
  return {
    id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    type: 'MANUAL_GRANT',
    scopeCustomerRef: null,
    scopeNationality: null,
    waivedCategories: [],
    riskLevel: 'LOW',
    reason: 'test exception',
    active: true,
    expiresAt: null,
    ...overrides,
  };
}
