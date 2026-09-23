import { EligibilityRuleCategory } from '@ai-concierge/domain';
import type { EligibilityRule } from '../types.js';

/** MASTER-PLAN.md journey Step 5: "licence type (UAE / IDP)". */
export const licenseRule: EligibilityRule = {
  id: 'license-required',
  category: EligibilityRuleCategory.LICENSE,
  evaluate(context, policy) {
    if (!context.customer.hasValidLicense) {
      return { outcome: 'FAIL', message: 'No valid driving license was declared.' };
    }
    if (!policy.requiredLicenseTypes.includes(context.customer.licenseType)) {
      return {
        outcome: 'FAIL',
        message: `License type ${context.customer.licenseType} is not accepted; accepted types: ${policy.requiredLicenseTypes.join(', ')}.`,
      };
    }
    return {
      outcome: 'PASS',
      message: `License type ${context.customer.licenseType} is accepted.`,
    };
  },
};
