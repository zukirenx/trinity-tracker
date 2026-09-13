import { describe, expect, it } from 'vitest';
import {
  formatDate,
  formatDisplayDate,
  truncateName,
  formatScoreMillions,
  buildTableMessage,
  formatTableRows,
  formatLeaderboardLabel,
} from '../src/utils/format';

describe('formatDate', () => {
  it('formats a UTC date as YYYY-MM-DD', () => {
    expect(formatDate(new Date('2026-03-17T00:00:00Z'))).toBe('2026-03-17');
  });

  it('pads single-digit month and day', () => {
    expect(formatDate(new Date('2025-01-05T00:00:00Z'))).toBe('2025-01-05');
  });

  it('uses UTC to avoid timezone shift', () => {
    // A date at 23:00 UTC on Dec 31 should still be Dec 31, not Jan 1 in UTC
    const date = new Date('2025-12-31T23:59:59Z');
    expect(formatDate(date)).toBe('2025-12-31');
  });

  it('handles midnight UTC boundary correctly', () => {
    // This was the original bug: local time could shift the date
    const date = new Date('2025-06-15T00:00:00Z');
    expect(formatDate(date)).toBe('2025-06-15');
  });
});

describe('formatDisplayDate', () => {
  it('converts YYYY-MM-DD to DD.MM', () => {
    expect(formatDisplayDate('2026-03-17')).toBe('17.03');
  });

  it('returns original string for invalid format', () => {
    expect(formatDisplayDate('invalid')).toBe('invalid');
  });

  it('handles single segment', () => {
    expect(formatDisplayDate('2026')).toBe('2026');
  });
});

describe('truncateName', () => {
  it('returns name unchanged if within limit', () => {
    expect(truncateName('Player')).toBe('Player');
  });

  it('truncates name exceeding default limit (15)', () => {
    expect(truncateName('VeryLongPlayerNameHere')).toBe('VeryLongPlayerN');
  });

  it('respects custom limit', () => {
    expect(truncateName('LongName', 4)).toBe('Long');
  });

  it('trims whitespace before checking length', () => {
    expect(truncateName('  abc  ')).toBe('abc');
  });

  it('handles empty string', () => {
    expect(truncateName('')).toBe('');
  });
});

describe('formatScoreMillions', () => {
  it('returns 0 for zero', () => {
    expect(formatScoreMillions(0)).toBe('0');
  });

  it('formats large scores with no decimals', () => {
    expect(formatScoreMillions(150_000_000)).toBe('150M');
  });

  it('formats medium scores with 1 decimal', () => {
    expect(formatScoreMillions(25_500_000)).toBe('25.5M');
  });

  it('formats small scores with 2 decimals', () => {
    expect(formatScoreMillions(5_250_000)).toBe('5.25M');
  });

  it('returns — for NaN', () => {
    expect(formatScoreMillions(NaN)).toBe('—');
  });

  it('returns — for Infinity', () => {
    expect(formatScoreMillions(Infinity)).toBe('—');
  });

  it('handles negative scores', () => {
    expect(formatScoreMillions(-5_000_000)).toBe('-5.00M');
  });
});

describe('formatTableRows', () => {
  it('returns empty string for no rows', () => {
    expect(formatTableRows([], ['left'])).toBe('');
  });

  it('formats single header row without separator', () => {
    const result = formatTableRows([['A', 'B']], ['left', 'left']);
    expect(result).toBe('A  B');
  });

  it('aligns columns with right alignment', () => {
    const rows = [
      ['#', 'Name'],
      ['1', 'Alice'],
      ['10', 'Bob'],
    ];
    const result = formatTableRows(rows, ['right', 'left']);
    const lines = result.split('\n');
    expect(lines).toHaveLength(4); // header + separator + 2 data rows
    expect(lines[0]).toContain(' #');
    expect(lines[2]).toContain(' 1');
    expect(lines[3]).toContain('10');
  });

  it('inserts separator after header', () => {
    const rows = [
      ['Col1', 'Col2'],
      ['a', 'b'],
    ];
    const result = formatTableRows(rows, ['left', 'left']);
    const lines = result.split('\n');
    expect(lines[1]).toMatch(/^-+\s+-+$/);
  });
});

describe('buildTableMessage', () => {
  it('builds a message with header and table', () => {
    const { message, displayed } = buildTableMessage(
      '**Test**',
      ['#', 'Name'],
      [['1', 'Alice'], ['2', 'Bob']],
      ['right', 'left']
    );
    expect(displayed).toBe(2);
    expect(message).toContain('**Test**');
    expect(message).toContain('Alice');
    expect(message).toContain('Bob');
  });

  it('truncates rows that would exceed Discord message limit', () => {
    const longRows = Array.from({ length: 200 }, (_, i) => [
      `${i + 1}`,
      'A'.repeat(50),
      'B'.repeat(50),
    ]);
    const { displayed } = buildTableMessage(
      '**Header**',
      ['#', 'Name', 'Info'],
      longRows,
      ['right', 'left', 'left']
    );
    expect(displayed).toBeLessThan(200);
    expect(displayed).toBeGreaterThan(0);
  });

  it('returns at least one row even if it exceeds limit', () => {
    const { displayed } = buildTableMessage(
      'X'.repeat(1900),
      ['#', 'Name'],
      [['1', 'Alice']],
      ['right', 'left']
    );
    expect(displayed).toBe(1);
  });

  it('falls back to simplified format when single forced row exceeds 2000 chars', () => {
    const { message, displayed } = buildTableMessage(
      'H'.repeat(1950),
      ['#', 'Name'],
      [['1', 'A'.repeat(100)]],
      ['right', 'left']
    );
    expect(displayed).toBe(1);
    // Fallback format: "1. AAAA... – AAAA..."
    expect(message).not.toContain('```');
    expect(message.length).toBeLessThanOrEqual(2000);
  });
});

describe('formatLeaderboardLabel', () => {
  it('returns null for null input', () => {
    expect(formatLeaderboardLabel(null)).toBeNull();
  });

  it('extracts week number from title', () => {
    expect(formatLeaderboardLabel({ title: 'Week 10 Leaderboard', slug: 'ww10' })).toBe('Week 10');
  });

  it('falls back to slug week number', () => {
    expect(formatLeaderboardLabel({ title: null, slug: 'ww05' })).toBe('Week 5');
  });

  it('falls back to slug when no week pattern matches', () => {
    expect(formatLeaderboardLabel({ title: null, slug: 'special-event' })).toBe('special-event');
  });

  it('prefers title over slug', () => {
    expect(formatLeaderboardLabel({ title: 'Week 3 Results', slug: 'ww99' })).toBe('Week 3');
  });

  it('returns title when no week pattern in title but title exists', () => {
    expect(formatLeaderboardLabel({ title: 'Defeat S2', slug: 'defeat-s2' })).toBe('Defeat S2');
  });
});
