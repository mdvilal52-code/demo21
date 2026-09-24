import { EligibilityRuleCategory } from '@ai-concierge/domain';
import { calculateAgeAt } from '../age.js';
import type { EligibilityRule } from '../types.js';

/**
 * MASTER-PLAN.md journey Step 5: "vehicle-specific rules" — extra
 * constraints a tenant attaches to one luxury tier specifically (e.g.
 * ULTRA_LUXURY requiring a higher age, or excluding a nationality just for
 * that tier), layered on top of the base `ageRule`/`nationalityRule`
 * checks, not a replacement for them. A vehicle Step 3 hasn't resolved yet
 * has nothing tier-specific to check — that is a Step 4 completeness
 * concern, not this rule's.
 */
export const vehicleRule: EligibilityRule = {
  id: 'vehicle-tier-restriction',
  category: EligibilityRuleCategory.VEHICLE,
  evaluate(context, policy) {
    if (!context.vehicle) {
      return {
        outcome: 'PASS',
        message: 'No vehicle resolved yet; no tier-specific restriction to check.',
      };
    }
    const restriction = policy.vehicleRestrictions[context.vehicle.luxuryTier];
    if (!restriction) {
      return {
        outcome: 'PASS',
        message: `No tier-specific restriction for ${context.vehicle.luxuryTier}.`,
      };
    }

    if (restriction.minAge !== undefined) {
      const referenceDate = context.pickupDate ? new Date(context.pickupDate) : context.now;
      const age = calculateAgeAt(context.customer.dateOfBirth, referenceDate);
      if (age < restriction.minAge) {
        return {
          outcome: 'FAIL',
          message: `${context.vehicle.luxuryTier} requires a minimum age of ${restriction.minAge}; customer is ${age}.`,
        };
      }
    }

    if (restriction.blockedNationalities?.includes(context.customer.nationality)) {
      return {
        outcome: 'FAIL',
        message: `${context.vehicle.luxuryTier} is restricted for nationality ${context.customer.nationality}.`,
      };
    }

    return {
      outcome: 'PASS',
      message: `${context.vehicle.luxuryTier} tier restrictions satisfied.`,
    };
  },
};
