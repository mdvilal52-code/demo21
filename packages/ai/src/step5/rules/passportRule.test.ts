import { describe, expect, it } from 'vitest';
import { baseContext, baseCustomer, basePolicyRules } from '../test/fixtures.js';
import { passportRule } from './passportRule.js';

describe('passportRule', () => {
  it('passes when a passport is required and was provided', () => {
    const context = baseContext({ customer: baseCustomer({ passportProvided: true }) });
    const result = passportRule.evaluate(context, basePolicyRules({ passportRequired: true }));
    expect(result.outcome).toBe('PASS');
  });

  it('fails when a passport is required but was not provided', () => {
    const context = baseContext({ customer: baseCustomer({ passportProvided: false }) });
    const result = passportRule.evaluate(context, basePolicyRules({ passportRequired: true }));
    expect(result.outcome).toBe('FAIL');
    expect(result.message).toMatch(/passport is required/i);
  });

  it('passes when a passport is not required, regardless of whether one was provided', () => {
    const context = baseContext({ customer: baseCustomer({ passportProvided: false }) });
    const result = passportRule.evaluate(context, basePolicyRules({ passportRequired: false }));
    expect(result.outcome).toBe('PASS');
  });
});
