// Dashboard translations: one file per language (source of truth), assembled
// here and serialized to JS by renderTranslationsJs(). Every language must
// expose the same key set — enforced by tests/pageI18n.test.ts.
import { de } from './de';
import { en } from './en';
import { fr } from './fr';
import { it } from './it';
import { ru } from './ru';

export type DashboardTranslations = Record<string, Record<string, string>>;

export const TRANSLATIONS: DashboardTranslations = { en, fr, de, ru, it };

export const SUPPORTED_LANGUAGES: readonly string[] = ['en', 'fr', 'de', 'ru', 'it'];

/** Serializes the table as a JS `const TRANSLATIONS = {...};` statement. */
export function renderTranslationsJs(): string {
  return '  const TRANSLATIONS = ' + JSON.stringify(TRANSLATIONS, null, 2) + ';';
}
