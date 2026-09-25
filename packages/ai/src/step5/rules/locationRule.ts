import { EligibilityRuleCategory } from '@ai-concierge/domain';
import type { EligibilityRule } from '../types.js';

/**
 * MASTER-PLAN.md journey Step 5: "location restrictions". Matches the
 * resolved pickup/dropoff location's `city` (from Step 2's
 * `NormalizedLocation`) against a tenant-configured city blocklist,
 * case-insensitively. A location Step 2 hasn't resolved yet has nothing to
 * check — that is a Step 4 completeness concern, not this rule's.
 */
export const locationRule: EligibilityRule = {
  id: 'location-restriction',
  category: EligibilityRuleCategory.LOCATION,
  evaluate(context, policy) {
    const restricted = new Set(policy.restrictedCities.map((city) => city.toLowerCase()));
    const candidates = [context.pickupLocation?.city, context.dropoffLocation?.city].filter(
      (city): city is string => Boolean(city),
    );
    const hit = candidates.find((city) => restricted.has(city.toLowerCase()));

    if (hit) {
      return { outcome: 'FAIL', message: `Rentals are not offered in ${hit}.` };
    }
    return { outcome: 'PASS', message: 'No location restriction applies.' };
  },
};
