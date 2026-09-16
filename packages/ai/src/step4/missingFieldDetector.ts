import {
  MissingInfoFieldKey,
  OPTIONAL_MISSING_INFO_FIELDS,
  type MissingInfoAnswer,
  type MissingInfoFieldKeyValue,
} from '@ai-concierge/domain';
import { isFieldRequired, type FieldRequirementContext } from './fieldRequirementRules.js';

/** Priority order questions are surfaced in — required fields first, optional last. */
const FIELD_PRIORITY: MissingInfoFieldKeyValue[] = [
  MissingInfoFieldKey.DRIVER_REQUIREMENT,
  MissingInfoFieldKey.FLIGHT_NUMBER,
  MissingInfoFieldKey.PICKUP_TIME,
  MissingInfoFieldKey.DROPOFF_ADDRESS,
  MissingInfoFieldKey.CONTACT_DETAILS,
  MissingInfoFieldKey.SPECIAL_REQUESTS,
];

export interface DetectMissingFieldsInput {
  context: FieldRequirementContext;
  /** The conversation's current known answers (Step 1 + any Step 4 customer replies). */
  answers: MissingInfoAnswer[];
}

export interface DetectMissingFieldsOutput {
  /** Required and not yet known — this is what blocks `status: COMPLETE`. */
  missingFields: MissingInfoFieldKeyValue[];
  /** Optional and not yet known — never blocks completion. */
  unansweredOptionalFields: MissingInfoFieldKeyValue[];
}

/**
 * The sole deterministic authority on "genuinely missing" — mirrors
 * TemporalValidationService/VehicleValidationService's role in Steps 2-3.
 * A field already present in `answers` (from any source) is never
 * reported as missing, however it got there.
 */
export class MissingFieldDetector {
  detect(input: DetectMissingFieldsInput): DetectMissingFieldsOutput {
    const answeredFields = new Set(input.answers.map((answer) => answer.field));
    const missingFields: MissingInfoFieldKeyValue[] = [];
    const unansweredOptionalFields: MissingInfoFieldKeyValue[] = [];

    for (const field of FIELD_PRIORITY) {
      if (answeredFields.has(field)) continue;

      if (OPTIONAL_MISSING_INFO_FIELDS.includes(field)) {
        unansweredOptionalFields.push(field);
        continue;
      }

      if (isFieldRequired(field, input.context)) {
        missingFields.push(field);
      }
    }

    return { missingFields, unansweredOptionalFields };
  }
}
