import {
  VehicleMatchType,
  type VehicleCategoryValue,
  type VehicleMatchTypeValue,
} from '@ai-concierge/domain';
import { CATEGORY_KEYWORDS } from './categoryKeywords.js';
import { similarityRatio } from './levenshtein.js';
import type { VehicleLexiconEntry } from './vehicleCatalogProvider.js';

export interface VehicleMentionCandidate {
  lexiconEntryId: string;
  make: string;
  model: string;
  category: VehicleCategoryValue;
  matchType: VehicleMatchTypeValue;
  matchedText: string;
  /** 1.0 for exact/brand/category matches; the typo-tolerance score for FUZZY_MATCH. */
  similarity: number;
}

export interface VehicleIntentProposal {
  /** Always one matchType, from the highest tier that produced any hits — see `propose`. */
  candidates: VehicleMentionCandidate[];
  /** A vehicle-shaped phrase that matched nothing in the fleet (for the UNKNOWN_VEHICLE message). */
  rawMention: string | null;
}

const FUZZY_SIMILARITY_THRESHOLD = 0.75;

/**
 * 2-3 word Capitalized phrases — two consecutive capitalized words together
 * are a strong proper-noun signal regardless of position (e.g. "Toyota
 * Corolla"), unlike ordinary English sentence-initial capitalization.
 */
const MULTI_WORD_CAPITALIZED_PHRASE_RE = /\b[A-Z][a-zA-Z]*(?:\s+[A-Z][a-zA-Z]*){1,2}\b/g;

/** A single Capitalized word — only meaningful as a proper-noun signal away from the very start of the sentence (see `extractVehicleShapedPhrases`). */
const SINGLE_CAPITALIZED_WORD_RE = /\b[A-Z][a-zA-Z]+\b/g;

/**
 * A generic "verb + noun phrase" fallback for a lowercase mention (e.g. "book
 * a spaceship") that the capitalized-phrase heuristic above would miss.
 */
const GENERIC_MENTION_RE =
  /\b(?:book|rent|hire|need|want)(?:\s+to\s+(?:book|rent|hire))?\s+(?:an?\s+)?([a-zA-Z][a-zA-Z\s]{1,40}?)(?=\s+(?:for|from|on|in|please|now|today|tomorrow|asap)\b|[.,!?]|$)/i;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function textMentions(text: string, phrase: string): RegExpMatchArray | null {
  return text.match(new RegExp(`\\b${escapeRegExp(phrase)}\\b`, 'i'));
}

/**
 * Multi-word capitalized phrases anywhere, plus single capitalized words
 * that are *not* the very first word of the (trimmed) text — sentence-
 * initial capitalization is grammatically mandatory in English and carries
 * no proper-noun signal on its own (e.g. "What time..." / "I want...").
 */
function extractVehicleShapedPhrases(text: string): string[] {
  const multiWord = [...text.matchAll(MULTI_WORD_CAPITALIZED_PHRASE_RE)].map((match) => match[0]);
  const singleWord = [...text.matchAll(SINGLE_CAPITALIZED_WORD_RE)]
    .filter((match) => match.index !== 0)
    .map((match) => match[0]);
  return [...multiWord, ...singleWord];
}

/**
 * AI-side proposal step: matches the (sanitized) message text against the
 * tenant's real fleet lexicon — never a hardcoded model list — so it can
 * never propose a vehicle the fleet doesn't actually carry. Tiered,
 * mutually-exclusive matching (exact model > brand only > category only >
 * typo-tolerant fuzzy), matching the distinct scenarios the business cares
 * about: naming the exact car, naming just the brand, naming just a
 * category, or a typo. `VehicleValidationService` decides what a given
 * proposal shape means for the final result.
 */
