import { parse } from 'date-fns';

const MESSAGE_PATTERN = /^(?<date>\d{1,2}[./-]\d{1,2}(?:[./-]\d{2,4})?)\s+(?<driver>[^+]+?)(?:\s*\+\s*(?<vip>.+))?$/i;

export interface ParsedRewardMessage {
  happenedAt: Date;
  driverName: string;
  vipName?: string;
}

// A parsed reward line is suspicious when it breaks the channel's
// chronological order or postdates its own message — almost always a
// wrong-month typo (e.g. "04.08" posted in September). Ingesting such lines
// corrupts the train queue (drivers get moved to the end for drives that
// never happened on that date), so the ingester skips them and posts a
// warning instead.
//
// Backdated rule: the tracking channel is an append-only chronological log.
// A reward dated strictly before the latest reward date already in the
// database is either a typo or a late report; either way ingesting it would
// reorder the queue incorrectly, so it is skipped. A reward on the same day
// as (or after) the latest known date is fine, as is everything when the
// database holds no rewards yet (bootstrap).
export const FUTURE_REWARD_GRACE_DAYS = 1;

/** A line that starts like a reward entry (date token first) but isn't one. */
const DATE_LEADING_PATTERN = /^\d{1,2}[./-]\d{1,2}/;

/**
 * True for lines that were clearly meant as reward entries but cannot be
 * parsed (bad day/month, trailing garbage, …). Pure chatter ("hey guys")
 * returns false so everyday conversation never triggers warnings.
 */
export function looksLikeRewardAttempt(line: string): boolean {
  return DATE_LEADING_PATTERN.test(line.trimStart());
}

/** Marker prefix for bot-posted warnings. Such lines are never ingested. */
export const BOT_WARNING_PREFIX = '⚠️';

export function isBotWarningLine(line: string): boolean {
  return line.trimStart().startsWith(BOT_WARNING_PREFIX);
}

/** True when rewardDateISO is strictly before the latest known reward date. */
export function isBackdatedReward(
  rewardDateISO: string,
  latestRewardDateISO: string | null | undefined,
): boolean {
  if (!latestRewardDateISO) return false;
  return rewardDateISO < latestRewardDateISO;
}

/**
 * True when the reward day is more than FUTURE_REWARD_GRACE_DAYS ahead of
 * the reporting message's UTC day (a drive cannot be reported before it
 * happens; one day of grace covers late-evening posts).
 */
export function isFutureReward(
  rewardDateISO: string,
  messageTimestamp: Date | undefined,
  now: Date = new Date(),
): boolean {
  const ref = messageTimestamp && !Number.isNaN(messageTimestamp.getTime()) ? messageTimestamp : now;
  const parts = rewardDateISO.split('-').map(Number);
  if (parts.length < 3 || parts.some((n) => !Number.isFinite(n) || n <= 0)) return false;
  const rewardDay = Date.UTC(parts[0], parts[1] - 1, parts[2]);
  if (Number.isNaN(rewardDay)) return false;
  const refDay = Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate());
  return Math.round((rewardDay - refDay) / 86400000) > FUTURE_REWARD_GRACE_DAYS;
}

export type SkippedRewardReason = 'backdated' | 'future';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function describeDay(iso: string): string {
  const parts = iso.split('-').map(Number);
  if (parts.length < 3 || !parts[1] || parts[1] < 1 || parts[1] > 12 || !parts[2]) return iso;
  return `${parts[2]} ${MONTH_NAMES[parts[1] - 1]}`;
}

/**
 * Builds the warning posted to the tracking channel when backdated/future
 * lines are skipped. Tells the author exactly how to fix it: delete the
 * wrong message and post a new one — editing the old message alone is not
 * enough (the ingester only reads new messages) and leaving the wrong
 * message pollutes future full-channel re-ingests.
 *
 * The text is deliberately ingestion-proof: a single line starting with the
 * bot-warning marker, with dates spelled out as month names (never DD.MM),
 * so a later ingestion pass cannot parse it back as a reward.
 * parseMessagesIntoRewards() additionally drops marker lines outright.
 */
export function formatStaleWarning(
  entries: Array<{ driverName: string; rewardDateISO: string; messageDateISO: string; reason: SkippedRewardReason }>,
): string {
  const backdated = entries.filter((e) => e.reason === 'backdated').length;
  const future = entries.length - backdated;
  const cause =
    future === 0
      ? 'reward date older than the latest ingested reward date \u2014 likely a wrong-month typo'
      : backdated === 0
        ? 'reward date in the future \u2014 likely a typo'
        : 'reward date older than the latest ingested reward date or in the future \u2014 likely typos';
  const shown = entries.slice(0, 5).map(
    (e) => `${e.driverName} reported for ${describeDay(e.rewardDateISO)} in a ${describeDay(e.messageDateISO)} message`,
  );
  const more = entries.length > 5 ? ` and ${entries.length - 5} more` : '';
  const plural = entries.length === 1 ? '' : 's';
  return `${BOT_WARNING_PREFIX} [bot-warning] Skipped ${entries.length} suspicious reward line${plural} (${cause}; queue unchanged, nothing ingested): ${shown.join('; ')}${more}. To fix: 1) delete the wrong message, 2) post a new message with the correct date. Do not just edit the old message (edits are not picked up) and do not leave the wrong message in the channel.`;
}

