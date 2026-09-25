import { describe, expect, it } from 'vitest';
import { baseContext, basePolicyRules } from '../test/fixtures.js';
import { locationRule } from './locationRule.js';

const DUBAI_MARINA = {
  raw: 'Dubai Marina',
  normalized: 'Dubai Marina',
  city: 'Dubai',
  country: 'AE',
  timezone: 'Asia/Dubai',
  locationType: 'CITY_AREA' as const,
};

const SHARJAH_ADDRESS = {
  raw: 'Al Majaz, Sharjah',
  normalized: 'Al Majaz, Sharjah',
  city: 'Sharjah',
  country: 'AE',
  timezone: 'Asia/Dubai',
  locationType: 'ADDRESS' as const,
};

describe('locationRule', () => {
  it('passes when no restriction is configured', () => {
    const context = baseContext({ pickupLocation: DUBAI_MARINA });
    const result = locationRule.evaluate(context, basePolicyRules());
    expect(result.outcome).toBe('PASS');
  });

  it('passes when the location has not been resolved yet', () => {
    const context = baseContext({ pickupLocation: null, dropoffLocation: null });
    const result = locationRule.evaluate(
      context,
      basePolicyRules({ restrictedCities: ['Sharjah'] }),
    );
    expect(result.outcome).toBe('PASS');
  });

  it('fails a restricted pickup city, case-insensitively', () => {
    const context = baseContext({ pickupLocation: SHARJAH_ADDRESS });
    const result = locationRule.evaluate(
      context,
      basePolicyRules({ restrictedCities: ['sharjah'] }),
    );
    expect(result.outcome).toBe('FAIL');
    expect(result.message).toMatch(/Sharjah/);
  });

  it('fails a restricted dropoff city even when the pickup city is fine', () => {
    const context = baseContext({ pickupLocation: DUBAI_MARINA, dropoffLocation: SHARJAH_ADDRESS });
    const result = locationRule.evaluate(
      context,
      basePolicyRules({ restrictedCities: ['Sharjah'] }),
    );
    expect(result.outcome).toBe('FAIL');
  });
});
