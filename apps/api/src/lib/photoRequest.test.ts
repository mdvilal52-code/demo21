import { describe, expect, it } from 'vitest';
import {
  isPhotoRequest,
  matchNamedVehicles,
  wantsWholeFleet,
  type PhotoCatalogEntry,
} from './photoRequest.js';

const catalog: PhotoCatalogEntry[] = [
  {
    id: 'v1-black',
    make: 'Lamborghini',
    model: 'Urus',
    color: 'Black',
    name: 'Lamborghini Urus',
    photos: [{ id: 'p1', caption: null }],
  },
  {
    id: 'v1-white',
    make: 'Lamborghini',
    model: 'Urus',
    color: 'White',
    name: 'Lamborghini Urus',
    photos: [{ id: 'p2', caption: null }],
  },
  {
    id: 'v2',
    make: 'Land Rover',
    model: 'Range Rover',
    color: 'Grey',
    name: 'Land Rover Range Rover',
    photos: [{ id: 'p3', caption: null }],
  },
];

describe('isPhotoRequest', () => {
  it.each([
    'send me a photo of the Range Rover',
    'can I see pictures of the Urus?',
    'pic bhejo',
    'range rover ki photo dikhao',
    'show me the cars you have',
    'what does it look like',
    'do you have any images',
  ])('recognises %j', (text) => {
    expect(isPhotoRequest(text)).toBe(true);
  });

  it.each([
    'I want the Range Rover from 2026-10-10 to 2026-10-14',
    'yes please give me the quote',
    'I can send a photo of my passport',
    'here is my driving licence photo',
    'my email is a@b.com',
  ])('ignores %j', (text) => {
    expect(isPhotoRequest(text)).toBe(false);
  });
});

describe('wantsWholeFleet', () => {
  it('recognises a request for every car', () => {
    expect(wantsWholeFleet('show me all your cars')).toBe(true);
    expect(wantsWholeFleet('what is in your fleet')).toBe(true);
    expect(wantsWholeFleet('photo of the range rover')).toBe(false);
  });
});

describe('matchNamedVehicles', () => {
  it('matches by model, by make and by full name — every colour when none is named', () => {
    expect(matchNamedVehicles('photo of the range rover', catalog).map((c) => c.id)).toEqual([
      'v2',
    ]);
    expect(matchNamedVehicles('lamborghini pics', catalog).map((c) => c.id)).toEqual([
      'v1-black',
      'v1-white',
    ]);
    expect(matchNamedVehicles('land rover range rover photo', catalog).map((c) => c.id)).toEqual([
      'v2',
    ]);
  });

  it('narrows to the named colour when one is mentioned', () => {
    expect(matchNamedVehicles('photo of the black urus', catalog).map((c) => c.id)).toEqual([
      'v1-black',
    ]);
    expect(matchNamedVehicles('white urus pics please', catalog).map((c) => c.id)).toEqual([
      'v1-white',
    ]);
  });

  it('matches whole words only', () => {
    expect(matchNamedVehicles('photo of the hurusan', catalog)).toEqual([]);
  });

  it('matches nothing when no car is named', () => {
    expect(matchNamedVehicles('send me a photo', catalog)).toEqual([]);
  });
});
