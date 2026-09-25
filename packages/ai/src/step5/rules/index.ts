import type { EligibilityRule } from '../types.js';
import { ageRule } from './ageRule.js';
import { driverRequirementRule } from './driverRequirementRule.js';
import { licenseRule } from './licenseRule.js';
import { locationRule } from './locationRule.js';
import { nationalityRule } from './nationalityRule.js';
import { passportRule } from './passportRule.js';
import { vehicleRule } from './vehicleRule.js';

export { ageRule } from './ageRule.js';
export { driverRequirementRule } from './driverRequirementRule.js';
export { licenseRule } from './licenseRule.js';
export { locationRule } from './locationRule.js';
export { nationalityRule } from './nationalityRule.js';
export { passportRule } from './passportRule.js';
export { vehicleRule } from './vehicleRule.js';

/** MASTER-PLAN.md journey Step 5's rule set, evaluated in a fixed, deterministic order. */
export const ELIGIBILITY_RULES: EligibilityRule[] = [
  ageRule,
  licenseRule,
  passportRule,
  nationalityRule,
  vehicleRule,
  locationRule,
  driverRequirementRule,
];
