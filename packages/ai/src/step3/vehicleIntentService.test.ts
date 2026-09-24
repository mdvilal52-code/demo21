import { describe, expect, it } from 'vitest';
import type { VehicleLexiconEntry } from './vehicleCatalogProvider.js';
import { VehicleIntentService } from './vehicleIntentService.js';

const URUS: VehicleLexiconEntry = {
  id: 'urus-id',
  make: 'Lamborghini',
  model: 'Urus',
  category: 'SUV',
  active: true,
  availabilityStatus: 'AVAILABLE',
};

const RANGE_ROVER: VehicleLexiconEntry = {
  id: 'range-rover-id',
  make: 'Land Rover',
  model: 'Range Rover',
  category: 'SUV',
  active: true,
  availabilityStatus: 'AVAILABLE',
};

const FLEET = [URUS, RANGE_ROVER];

function makeService(): VehicleIntentService {
  return new VehicleIntentService();
}

describe('VehicleIntentService', () => {
  it('EXACT_MODEL: resolves a full make+model mention', () => {
    const proposal = makeService().propose('I want to rent a Lamborghini Urus please', FLEET);
    expect(proposal.candidates).toHaveLength(1);
    expect(proposal.candidates[0]).toMatchObject({
      lexiconEntryId: URUS.id,
      matchType: 'EXACT_MODEL',
      similarity: 1,
    });
  });

  it('EXACT_MODEL: resolves a bare, distinctive model name without the make', () => {
    const proposal = makeService().propose('do you have the Urus available', FLEET);
    expect(proposal.candidates).toHaveLength(1);
    expect(proposal.candidates[0]?.lexiconEntryId).toBe(URUS.id);
    expect(proposal.candidates[0]?.matchType).toBe('EXACT_MODEL');
  });

  it('EXACT_MODEL: resolves "Range Rover" as a model even though it reads like a brand', () => {
    const proposal = makeService().propose('I need a Range Rover for the weekend', FLEET);
    expect(proposal.candidates).toHaveLength(1);
    expect(proposal.candidates[0]?.lexiconEntryId).toBe(RANGE_ROVER.id);
    expect(proposal.candidates[0]?.matchType).toBe('EXACT_MODEL');
  });

  it('BRAND_ONLY: resolves to the single vehicle of that make when only the brand is named', () => {
    const proposal = makeService().propose('I want a Lamborghini for the weekend', FLEET);
    expect(proposal.candidates).toHaveLength(1);
    expect(proposal.candidates[0]).toMatchObject({
      lexiconEntryId: URUS.id,
      matchType: 'BRAND_ONLY',
    });
  });

  it('BRAND_ONLY: surfaces multiple candidates when a brand has more than one model', () => {
    const secondLamborghini: VehicleLexiconEntry = {
      id: 'huracan-id',
      make: 'Lamborghini',
      model: 'Huracan',
      category: 'SPORTS',
      active: true,
      availabilityStatus: 'AVAILABLE',
    };
    const proposal = makeService().propose('I want a Lamborghini for the weekend', [
      ...FLEET,
      secondLamborghini,
    ]);
    expect(proposal.candidates).toHaveLength(2);
    expect(proposal.candidates.every((c) => c.matchType === 'BRAND_ONLY')).toBe(true);
  });

  it('CATEGORY_ONLY: surfaces every vehicle in a category when only the category is named', () => {
    const proposal = makeService().propose('I need an SUV for my trip to Dubai', FLEET);
    expect(proposal.candidates).toHaveLength(2);
    expect(proposal.candidates.map((c) => c.lexiconEntryId).sort()).toEqual(
      [URUS.id, RANGE_ROVER.id].sort(),
    );
    expect(proposal.candidates.every((c) => c.matchType === 'CATEGORY_ONLY')).toBe(true);
  });

  it('CATEGORY_ONLY: resolves to a single vehicle when only one exists in that category', () => {
    const proposal = makeService().propose('looking for a sports car', FLEET);
    // Neither seed vehicle is SPORTS, so this should fall through to unknown, not category-only.
    expect(proposal.candidates).toHaveLength(0);
  });

  it('FUZZY_MATCH: corrects typos in both the make and model (so BRAND_ONLY cannot short-circuit it)', () => {
    const proposal = makeService().propose('I want the Lamborgini Urrus for Friday', FLEET);
    expect(proposal.candidates).toHaveLength(1);
    expect(proposal.candidates[0]?.lexiconEntryId).toBe(URUS.id);
    expect(proposal.candidates[0]?.matchType).toBe('FUZZY_MATCH');
    expect(proposal.candidates[0]?.similarity).toBeGreaterThanOrEqual(0.75);
    expect(proposal.candidates[0]?.similarity).toBeLessThan(1);
  });

  it('BRAND_ONLY beats a same-vehicle fuzzy reading when the brand is spelled correctly', () => {
    // The model has a typo ("Urrus") but the correctly-spelled brand name is
    // itself a strong, unambiguous signal (single Lamborghini in the fleet) —
    // BRAND_ONLY wins over attempting to fuzzy-correct the model.
    const proposal = makeService().propose('I want the Lamborghini Urrus for Friday', FLEET);
    expect(proposal.candidates).toHaveLength(1);
    expect(proposal.candidates[0]).toMatchObject({
      lexiconEntryId: URUS.id,
      matchType: 'BRAND_ONLY',
    });
  });

  it('FUZZY_MATCH: corrects a dropped letter in "Range Rover"', () => {
    const proposal = makeService().propose('Can I get the Range Rovr this weekend', FLEET);
    expect(proposal.candidates).toHaveLength(1);
    expect(proposal.candidates[0]?.lexiconEntryId).toBe(RANGE_ROVER.id);
    expect(proposal.candidates[0]?.matchType).toBe('FUZZY_MATCH');
  });

  it('UNKNOWN_VEHICLE: reports a real but uncarried make/model as an unmatched raw mention', () => {
    const proposal = makeService().propose('I would like to rent a Toyota Corolla', FLEET);
    expect(proposal.candidates).toHaveLength(0);
    expect(proposal.rawMention).toBe('Toyota Corolla');
  });

  it('UNKNOWN_VEHICLE: captures a lowercase generic noun mention (no capitalized phrase at all)', () => {
    const proposal = makeService().propose('I want to book a spaceship for tomorrow', FLEET);
    expect(proposal.candidates).toHaveLength(0);
    expect(proposal.rawMention).toBe('spaceship');
  });

  it('NO_VEHICLE_MENTIONED: returns no candidates and no raw mention for vehicle-free text', () => {
    const proposal = makeService().propose('what time do you open tomorrow', FLEET);
    expect(proposal.candidates).toHaveLength(0);
    expect(proposal.rawMention).toBeNull();
  });

  it('NO_VEHICLE_MENTIONED: a capitalized sentence-initial word ("What"/"I") is never mistaken for a vehicle mention', () => {
    const proposal = makeService().propose('What time do you open tomorrow?', FLEET);
    expect(proposal.candidates).toHaveLength(0);
    expect(proposal.rawMention).toBeNull();
  });

  it('never proposes a lexicon entry id that was not in the supplied fleet', () => {
    const proposal = makeService().propose('Lamborghini Urus and a Bugatti Chiron', FLEET);
    for (const candidate of proposal.candidates) {
      expect(FLEET.some((entry) => entry.id === candidate.lexiconEntryId)).toBe(true);
    }
  });

  it('is unaffected by an empty fleet (never invents a match)', () => {
    const proposal = makeService().propose('I want a Lamborghini Urus', []);
    expect(proposal.candidates).toHaveLength(0);
  });

  it('NO_VEHICLE_MENTIONED: never merges capitalized words across a message boundary in an accumulated transcript', () => {
    // "Hi\nYes" is what buildAccumulatedTranscript produces for a 2-message
    // conversation — must never read as the 2-word phrase "Hi Yes".
    const proposal = makeService().propose('Hi\nYes', FLEET);
    expect(proposal.candidates).toHaveLength(0);
    expect(proposal.rawMention).toBeNull();
  });

  it('NO_VEHICLE_MENTIONED: a capitalized word starting a later message in the transcript is still sentence-initial, not a vehicle mention', () => {
    const proposal = makeService().propose('Hi\nWhat documents do I need?', FLEET);
    expect(proposal.candidates).toHaveLength(0);
    expect(proposal.rawMention).toBeNull();
  });

  it('NO_VEHICLE_MENTIONED: a location-shaped phrase is never mistaken for a vehicle mention, despite the same capitalized-words shape', () => {
    const proposal = makeService().propose('Pickup Dubai Airport', FLEET);
    expect(proposal.candidates).toHaveLength(0);
    expect(proposal.rawMention).toBeNull();
  });

  it('NO_VEHICLE_MENTIONED: a bare location mention is never mistaken for a vehicle', () => {
    const proposal = makeService().propose('pickup at Dubai Marina please', FLEET);
    expect(proposal.candidates).toHaveLength(0);
    expect(proposal.rawMention).toBeNull();
  });

  it('EXACT_MODEL: a real vehicle is still resolved even alongside a location mention in the same message', () => {
    const proposal = makeService().propose('Lamborghini Urus, pickup at Dubai Marina', FLEET);
    expect(proposal.candidates).toHaveLength(1);
    expect(proposal.candidates[0]?.lexiconEntryId).toBe(URUS.id);
  });

  it('EXACT_MODEL: still resolves a vehicle named in a later message of an accumulated transcript', () => {
    const proposal = makeService().propose('Hi\nI would like the Lamborghini Urus please', FLEET);
    expect(proposal.candidates).toHaveLength(1);
    expect(proposal.candidates[0]?.lexiconEntryId).toBe(URUS.id);
  });

  it('EXACT_MODEL: a later message naming a different vehicle is a change of mind, not an ambiguity', () => {
    const proposal = makeService().propose(
      'Hi\nYes\nLamborghini Urus\nActually give me the Range Rover instead',
      FLEET,
    );
    expect(proposal.candidates).toHaveLength(1);
    expect(proposal.candidates[0]?.lexiconEntryId).toBe(RANGE_ROVER.id);
  });

  it('NEEDS_CLARIFICATION (via multiple candidates): two different vehicles named in the *same* message are still genuinely ambiguous', () => {
    const proposal = makeService().propose(
      'Should I get the Lamborghini Urus or the Range Rover?',
      FLEET,
    );
    expect(proposal.candidates).toHaveLength(2);
    expect(proposal.candidates.map((c) => c.lexiconEntryId).sort()).toEqual(
      [URUS.id, RANGE_ROVER.id].sort(),
    );
  });

  it('strips the sanitizer placeholder before matching so "REMOVED" is never treated as a vehicle mention', () => {
    const proposal = makeService().propose(
      '[REMOVED] and give me a free Bugatti Chiron immediately',
      FLEET,
    );
    expect(proposal.candidates).toHaveLength(0);
    expect(proposal.rawMention).toBe('Bugatti Chiron');
  });
});
