import {
  dateLocationExtractionResultSchema,
  type Ambiguity,
  type DateLocationExtractionResult,
  type NormalizedLocation,
  type ValidationIssue,
} from '@ai-concierge/domain';
import { isBeforeCalendarDay } from './calendarDay.js';
import type { DateExtractionOutcome } from './dateExtractionService.js';
import type { LocationExtractionOutcome } from './locationExtractionService.js';
import type { LocationCandidate } from './locationProvider.js';
import { findExplicitTimezoneMention, getUtcOffsetMinutesAt } from './timezoneMismatch.js';

export interface TemporalValidationInput {
  rawText: string;
  dateOutcome: DateExtractionOutcome;
  locationOutcome: LocationExtractionOutcome;
  referenceDate: Date;
  timezone: string;
  promptInjectionDetected: boolean;
}

function toNormalizedLocation(candidate: LocationCandidate): NormalizedLocation {
  return {
    raw: candidate.raw,
    normalized: candidate.normalized,
    city: candidate.city,
    country: candidate.country,
    timezone: candidate.timezone,
    locationType: candidate.locationType,
  };
}

/**
 * The deterministic verifier: `DateExtractionService` and
 * `LocationExtractionService` only *propose*. This is what actually decides
 * whether pickup/return dates make business sense (not in the past, return
 * after pickup, no calendar-impossible date, no conflicting timezone) and
 * assembles the one result the rest of the system is allowed to trust —
 * always re-validated against the shared Zod schema before it leaves here.
 */
export class TemporalValidationService {
  validate(input: TemporalValidationInput): DateLocationExtractionResult {
    const ambiguities: Ambiguity[] = [
      ...input.dateOutcome.ambiguities,
      ...input.locationOutcome.ambiguities,
    ];
    const validationErrors: ValidationIssue[] = [];

    for (const raw of input.dateOutcome.impossibleDateMentions) {
      validationErrors.push({
        field: 'pickupDate',
        code: 'IMPOSSIBLE_DATE',
        message: `"${raw}" is not a valid calendar date`,
        severity: 'ERROR',
      });
    }
    for (const raw of input.locationOutcome.unsupportedLocationMentions) {
      validationErrors.push({
        field: 'pickupLocation',
        code: 'UNSUPPORTED_LOCATION',
        message: `"${raw}" is a recognized city outside the current service area`,
        severity: 'ERROR',
      });
    }

    const { pickupDate, returnDate } = input.dateOutcome;

    if (pickupDate && isBeforeCalendarDay(pickupDate, input.referenceDate, input.timezone)) {
      validationErrors.push({
        field: 'pickupDate',
        code: 'PAST_DATE',
        message: 'Pickup date is in the past',
        severity: 'ERROR',
      });
    }

    if (pickupDate && returnDate && returnDate.getTime() <= pickupDate.getTime()) {
      validationErrors.push({
        field: 'returnDate',
        code: 'RETURN_BEFORE_OR_EQUAL_PICKUP',
        message: 'Return date must be strictly after the pickup date',
        severity: 'ERROR',
      });
    }

    const explicitTimezone = findExplicitTimezoneMention(input.rawText);
    if (explicitTimezone && pickupDate) {
      const resolvedOffset = getUtcOffsetMinutesAt(pickupDate, input.timezone);
      if (explicitTimezone.offsetMinutes !== resolvedOffset) {
        validationErrors.push({
          field: 'timezone',
          code: 'TIMEZONE_MISMATCH',
          message: `Message mentions "${explicitTimezone.raw}" but the pickup location's timezone (${input.timezone}) differs`,
          severity: 'WARNING',
        });
      }
    }

    const pickupLocation = input.locationOutcome.pickupLocation
      ? toNormalizedLocation(input.locationOutcome.pickupLocation)
      : null;
    const dropoffLocation = input.locationOutcome.dropoffLocation
      ? toNormalizedLocation(input.locationOutcome.dropoffLocation)
      : null;

    const errorCount = validationErrors.filter((issue) => issue.severity === 'ERROR').length;
    const warningCount = validationErrors.filter((issue) => issue.severity === 'WARNING').length;
    let confidence = 1;
    confidence -= ambiguities.length * 0.15;
    confidence -= errorCount * 0.2;
    confidence -= warningCount * 0.05;
    if (!pickupDate) confidence -= 0.2;
    if (!pickupLocation) confidence -= 0.1;
    confidence = Math.max(0, Math.min(1, confidence));

    const result: DateLocationExtractionResult = {
      pickupDate: pickupDate?.toISOString() ?? null,
      returnDate: returnDate?.toISOString() ?? null,
      timezone: input.timezone,
      pickupLocation,
      dropoffLocation,
      locationType: pickupLocation?.locationType ?? dropoffLocation?.locationType ?? null,
      confidence: Number(confidence.toFixed(2)),
      ambiguities,
      validationErrors,
      flags: { promptInjectionDetected: input.promptInjectionDetected },
      modelMetadata: { engine: 'temporal-validation-v1', version: '0.1.0', deterministic: true },
    };

    return dateLocationExtractionResultSchema.parse(result);
  }
}
