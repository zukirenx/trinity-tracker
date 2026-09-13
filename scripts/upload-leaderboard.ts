/**
 * Upload a parsed leaderboard JSON file into the D1 database.
 *
 * Example:
 *   npx tsx scripts/upload-leaderboard.ts \
 *     --input tmp/leaderboard/leaderboard-ww52.json \
 *     --slug ww52-2025 \
 *     --week 52 \
 *     --year 2025 \
 *     --source leaderboard-ww52.json
 */

import 'dotenv/config';
import { readFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import { z } from 'zod';

import { addWeeks, endOfISOWeek, formatISO, startOfISOWeek } from 'date-fns';

import { canonicalDisplayName, normalizeName } from '../src/utils/normalizer';

const ENTRY_SCHEMA = z.object({
  Ranking: z.number().int().min(1).optional(),
  ranking: z.number().int().min(1).optional(),
  Commander: z.string().min(1).optional(),
  commander: z.string().min(1).optional(),
  Points: z.number().int().min(0).optional(),
  points: z.number().int().min(0).optional(),
}).refine(
  entry => (entry.Ranking ?? entry.ranking) !== undefined
    && (entry.Commander ?? entry.commander) !== undefined
    && (entry.Points ?? entry.points) !== undefined,
  { message: 'Entry is missing required ranking/commander/points fields.' }
);

const PAYLOAD_SCHEMA = z.array(ENTRY_SCHEMA).min(1);

type CliOptions = {
  inputPath?: string;
  database: string;
  slug: string;
  title: string;
  weekStart?: string;
  weekEnd?: string;
  source?: string;
  isoWeek?: number;
  isoYear?: number;
  remote: boolean;
  env?: string;
  dryRun: boolean;
  updateMembers: boolean;
  maintenanceOnly: boolean;
  pointsMultiplier: number;
};

function parseArgs(argv: string[]): CliOptions {
  const args = new Map<string, string | undefined>();
  const tokens = argv.slice(2).filter(token => token !== '--');

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token.startsWith('--')) continue;

    const withoutPrefix = token.slice(2);
    const [flag, inlineValue] = withoutPrefix.split('=', 2);

    if (inlineValue !== undefined) {
      args.set(flag, inlineValue);
      continue;
    }

    const next = tokens[i + 1];
    if (next && !next.startsWith('--')) {
      args.set(flag, next);
      i += 1;
    } else {
      args.set(flag, undefined);
    }
  }

  const getValue = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = args.get(key);
      if (value !== undefined) return value;
    }
    return undefined;
  };

  const maintenanceOnly = args.has('maintenanceOnly') || args.has('maintenance-only');

  const inputPath = getValue('input', 'json');
  if (!maintenanceOnly && !inputPath) {
    throw new Error('Missing --input=<path-to-json> argument');
  }

  const resolvedInput = inputPath ? path.resolve(process.cwd(), inputPath) : undefined;
  const slugArg = getValue('slug');
  let slug: string;

  if (maintenanceOnly) {
    if (!slugArg) {
      throw new Error('When using --maintenance-only you must provide --slug=<identifier>.');
    }
    slug = slugArg.trim();
  } else {
    slug = (slugArg ?? path.parse(resolvedInput!).name).trim();
    if (!slug) {
      throw new Error('Unable to determine leaderboard slug. Pass --slug=<identifier>.');
    }
  }

  const parseIntOption = (value: string | undefined, label: string): number | undefined => {
    if (value === undefined) return undefined;
    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed)) {
      throw new Error(`Invalid ${label} value: ${value}`);
    }
    return parsed;
  };

  const isoWeek = parseIntOption(getValue('week', 'isoWeek', 'iso-week'), 'week');
  if (isoWeek !== undefined && (isoWeek < 1 || isoWeek > 53)) {
    throw new Error(`Invalid ISO week number: ${isoWeek}. Expected 1-53.`);
  }

  const isoYear = parseIntOption(getValue('year', 'isoYear', 'iso-year'), 'year');
  if (isoYear !== undefined && (isoYear < 2000 || isoYear > 3000)) {
    throw new Error(`Unreasonable ISO year: ${isoYear}.`);
  }

  const multiplierArg = parseIntOption(getValue('pointsMultiplier', 'points-multiplier', 'multiplier'), 'points multiplier');
  const x6Flag = args.has('x6') || args.has('multiply-by-6') || args.has('times6');
  const pointsMultiplier = multiplierArg ?? (x6Flag ? 6 : 1);
  if (pointsMultiplier < 1) {
    throw new Error(`Invalid points multiplier: ${pointsMultiplier}. Expected a positive integer.`);
  }

  const defaultTitle = !maintenanceOnly && isoWeek !== undefined && isoYear !== undefined
    ? `Week ${isoWeek.toString().padStart(2, '0')} ${isoYear} Leaderboard`
    : `Leaderboard ${slug.toUpperCase()}`;

  const remote = args.has('remote');
  const env = getValue('env');

  return {
    inputPath: resolvedInput,
    database: (getValue('database') ?? 'lw-rewards').trim(),
    slug,
    title: (getValue('title') ?? defaultTitle).trim(),
    weekStart: getValue('weekStart', 'week-start')?.trim(),
    weekEnd: getValue('weekEnd', 'week-end')?.trim(),
    source: getValue('source')?.trim(),
    isoWeek,
    isoYear,
    remote,
    env: env?.trim(),
    dryRun: args.has('dryRun') || args.has('dry-run'),
    updateMembers: args.has('updateMembers') || args.has('update-members'),
    maintenanceOnly,
    pointsMultiplier,
  };
}

