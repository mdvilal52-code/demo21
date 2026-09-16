import { LocationType, type LocationTypeValue } from '@ai-concierge/domain';

export interface GazetteerEntry {
  /** Lowercase match keys, longest/most specific first so it wins over a generic city name. */
  aliases: string[];
  normalized: string;
  city: string;
  country: string;
  timezone: string;
  locationType: LocationTypeValue;
}

/**
 * Dubai/UAE only, per Phase 2 scope. Adding a city/country later means
 * adding entries here (or a new provider) — `LocationExtractionService`
 * itself has no UAE-specific logic, it just asks whatever `LocationProvider`
 * it was given.
 */
export const UAE_GAZETTEER: GazetteerEntry[] = [
  {
    aliases: ['dubai international airport', 'dxb airport', 'dxb'],
    normalized: 'Dubai International Airport',
    city: 'Dubai',
    country: 'AE',
    timezone: 'Asia/Dubai',
    locationType: LocationType.AIRPORT,
  },
  {
    aliases: ['al maktoum international airport', 'dwc airport', 'dwc'],
    normalized: 'Al Maktoum International Airport',
    city: 'Dubai',
    country: 'AE',
    timezone: 'Asia/Dubai',
    locationType: LocationType.AIRPORT,
  },
  {
    aliases: ['burj al arab'],
    normalized: 'Burj Al Arab',
    city: 'Dubai',
    country: 'AE',
    timezone: 'Asia/Dubai',
    locationType: LocationType.HOTEL,
  },
  {
    aliases: ['atlantis the palm', 'atlantis'],
    normalized: 'Atlantis The Palm',
    city: 'Dubai',
    country: 'AE',
    timezone: 'Asia/Dubai',
    locationType: LocationType.HOTEL,
  },
  {
    aliases: ['burj khalifa'],
    normalized: 'Burj Khalifa',
    city: 'Dubai',
    country: 'AE',
    timezone: 'Asia/Dubai',
    locationType: LocationType.LANDMARK,
  },
  {
    aliases: ['dubai marina'],
    normalized: 'Dubai Marina',
    city: 'Dubai',
    country: 'AE',
    timezone: 'Asia/Dubai',
    locationType: LocationType.CITY_AREA,
  },
  {
    aliases: ['downtown dubai'],
    normalized: 'Downtown Dubai',
    city: 'Dubai',
    country: 'AE',
    timezone: 'Asia/Dubai',
    locationType: LocationType.CITY_AREA,
  },
  {
    aliases: ['business bay'],
    normalized: 'Business Bay',
    city: 'Dubai',
    country: 'AE',
    timezone: 'Asia/Dubai',
    locationType: LocationType.CITY_AREA,
  },
  {
    aliases: ['jumeirah beach residence', 'jbr'],
    normalized: 'Jumeirah Beach Residence',
    city: 'Dubai',
    country: 'AE',
    timezone: 'Asia/Dubai',
    locationType: LocationType.CITY_AREA,
  },
  {
    aliases: ['palm jumeirah'],
    normalized: 'Palm Jumeirah',
    city: 'Dubai',
    country: 'AE',
    timezone: 'Asia/Dubai',
    locationType: LocationType.CITY_AREA,
  },
  {
    aliases: ['abu dhabi'],
    normalized: 'Abu Dhabi',
    city: 'Abu Dhabi',
    country: 'AE',
    timezone: 'Asia/Dubai',
    locationType: LocationType.CITY_AREA,
  },
  {
    aliases: ['sharjah'],
    normalized: 'Sharjah',
    city: 'Sharjah',
    country: 'AE',
    timezone: 'Asia/Dubai',
    locationType: LocationType.CITY_AREA,
  },
  {
    aliases: ['dubai'],
    normalized: 'Dubai',
    city: 'Dubai',
    country: 'AE',
    timezone: 'Asia/Dubai',
    locationType: LocationType.CITY_AREA,
  },
];

/**
 * Real, well-known cities outside the current service area. Recognizing
 * these lets `LocationExtractionService` tell "this is a real place we
 * don't operate in yet" (UNSUPPORTED_LOCATION) apart from "this doesn't
 * look like a place at all" (UNRECOGNIZED_LOCATION_TEXT) — the distinction
 * the `MASTER-PLAN.md` "future cities/countries" requirement exists for.
 * Extend this (or replace it with a real geocoder's coverage check) as more
 * cities go live; it is intentionally not exhaustive.
 */
export const KNOWN_UNSERVICED_CITIES = new Set([
  'london',
  'new york',
  'paris',
  'tokyo',
  'singapore',
  'mumbai',
  'delhi',
  'riyadh',
  'doha',
  'cairo',
]);
