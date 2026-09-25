import type {
  DriverInput,
  EligibilityCustomerInput,
  EligibilityPolicyRules,
  EligibilityRuleCategoryValue,
  NormalizedLocation,
  Vehicle,
} from '@ai-concierge/domain';

/**
 * Step 5 — Eligibility. Everything this orchestrator needs, already
 * validated: `customer`/`additionalDrivers` are request-boundary input Zod
 * validated at the API layer (this step is the first to collect them, so
 * there is no prior step to have verified them already); `vehicle`/
 * `pickupDate`/`returnDate`/`pickupLocation`/`dropoffLocation` are read from
 * whatever Steps 2-3 already resolved and verified for the conversation —
 * never re-derived here, matching Step 4's convention exactly.
 */
export interface EligibilityCheckContext {
  customer: EligibilityCustomerInput;
  additionalDrivers: DriverInput[];
  /** The conversation's customerRef — used to match customer-scoped exceptions (VIP/AGE_OVERRIDE/MANUAL_GRANT). */
  customerRef: string;
  vehicle: Vehicle | null;
  pickupDate: string | null;
  returnDate: string | null;
  pickupLocation: NormalizedLocation | null;
  dropoffLocation: NormalizedLocation | null;
  now: Date;
}

export interface EligibilityRuleVerdict {
  outcome: 'PASS' | 'FAIL';
  message: string;
}

/**
 * A single, named, independently testable policy check. Pure and
 * synchronous — every rule reads only `context` and the tenant's configured
 * `policy`, never a database, the network, or an AI call. This is the unit
 * `docs/PHASE-CONTRACTS.json`/CLAUDE.md mean by "EligibilityRule":
 * deterministic and configurable (every threshold/list it reads comes from
 * `policy`, fixed code only implements how to check it).
 */
export interface EligibilityRule {
  readonly id: string;
  readonly category: EligibilityRuleCategoryValue;
  evaluate(
    context: EligibilityCheckContext,
    policy: EligibilityPolicyRules,
  ): EligibilityRuleVerdict;
}
