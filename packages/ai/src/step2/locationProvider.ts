import type { LocationTypeValue } from '@ai-concierge/domain';

export interface LocationCandidate {
  raw: string;
  normalized: string;
  city: string;
  country: string;
  timezone: string;
  locationType: LocationTypeValue;
  /** Character offset of the match in the input text, used to order pickup vs dropoff. */
  matchIndex: number;
}

/**
 * Seam for location resolution. `GazetteerLocationProvider` (this phase) is
 * a static, zero-network lookup limited to Dubai/UAE. A future provider
 * backed by a real geocoding API is a straightforward drop-in — as long as
 * it makes its HTTP calls through `ssrfSafeFetch` (packages/security) and is
 * wrapped the same way `GazetteerLocationProvider` is wrapped here (timeout
 * + circuit breaker + rate limit; see `withLocationResilience`), never with
 * a raw `fetch` to a caller-influenced URL.
 */
export interface LocationProvider {
  readonly name: string;
  resolve(text: string): Promise<LocationCandidate[]>;
}