type WranglerResult = {
  results?: Array<Record<string, unknown>>;
  success: boolean;
  error?: string;
};

function formatDate(date: Date): string {
  return formatISO(date, { representation: 'date' });
}

function computeIsoWeekRange(isoYear: number, isoWeek: number): { start: string; end: string } {
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const firstWeekStart = startOfISOWeek(jan4);
  const weekStartDate = addWeeks(firstWeekStart, isoWeek - 1);
  const weekEndDate = endOfISOWeek(weekStartDate);
  return {
    start: formatDate(weekStartDate),
    end: formatDate(weekEndDate),
  };
}

function spawnWrangler(database: string, sql: string, opts: { remote: boolean; env?: string }): WranglerResult[] {
  const __filename = fileURLToPath(import.meta.url);
  const projectRoot = path.resolve(path.dirname(__filename), '..');
  const wranglerCmd = process.platform === 'win32'
    ? path.resolve(projectRoot, 'node_modules', '.bin', 'wrangler.cmd')
    : path.resolve(projectRoot, 'node_modules', '.bin', 'wrangler');

  const baseArgs = ['d1', 'execute', database, '--command', sql, '--json'];
  if (opts.remote) {
    baseArgs.push('--remote');
  }
  if (opts.env) {
    baseArgs.push('--env', opts.env);
  }
  const command = process.platform === 'win32' ? 'cmd.exe' : wranglerCmd;
  const args = process.platform === 'win32'
    ? ['/c', wranglerCmd, ...baseArgs]
    : baseArgs;

  const result = spawnSync(command, args, {
    encoding: 'utf-8',
    cwd: projectRoot,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'wrangler command failed');
  }

  try {
    return JSON.parse(result.stdout) as WranglerResult[];
  } catch (error) {
    throw new Error(`Failed to parse wrangler output: ${result.stdout}\n${error}`);
  }
}

function getFirstRow(results: WranglerResult[]): Record<string, unknown> | undefined {
  for (const statement of results) {
    if (!statement.success) {
      throw new Error(statement.error ?? 'Statement failed');
    }
    if (statement.results && statement.results.length > 0) {
      return statement.results[0];
    }
  }
  return undefined;
}

function escapeSql(value: string | null | undefined): string {
  if (value == null) return 'NULL';
  const escaped = value.replace(/'/g, "''");
  return `'${escaped}'`;
}

function collectRows(results: WranglerResult[]): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const statement of results) {
    if (!statement.success) {
      throw new Error(statement.error ?? 'Statement failed');
    }
    if (statement.results) {
      rows.push(...statement.results);
    }
  }
  return rows;
}

type MemberRow = {
  id: number;
  display_name: string;
  normalized_name: string;
};

type LeaderboardCommander = {
  rank: number;
  commander: string;
  normalized: string;
};

