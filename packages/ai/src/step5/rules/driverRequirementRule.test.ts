import { describe, expect, it } from 'vitest';
import { baseContext, basePolicyRules, driver } from '../test/fixtures.js';
import { driverRequirementRule } from './driverRequirementRule.js';

describe('driverRequirementRule', () => {
  it('passes with no additional drivers', () => {
    const context = baseContext({ additionalDrivers: [] });
    const result = driverRequirementRule.evaluate(context, basePolicyRules());
    expect(result.outcome).toBe('PASS');
  });

  it('passes when every additional driver meets the requirements', () => {
    const context = baseContext({ additionalDrivers: [driver(), driver()] });
    const result = driverRequirementRule.evaluate(
      context,
      basePolicyRules({
        driverRequirements: {
          maxAdditionalDrivers: 2,
          additionalDriverMinAge: 21,
          additionalDriversRequireValidLicense: true,
        },
      }),
    );
    expect(result.outcome).toBe('PASS');
  });

  it('fails when there are more additional drivers than the configured maximum', () => {
    const context = baseContext({ additionalDrivers: [driver(), driver(), driver()] });
    const result = driverRequirementRule.evaluate(
      context,
      basePolicyRules({
        driverRequirements: {
          maxAdditionalDrivers: 2,
          additionalDriverMinAge: 21,
          additionalDriversRequireValidLicense: true,
        },
      }),
    );
    expect(result.outcome).toBe('FAIL');
    expect(result.message).toMatch(/too many/i);
  });

  it('fails when an additional driver is below the minimum age', () => {
    const context = baseContext({ additionalDrivers: [driver({ dateOfBirth: '2010-01-01' })] });
    const result = driverRequirementRule.evaluate(
      context,
      basePolicyRules({
        driverRequirements: {
          maxAdditionalDrivers: 2,
          additionalDriverMinAge: 21,
          additionalDriversRequireValidLicense: true,
        },
      }),
    );
    expect(result.outcome).toBe('FAIL');
    expect(result.message).toMatch(/driver 1 is below the minimum age/i);
  });

  it('fails when an additional driver lacks a valid license and one is required', () => {
    const context = baseContext({ additionalDrivers: [driver({ hasValidLicense: false })] });
    const result = driverRequirementRule.evaluate(
      context,
      basePolicyRules({
        driverRequirements: {
          maxAdditionalDrivers: 2,
          additionalDriverMinAge: 21,
          additionalDriversRequireValidLicense: true,
        },
      }),
    );
    expect(result.outcome).toBe('FAIL');
    expect(result.message).toMatch(/does not have a valid license/i);
  });
});
