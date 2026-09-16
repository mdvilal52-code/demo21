import { VehicleCategory, type VehicleCategoryValue } from '@ai-concierge/domain';

/**
 * Deterministic keyword lexicon for category-only vehicle mentions (e.g.
 * "I need an SUV"), mirroring `packages/ai/src/lexicon.ts`'s style: a small,
 * explicit list — a keyword not in here simply isn't matched. Recognizing a
 * category *word* is independent of what's actually in stock; whether any
 * vehicle of that category exists is decided later, against the real
 * catalog lexicon, never invented here.
 */
export const CATEGORY_KEYWORDS: Record<VehicleCategoryValue, string[]> = {
  [VehicleCategory.SEDAN]: ['sedan', 'saloon'],
  [VehicleCategory.SUV]: ['suv', 'sport utility vehicle', '4x4', 'four wheel drive'],
  [VehicleCategory.COUPE]: ['coupe', 'coupé'],
  [VehicleCategory.CONVERTIBLE]: ['convertible', 'cabriolet', 'cabrio', 'roadster'],
  [VehicleCategory.SPORTS]: ['sports car', 'supercar', 'super car'],
  [VehicleCategory.VAN]: ['van', 'minivan', 'people carrier', '7 seater', 'seven seater'],
};