async function backupRemoteDatabase(
  database: string,
  opts: { env?: string },
): Promise<string> {
  const __filename = fileURLToPath(import.meta.url);
  const projectRoot = path.resolve(path.dirname(__filename), '..');
  const wranglerCmd = process.platform === 'win32'
    ? path.resolve(projectRoot, 'node_modules', '.bin', 'wrangler.cmd')
    : path.resolve(projectRoot, 'node_modules', '.bin', 'wrangler');

  const backupsDir = path.resolve(projectRoot, 'backups');
  await mkdir(backupsDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${database}-remote-backup-${timestamp}.sql`;
  const outputPath = path.join(backupsDir, filename);

  const baseArgs = ['d1', 'export', database, '--output', outputPath, '--remote'];
  if (opts.env) {
    baseArgs.push('--env', opts.env);
  }

  const command = process.platform === 'win32' ? 'cmd.exe' : wranglerCmd;
  const args = process.platform === 'win32'
    ? ['/c', wranglerCmd, ...baseArgs]
    : baseArgs;

  const result = spawnSync(command, args, {
    encoding: 'utf-8',
    cwd: projectRoot,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'Failed to export remote database');
  }

  console.log(`Remote backup saved to ${outputPath}`);
  return outputPath;
}

async function ensureLeaderboardMembers(
  database: string,
  commanders: LeaderboardCommander[],
  opts: { remote: boolean; env?: string },
): Promise<void> {
  const byNormalized = new Map<string, { commander: string }>();
  for (const entry of commanders) {
    if (!byNormalized.has(entry.normalized)) {
      byNormalized.set(entry.normalized, { commander: entry.commander });
    }
  }

  for (const [normalized, info] of byNormalized.entries()) {
    const displaySql = escapeSql(info.commander);
    const normalizedSql = escapeSql(normalized);
    const existing = collectRows(
      await spawnWrangler(
        database,
        `SELECT id, display_name, active FROM members WHERE normalized_name = ${normalizedSql} LIMIT 1;`,
        opts,
      ),
    );

    if (existing.length === 0) {
      await spawnWrangler(
        database,
        `INSERT INTO members (display_name, normalized_name, active) VALUES (${displaySql}, ${normalizedSql}, 1);`,
        opts,
      );
      console.log(`  Added new active member from leaderboard: ${info.commander}`);
      continue;
    }

    const row = existing[0];
    const currentDisplay = typeof row.display_name === 'string' ? row.display_name : String(row.display_name ?? '');
    const currentActive = Number(row.active) === 1;
    const setStatements: string[] = [];

    if (currentDisplay !== info.commander) {
      setStatements.push(`display_name = ${displaySql}`);
    }
    if (!currentActive) {
      setStatements.push('active = 1');
    }

    if (setStatements.length > 0) {
      await spawnWrangler(
        database,
        `UPDATE members SET ${setStatements.join(', ')} WHERE normalized_name = ${normalizedSql};`,
        opts,
      );
      if (!currentActive) {
        console.log(`  Reactivated member ${info.commander} based on leaderboard entry.`);
      } else {
        console.log(`  Updated display name for ${normalized} to '${info.commander}'.`);
      }
    }
  }
}

async function fetchActiveMembers(
  database: string,
  opts: { remote: boolean; env?: string },
): Promise<MemberRow[]> {
  const rows = collectRows(
    await spawnWrangler(
      database,
      'SELECT id, display_name, normalized_name FROM members WHERE active = 1 ORDER BY display_name COLLATE NOCASE;',
      opts,
    ),
  );

  return rows.map((row) => {
    const idValue = row.id;
    const displayValue = row.display_name;
    const normalizedValue = row.normalized_name;

    const id = typeof idValue === 'number' ? idValue : Number(idValue);
    if (!Number.isFinite(id)) {
      throw new Error('Invalid member id returned from database.');
    }

    if (typeof displayValue !== 'string' || typeof normalizedValue !== 'string') {
      throw new Error('Member rows missing required string fields.');
    }

    return {
      id,
      display_name: displayValue,
      normalized_name: normalizedValue,
    };
  });
}

async function ensureAlias(
  database: string,
  memberId: number,
  alias: string,
  opts: { remote: boolean; env?: string },
): Promise<void> {
  const trimmed = alias.trim();
  if (!trimmed) return;

  const aliasSql = escapeSql(trimmed);
  const existing = collectRows(
    await spawnWrangler(
      database,
      `SELECT 1 FROM member_aliases WHERE member_id = ${memberId} AND alias = ${aliasSql} LIMIT 1;`,
      opts,
    ),
  );

  if (existing.length > 0) {
    return;
  }

  await spawnWrangler(
    database,
    `INSERT INTO member_aliases (member_id, alias) VALUES (${memberId}, ${aliasSql});`,
    opts,
  );
}

async function mergeMemberRecords(
  database: string,
  duplicate: MemberRow,
  target: LeaderboardCommander,
  opts: { remote: boolean; env?: string },
): Promise<void> {
  const duplicateNormalized = normalizeName(duplicate.display_name);
  if (duplicateNormalized === target.normalized) {
    return;
  }

  const targetDisplaySql = escapeSql(target.commander);
  const targetNormalizedSql = escapeSql(target.normalized);

  const existing = collectRows(
    await spawnWrangler(
      database,
      `SELECT id FROM members WHERE normalized_name = ${targetNormalizedSql} LIMIT 1;`,
      opts,
    ),
  );

  let targetId: number;
  if (existing.length === 0) {
    const inserted = getFirstRow(
      await spawnWrangler(
        database,
        `INSERT INTO members (display_name, normalized_name, active) VALUES (${targetDisplaySql}, ${targetNormalizedSql}, 1) RETURNING id;`,
        opts,
      ),
    );
    if (!inserted || typeof inserted.id !== 'number') {
      throw new Error('Failed to create target member record.');
    }
    targetId = inserted.id;
  } else {
    const rawId = existing[0].id;
    const parsedId = typeof rawId === 'number' ? rawId : Number(rawId);
    if (!Number.isFinite(parsedId)) {
      throw new Error('Invalid target member id.');
    }
    targetId = parsedId;
    await spawnWrangler(
      database,
      `UPDATE members SET display_name = ${targetDisplaySql}, active = 1 WHERE id = ${targetId};`,
      opts,
    );
  }

  if (normalizeName(duplicate.display_name) !== target.normalized) {
    await ensureAlias(database, targetId, duplicate.display_name, opts);
  }

  const duplicateAliases = collectRows(
    await spawnWrangler(
      database,
      `SELECT alias FROM member_aliases WHERE member_id = ${duplicate.id};`,
      opts,
    ),
  );

  for (const aliasRow of duplicateAliases) {
    const aliasValue = aliasRow.alias;
    const aliasString = typeof aliasValue === 'string' ? aliasValue : String(aliasValue ?? '');
    if (!aliasString) continue;
    if (normalizeName(aliasString) === target.normalized) continue;
    await ensureAlias(database, targetId, aliasString, opts);
  }

  const duplicateDisplaySql = escapeSql(duplicate.display_name);
  await spawnWrangler(
    database,
    `UPDATE rewards SET driver_name = ${targetDisplaySql} WHERE driver_name = ${duplicateDisplaySql};`,
    opts,
  );
  await spawnWrangler(
    database,
    `UPDATE rewards SET vip_name = ${targetDisplaySql} WHERE vip_name = ${duplicateDisplaySql};`,
    opts,
  );

  await spawnWrangler(
    database,
    `DELETE FROM members WHERE id = ${duplicate.id};`,
    opts,
  );
}

async function promptForMergeTarget(
  rl: ReturnType<typeof createInterface>,
  commanders: LeaderboardCommander[],
): Promise<LeaderboardCommander | undefined> {
  while (true) {
    const raw = (await rl.question('  Merge target (#, name, or enter to skip): ')).trim();
    if (raw === '' || raw.toLowerCase() === 'skip' || raw.toLowerCase() === 's') {
      return undefined;
    }

    if (/^\d+$/.test(raw)) {
      const index = Number.parseInt(raw, 10);
      if (index >= 1 && index <= commanders.length) {
        return commanders[index - 1];
      }
      console.log('  Index out of range.');
      continue;
    }

    const normalizedInput = normalizeName(raw);
    const match = commanders.find((entry) =>
      entry.normalized === normalizedInput || entry.commander.toLowerCase() === raw.toLowerCase(),
    );
    if (match) {
      return match;
    }

    console.log('  Could not match that commander. Try again or press enter to skip.');
  }
}

async function promptMemberMaintenance(
  database: string,
  commanders: LeaderboardCommander[],
  opts: { remote: boolean; env?: string },
): Promise<void> {
  const normalizedSet = new Set(commanders.map((entry) => entry.normalized));
  const rl = createInterface({ input, output });

  try {
    const activeMembers = await fetchActiveMembers(database, opts);
    if (activeMembers.length === 0) {
      console.log('No active members found in the database.');
      return;
    }

    for (const member of activeMembers) {
      const memberNormalized = member.normalized_name;
      const normalizedDisplay = normalizeName(member.display_name);
      if (normalizedSet.has(memberNormalized) || normalizedSet.has(normalizedDisplay)) {
        continue;
      }

      console.log(`\nMember '${member.display_name}' is active but missing from the leaderboard.`);
      let action: string;
      while (true) {
        action = (await rl.question('  Action? [enter=keep, r=remove, m=merge]: ')).trim().toLowerCase();
        if (action === '' || action === 'r' || action === 'remove' || action === 'm' || action === 'merge') {
          break;
        }
        console.log('  Please choose enter, r, or m.');
      }

      if (action === '' || action === 'keep') {
        continue;
      }

      if (action.startsWith('r')) {
        await spawnWrangler(
          database,
          `UPDATE members SET active = 0 WHERE id = ${member.id};`,
          opts,
        );
        console.log(`  Marked ${member.display_name} inactive.`);
        continue;
      }

      const target = await promptForMergeTarget(rl, commanders);
      if (!target) {
        console.log('  Merge skipped.');
        continue;
      }

      await mergeMemberRecords(database, member, target, opts);
      console.log(`  Merged ${member.display_name} into ${target.commander}.`);
    }
  } finally {
    rl.close();
  }
}

async function guardRankConsistency(entries: LeaderboardCommander[]): Promise<void> {
  if (entries.length === 0) return;

  const seen = new Set<number>();
  const duplicates = new Set<number>();
  let maxRank = 0;

  for (const entry of entries) {
    if (seen.has(entry.rank)) {
      duplicates.add(entry.rank);
    }
    seen.add(entry.rank);
    if (entry.rank > maxRank) {
      maxRank = entry.rank;
    }
  }

  const missing: number[] = [];
  for (let i = 1; i <= maxRank; i += 1) {
    if (!seen.has(i)) {
      missing.push(i);
    }
  }

  if (duplicates.size === 0 && missing.length === 0) {
    return;
  }

  console.log('Detected inconsistencies in leaderboard ranks.');
  if (duplicates.size > 0) {
    const duplicateList = Array.from(duplicates).sort((a, b) => a - b).join(', ');
    console.log(` Duplicate ranks: ${duplicateList}`);
  }
  if (missing.length > 0) {
    console.log(` Missing ranks: ${missing.join(', ')}`);
  }

  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question(' Continue with upload anyway? [y/N]: ')).trim().toLowerCase();
    if (answer !== 'y' && answer !== 'yes') {
      throw new Error('Aborted due to rank inconsistencies in leaderboard input.');
    }
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv);
  const wranglerOpts = { remote: options.remote, env: options.env };

  if (options.maintenanceOnly) {
    if (!options.updateMembers) {
      console.log('Specify --update-members together with --maintenance-only to review active members.');
      return;
    }

    const slugSql = escapeSql(options.slug);
    const leaderboardRow = getFirstRow(
      spawnWrangler(
        options.database,
        `SELECT id FROM leaderboards WHERE slug = ${slugSql} LIMIT 1;`,
        wranglerOpts,
      ),
    );

    if (!leaderboardRow || typeof leaderboardRow.id !== 'number') {
      throw new Error(`Leaderboard with slug '${options.slug}' not found.`);
    }

    const entries = collectRows(
      spawnWrangler(
        options.database,
        `SELECT rank, commander, normalized_commander AS normalized FROM leaderboard_entries WHERE leaderboard_id = ${leaderboardRow.id} ORDER BY rank ASC;`,
        wranglerOpts,
      ),
    ).map((row) => {
      const rankValue = row.rank;
      if (typeof rankValue !== 'number') {
        throw new Error('Unexpected rank value when loading leaderboard entries.');
      }
      const commanderValue = row.commander;
      const normalizedValue = row.normalized;
      if (typeof commanderValue !== 'string' || typeof normalizedValue !== 'string') {
        throw new Error('Unexpected commander row shape.');
      }
      return {
        rank: rankValue,
        commander: commanderValue,
        normalized: normalizedValue,
      };
    });

    if (entries.length === 0) {
      console.log(`No leaderboard entries stored for slug '${options.slug}'.`);
      return;
    }

    await promptMemberMaintenance(options.database, entries, wranglerOpts);
    console.log(`Member maintenance completed using existing leaderboard '${options.slug}'.`);
    return;
  }

  if (!options.inputPath) {
    throw new Error('Missing --input=<path-to-json> argument');
  }

  const raw = await readFile(options.inputPath, 'utf-8');
  const parsed = PAYLOAD_SCHEMA.parse(JSON.parse(raw));

  if ((options.isoWeek === undefined) !== (options.isoYear === undefined)) {
    throw new Error('Specify both --week and --year when providing ISO week metadata.');
  }

  const entries = parsed.map(entry => {
    const rank = entry.Ranking ?? entry.ranking!;
    const commanderRaw = entry.Commander ?? entry.commander!;
    const points = (entry.Points ?? entry.points!) * options.pointsMultiplier;
    return {
      rank,
      commander: canonicalDisplayName(commanderRaw),
      normalized: normalizeName(commanderRaw),
      points,
    };
  });

  if (options.dryRun) {
    console.log(`[dry-run] Would upsert leaderboard '${options.slug}' with ${entries.length} entries (points multiplier: ${options.pointsMultiplier}x).`);
    return;
  }

  if (options.pointsMultiplier !== 1) {
    console.log(`Applying points multiplier: ${options.pointsMultiplier}x`);
  }

  await guardRankConsistency(entries);

  if (options.remote && !options.dryRun) {
    await backupRemoteDatabase(options.database, { env: options.env });
  }

  let weekStart = options.weekStart;
  let weekEnd = options.weekEnd;

  if (options.isoWeek !== undefined && options.isoYear !== undefined) {
    const range = computeIsoWeekRange(options.isoYear, options.isoWeek);
    weekStart = weekStart ?? range.start;
    weekEnd = weekEnd ?? range.end;
  }

  const slugSql = escapeSql(options.slug);
  const titleSql = escapeSql(options.title);
  const sourceSql = escapeSql(options.source ?? options.inputPath);
  const weekStartSql = escapeSql(weekStart ?? null);
  const weekEndSql = escapeSql(weekEnd ?? null);

  const existing = getFirstRow(spawnWrangler(options.database, `SELECT id FROM leaderboards WHERE slug = ${slugSql} LIMIT 1;`, wranglerOpts));
  let leaderboardId: number;

  if (existing && typeof existing.id === 'number') {
    leaderboardId = existing.id;
    spawnWrangler(options.database, `UPDATE leaderboards SET title = ${titleSql}, week_start = ${weekStartSql}, week_end = ${weekEndSql}, source = ${sourceSql} WHERE id = ${leaderboardId};`, wranglerOpts);
    console.log(`Updated existing leaderboard '${options.slug}' (id=${leaderboardId}).`);
  } else {
    const inserted = getFirstRow(spawnWrangler(options.database, `INSERT INTO leaderboards (slug, title, week_start, week_end, source) VALUES (${slugSql}, ${titleSql}, ${weekStartSql}, ${weekEndSql}, ${sourceSql}) RETURNING id;`, wranglerOpts));
    if (!inserted || typeof inserted.id !== 'number') {
      throw new Error('Failed to insert leaderboard metadata.');
    }
    leaderboardId = inserted.id;
    console.log(`Created new leaderboard '${options.slug}' (id=${leaderboardId}).`);
  }

  spawnWrangler(options.database, `DELETE FROM leaderboard_entries WHERE leaderboard_id = ${leaderboardId};`, wranglerOpts);

  const values = entries
    .map(entry => `(${leaderboardId}, ${entry.rank}, ${escapeSql(entry.commander)}, ${escapeSql(entry.normalized)}, ${entry.points})`)
    .join(', ');

  if (values.length === 0) {
    console.log('No entries to insert (after filtering).');
  } else {
    const insertSql = `INSERT INTO leaderboard_entries (leaderboard_id, rank, commander, normalized_commander, points) VALUES ${values};`;
    spawnWrangler(options.database, insertSql, wranglerOpts);
  }

  console.log(`Imported ${entries.length} leaderboard rows for '${options.slug}'.`);

  console.log('\nLeaderboard commanders from JSON:');
  for (const entry of entries) {
    console.log(` ${entry.rank.toString().padStart(3, ' ')}. ${entry.commander} (${entry.points})`);
  }

  if (options.updateMembers) {
    await ensureLeaderboardMembers(options.database, entries, wranglerOpts);
    await promptMemberMaintenance(options.database, entries, wranglerOpts);
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
