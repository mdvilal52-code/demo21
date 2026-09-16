import type { Ambiguity } from '@ai-concierge/domain';
import { KNOWN_UNSERVICED_CITIES } from './gazetteer.js';
import type { LocationCandidate, LocationProvider } from './locationProvider.js';

/** "in/at/from/to/near/pickup/dropoff <Capitalized Phrase>" — a location was clearly *mentioned*. */
const LOCATION_PHRASE_RE =
  /\b(?:in|at|from|to|near|pick(?:\s*-?\s*up)?(?:\s+(?:at|in|from))?|drop(?:\s*-?\s*off)?(?:\s+(?:at|to|in))?)\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,3})/g;

interface TextRange {
  start: number;
  end: number;
}

function rangesOverlap(a: TextRange, b: TextRange): boolean {
  return a.start < b.end && a.end > b.start;
}

interface UnmatchedPhrases {
  /** A real, known place name — just outside the current service area. */
  unsupported: string[];
  /** Looks like a location mention but isn't recognized as a place at all. */
  unrecognized: string[];
}

function findUnmatchedLocationPhrases(
  text: string,
  resolved: LocationCandidate[],
): UnmatchedPhrases {
  const resolvedRanges: TextRange[] = resolved.map((candidate) => ({
    start: candidate.matchIndex,
    end: candidate.matchIndex + candidate.raw.length,
  }));

  const result: UnmatchedPhrases = { unsupported: [], unrecognized: [] };
  for (const match of text.matchAll(LOCATION_PHRASE_RE)) {
    const phrase = match[1];
    if (!phrase) continue;
    const phraseStart = match.index + match[0].length - phrase.length;
    const phraseRange: TextRange = { start: phraseStart, end: phraseStart + phrase.length };
    const alreadyResolved = resolvedRanges.some((range) => rangesOverlap(range, phraseRange));
    if (alreadyResolved) continue;

    if (KNOWN_UNSERVICED_CITIES.has(phrase.toLowerCase())) {
      result.unsupported.push(phrase);
    } else {
      result.unrecognized.push(phrase);
    }
  }
  return result;
}

export interface LocationExtractionOutcome {
  pickupLocation: LocationCandidate | null;
  dropoffLocation: LocationCandidate | null;
  ambiguities: Ambiguity[];
  /** Real, known cities mentioned outside the current service area (see gazetteer.ts). */
  unsupportedLocationMentions: string[];
}

/**
 * AI-side proposal step: finds location mentions via the injected
 * `LocationProvider` and makes a best-effort pickup/dropoff assignment by
 * reading order. It never invents a location that wasn't in the text, and
 * it flags (rather than silently drops) a location-shaped phrase it
 * couldn't resolve — `TemporalValidationService` decides what that means
 * for the overall result.
 */
export class LocationExtractionService {
  constructor(private readonly provider: LocationProvider) {}

  async extract(sanitizedText: string): Promise<LocationExtractionOutcome> {
    const candidates = await this.provider.resolve(sanitizedText);
    const unmatched = findUnmatchedLocationPhrases(sanitizedText, candidates);
    const ambiguities: Ambiguity[] = unmatched.unrecognized.map((phrase) => ({
      field: 'pickupLocation' as const,
      code: 'UNRECOGNIZED_LOCATION_TEXT' as const,
      message: `"${phrase}" was not recognized as a location`,
      raw: phrase,
    }));

    if (candidates.length === 0) {
      return {
        pickupLocation: null,
        dropoffLocation: null,
        ambiguities,
        unsupportedLocationMentions: unmatched.unsupported,
      };
    }
    if (candidates.length === 1) {
      return {
        pickupLocation: candidates[0]!,
        dropoffLocation: null,
        ambiguities,
        unsupportedLocationMentions: unmatched.unsupported,
      };
    }

    if (candidates.length > 2) {
      ambiguities.push({
        field: 'dropoffLocation',
        code: 'MULTIPLE_CANDIDATE_LOCATIONS',
        message: `${candidates.length} distinct locations were mentioned; using the first two in reading order as pickup and dropoff`,
      });
    }

    return {
      pickupLocation: candidates[0]!,
      dropoffLocation: candidates[1]!,
      ambiguities,
      unsupportedLocationMentions: unmatched.unsupported,
    };
  }
}
