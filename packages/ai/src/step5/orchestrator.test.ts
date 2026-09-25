import { describe, expect, it } from 'vitest';
import { baseContext, baseCustomer, baseException, basePolicy, URUS } from './test/fixtures.js';
import { EligibilityOrchestrator } from './orchestrator.js';

function makeOrchestrator(): EligibilityOrchestrator {
  return new EligibilityOrchestrator();
}

describe('EligibilityOrchestrator', () => {
  it('is ELIGIBLE for a valid customer who passes every rule', () => {
    const context = baseContext({ vehicle: URUS });
    const decision = makeOrchestrator().evaluate(context, basePolicy(), []);

    expect(decision.status).toBe('ELIGIBLE');
    expect(decision.ruleResults).toHaveLength(7);
    expect(decision.ruleResults.every((result) => result.outcome === 'PASS')).toBe(true);
    expect(decision.exceptionsApplied).toEqual([]);
    expect(decision.policyConflicts).toEqual([]);
    expect(decision.flags.policyConflictDetected).toBe(false);
    expect(decision.policyId).toBe(basePolicy().id);
  });

  it('is INELIGIBLE for an underage customer with no applicable exception', () => {
    const context = baseContext({ customer: baseCustomer({ dateOfBirth: '2010-01-01' }) });
    const decision = makeOrchestrator().evaluate(context, basePolicy(), []);

    expect(decision.status).toBe('INELIGIBLE');
    const ageResult = decision.ruleResults.find((result) => result.category === 'AGE');
    expect(ageResult?.outcome).toBe('FAIL');
    expect(decision.reason).toMatch(/ineligible/i);
  });

  it('is INELIGIBLE when no valid license was declared (missing license)', () => {
    const context = baseContext({ customer: baseCustomer({ hasValidLicense: false }) });
    const decision = makeOrchestrator().evaluate(context, basePolicy(), []);

    expect(decision.status).toBe('INELIGIBLE');
    const licenseResult = decision.ruleResults.find((result) => result.category === 'LICENSE');
    expect(licenseResult?.outcome).toBe('FAIL');
    expect(licenseResult?.message).toMatch(/no valid driving license/i);
  });

  it('is INELIGIBLE for a license type the tenant does not accept (invalid license)', () => {
    const context = baseContext({
      customer: baseCustomer({ hasValidLicense: true, licenseType: 'FOREIGN' }),
    });
    const decision = makeOrchestrator().evaluate(context, basePolicy(), []);

    expect(decision.status).toBe('INELIGIBLE');
    const licenseResult = decision.ruleResults.find((result) => result.category === 'LICENSE');
    expect(licenseResult?.outcome).toBe('FAIL');
    expect(licenseResult?.message).toMatch(/not accepted/i);
  });

  it('auto-applies a LOW-risk nationality exception and becomes ELIGIBLE', () => {
    const context = baseContext({ customer: baseCustomer({ nationality: 'XX' }) });
    const policy = basePolicy({
      nationalityRules: { blockedNationalities: ['XX'], allowedNationalitiesOnly: [] },
    });
    const exception = baseException({
      id: '33333333-3333-3333-3333-333333333333',
      type: 'NATIONALITY_OVERRIDE',
      scopeNationality: 'XX',
      waivedCategories: ['NATIONALITY'],
      riskLevel: 'LOW',
      reason: 'Pre-approved market despite the default blocklist.',
    });

    const decision = makeOrchestrator().evaluate(context, policy, [exception]);

    expect(decision.status).toBe('ELIGIBLE');
    expect(decision.exceptionsApplied).toEqual([
      {
        exceptionId: '33333333-3333-3333-3333-333333333333',
        type: 'NATIONALITY_OVERRIDE',
        categoriesWaived: ['NATIONALITY'],
        riskLevel: 'LOW',
        autoApplied: true,
      },
    ]);
    const nationalityResult = decision.ruleResults.find(
      (result) => result.category === 'NATIONALITY',
    );
    expect(nationalityResult?.outcome).toBe('WAIVED');
  });

  it('never auto-applies a HIGH-risk VIP exception — escalates to NEEDS_HUMAN_REVIEW instead', () => {
    // Underage, but a VIP exception waiving AGE exists for this customer.
    // "High-risk exceptions -> human": it must never silently make this
    // customer ELIGIBLE on its own.
    const context = baseContext({
      customer: baseCustomer({ dateOfBirth: '2010-01-01' }),
      customerRef: 'vip-customer-1',
    });
    const exception = baseException({
      id: '44444444-4444-4444-4444-444444444444',
      type: 'VIP',
      scopeCustomerRef: 'vip-customer-1',
      waivedCategories: ['AGE'],
      riskLevel: 'HIGH',
      reason: 'VIP customer requesting an age exception.',
    });

    const decision = makeOrchestrator().evaluate(context, basePolicy(), [exception]);

    expect(decision.status).toBe('NEEDS_HUMAN_REVIEW');
    expect(decision.exceptionsApplied).toEqual([
      {
        exceptionId: '44444444-4444-4444-4444-444444444444',
        type: 'VIP',
        categoriesWaived: ['AGE'],
        riskLevel: 'HIGH',
        autoApplied: false,
      },
    ]);
    const ageResult = decision.ruleResults.find((result) => result.category === 'AGE');
    expect(ageResult?.outcome).toBe('REQUIRES_REVIEW');
  });

  it('an unwaivable failure elsewhere still wins over a pending high-risk exception', () => {
    // Underage (VIP-exempted) AND missing a valid license (no exception) —
    // the categorical, unwaivable LICENSE failure must decide the outcome.
    const context = baseContext({
      customer: baseCustomer({ dateOfBirth: '2010-01-01', hasValidLicense: false }),
      customerRef: 'vip-customer-1',
    });
    const exception = baseException({
      type: 'VIP',
      scopeCustomerRef: 'vip-customer-1',
      waivedCategories: ['AGE'],
      riskLevel: 'HIGH',
    });

    const decision = makeOrchestrator().evaluate(context, basePolicy(), [exception]);
    expect(decision.status).toBe('INELIGIBLE');
  });

  it('fails safe to NEEDS_HUMAN_REVIEW when the tenant policy itself has a conflict', () => {
    const policy = basePolicy({
      nationalityRules: { blockedNationalities: ['XX'], allowedNationalitiesOnly: ['XX', 'AE'] },
    });
    const context = baseContext();

    const decision = makeOrchestrator().evaluate(context, policy, []);

    expect(decision.status).toBe('NEEDS_HUMAN_REVIEW');
    expect(decision.flags.policyConflictDetected).toBe(true);
    expect(decision.policyConflicts).toHaveLength(1);
    expect(decision.policyConflicts[0]?.code).toBe('NATIONALITY_IN_BOTH_LISTS');
    // No rule was evaluated against a policy we already know is inconsistent.
    expect(decision.ruleResults).toEqual([]);
  });

  it('every decision carries the policy id/version it was evaluated against (auditable)', () => {
    const policy = basePolicy();
    const decision = makeOrchestrator().evaluate(baseContext(), policy, []);
    expect(decision.policyId).toBe(policy.id);
    expect(decision.policyVersion).toBe(policy.version);
    expect(decision.modelMetadata.deterministic).toBe(true);
  });
});
