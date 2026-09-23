import { describe, expect, it } from 'vitest';
import { computeInventoryStatus, rangesOverlapWithBuffer } from './availabilityCalculator.js';

const BASE = {
  catalogAvailabilityStatus: 'AVAILABLE' as const,
  catalogActive: true,
  activeUnits: 3,
  maintenanceUnits: 0,
  overlappingCount: 0,
};

describe('computeInventoryStatus', () => {
  it('returns AVAILABLE when capacity exceeds overlapping reservations', () => {
    expect(computeInventoryStatus({ ...BASE, overlappingCount: 2 })).toBe('AVAILABLE');
  });

  it('returns UNAVAILABLE once overlapping reservations reach active capacity', () => {
    expect(computeInventoryStatus({ ...BASE, overlappingCount: 3 })).toBe('UNAVAILABLE');
  });

  it('returns UNAVAILABLE when overlapping reservations exceed active capacity', () => {
    expect(computeInventoryStatus({ ...BASE, overlappingCount: 4 })).toBe('UNAVAILABLE');
  });

  it('returns UNAVAILABLE when the catalog entry is inactive, regardless of units', () => {
    expect(computeInventoryStatus({ ...BASE, catalogActive: false, overlappingCount: 0 })).toBe(
      'UNAVAILABLE',
    );
  });

  it('returns UNAVAILABLE when the catalog status is UNAVAILABLE', () => {
    expect(
      computeInventoryStatus({
        ...BASE,
        catalogAvailabilityStatus: 'UNAVAILABLE',
        overlappingCount: 0,
      }),
    ).toBe('UNAVAILABLE');
  });

  it('returns MAINTENANCE when the catalog status is MAINTENANCE, even with free capacity', () => {
    expect(
      computeInventoryStatus({
        ...BASE,
        catalogAvailabilityStatus: 'MAINTENANCE',
        overlappingCount: 0,
      }),
    ).toBe('MAINTENANCE');
  });

  it('returns MAINTENANCE when there are zero active units but some are in maintenance', () => {
    expect(computeInventoryStatus({ ...BASE, activeUnits: 0, maintenanceUnits: 2 })).toBe(
      'MAINTENANCE',
    );
  });

  it('returns UNAVAILABLE when there are zero active units and none in maintenance either', () => {
    expect(computeInventoryStatus({ ...BASE, activeUnits: 0, maintenanceUnits: 0 })).toBe(
      'UNAVAILABLE',
    );
  });

  it('catalog-inactive takes priority over an otherwise-available unit count', () => {
    expect(
      computeInventoryStatus({
        ...BASE,
        catalogActive: false,
        activeUnits: 10,
        overlappingCount: 0,
      }),
    ).toBe('UNAVAILABLE');
  });
});

describe('rangesOverlapWithBuffer', () => {
  const day = (n: number): Date => new Date(Date.UTC(2026, 9, n, 10, 0, 0));

  it('detects a direct overlap with zero buffer', () => {
    expect(rangesOverlapWithBuffer(day(1), day(5), day(3), day(7), 0)).toBe(true);
  });

  it('does not overlap when ranges are disjoint and the buffer is zero', () => {
    expect(rangesOverlapWithBuffer(day(1), day(3), day(5), day(7), 0)).toBe(false);
  });

  it('treats back-to-back ranges (end === start) as non-overlapping with zero buffer', () => {
    expect(rangesOverlapWithBuffer(day(1), day(5), day(5), day(7), 0)).toBe(false);
  });

  it('a turnaround buffer makes back-to-back ranges overlap (blocks the next pickup)', () => {
    const twoHoursMs = 2 * 60 * 60 * 1000;
    expect(rangesOverlapWithBuffer(day(1), day(5), day(5), day(7), twoHoursMs)).toBe(true);
  });

  it('a buffer smaller than the actual gap still leaves disjoint ranges non-overlapping', () => {
    const oneHourMs = 60 * 60 * 1000;
    const gapStart = new Date(day(5).getTime() + 5 * 60 * 60 * 1000); // 5h after day(5)
    expect(rangesOverlapWithBuffer(day(1), day(5), gapStart, day(7), oneHourMs)).toBe(false);
  });

  it('is symmetric regardless of argument order', () => {
    const bufferMs = 60 * 60 * 1000;
    expect(rangesOverlapWithBuffer(day(1), day(5), day(3), day(7), bufferMs)).toBe(
      rangesOverlapWithBuffer(day(3), day(7), day(1), day(5), bufferMs),
    );
  });

  it('compares absolute instants — the same instant expressed via a +04:00 offset behaves identically to its UTC form', () => {
    // 2026-10-05T10:00:00Z vs the identical instant expressed as +04:00 (Asia/Dubai) wall-clock.
    const utcInstant = new Date('2026-10-05T10:00:00.000Z');
    const sameInstantViaOffset = new Date('2026-10-05T14:00:00.000+04:00');
    expect(utcInstant.getTime()).toBe(sameInstantViaOffset.getTime());

    const viaOffset = rangesOverlapWithBuffer(day(1), day(7), sameInstantViaOffset, day(9), 0);
    const viaUtc = rangesOverlapWithBuffer(day(1), day(7), utcInstant, day(9), 0);
    expect(viaOffset).toBe(viaUtc);
    expect(viaOffset).toBe(true);
  });
});