export class VehicleIntentService {
  propose(sanitizedText: string, lexicon: VehicleLexiconEntry[]): VehicleIntentProposal {
    // Strip the sanitizer's injection placeholder so it can never be
    // mistaken for a capitalized "vehicle-shaped" phrase (e.g. "REMOVED").
    const text = sanitizedText.replace(/\[REMOVED\]/g, ' ').trim();

    const exact = this.matchExactModel(text, lexicon);
    if (exact.length > 0) return { candidates: exact, rawMention: null };

    const brand = this.matchBrandOnly(text, lexicon);
    if (brand.length > 0) return { candidates: brand, rawMention: null };

    const category = this.matchCategoryOnly(text, lexicon);
    if (category.length > 0) return { candidates: category, rawMention: null };

    const fuzzy = this.matchFuzzy(text, lexicon);
    if (fuzzy.length > 0) return { candidates: fuzzy, rawMention: null };

    return { candidates: [], rawMention: this.findGenericVehiclePhrase(text) };
  }

  private matchExactModel(text: string, lexicon: VehicleLexiconEntry[]): VehicleMentionCandidate[] {
    const results: VehicleMentionCandidate[] = [];
    for (const entry of lexicon) {
      const fullMatch = textMentions(text, `${entry.make} ${entry.model}`);
      const match = fullMatch ?? textMentions(text, entry.model);
      if (match) {
        results.push({
          lexiconEntryId: entry.id,
          make: entry.make,
          model: entry.model,
          category: entry.category,
          matchType: VehicleMatchType.EXACT_MODEL,
          matchedText: match[0],
          similarity: 1,
        });
      }
    }
    return results;
  }

  private matchBrandOnly(text: string, lexicon: VehicleLexiconEntry[]): VehicleMentionCandidate[] {
    const makes = [...new Set(lexicon.map((entry) => entry.make))];
    const results: VehicleMentionCandidate[] = [];
    for (const make of makes) {
      const match = textMentions(text, make);
      if (!match) continue;
      for (const entry of lexicon.filter((e) => e.make === make)) {
        results.push({
          lexiconEntryId: entry.id,
          make: entry.make,
          model: entry.model,
          category: entry.category,
          matchType: VehicleMatchType.BRAND_ONLY,
          matchedText: match[0],
          similarity: 1,
        });
      }
    }
    return results;
  }

  private matchCategoryOnly(
    text: string,
    lexicon: VehicleLexiconEntry[],
  ): VehicleMentionCandidate[] {
    const lowerText = text.toLowerCase();
    const results: VehicleMentionCandidate[] = [];
    for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS) as [
      VehicleCategoryValue,
      string[],
    ][]) {
      const matchedKeyword = keywords.find((keyword) => lowerText.includes(keyword));
      if (!matchedKeyword) continue;
      for (const entry of lexicon.filter((e) => e.category === category)) {
        results.push({
          lexiconEntryId: entry.id,
          make: entry.make,
          model: entry.model,
          category: entry.category,
          matchType: VehicleMatchType.CATEGORY_ONLY,
          matchedText: matchedKeyword,
          similarity: 1,
        });
      }
    }
    return results;
  }

  private matchFuzzy(text: string, lexicon: VehicleLexiconEntry[]): VehicleMentionCandidate[] {
    const phrases = extractVehicleShapedPhrases(text);
    const seen = new Set<string>();
    const results: VehicleMentionCandidate[] = [];

    for (const phrase of phrases) {
      let best: { entry: VehicleLexiconEntry; similarity: number } | null = null;
      for (const entry of lexicon) {
        for (const candidate of [`${entry.make} ${entry.model}`, entry.model, entry.make]) {
          const similarity = similarityRatio(phrase.toLowerCase(), candidate.toLowerCase());
          if (!best || similarity > best.similarity) best = { entry, similarity };
        }
      }
      if (
        best &&
        best.similarity >= FUZZY_SIMILARITY_THRESHOLD &&
        best.similarity < 1 &&
        !seen.has(best.entry.id)
      ) {
        seen.add(best.entry.id);
        results.push({
          lexiconEntryId: best.entry.id,
          make: best.entry.make,
          model: best.entry.model,
          category: best.entry.category,
          matchType: VehicleMatchType.FUZZY_MATCH,
          matchedText: phrase,
          similarity: best.similarity,
        });
      }
    }
    return results;
  }

  private findGenericVehiclePhrase(text: string): string | null {
    const capitalizedPhrases = extractVehicleShapedPhrases(text);
    if (capitalizedPhrases.length > 0) return capitalizedPhrases[0]!;
    const match = GENERIC_MENTION_RE.exec(text);
    return match?.[1]?.trim() ?? null;
  }
}
