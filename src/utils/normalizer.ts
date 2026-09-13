const TRIM_REGEXP = /\s+/g;
const ZERO_CHAR = /0/g;
const NON_ALPHANUM = /[^a-z0-9]/g;
const DIACRITICS = /[\u0300-\u036f]/g;

export function normalizeName(input: string): string {
  const ascii = input
    .normalize('NFD')
    .replace(DIACRITICS, '')
    .toLowerCase();

  const zeroFixed = ascii.replace(ZERO_CHAR, 'o');
  const collapsed = zeroFixed.replace(TRIM_REGEXP, ' ').trim();
  return collapsed.replace(NON_ALPHANUM, '');
}

export function canonicalDisplayName(input: string): string {
  const trimmed = input.trim();
  return trimmed.replace(TRIM_REGEXP, ' ');
}
