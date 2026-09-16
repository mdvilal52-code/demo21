import { DEFAULT_SERVICE_TIMEZONE, type DateLocationExtractionResult } from '@ai-concierge/domain';
import { sanitizeForProcessing } from '../sanitize.js';
import { DateExtractionService } from './dateExtractionService.js';
import { GazetteerLocationProvider } from './gazetteerLocationProvider.js';
import { LocationExtractionService } from './locationExtractionService.js';
import type { LocationProvider } from './locationProvider.js';
import { ResilientLocationProvider } from './resilientLocationProvider.js';
import { TemporalValidationService } from './temporalValidationService.js';

export interface ExtractDatesAndLocationOptions {
  referenceDate?: Date;
  locationProvider?: LocationProvider;
}

/**
 * Step 2 — Extract Dates & Location. Wires the AI-side proposal services
 * (`DateExtractionService`, `LocationExtractionService`) to the
 * deterministic `TemporalValidationService`, matching Phase 1's rule: AI
 * proposes, deterministic domain logic verifies. Input is the raw message
 * text from a Phase 1 conversation/message; output is always
 * `dateLocationExtractionResultSchema`-valid.
 */
export class DateLocationExtractionOrchestrator {
  private readonly dateExtractionService = new DateExtractionService();
  private readonly locationExtractionService: LocationExtractionService;
  private readonly temporalValidationService = new TemporalValidationService();

  constructor(options: ExtractDatesAndLocationOptions = {}) {
    const provider =
      options.locationProvider ?? new ResilientLocationProvider(new GazetteerLocationProvider());
    this.locationExtractionService = new LocationExtractionService(provider);
  }

  async extract(
    rawMessage: string,
    options: ExtractDatesAndLocationOptions = {},
  ): Promise<DateLocationExtractionResult> {
    const referenceDate = options.referenceDate ?? new Date();
    const { promptInjectionDetected, sanitizedText } = sanitizeForProcessing(rawMessage);

    const locationOutcome = await this.locationExtractionService.extract(sanitizedText);
    const timezone = locationOutcome.pickupLocation?.timezone ?? DEFAULT_SERVICE_TIMEZONE;

    const dateOutcome = this.dateExtractionService.extract(sanitizedText, {
      referenceDate,
      timezone,
    });

    return this.temporalValidationService.validate({
      rawText: sanitizedText,
      dateOutcome,
      locationOutcome,
      referenceDate,
      timezone,
      promptInjectionDetected,
    });
  }
}
