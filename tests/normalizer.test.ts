import { describe, expect, it } from 'vitest';
import { normalizeName, canonicalDisplayName } from '../src/utils/normalizer';

describe('normalizeName', () => {
  it('lowercases and removes non-alphanumeric characters', () => {
    expect(normalizeName('Hello World')).toBe('helloworld');
  });

  it('replaces 0 with o', () => {
    expect(normalizeName('Play3r0ne')).toBe('play3rone');
  });

  it('strips diacritics', () => {
    expect(normalizeName('Café')).toBe('cafe');
    expect(normalizeName('über')).toBe('uber');
    expect(normalizeName('naïve')).toBe('naive');
  });

  it('removes special characters', () => {
    expect(normalizeName('player-one_two')).toBe('playeronetwo');
    expect(normalizeName('test@#$%!')).toBe('test');
  });

  it('collapses whitespace before removing non-alphanum', () => {
    expect(normalizeName('  multi   space  ')).toBe('multispace');
  });

  it('handles empty string', () => {
    expect(normalizeName('')).toBe('');
  });

  it('handles string with only special characters', () => {
    expect(normalizeName('---')).toBe('');
  });

  it('normalizes game names with zero/O confusion', () => {
    // "0xypia" and "Oxypia" should normalize to same value
    expect(normalizeName('0xypia')).toBe(normalizeName('Oxypia'));
  });

  it('handles mixed diacritics and zeros', () => {
    expect(normalizeName('Z0rr0 Señor')).toBe('zorrosenor');
  });
});

describe('canonicalDisplayName', () => {
  it('trims leading and trailing whitespace', () => {
    expect(canonicalDisplayName('  hello  ')).toBe('hello');
  });

  it('collapses internal whitespace', () => {
    expect(canonicalDisplayName('Kent  le   grand')).toBe('Kent le grand');
  });

  it('preserves original case', () => {
    expect(canonicalDisplayName('ZukirenX')).toBe('ZukirenX');
  });

  it('handles empty string', () => {
    expect(canonicalDisplayName('')).toBe('');
  });

  it('handles single word', () => {
    expect(canonicalDisplayName('  Oxypia  ')).toBe('Oxypia');
  });
});
