import { describe, expect, it } from 'vitest';
import { baseException } from './test/fixtures.js';
import { resolveWithExceptions } from './exceptionResolver.js';

const FAILED_AGE_RESULT = {
  ruleId: 'age-minimum',
  category: 'AGE' as const,
  outcome: 'FAIL' as const,
  message: 'Minimum age is 21; customer is 19.',
};

describe('resolveWithExceptions', () => {
  it('returns a PASS result unchanged even if an exception would otherwise match', () => {
    const passResult = { ...FAILED_AGE_RESULT, outcome: 'PASS' as const };
    const { ruleResult, applied } = resolveWithExceptions(passResult, [
      baseException({ waivedCategories: ['AGE'], riskLevel: 'LOW' }),
    ]);
    expect(ruleResult).toEqual(passResult);
    expect(applied).toBeUndefined();
  });

  it('leaves a FAIL result unchanged when no exception covers its category', () => {
    const { ruleResult, applied } = resolveWithExceptions(FAILED_AGE_RESULT, [
      baseException({ waivedCategories: ['NATIONALITY'], riskLevel: 'LOW' }),
    ]);
    expect(ruleResult.outcome).toBe('FAIL');
    expect(applied).toBeUndefined();
  });

  it('auto-waives a FAIL when a LOW-risk exception covers its category', () => {
    const exception = baseException({ id: 'exc-1', waivedCategories: ['AGE'], riskLevel: 'LOW' });
    const { ruleResult, applied } = resolveWithExceptions(FAILED_AGE_RESULT, [exception]);
    expect(ruleResult.outcome).toBe('WAIVED');
    expect(ruleResult.waivedByExceptionId).toBe('exc-1');
    expect(applied).toEqual({
      exceptionId: 'exc-1',
      type: exception.type,
      categoriesWaived: ['AGE'],
      riskLevel: 'LOW',
      autoApplied: true,
    });
  });

  it('never auto-applies a HIGH-risk exception — marks REQUIRES_REVIEW instead', () => {
    const exception = baseException({ id: 'exc-2', waivedCategories: ['AGE'], riskLevel: 'HIGH' });
    const { ruleResult, applied } = resolveWithExceptions(FAILED_AGE_RESULT, [exception]);
    expect(ruleResult.outcome).toBe('REQUIRES_REVIEW');
    expect(applied?.autoApplied).toBe(false);
  });
});
