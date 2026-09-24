import type { QuoteSelections, Vehicle } from '@ai-concierge/domain';

/** A minimal, valid `Vehicle` for step8 tests — override only what a test cares about. */
export function makeVehicle(overrides: Partial<Vehicle> = {}): Vehicle {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    make: 'Lamborghini',
    model: 'Urus',
    category: 'SUV',
    luxuryTier: 'ULTRA_LUXURY',
    seats: 5,
    luggage: 3,
    transmission: 'AUTOMATIC',
    availabilityStatus: 'AVAILABLE',
    pricingProfile: { currency: 'AED', dailyRate: 3500 },
    active: true,
    ...overrides,
  };
}

export function makeSelections(overrides: Partial<QuoteSelections> = {}): QuoteSelections {
  return {
    extraCodes: [],
    insuranceTier: 'NONE',
    deliveryRequested: false,
    discountCode: null,
    ...overrides,
  };
}
