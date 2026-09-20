import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SCORE_PENALTY_CONFIG,
  normalizeScorePenaltyConfig,
  computeScorePenalty,
  computeScorePenalties,
  parsePointsInput,
  formatPointsShort,
} from '../src/utils/scorePenalties';

describe('score penalty calculation', () => {
  it('is disabled by default (no rules enabled)', () => {
    expect(DEFAULT_SCORE_PENALTY_CONFIG.minEnabled).toBe(false);
    expect(DEFAULT_SCORE_PENALTY_CONFIG.maxEnabled).toBe(false);
    expect(DEFAULT_SCORE_PENALTY_CONFIG.minPoints).toBe(7_200_000);
    expect(DEFAULT_SCORE_PENALTY_CONFIG.severeStep).toBe(1_000_000);
    expect(DEFAULT_SCORE_PENALTY_CONFIG.maxCap).toBe(5);
    expect(DEFAULT_SCORE_PENALTY_CONFIG.streakThreshold).toBe(2);
    const r = computeScorePenalty(1, DEFAULT_SCORE_PENALTY_CONFIG);
    expect(r).toEqual({ penalty: 0, reason: null, rawPenalty: 0, capped: false });
  });

  it('penalises below-minimum scores by N (default 1)', () => {
    const cfg = normalizeScorePenaltyConfig({ minEnabled: true });
    expect(computeScorePenalty(7_199_999, cfg)).toEqual({ penalty: 1, reason: 'below-min', rawPenalty: 1, capped: false });
    expect(computeScorePenalty(0, cfg)).toEqual({ penalty: 1, reason: 'below-min', rawPenalty: 1, capped: false });
    // Equality with the threshold never penalises.
    expect(computeScorePenalty(7_200_000, cfg).penalty).toBe(0);
    const cfg3 = normalizeScorePenaltyConfig({ minEnabled: true, belowMinPenalty: 3 });
    expect(computeScorePenalty(100, cfg3).penalty).toBe(3);
  });

  it('escalates above-maximum penalties per M of excess, capped at X', () => {
    const cfg = normalizeScorePenaltyConfig({ maxEnabled: true, maxPoints: 10_000_000 });
    // Spec example: max 10M, step 1M, cap 5.
    expect(computeScorePenalty(10_000_000, cfg).penalty).toBe(0); // equality: no penalty
    expect(computeScorePenalty(10_000_001, cfg)).toEqual({ penalty: 1, reason: 'above-max', rawPenalty: 1, capped: false });
    expect(computeScorePenalty(11_900_000, cfg)).toEqual({ penalty: 2, reason: 'above-max', rawPenalty: 2, capped: false });
    expect(computeScorePenalty(14_900_000, cfg)).toEqual({ penalty: 5, reason: 'above-max', rawPenalty: 5, capped: false });
    expect(computeScorePenalty(20_000_000, cfg)).toEqual({ penalty: 5, reason: 'above-max', rawPenalty: 11, capped: true });
  });

  it('respects a custom cap and step', () => {
    const cfg = normalizeScorePenaltyConfig({ maxEnabled: true, maxPoints: 5_000_000, severeStep: 2_000_000, maxCap: 3 });
    expect(computeScorePenalty(6_900_000, cfg).penalty).toBe(1);
    expect(computeScorePenalty(9_000_000, cfg)).toEqual({ penalty: 3, reason: 'above-max', rawPenalty: 3, capped: false });
    expect(computeScorePenalty(11_000_000, cfg)).toEqual({ penalty: 3, reason: 'above-max', rawPenalty: 4, capped: true });
  });

  it('below-min takes precedence structurally (min <= max enforced)', () => {
    expect(() => normalizeScorePenaltyConfig({ minEnabled: true, minPoints: 9_000_000, maxEnabled: true, maxPoints: 8_000_000 }))
      .toThrow(/minPoints must be <= maxPoints/);
  });

  it('treats an empty max as unset', () => {
    const cfg = normalizeScorePenaltyConfig({ maxEnabled: true, maxPoints: '' });
    expect(cfg.maxPoints).toBeNull();
    expect(computeScorePenalty(999_999_999, cfg).penalty).toBe(0);
  });

  it('clamps and coerces admin input', () => {
    const cfg = normalizeScorePenaltyConfig({
      minEnabled: true, minPoints: '7.2M', belowMinPenalty: 99,
      maxEnabled: true, maxPoints: '10M', severeStep: '1M', maxCap: 99, streakThreshold: 99,
    });
    // Coercion happens in normalizeScorePenaltyConfig for numbers; M-suffix
    // strings are parsed by the API layer — plain Number('7.2M') is NaN.
    expect(cfg.belowMinPenalty).toBe(50);
    expect(cfg.maxCap).toBe(50);
    expect(cfg.streakThreshold).toBe(25);
  });

  it('computes a whole board at once', () => {
    const cfg = normalizeScorePenaltyConfig({ minEnabled: true, maxEnabled: true, maxPoints: 10_000_000 });
    const out = computeScorePenalties([
      { normalized: 'a', commander: 'A', points: 1_000 },
      { normalized: 'b', commander: 'B', points: 8_000_000 },
      { normalized: 'c', commander: 'C', points: 12_500_000 },
    ], cfg);
    expect(out.map((r) => r.penalty)).toEqual([1, 0, 3]);
    expect(out.map((r) => r.reason)).toEqual(['below-min', null, 'above-max']);
  });
});

describe('points input parsing/formatting', () => {
  it('parses plain numbers and M/k suffixes', () => {
    expect(parsePointsInput('7200000')).toBe(7_200_000);
    expect(parsePointsInput('7.2M')).toBe(7_200_000);
    expect(parsePointsInput('7,2M')).toBe(7_200_000);
    expect(parsePointsInput('1M')).toBe(1_000_000);
    expect(parsePointsInput('500k')).toBe(500_000);
    expect(parsePointsInput('')).toBeNull();
    expect(parsePointsInput(null)).toBeNull();
    expect(parsePointsInput('abc')).toBeNaN();
  });

  it('formats points compactly', () => {
    expect(formatPointsShort(7_200_000)).toBe('7.2M');
    expect(formatPointsShort(10_000_000)).toBe('10M');
    expect(formatPointsShort(500_000)).toBe('500k');
    expect(formatPointsShort(42)).toBe('42');
  });
});
