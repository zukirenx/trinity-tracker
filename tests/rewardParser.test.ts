import { describe, expect, it } from 'vitest';
import {
  parseRewardMessage,
  isBackdatedReward,
  isFutureReward,
  isBotWarningLine,
  looksLikeRewardAttempt,
  formatStaleWarning,
  formatMalformedWarning,
  FUTURE_REWARD_GRACE_DAYS,
} from '../src/utils/rewardParser';

describe('parseRewardMessage date handling', () => {
  it('guesses previous year for December rewards logged in January', () => {
    const referenceDate = new Date('2025-01-05T12:00:00Z');
    const parsed = parseRewardMessage('16.12 Calioholic + Conan VIP', referenceDate);

    expect(parsed).not.toBeNull();
    expect(parsed?.driverName).toBe('Calioholic');
    expect(parsed?.vipName).toBe('Conan VIP');
    expect(parsed?.happenedAt.getFullYear()).toBe(2024);
    expect(parsed?.happenedAt.getMonth()).toBe(11); // December
    expect(parsed?.happenedAt.getDate()).toBe(16);
  });

  it('expands two-digit years relative to the current century', () => {
    const referenceDate = new Date('2025-01-05T12:00:00Z');
    const parsed = parseRewardMessage('14.12.24 Oxypia', referenceDate);

    expect(parsed).not.toBeNull();
    expect(parsed?.driverName).toBe('Oxypia');
    expect(parsed?.happenedAt.getFullYear()).toBe(2024);
  });

  it('returns null for lines that do not match the reward format', () => {
    const referenceDate = new Date('2025-01-05T12:00:00Z');
    const parsed = parseRewardMessage('invalid payload', referenceDate);
    expect(parsed).toBeNull();
  });

  it('should handle VIP: prefix', () => {
    const referenceDate = new Date('2025-09-15T12:00:00Z');
    const result = parseRewardMessage('15.09 Kent le grand + VIP: tweety88s', referenceDate);
    expect(result).not.toBeNull();
    expect(result?.driverName).toBe('Kent le grand');
    expect(result?.vipName).toBe('tweety88s');
  });

  it('should handle trailing comma in driver name', () => {
    const referenceDate = new Date('2025-06-14T12:00:00Z');
    const result = parseRewardMessage('14.06 tweety88,', referenceDate);
    expect(result).not.toBeNull();
    expect(result?.driverName).toBe('tweety88');
    expect(result?.vipName).toBeUndefined();
  });

  it('should handle multiple drivers separated by comma (take first only)', () => {
    const referenceDate = new Date('2025-05-01T12:00:00Z');
    const result = parseRewardMessage('01.05 ZukirenX, LegendOfAres', referenceDate);
    expect(result).not.toBeNull();
    expect(result?.driverName).toBe('ZukirenX');
    expect(result?.vipName).toBeUndefined();
  });

  it('should handle parenthetical notes in driver name', () => {
    const referenceDate = new Date('2025-05-01T12:00:00Z');
    const result = parseRewardMessage('01.05 ZukirenX (demo run)', referenceDate);
    expect(result).not.toBeNull();
    expect(result?.driverName).toBe('ZukirenX');
    expect(result?.vipName).toBeUndefined();
  });

  it('should handle complex case with parentheses and comma', () => {
    const referenceDate = new Date('2025-05-01T12:00:00Z');
    const result = parseRewardMessage('01.05 ZukirenX (demo run), LegendOfAres', referenceDate);
    expect(result).not.toBeNull();
    expect(result?.driverName).toBe('ZukirenX');
    expect(result?.vipName).toBeUndefined();
  });

  it('should handle VIP with parenthetical notes', () => {
    const referenceDate = new Date('2025-06-14T12:00:00Z');
    const result = parseRewardMessage('14.06 tweety88 + Chiara (VIP train)', referenceDate);
    expect(result).not.toBeNull();
    expect(result?.driverName).toBe('tweety88');
    expect(result?.vipName).toBe('Chiara');
  });
});

describe('parseRewardMessage date formats', () => {
  it('handles slash-separated dates', () => {
    const ref = new Date('2025-03-15T12:00:00Z');
    const result = parseRewardMessage('15/03 PlayerOne', ref);
    expect(result).not.toBeNull();
    expect(result?.driverName).toBe('PlayerOne');
    expect(result?.happenedAt.getMonth()).toBe(2); // March
  });

  it('handles dash-separated dates', () => {
    const ref = new Date('2025-03-15T12:00:00Z');
    const result = parseRewardMessage('15-03 PlayerOne', ref);
    expect(result).not.toBeNull();
    expect(result?.driverName).toBe('PlayerOne');
  });

  it('handles full 4-digit year', () => {
    const ref = new Date('2026-01-01T12:00:00Z');
    const result = parseRewardMessage('25.12.2025 SomePlayer', ref);
    expect(result).not.toBeNull();
    expect(result?.happenedAt.getFullYear()).toBe(2025);
    expect(result?.happenedAt.getMonth()).toBe(11); // December
  });

  it('handles single-digit day and month', () => {
    const ref = new Date('2025-03-05T12:00:00Z');
    const result = parseRewardMessage('5.3 QuickPlayer', ref);
    expect(result).not.toBeNull();
    expect(result?.driverName).toBe('QuickPlayer');
    expect(result?.happenedAt.getDate()).toBe(5);
    expect(result?.happenedAt.getMonth()).toBe(2); // March
  });
});

