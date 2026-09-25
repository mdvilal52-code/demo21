import { describe, expect, it } from 'vitest';
import { baseContext, baseCustomer, basePolicyRules } from '../test/fixtures.js';
import { licenseRule } from './licenseRule.js';

describe('licenseRule', () => {
  it('passes a valid license of an accepted type', () => {
    const context = baseContext({
      customer: baseCustomer({ hasValidLicense: true, licenseType: 'UAE' }),
    });
    const result = licenseRule.evaluate(context, basePolicyRules());
    expect(result.outcome).toBe('PASS');
  });

  it('fails when no valid license was declared (missing license)', () => {
    const context = baseContext({ customer: baseCustomer({ hasValidLicense: false }) });
    const result = licenseRule.evaluate(context, basePolicyRules());
    expect(result.outcome).toBe('FAIL');
    expect(result.message).toMatch(/no valid driving license/i);
  });

  it('fails when the license type is not accepted (invalid license)', () => {
    const context = baseContext({
      customer: baseCustomer({ hasValidLicense: true, licenseType: 'FOREIGN' }),
    });
    const result = licenseRule.evaluate(
      context,
      basePolicyRules({ requiredLicenseTypes: ['UAE', 'GCC', 'IDP'] }),
    );
    expect(result.outcome).toBe('FAIL');
    expect(result.message).toMatch(/not accepted/i);
  });
});
