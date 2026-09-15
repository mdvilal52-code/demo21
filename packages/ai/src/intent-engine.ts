import {
  BOOKING_REQUIRED_FIELDS,
  CONFIDENCE_THRESHOLD,
  IntentStatus,
  IntentType,
  Urgency,
  intentResultSchema,
  type ExtractedEntities,
  type IntentResult,
  type IntentTypeValue,
} from '@ai-concierge/domain';
import { extractDates } from './dates.js';
import {
  DRIVER_REQUIRED_KEYWORDS,
  HIGH_URGENCY_KEYWORDS,
  INTENT_KEYWORDS,
  LOCATION_KEYWORDS,
  MEDIUM_URGENCY_KEYWORDS,
  SELF_DRIVE_KEYWORDS,
  VEHICLE_KEYWORDS,
} from './lexicon.js';
import { sanitizeForProcessing } from './sanitize.js';

export interface IntentEngine {
  recognize(message: string, options?: { referenceDate?: Date }): IntentResult;
}

const ARABIC_RE = /[؀-ۿ]/;
const DEVANAGARI_RE = /[ऀ-ॿ]/;

function detectLanguage(text: string): string {
  if (ARABIC_RE.test(text)) return 'ar';
  if (DEVANAGARI_RE.test(text)) return 'hi';
  return 'en';
}

function detectUrgency(lowerText: string): (typeof Urgency)[keyof typeof Urgency] {
  if (HIGH_URGENCY_KEYWORDS.some((keyword) => lowerText.includes(keyword))) return Urgency.HIGH;
  if (MEDIUM_URGENCY_KEYWORDS.some((keyword) => lowerText.includes(keyword))) return Urgency.MEDIUM;
  return Urgency.LOW;
}

function findFirstKeyword(lowerText: string, keywords: string[]): string | undefined {
  return keywords.find((keyword) => lowerText.includes(keyword));
}

function countMatches(lowerText: string, keywords: string[]): number {
  return keywords.reduce((count, keyword) => (lowerText.includes(keyword) ? count + 1 : count), 0);
}

interface Classification {
  intentType: IntentTypeValue;
  keywordScore: number;
}

function classifyIntentType(lowerText: string): Classification {
  let best: Classification = { intentType: IntentType.UNKNOWN, keywordScore: 0 };
  for (const [intentType, keywords] of Object.entries(INTENT_KEYWORDS) as [
    Exclude<IntentTypeValue, 'UNKNOWN'>,
    string[],
  ][]) {
    const score = countMatches(lowerText, keywords);
    if (score > best.keywordScore) {
      best = { intentType, keywordScore: score };
    }
  }
  return best;
}

export class RuleBasedIntentEngine implements IntentEngine {
  recognize(message: string, options: { referenceDate?: Date } = {}): IntentResult {
    const referenceDate = options.referenceDate ?? new Date();
    const { promptInjectionDetected, sanitizedText } = sanitizeForProcessing(message);
    const lowerText = sanitizedText.toLowerCase();

    const language = detectLanguage(message);
    const urgency = detectUrgency(lowerText);
    const vehicleIntent = findFirstKeyword(lowerText, VEHICLE_KEYWORDS);
    const location = findFirstKeyword(lowerText, LOCATION_KEYWORDS);
    const { pickupDate, returnDate, ambiguousDateMentioned } = extractDates(
      sanitizedText,
      referenceDate,
    );

    const passengerMatch = /\b(\d{1,2})\s*(passengers?|people|persons?|pax|seats?)\b/i.exec(
      sanitizedText,
    );
    const passengerCount = passengerMatch ? Number(passengerMatch[1]) : undefined;

    let driverRequired: boolean | undefined;
    if (DRIVER_REQUIRED_KEYWORDS.some((keyword) => lowerText.includes(keyword))) {
      driverRequired = true;
    } else if (SELF_DRIVE_KEYWORDS.some((keyword) => lowerText.includes(keyword))) {
      driverRequired = false;
    }

    const { intentType, keywordScore } = classifyIntentType(lowerText);

    const entities: ExtractedEntities = {
      ...(vehicleIntent ? { vehicleIntent } : {}),
      ...(pickupDate ? { pickupDate: pickupDate.toISOString() } : {}),
      ...(returnDate ? { returnDate: returnDate.toISOString() } : {}),
      ...(location ? { location } : {}),
      ...(passengerCount ? { passengerCount } : {}),
      ...(driverRequired !== undefined ? { driverRequired } : {}),
      language,
      urgency,
    };

    let confidence: number;
    if (intentType === IntentType.UNKNOWN) {
      confidence = 0.9;
    } else {
      confidence = 0.3 + Math.min(keywordScore, 3) * 0.2;
      if (vehicleIntent) confidence += 0.1;
      if (pickupDate) confidence += 0.1;
      confidence = Math.min(confidence, 0.98);
    }
    if (ambiguousDateMentioned && !pickupDate) {
      confidence = Math.max(0, confidence - 0.15);
    }

    const missingFields =
      intentType === IntentType.BOOKING_REQUEST
        ? BOOKING_REQUIRED_FIELDS.filter((field) => entities[field] === undefined)
        : [];

    const needsClarification = confidence < CONFIDENCE_THRESHOLD || missingFields.length > 0;

    let clarificationPrompt: string | undefined;
    if (needsClarification) {
      clarificationPrompt =
        missingFields.length > 0
          ? `Could you share the following to proceed: ${missingFields.join(', ')}?`
          : 'Could you clarify what you would like help with?';
    }

    const result: IntentResult = {
      intentType,
      status: needsClarification ? IntentStatus.NEEDS_CLARIFICATION : IntentStatus.RECOGNIZED,
      confidence: Number(confidence.toFixed(2)),
      entities,
      missingFields,
      ...(clarificationPrompt ? { clarificationPrompt } : {}),
      flags: { promptInjectionDetected },
      modelMetadata: {
        engine: 'rule-based-v1',
        version: '0.1.0',
        deterministic: true,
      },
    };

    return intentResultSchema.parse(result);
  }
}
