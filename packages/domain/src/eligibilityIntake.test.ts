import { describe, expect, it } from 'vitest';
import {
  EligibilityIntakeField,
  createEmptyEligibilityIntake,
  findMissingEligibilityFields,
  toEligibilityCustomerInput,
  type EligibilityIntake,
} from './eligibilityIntake.js';

const COMPLETE: EligibilityIntake = {
  dateOfBirth: '1990-05-12',
  nationality: 'in',
  licenseType: 'UAE',
  hasValidLicense: true,
  passportProvided: true,
};

describe('eligibility intake', () => {
  it('starts with every field missing', () => {
    expect(findMissingEligibilityFields(createEmptyEligibilityIntake())).toEqual([
      EligibilityIntakeField.DATE_OF_BIRTH,
      EligibilityIntakeField.NATIONALITY,
      EligibilityIntakeField.LICENSE_TYPE,
      EligibilityIntakeField.LICENSE_VALID,
      EligibilityIntakeField.PASSPORT,
    ]);
    expect(toEligibilityCustomerInput(createEmptyEligibilityIntake())).toBeNull();
  });

  it('is complete once all five facts are valid, normalising the nationality code', () => {
    expect(findMissingEligibilityFields(COMPLETE)).toEqual([]);
    expect(toEligibilityCustomerInput(COMPLETE)).toEqual({
      dateOfBirth: '1990-05-12',
      nationality: 'IN',
      licenseType: 'UAE',
      hasValidLicense: true,
      passportProvided: true,
    });
  });

  it('counts a present-but-invalid value as missing, never as complete', () => {
    expect(findMissingEligibilityFields({ ...COMPLETE, dateOfBirth: '1990-02-31' })).toEqual([
      EligibilityIntakeField.DATE_OF_BIRTH,
    ]);
    expect(findMissingEligibilityFields({ ...COMPLETE, dateOfBirth: '2999-01-01' })).toEqual([
      EligibilityIntakeField.DATE_OF_BIRTH,
    ]);
    expect(findMissingEligibilityFields({ ...COMPLETE, nationality: 'India' })).toEqual([
      EligibilityIntakeField.NATIONALITY,
    ]);
  });

  it('keeps "missing" and "complete" in agreement', () => {
    for (const patch of [
      { licenseType: null },
      { hasValidLicense: null },
      { passportProvided: null },
      { dateOfBirth: null },
      { nationality: null },
    ]) {
      const intake = { ...COMPLETE, ...patch } as EligibilityIntake;
      expect(findMissingEligibilityFields(intake).length).toBe(1);
      expect(toEligibilityCustomerInput(intake)).toBeNull();
    }
  });
});
