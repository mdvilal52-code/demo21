import { describe, expect, it } from 'vitest';
import { levenshteinDistance, similarityRatio } from './levenshtein.js';

describe('levenshteinDistance', () => {
  it('is 0 for identical strings', () => {
    expect(levenshteinDistance('urus', 'urus')).toBe(0);
  });

  it('is the length of the other string when one is empty', () => {
    expect(levenshteinDistance('', 'urus')).toBe(4);
    expect(levenshteinDistance('urus', '')).toBe(4);
  });

  it('counts a single substitution as distance 1', () => {
    expect(levenshteinDistance('urus', 'urup')).toBe(1);
  });

  it('counts a single deletion as distance 1', () => {
    expect(levenshteinDistance('lamborghini', 'lamborgini')).toBe(1);
  });

  it('counts a single insertion as distance 1', () => {
    expect(levenshteinDistance('rover', 'rovver')).toBe(1);
  });

  it('is case-sensitive', () => {
    expect(levenshteinDistance('Urus', 'urus')).toBe(1);
  });

  it('computes a realistic multi-edit distance', () => {
    expect(levenshteinDistance('range rover', 'range rovr')).toBe(1);
  });
});

describe('similarityRatio', () => {
  it('is 1 for identical strings', () => {
    expect(similarityRatio('urus', 'urus')).toBe(1);
  });

  it('is 1 for two empty strings', () => {
    expect(similarityRatio('', '')).toBe(1);
  });

  it('is 0 for completely different strings of the same length', () => {
    expect(similarityRatio('abcd', 'wxyz')).toBe(0);
  });

  it('is high for a realistic one-letter typo', () => {
    expect(similarityRatio('lamborghini', 'lamborgini')).toBeGreaterThan(0.9);
  });

  it('is low for two unrelated words', () => {
    expect(similarityRatio('urus', 'corolla')).toBeLessThan(0.3);
  });
});
