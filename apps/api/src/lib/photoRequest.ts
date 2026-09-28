/**
 * Recognises "send me a photo of the car" in a customer's message (English
 * and common Hinglish) and works out which cars they mean. Pure and
 * deterministic — the concierge attaches only photos staff uploaded for the
 * matched cars, it never invents or generates an image.
 */

const PHOTO_WORD_RE =
  /\b(?:photos?|pics?|pictures?|images?|imgs?|fotos?|snaps?|tasveer(?:en)?|tasvir)\b/i;
const SHOW_RE =
  /\b(?:show|dikha(?:o|na|do)?|dikhado|dekhna|dekhao)\b.{0,40}\b(?:car|cars|gaadi|gadi|vehicle|vehicles|fleet)\b/i;
const LOOK_RE = /\b(?:look(?:s)? like|kaisi (?:dikhti|lagti)|kaisa (?:dikhta|lagta))\b/i;

/** The customer is talking about their own documents, not about a car. */
const DOCUMENT_CONTEXT_RE =
  /\b(?:passport|licen[cs]e|licence|emirates id|id card|visa|selfie|document|documents|copy|scan)\b/i;

export function isPhotoRequest(text: string): boolean {
  if (DOCUMENT_CONTEXT_RE.test(text)) return false;
  return PHOTO_WORD_RE.test(text) || SHOW_RE.test(text) || LOOK_RE.test(text);
}

const FLEET_RE =
  /\b(?:all|every|each|available|your|other|more)\b.{0,25}\b(?:cars|vehicles|models|fleet|gaadiyan|gadiyan)\b|\bfleet\b|\bcatalog(?:ue)?\b/i;

export function wantsWholeFleet(text: string): boolean {
  return FLEET_RE.test(text);
}

export interface PhotoCatalogEntry {
  id: string;
  make: string;
  model: string;
  /** The colour stored on the vehicle row (each colour is its own catalog row). */
  color: string;
  /** "Land Rover Range Rover" — colour is deliberately left out, so a plain
   * model mention matches every colour of it; see `matchNamedVehicles`. */
  name: string;
  photos: { id: string; caption: string | null }[];
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function containsPhrase(haystack: string, phrase: string): boolean {
  if (phrase.length < 3) return false;
  return ` ${haystack} `.includes(` ${phrase} `);
}

/**
 * Cars the message names — by full name, by model ("range rover") or by make
 * ("lamborghini", which matches every car of that make). Longest match wins
 * per car; nothing matches on a one-or-two-letter fragment.
 *
 * When several colours of the same matched model exist, a colour the message
 * also names (e.g. "the black Urus") narrows the result to that colour only
 * — otherwise every colour of the matched model/make is returned, same as
 * asking to see "the Urus" in person would show every unit in stock.
 */
export function matchNamedVehicles(
  text: string,
  catalog: PhotoCatalogEntry[],
): PhotoCatalogEntry[] {
  const haystack = normalize(text);
  const matched = catalog.filter((entry) => {
    const model = normalize(entry.model);
    const make = normalize(entry.make);
    return (
      containsPhrase(haystack, normalize(entry.name)) ||
      containsPhrase(haystack, model) ||
      containsPhrase(haystack, make)
    );
  });

  const byColor = matched.filter((entry) => containsPhrase(haystack, normalize(entry.color)));
  return byColor.length > 0 ? byColor : matched;
}
