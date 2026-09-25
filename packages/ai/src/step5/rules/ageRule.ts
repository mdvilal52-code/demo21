import { EligibilityRuleCategory } from '@ai-concierge/domain';
import { calculateAgeAt } from '../age.js';
import type { EligibilityRule } from '../types.js';

/**
 * MASTER-PLAN.md journey Step 5: "min age per class". The base minimum age
 * applies unless the resolved vehicle's luxury tier configures a higher one
 * (`minAgeByLuxuryTier`) — a tier-specific *extra* constraint layered on top
 * is `vehicleRule`'s job, not this one's.
 */
export const ageRule: EligibilityRule = {
  id: 'age-minimum',
  category: EligibilityRuleCategory.AGE,
  evaluate(context, policy) {
    const referenceDate = context.pickupDate ? new Date(context.pickupDate) : context.now;
    const age = calculateAgeAt(context.customer.dateOfBirth, referenceDate);
    const tierMinAge = context.vehicle
      ? policy.minAgeByLuxuryTier[context.vehicle.luxuryTier]
      : undefined;
    const requiredAge = tierMinAge ?? policy.minAge;

    if (age < requiredAge) {
      return {
        outcome: 'FAIL',
        message: `Minimum age is ${requiredAge}; customer is ${age}.`,
      };
    }
    return { outcome: 'PASS', message: `Age ${age} meets the minimum of ${requiredAge}.` };
  },
};
