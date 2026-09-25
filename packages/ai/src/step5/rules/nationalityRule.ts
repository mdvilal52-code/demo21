import { EligibilityRuleCategory } from '@ai-concierge/domain';
import type { EligibilityRule } from '../types.js';

/**
 * MASTER-PLAN.md journey Step 5: "nationality restrictions". Two
 * independent modes, both tenant-configurable: a blocklist (always denies,
 * regardless of the allowlist) and, only when non-empty, an allowlist
 * (denies anything not explicitly named).
 */
export const nationalityRule: EligibilityRule = {
  id: 'nationality-restriction',
  category: EligibilityRuleCategory.NATIONALITY,
  evaluate(context, policy) {
    const nationality = context.customer.nationality;
    const { blockedNationalities, allowedNationalitiesOnly } = policy.nationalityRules;

    if (blockedNationalities.includes(nationality)) {
      return { outcome: 'FAIL', message: `Nationality ${nationality} is restricted for rentals.` };
    }
    if (allowedNationalitiesOnly.length > 0 && !allowedNationalitiesOnly.includes(nationality)) {
      return {
        outcome: 'FAIL',
        message: `Nationality ${nationality} is not in the permitted list.`,
      };
    }
    return { outcome: 'PASS', message: `Nationality ${nationality} is permitted.` };
  },
};