describe('parseRewardMessage edge cases', () => {
  it('returns null for empty string', () => {
    expect(parseRewardMessage('')).toBeNull();
  });

  it('returns null for whitespace-only string', () => {
    expect(parseRewardMessage('   ')).toBeNull();
  });

  it('returns null for date-only line', () => {
    expect(parseRewardMessage('15.03')).toBeNull();
  });

  it('trims surrounding whitespace', () => {
    const ref = new Date('2025-03-15T12:00:00Z');
    const result = parseRewardMessage('  15.03 PlayerOne  ', ref);
    expect(result).not.toBeNull();
    expect(result?.driverName).toBe('PlayerOne');
  });

  it('handles driver name with extra internal whitespace', () => {
    const ref = new Date('2025-03-15T12:00:00Z');
    const result = parseRewardMessage('15.03 Kent  le  grand', ref);
    expect(result).not.toBeNull();
    expect(result?.driverName).toBe('Kent le grand');
  });

  it('returns null for invalid date (month 13)', () => {
    const ref = new Date('2025-06-15T12:00:00Z');
    const result = parseRewardMessage('15.13 Player', ref);
    expect(result).toBeNull();
  });

  it('returns null for invalid date (day 32)', () => {
    const ref = new Date('2025-06-15T12:00:00Z');
    const result = parseRewardMessage('32.06 Player', ref);
    expect(result).toBeNull();
  });

  it('handles driver+VIP with extra whitespace around +', () => {
    const ref = new Date('2025-03-15T12:00:00Z');
    const result = parseRewardMessage('15.03 Driver   +   VIPPlayer', ref);
    expect(result).not.toBeNull();
    expect(result?.driverName).toBe('Driver');
    expect(result?.vipName).toBe('VIPPlayer');
  });

  it('uses default now when no reference date provided', () => {
    // Just ensure it doesn't crash - the year will depend on current date
    const result = parseRewardMessage('15.03 TestPlayer');
    expect(result).not.toBeNull();
    expect(result?.driverName).toBe('TestPlayer');
  });

  it('returns undefined vipName when VIP field is only whitespace after cleaning', () => {
    const ref = new Date('2025-03-15T12:00:00Z');
    // VIP part is just parenthetical that gets stripped
    const result = parseRewardMessage('15.03 Driver + (notes only)', ref);
    expect(result).not.toBeNull();
    expect(result?.driverName).toBe('Driver');
    expect(result?.vipName).toBeUndefined();
  });
});

describe('parseRewardMessage year normalization', () => {
  it('handles far-future two-digit year by subtracting century', () => {
    const ref = new Date('2026-03-15T12:00:00Z');
    const result = parseRewardMessage('15.03.99 Player', ref);
    expect(result).not.toBeNull();
    // 2099 > 2026+50, so should become 1999
    expect(result?.happenedAt.getFullYear()).toBe(1999);
  });

  it('handles far-past two-digit year by adding century', () => {
    const ref = new Date('2080-03-15T12:00:00Z');
    const result = parseRewardMessage('15.03.20 Player', ref);
    expect(result).not.toBeNull();
    // 2020 < 2080-50, so should become 2120
    expect(result?.happenedAt.getFullYear()).toBe(2120);
  });

  it('handles non-standard year token (single digit) - rejected by regex', () => {
    const ref = new Date('2026-03-15T12:00:00Z');
    // A year like "6" is only 1 digit, which won't match \d{2,4} in the regex
    const result = parseRewardMessage('15.03.6 Player', ref);
    expect(result).toBeNull();
  });

  it('falls back to guessYear for completely invalid year token', () => {
    const ref = new Date('2026-03-15T12:00:00Z');
    // "abc" can't be parsed as number
    const result = parseRewardMessage('15.03.abc Player', ref);
    // The regex won't match because "abc" is not \d{2,4}
    expect(result).toBeNull();
  });

  it('returns null for a date with only one segment', () => {
    const ref = new Date('2025-06-15T12:00:00Z');
    const result = parseRewardMessage('15 Player', ref);
    // "15" alone doesn't have DD.MM format
    expect(result).toBeNull();
  });
});