/**
 * Builds the warning posted when lines look like reward entries but cannot
 * be parsed (wrong format). Quoted raw lines are safe to include: the whole
 * warning is one marker-prefixed line, so no quoted date token can match at
 * a line start. Same delete-and-repost remediation as stale warnings.
 */
export function formatMalformedWarning(
  entries: Array<{ rawLine: string; messageDateISO: string }>,
): string {
  const quote = (s: string) => `"${s.length > 80 ? s.slice(0, 80) + '…' : s}"`;
  const shown = entries
    .slice(0, 5)
    .map((e) => `${quote(e.rawLine)} posted ${describeDay(e.messageDateISO)}`);
  const more = entries.length > 5 ? ` and ${entries.length - 5} more` : '';
  const plural = entries.length === 1 ? '' : 's';
  return `${BOT_WARNING_PREFIX} [bot-warning] Could not understand ${entries.length} reward-looking line${plural} (wrong format; nothing ingested): ${shown.join('; ')}${more}. To fix: 1) delete the wrong message, 2) post a new message as "DD.MM driver + vip" with the correct date. Do not just edit the old message (edits are not picked up).`;
}

export function parseRewardMessage(raw: string, now = new Date()): ParsedRewardMessage | null {
  const content = raw.trim();
  const match = MESSAGE_PATTERN.exec(content);

  if (!match || !match.groups) {
    return null;
  }

  const { date, driver, vip } = match.groups;
  const happenedAt = resolveDate(date, now);

  if (!happenedAt) {
    return null;
  }

  // Clean driver name: remove trailing commas, parenthetical notes
  let driverName = driver.trim()
    .replace(/\s*\([^)]*\)\s*/g, ' ') // Remove parenthetical notes like "(demo run)"
    .replace(/,\s*$/, '')               // Remove trailing comma
    .replace(/\s+/g, ' ')               // Normalize whitespace
    .trim();
  
  // If driver contains comma, it might be multiple people - take only first
  if (driverName.includes(',')) {
    driverName = driverName.split(',')[0].trim();
  }

  // Clean VIP name if present
  let vipName: string | undefined = vip?.trim();
  if (vipName) {
    // Remove "VIP:" prefix if present
    vipName = vipName
      .replace(/^VIP:\s*/i, '')          // Remove "VIP:" prefix
      .replace(/\s*\([^)]*\)\s*/g, ' ')  // Remove parenthetical notes
      .replace(/,\s*$/, '')               // Remove trailing comma
      .replace(/\s+/g, ' ')               // Normalize whitespace
      .trim();
    
    // If VIP field is empty after cleaning, set to undefined
    if (!vipName) {
      vipName = undefined;
    }
  }

  if (!driverName) {
    return null;
  }

  return { happenedAt, driverName, vipName };
}

function resolveDate(token: string, now: Date): Date | null {
  const normalized = token.replace(/-/g, '.').replace(/\//g, '.');
  const segments = normalized.split('.').map((part) => part.trim()).filter(Boolean);

  if (segments.length < 2) {
    return null;
  }

  const [day, month, maybeYear] = segments;
  const monthNumber = parseInt(month, 10);
  const yearToken = maybeYear ? normalizeYearToken(maybeYear, monthNumber, now) : guessYear(monthNumber, now);
  const dateStr = `${day}.${month}.${yearToken}`;

  const date = parse(dateStr, 'd.M.yyyy', now);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date;
}

function normalizeYearToken(token: string, month: number, now: Date): string {
  const trimmed = token.trim();
  if (/^\d{4}$/.test(trimmed)) {
    return trimmed;
  }

  if (/^\d{2}$/.test(trimmed)) {
    const yearTwoDigit = parseInt(trimmed, 10);
    if (Number.isNaN(yearTwoDigit)) {
      return guessYear(month, now);
    }

    const currentYear = now.getUTCFullYear();
    const currentCentury = Math.floor(currentYear / 100) * 100;
    let candidate = currentCentury + yearTwoDigit;

    if (candidate > currentYear + 50) {
      candidate -= 100;
    } else if (candidate < currentYear - 50) {
      candidate += 100;
    }

    return String(candidate);
  }

  const numeric = parseInt(trimmed, 10);
  if (!Number.isNaN(numeric)) {
    return String(numeric);
  }

  return guessYear(month, now);
}

function guessYear(month: number, now: Date): string {
  const currentYear = now.getUTCFullYear();
  // If month is ahead of current month by more than 6, assume previous year (covers January logs for December rewards)
  if (month - (now.getUTCMonth() + 1) > 6) {
    return String(currentYear - 1);
  }
  return String(currentYear);
}
