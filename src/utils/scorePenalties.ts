// Score-threshold penalties for leaderboard uploads.
//
// When an admin uploads a leaderboard they may optionally penalise players
// whose score falls outside a [min, max] band by moving them DOWN the train
// queue (away from position 1). Both rules are opt-in and disabled by default.
//
// Rules:
// - below-min: points < minPoints  -> move down `belowMinPenalty` spots.
// - above-max: points > maxPoints  -> base -1, plus -1 per full `severeStep`
//   points of excess, capped at `maxCap`.
//   Example (max=10M, step=1M, cap=5): 11.9M -> -2, 14.9M -> -5, 20M -> -5 (capped).
// Equality with a threshold never penalises.

export interface ScorePenaltyConfig {
  minEnabled: boolean;
  minPoints: number;
  belowMinPenalty: number;
  maxEnabled: boolean;
  /** Null = not defined (rule inactive even if maxEnabled). */
  maxPoints: number | null;
  /** Points of excess per extra -1. */
  severeStep: number;
  /** Maximum queue spots a single above-max hit can cost. */
  maxCap: number;
  /** Consecutive capped-max hits that qualify a player as a "regular offender". */
  streakThreshold: number;
}

export interface ScorePenaltyInput {
  normalized: string;
  commander: string;
  points: number;
  memberId?: number | null;
}

export interface ScorePenaltyResult extends ScorePenaltyInput {
  penalty: number;
  reason: 'below-min' | 'above-max' | null;
  rawPenalty: number;
  capped: boolean;
}

export const DEFAULT_SCORE_PENALTY_CONFIG: ScorePenaltyConfig = {
  minEnabled: false,
  minPoints: 7_200_000,
  belowMinPenalty: 1,
  maxEnabled: false,
  maxPoints: null,
  severeStep: 1_000_000,
  maxCap: 5,
  streakThreshold: 2,
};

/** Coerce an admin-supplied config (API body or settings) into a validated config. */
export function normalizeScorePenaltyConfig(raw: unknown): ScorePenaltyConfig {
  const r = (raw ?? {}) as Partial<Record<keyof ScorePenaltyConfig, unknown>>;
  const num = (v: unknown, fallback: number): number => {
    const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(0, Math.floor(n));
  };
  const cfg: ScorePenaltyConfig = {
    minEnabled: Boolean(r.minEnabled),
    minPoints: num(r.minPoints, DEFAULT_SCORE_PENALTY_CONFIG.minPoints),
    belowMinPenalty: Math.max(1, Math.min(50, num(r.belowMinPenalty, DEFAULT_SCORE_PENALTY_CONFIG.belowMinPenalty) || 1)),
    maxEnabled: Boolean(r.maxEnabled),
    maxPoints:
      r.maxPoints === null || r.maxPoints === undefined || (typeof r.maxPoints === 'string' && r.maxPoints.trim() === '')
        ? null
        : num(r.maxPoints, NaN),
    severeStep: Math.max(1, num(r.severeStep, DEFAULT_SCORE_PENALTY_CONFIG.severeStep) || 1),
    maxCap: Math.max(1, Math.min(50, num(r.maxCap, DEFAULT_SCORE_PENALTY_CONFIG.maxCap) || 1)),
    streakThreshold: Math.max(1, Math.min(25, num(r.streakThreshold, DEFAULT_SCORE_PENALTY_CONFIG.streakThreshold) || 1)),
  };
  if (typeof cfg.maxPoints === 'number' && !Number.isFinite(cfg.maxPoints)) cfg.maxPoints = null;
  if (cfg.maxPoints !== null && cfg.maxPoints < 0) cfg.maxPoints = 0;
  if (cfg.minEnabled && cfg.maxEnabled && cfg.maxPoints !== null && cfg.minPoints > cfg.maxPoints) {
    throw new Error('minPoints must be <= maxPoints when both rules are enabled');
  }
  return cfg;
}

/** Compute the queue penalty for a single score. Pure — no I/O. */
export function computeScorePenalty(points: number, cfg: ScorePenaltyConfig): { penalty: number; reason: 'below-min' | 'above-max' | null; rawPenalty: number; capped: boolean } {
  const pts = Math.floor(Number(points));
  if (!Number.isFinite(pts) || pts < 0) return { penalty: 0, reason: null, rawPenalty: 0, capped: false };
  if (cfg.minEnabled && Number.isFinite(cfg.minPoints) && pts < cfg.minPoints) {
    return { penalty: cfg.belowMinPenalty, reason: 'below-min', rawPenalty: cfg.belowMinPenalty, capped: false };
  }
  if (cfg.maxEnabled && cfg.maxPoints !== null && pts > cfg.maxPoints) {
    const excess = pts - (cfg.maxPoints as number);
    const extra = Math.floor(excess / Math.max(1, cfg.severeStep));
    const raw = 1 + extra;
    const applied = Math.min(raw, cfg.maxCap);
    return { penalty: applied, reason: 'above-max', rawPenalty: raw, capped: raw > cfg.maxCap };
  }
  return { penalty: 0, reason: null, rawPenalty: 0, capped: false };
}

/** Apply `computeScorePenalty` to a whole leaderboard entry list. */
export function computeScorePenalties(entries: ScorePenaltyInput[], cfg: ScorePenaltyConfig): ScorePenaltyResult[] {
  return entries.map((e) => {
    const r = computeScorePenalty(e.points, cfg);
    return { ...e, penalty: r.penalty, reason: r.reason, rawPenalty: r.rawPenalty, capped: r.capped };
  });
}

/** Format points compactly for the dialog (e.g. 7200000 -> "7.2M"). */
export function formatPointsShort(points: number): string {
  if (!Number.isFinite(points)) return '—';
  if (points >= 1_000_000) {
    const m = points / 1_000_000;
    return `${Number(m.toFixed(m >= 100 ? 0 : 1))}M`;
  }
  if (points >= 1_000) return `${Number((points / 1_000).toFixed(1))}k`;
  return String(points);
}

/** Parse admin input like "7.2M", "7200000", "7,2M" into raw points. Null = empty. */
export function parsePointsInput(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim().replace(/\s+/g, '').replace(',', '.');
  if (s === '') return null;
  const m = s.match(/^(\d+(?:\.\d+)?)([mMkK]?)$/);
  if (!m) return NaN as unknown as null;
  const base = Number(m[1]);
  if (!Number.isFinite(base)) return NaN as unknown as null;
  const suffix = m[2].toLowerCase();
  const mult = suffix === 'm' ? 1_000_000 : suffix === 'k' ? 1_000 : 1;
  return Math.floor(base * mult);
}