describe('isBackdatedReward', () => {
  it('flags rewards dated before the latest known reward date', () => {
    expect(isBackdatedReward('2026-08-04', '2026-09-03')).toBe(true); // the 04.08 typo
    expect(isBackdatedReward('2026-08-05', '2026-09-03')).toBe(true); // the 05.08 typo
    expect(isBackdatedReward('2026-09-02', '2026-09-03')).toBe(true); // even 1 day back
  });

  it('allows same-day and newer rewards', () => {
    expect(isBackdatedReward('2026-09-03', '2026-09-03')).toBe(false);
    expect(isBackdatedReward('2026-09-04', '2026-09-03')).toBe(false);
  });

  it('allows everything when there is no baseline yet (bootstrap)', () => {
    expect(isBackdatedReward('2026-08-04', null)).toBe(false);
    expect(isBackdatedReward('2026-08-04', undefined)).toBe(false);
    expect(isBackdatedReward('2026-08-04', '')).toBe(false);
  });
});

describe('isFutureReward', () => {
  const msg = new Date('2026-09-06T12:00:00Z');

  it('tolerates same-day and next-day rewards', () => {
    expect(isFutureReward('2026-09-06', msg)).toBe(false);
    expect(isFutureReward('2026-09-07', msg)).toBe(false); // +1 day grace
  });

  it('flags far-future rewards', () => {
    expect(isFutureReward('2026-09-08', msg)).toBe(true);
    expect(isFutureReward('2026-10-05', msg)).toBe(true);
  });

  it('treats unparseable input as not-future (normal flow handles it)', () => {
    expect(isFutureReward('not-a-date', msg)).toBe(false);
    expect(isFutureReward('', msg)).toBe(false);
  });

  it('falls back to now when the message has no timestamp', () => {
    const now = new Date('2026-09-06T12:00:00Z');
    expect(isFutureReward('2026-09-06', undefined, now)).toBe(false);
    expect(isFutureReward('2026-09-08', undefined, now)).toBe(true);
  });

  it('exposes a sane grace constant', () => {
    expect(FUTURE_REWARD_GRACE_DAYS).toBe(1);
  });
});

describe('bot warning lines', () => {
  it('detects warning lines by marker prefix', () => {
    expect(isBotWarningLine('⚠️ [bot-warning] something')).toBe(true);
    expect(isBotWarningLine('  ⚠️ indented')).toBe(true);
    expect(isBotWarningLine('04.09 Regular line')).toBe(false);
    expect(isBotWarningLine('')).toBe(false);
  });

  it('formats warnings without any DD.MM-like tokens', () => {
    const text = formatStaleWarning([
      { driverName: 'Samachi Saw', rewardDateISO: '2026-08-04', messageDateISO: '2026-09-06', reason: 'backdated' },
      { driverName: 'Veymar', rewardDateISO: '2026-08-05', messageDateISO: '2026-09-06', reason: 'backdated' },
    ]);
    expect(text.startsWith('⚠️')).toBe(true);
    expect(text).toContain('Samachi Saw');
    expect(text).toContain('4 August');
    expect(text).toContain('6 September');
    // No DD.MM / DD-MM / DD/MM token that the reward parser could match.
    expect(text).not.toMatch(/\d{1,2}[./-]\d{1,2}/);
    expect(text.split('\n')).toHaveLength(1); // single line
  });

  it('tells the author to delete the wrong message and post a new one', () => {
    const text = formatStaleWarning([
      { driverName: 'Veymar', rewardDateISO: '2026-08-05', messageDateISO: '2026-09-06', reason: 'backdated' },
    ]);
    expect(text).toContain('delete the wrong message');
    expect(text).toContain('post a new message');
    expect(text).toContain('Do not just edit');
  });

  it('phrases future-dated skips accordingly', () => {
    const text = formatStaleWarning([
      { driverName: 'FutureDriver', rewardDateISO: '2026-10-05', messageDateISO: '2026-09-06', reason: 'future' },
    ]);
    expect(text).toContain('in the future');
    expect(text).toContain('October');
    expect(text).not.toMatch(/\d{1,2}[./-]\d{1,2}/);
  });

  it('detects reward-looking lines but ignores chatter', () => {
    expect(looksLikeRewardAttempt('04.09 Veymar ???')).toBe(true);
    expect(looksLikeRewardAttempt('32.13 Name')).toBe(true);
    expect(looksLikeRewardAttempt('04-09 Name')).toBe(true);
    expect(looksLikeRewardAttempt('hey guys, trains cancelled?')).toBe(false);
    expect(looksLikeRewardAttempt('thanks!')).toBe(false);
    expect(looksLikeRewardAttempt('')).toBe(false);
  });

  it('formats malformed warnings ingestion-proof with remediation steps', () => {
    const text = formatMalformedWarning([
      { rawLine: '04.09 Veymar ???', messageDateISO: '2026-09-06' },
    ]);
    expect(text.startsWith('⚠️')).toBe(true);
    expect(text).toContain('Could not understand');
    expect(text).toContain('delete the wrong message');
    expect(text).toContain('post a new message');
    expect(text).toContain('6 September');
    expect(text.split('\n')).toHaveLength(1);
    // The quoted date-like fragment must not match at a line start.
    expect(text).not.toMatch(/^\d{1,2}[./-]\d{1,2}/m);
  });
});