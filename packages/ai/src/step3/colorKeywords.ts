/**
 * Deterministic keyword lexicon for a vehicle's colour, mirroring
 * `categoryKeywords.ts`'s style: a small, explicit list, keyed by the exact
 * colour string stored on `Vehicle.color` — a keyword not in here simply
 * isn't matched. Recognizing a colour *word* is independent of what's
 * actually in stock; whether any vehicle in that colour exists is decided
 * later, against the real catalog lexicon, never invented here.
 */
export const COLOR_KEYWORDS: Record<string, string[]> = {
  Black: ['black', 'jet black', 'matte black'],
  White: ['white', 'pearl white'],
  Silver: ['silver', 'gunmetal'],
  Grey: ['grey', 'gray'],
  Blue: ['blue', 'navy'],
  Red: ['red'],
  Green: ['green', 'british racing green'],
  Yellow: ['yellow'],
  Orange: ['orange'],
  Brown: ['brown', 'bronze'],
  Beige: ['beige', 'champagne'],
};
