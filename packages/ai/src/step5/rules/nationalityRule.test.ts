import { describe, expect, it } from 'vitest';
import { baseContext, baseCustomer, basePolicyRules } from '../test/fixtures.js';
import { nationalityRule } from './nationalityRule.js';

describe('nationalityRule', () => {
  it('passes a nationality that is neither blocked nor excluded from an allowlist', () => {
    const context = baseContext({ customer: baseCustomer({ nationality: 'AE' }) });
    const result = nationalityRule.evaluate(context, basePolicyRules());
    expect(result.outcome).toBe('PASS');
  });

  it('fails a blocked nationality', () => {
    const context = baseContext({ customer: baseCustomer({ nationality: 'XX' }) });
    const result = nationalityRule.evaluate(
      context,
      basePolicyRules({
        nationalityRules: { blockedNationalities: ['XX'], allowedNationalitiesOnly: [] },
      }),
    );
    expect(result.outcome).toBe('FAIL');
    expect(result.message).toMatch(/restricted/i);
  });

  it('fails a nationality not in a non-empty allowlist', () => {
    const context = baseContext({ customer: baseCustomer({ nationality: 'FR' }) });
    const result = nationalityRule.evaluate(
      context,
      basePolicyRules({
        nationalityRules: { blockedNationalities: [], allowedNationalitiesOnly: ['AE', 'GB'] },
      }),
    );
    expect(result.outcome).toBe('FAIL');
    expect(result.message).toMatch(/permitted list/i);
  });

  it('passes a nationality that is in a non-empty allowlist', () => {
    const context = baseContext({ customer: baseCustomer({ nationality: 'GB' }) });
    const result = nationalityRule.evaluate(
      context,
      basePolicyRules({
        nationalityRules: { blockedNationalities: [], allowedNationalitiesOnly: ['AE', 'GB'] },
      }),
    );
    expect(result.outcome).toBe('PASS');
  });
});
