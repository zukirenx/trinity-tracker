import { describe, expect, it } from 'vitest';
import { renderPage } from '../src/web/page';
import { SUPPORTED_LANGUAGES, TRANSLATIONS } from '../src/web/page/i18n/index';

function placeholders(s: string): string[] {
  return [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

describe('dashboard i18n consistency', () => {
  it('all languages expose the same key set', () => {
    const enKeys = Object.keys(TRANSLATIONS.en).sort();
    expect(enKeys.length).toBeGreaterThan(0);
    for (const lang of SUPPORTED_LANGUAGES) {
      if (lang === 'en') continue;
      expect(Object.keys(TRANSLATIONS[lang]).sort()).toEqual(enKeys);
    }
  });

  it('every data-i18n key in the markup exists in translations', () => {
    for (const role of ['admin', 'readonly'] as const) {
      const html = renderPage('test-token', role);
      const keys = new Set<string>();
      for (const m of html.matchAll(/data-i18n="([^"]+)"/g)) keys.add(m[1]);
      for (const m of html.matchAll(/data-i18n-html="([^"]+)"/g)) keys.add(m[1]);
      for (const m of html.matchAll(/data-i18n-attr="([^"]+)"/g)) {
        for (const pair of m[1].split(',')) {
          const parts = pair.split(':');
          if (parts.length === 2) keys.add(parts[1].trim());
        }
      }
      expect(keys.size).toBeGreaterThan(0);
      for (const key of keys) {
        expect(
          TRANSLATIONS.en[key],
          `${role}: missing translation for data-i18n key "${key}"`,
        ).toBeDefined();
      }
    }
  });

  it('every static client t(...) key exists in translations', () => {
    const html = renderPage('test-token', 'admin');
    const script = html.slice(html.indexOf('<script>'));
    const missing = new Set<string>();
    // \bt avoids false positives from prompt('/...'), split(','), etc.
    const re = /\bt\('([^'\\]+)'/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(script)) !== null) {
      // Skip dynamic keys such as t('ev.role.' + row.role).
      if (script.startsWith(' +', m.index + m[0].length)) continue;
      if (!(m[1] in TRANSLATIONS.en)) missing.add(m[1]);
    }
    expect([...missing]).toEqual([]);
  });

  it('placeholders match the English source in every language', () => {
    // Known grammar exceptions: {s} appends an English plural suffix, which
    // Russian cannot use (день/дня/дней) — the ru text deliberately omits it
    // and t() tolerates absent placeholders.
    const exceptions = new Set(['ru:queue.stale']);
    const mismatches: string[] = [];
    for (const key of Object.keys(TRANSLATIONS.en)) {
      const expected = JSON.stringify(placeholders(TRANSLATIONS.en[key]));
      for (const lang of SUPPORTED_LANGUAGES) {
        if (lang === 'en') continue;
        if (exceptions.has(`${lang}:${key}`)) continue;
        const actual = JSON.stringify(placeholders(TRANSLATIONS[lang][key] ?? ''));
        if (actual !== expected) mismatches.push(`${lang}:${key}`);
      }
    }
    expect(mismatches).toEqual([]);
  });
});
