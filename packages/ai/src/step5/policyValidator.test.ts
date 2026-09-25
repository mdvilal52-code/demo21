import { describe, expect, it } from 'vitest';
import { basePolicyRules } from './test/fixtures.js';
import { validateEligibilityPolicy } from './policyValidator.js';

describe('validateEligibilityPolicy', () => {
  it('returns no conflicts for an internally consistent policy', () => {
    const conflicts = validateEligibilityPolicy(
      basePolicyRules({ minAge: 21, minAgeByLuxuryTier: { ULTRA_LUXURY: 25 } }),
    );
    expect(conflicts).toEqual([]);
  });

  it('detects a nationality present in both the blocked and allowed-only lists', () => {
    const conflicts = validateEligibilityPolicy(
      basePolicyRules({
        nationalityRules: { blockedNationalities: ['XX'], allowedNationalitiesOnly: ['XX', 'AE'] },
      }),
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.code).toBe('NATIONALITY_IN_BOTH_LISTS');
    expect(conflicts[0]?.message).toMatch(/XX/);
  });

  it('detects a tier minimum age configured below the global minimum age', () => {
    const conflicts = validateEligibilityPolicy(
      basePolicyRules({ minAge: 25, minAgeByLuxuryTier: { PREMIUM: 21 } }),
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.code).toBe('TIER_MIN_AGE_BELOW_GLOBAL');
  });

  it('reports every conflict found, not just the first', () => {
    const conflicts = validateEligibilityPolicy(
      basePolicyRules({
        minAge: 25,
        minAgeByLuxuryTier: { PREMIUM: 21 },
        nationalityRules: { blockedNationalities: ['XX'], allowedNationalitiesOnly: ['XX'] },
      }),
    );
    expect(conflicts).toHaveLength(2);
  });
});
