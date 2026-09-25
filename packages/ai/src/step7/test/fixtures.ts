import type { Vehicle } from '@ai-concierge/domain';

let counter = 0;

/** A minimal, valid `Vehicle` for step7 tests — override only what a test cares about. */
export function makeVehicle(overrides: Partial<Vehicle> = {}): Vehicle {
  counter += 1;
  return {
    id: overrides.id ?? `00000000-0000-0000-0000-${String(counter).padStart(12, '0')}`,
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
