import { EligibilityRuleCategory } from '@ai-concierge/domain';
import { calculateAgeAt } from '../age.js';
import type { EligibilityRule } from '../types.js';

/** MASTER-PLAN.md journey Step 5: "driver requirement" — count cap plus a per-driver age/license gate. */
export const driverRequirementRule: EligibilityRule = {
  id: 'driver-requirement',
  category: EligibilityRuleCategory.DRIVER_REQUIREMENT,
  evaluate(context, policy) {
    const { additionalDrivers } = context;
    const { maxAdditionalDrivers, additionalDriverMinAge, additionalDriversRequireValidLicense } =
      policy.driverRequirements;

    if (additionalDrivers.length > maxAdditionalDrivers) {
      return {
        outcome: 'FAIL',
        message: `Too many additional drivers (${additionalDrivers.length}); maximum is ${maxAdditionalDrivers}.`,
      };
    }

    const referenceDate = context.pickupDate ? new Date(context.pickupDate) : context.now;
    for (const [index, driver] of additionalDrivers.entries()) {
      const age = calculateAgeAt(driver.dateOfBirth, referenceDate);
      if (age < additionalDriverMinAge) {
        return {
          outcome: 'FAIL',
          message: `Additional driver ${index + 1} is below the minimum age of ${additionalDriverMinAge}.`,
        };
      }
      if (additionalDriversRequireValidLicense && !driver.hasValidLicense) {
        return {
          outcome: 'FAIL',
          message: `Additional driver ${index + 1} does not have a valid license.`,
        };
      }
    }

    return { outcome: 'PASS', message: 'Additional driver requirements satisfied.' };
  },
};
