import { describe, expect, it } from 'vitest';
import { baseContext, baseCustomer, basePolicyRules, URUS } from '../test/fixtures.js';
import { ageRule } from './ageRule.js';

describe('ageRule', () => {
  it('passes a customer at or above the global minimum age', () => {
    const context = baseContext({ customer: baseCustomer({ dateOfBirth: '1995-01-01' }) });
    const result = ageRule.evaluate(context, basePolicyRules());
    expect(result.outcome).toBe('PASS');
  });

  it('fails a customer below the global minimum age', () => {
    const context = baseContext({ customer: baseCustomer({ dateOfBirth: '2010-01-01' }) }); // 16 as of pickup
    const result = ageRule.evaluate(context, basePolicyRules({ minAge: 21 }));
    expect(result.outcome).toBe('FAIL');
    expect(result.message).toMatch(/minimum age is 21/i);
  });

  it('uses the vehicle tier minimum age when higher than the global minimum', () => {
    // 22 as of the 2026-10-15 pickup date used by baseContext — passes the
    // global minAge of 21 but not ULTRA_LUXURY's configured 25.
    const context = baseContext({
      customer: baseCustomer({ dateOfBirth: '2004-06-01' }),
      vehicle: URUS,
    });
    const policy = basePolicyRules({ minAge: 21, minAgeByLuxuryTier: { ULTRA_LUXURY: 25 } });
    const result = ageRule.evaluate(context, policy);
    expect(result.outcome).toBe('FAIL');
    expect(result.message).toMatch(/minimum age is 25/i);
  });

  it('evaluates age as of the pickup date, not "now"', () => {
    // Turns 21 on 2026-10-10, five days before the 2026-10-15 pickup date
    // used by baseContext, but still 20 as of the fixed "now".
    const context = baseContext({ customer: baseCustomer({ dateOfBirth: '2005-10-10' }) });
    const result = ageRule.evaluate(context, basePolicyRules({ minAge: 21 }));
    expect(result.outcome).toBe('PASS');
  });
});
