import { describe, expect, it } from 'vitest';
import { baseContext, baseCustomer, basePolicyRules, RANGE_ROVER, URUS } from '../test/fixtures.js';
import { vehicleRule } from './vehicleRule.js';

describe('vehicleRule', () => {
  it('passes when no vehicle has been resolved yet', () => {
    const context = baseContext({ vehicle: null });
    const result = vehicleRule.evaluate(context, basePolicyRules());
    expect(result.outcome).toBe('PASS');
  });

  it('passes when the resolved vehicle tier has no configured restriction', () => {
    const context = baseContext({ vehicle: RANGE_ROVER });
    const result = vehicleRule.evaluate(context, basePolicyRules({ vehicleRestrictions: {} }));
    expect(result.outcome).toBe('PASS');
  });

  it('fails a tier-specific minimum age even when the base age rule would pass', () => {
    // 22 as of the pickup date — passes a base minAge of 21, but not this
    // tier's own, higher, configured minAge.
    const context = baseContext({
      customer: baseCustomer({ dateOfBirth: '2004-06-01' }),
      vehicle: URUS,
    });
    const result = vehicleRule.evaluate(
      context,
      basePolicyRules({ minAge: 21, vehicleRestrictions: { ULTRA_LUXURY: { minAge: 25 } } }),
    );
    expect(result.outcome).toBe('FAIL');
    expect(result.message).toMatch(/ULTRA_LUXURY/);
  });

  it('fails a tier-specific blocked nationality', () => {
    const context = baseContext({
      customer: baseCustomer({ nationality: 'XX' }),
      vehicle: URUS,
    });
    const result = vehicleRule.evaluate(
      context,
      basePolicyRules({ vehicleRestrictions: { ULTRA_LUXURY: { blockedNationalities: ['XX'] } } }),
    );
    expect(result.outcome).toBe('FAIL');
    expect(result.message).toMatch(/restricted for nationality/i);
  });
});
