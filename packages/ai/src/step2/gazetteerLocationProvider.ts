import { UAE_GAZETTEER, type GazetteerEntry } from './gazetteer.js';
import type { LocationCandidate, LocationProvider } from './locationProvider.js';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface AliasEntry {
  entry: GazetteerEntry;
  alias: string;
}

/**
 * Deterministic, zero-network lookup against a static Dubai/UAE gazetteer.
 * Longer/more specific aliases (e.g. "Dubai Marina") claim their text range
 * before shorter ones (e.g. "Dubai") are allowed to match, so a mention of
 * a specific area is never also double-counted as a separate generic-city hit.
 */
export class GazetteerLocationProvider implements LocationProvider {
  readonly name = 'uae-gazetteer-v1';

  constructor(private readonly gazetteer: GazetteerEntry[] = UAE_GAZETTEER) {}

  async resolve(text: string): Promise<LocationCandidate[]> {
    const aliasEntries: AliasEntry[] = this.gazetteer
      .flatMap((entry) => entry.aliases.map((alias) => ({ entry, alias })))
      .sort((a, b) => b.alias.length - a.alias.length);

    const consumedRanges: Array<[number, number]> = [];
    const candidates: LocationCandidate[] = [];

    for (const { entry, alias } of aliasEntries) {
      const pattern = new RegExp(`\\b${escapeRegExp(alias)}\\b`, 'gi');
      for (const match of text.matchAll(pattern)) {
        const start = match.index;
        const end = start + match[0].length;
        const overlaps = consumedRanges.some(
          ([rangeStart, rangeEnd]) => start < rangeEnd && end > rangeStart,
        );
        if (overlaps) continue;

        consumedRanges.push([start, end]);
        candidates.push({
          raw: match[0],
          normalized: entry.normalized,
          city: entry.city,
          country: entry.country,
          timezone: entry.timezone,
          locationType: entry.locationType,
          matchIndex: start,
        });
      }
    }

    return candidates.sort((a, b) => a.matchIndex - b.matchIndex);
  }
}
