import { EligibilityRuleCategory } from '@ai-concierge/domain';
import type { EligibilityRule } from '../types.js';

/** MASTER-PLAN.md journey Step 5: "residency" documentation gate — a tenant-configurable requirement, not universal. */
export const passportRule: EligibilityRule = {
  id: 'passport-required',
  category: EligibilityRuleCategory.PASSPORT,
  evaluate(context, policy) {
    if (policy.passportRequired && !context.customer.passportProvided) {
      return {
        outcome: 'FAIL',
        message: 'A passport is required for this tenant but was not provided.',
      };
    }
    return { outcome: 'PASS', message: 'Passport requirement satisfied.' };
  },
};
