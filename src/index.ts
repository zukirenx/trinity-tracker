import { verifyKey } from 'discord-interactions';
import { InteractionType, InteractionResponseType } from 'discord-api-types/v10';
import { DataStore } from './storage';
import { parseRewardMessage, isBackdatedReward, isFutureReward, isBotWarningLine, looksLikeRewardAttempt, formatStaleWarning, formatMalformedWarning, type SkippedRewardReason } from './utils/rewardParser';
import { formatDate, truncateName, buildTableMessage } from './utils/format';
import { renderPage } from './web/page';
import {
  EventsStore,
  isValidRegStatus,
  isValidSquadType,
  isValidTeamPref,
  isValidTimeSlot,
  isValidCloseTime,
  resolveAnySlots,
  resolveAnyTeams,
  getSameTeamTime,
  computeEventTimestamp,
  computeRegistrationCloseTimestamp,
  serverWallFromGameSlot,
  computeRosterHash,
  VALID_CANYON_TIMES,
  VALID_DESERT_TIMES,
  CANYON_EVENT_DAY,
  DESERT_EVENT_DAY,
  CANYON_CLOSE_DAY_OFFSET,
  DESERT_CLOSE_DAY_OFFSET,
  type Assignment,
  type AssignmentInput,
  type AssignmentRole,
  type AssignmentTeam,
  type EventKind,
  type EventsSettings,
} from './eventsStore';
import { suggestRoster, DS_ROLE_SLOTS, CANYON_ROLE_SLOTS, seededRng, hashString } from './utils/eventSuggest';

/**
 * Discord channel for roster/registration announcements.
 * Set ROSTER_CHANNEL_ID as a Worker secret/env var. Falls back to
 * TRACKING_CHANNEL_ID so a single-channel setup keeps working.
 *
 * NOTE: if you use a separate announcements channel, ROSTER_CHANNEL_ID must
 * be set (wrangler secret put ROSTER_CHANNEL_ID). When it is missing the bot
 * posts announcements/rosters into the train-log (TRACKING) channel, which
 * pollutes the log.
 */
export function getRosterChannel(env: Env): string {
  const roster = env.ROSTER_CHANNEL_ID?.trim();
  if (roster) return roster;
  if (env.ROSTER_CHANNEL_ID != null && env.ROSTER_CHANNEL_ID.trim() === '') {
    console.warn(
      '[config] ROSTER_CHANNEL_ID is set but empty — falling back to TRACKING_CHANNEL_ID. ' +
      'Set it to the announcements channel ID to keep the train log clean.',
    );
  } else {
    console.warn(
      '[config] ROSTER_CHANNEL_ID is not set — posting announcements/rosters to TRACKING_CHANNEL_ID. ' +
      'Set ROSTER_CHANNEL_ID to the announcements channel ID to keep the train log clean.',
    );
  }
  return env.TRACKING_CHANNEL_ID;
}

/** 02:00 UTC == midnight at UTC-2 (game-server time). */
const SERVER_MIDNIGHT_UTC_HOUR = 2;

export interface Env {
  DISCORD_PUBLIC_KEY: string;
  DISCORD_BOT_TOKEN: string;
  DISCORD_APPLICATION_ID: string;
  TRACKING_CHANNEL_ID: string;
  ROSTER_CHANNEL_ID?: string;
  GUILD_ID: string;
  DB: D1Database;
  WEB_ACCESS_TOKEN?: string;
  WEB_READONLY_TOKEN?: string;
  /** Optional: full public URL of the worker (e.g. https://lw-discord-bot.example.workers.dev). Used in auto-open Discord posts. */
  WORKER_URL?: string;
}

export interface DiscordChannelMessage {
  id: string;
  content?: string;
  timestamp: string;
  author?: {
    username?: string;
  };
  attachments?: unknown[];
}

export interface ParsedReward {
  date: string;
  driverName: string;
  vipName: string | null;
  type: string;
  rawText: string;
  sourceMessageId: string;
  sourceLine: number;
}

export interface SkippedRewardLine {
  rawLine: string;
  date: string;
  driverName: string;
  messageId: string;
  messageDate: string;
  reason: SkippedRewardReason;
}

export interface MalformedRewardLine {
  rawLine: string;
  messageId: string;
  messageDate: string;
}

export function parseMessagesIntoRewards(
  messages: DiscordChannelMessage[],
  opts?: { latestRewardDate?: string | null },
): { rewards: ParsedReward[]; memberNames: Set<string>; parsed: number; failed: number; skipped: SkippedRewardLine[]; malformed: MalformedRewardLine[] } {
  const rewards: ParsedReward[] = [];
  const memberNames = new Set<string>();
  const skipped: SkippedRewardLine[] = [];
  const malformed: MalformedRewardLine[] = [];
  let parsed = 0;
  let failed = 0;

  for (const msg of messages) {
    const content = msg.content ?? '';
    if (!content.trim()) continue;

    const messageTimestamp = msg.timestamp ? new Date(msg.timestamp) : undefined;
    const referenceDate = messageTimestamp && !Number.isNaN(messageTimestamp.getTime()) ? messageTimestamp : undefined;
    const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

    for (const [lineIndex, line] of lines.entries()) {
      const cleanedLine = line.replace(/\s*\([^)]*\)\s*$/g, '').trim();
      if (!cleanedLine) continue;

      // Bot-posted warnings (e.g. stale-date alerts) must never be ingested.
      if (isBotWarningLine(cleanedLine)) continue;

      const result = parseRewardMessage(cleanedLine, referenceDate);
      if (result) {
        const date = formatDate(result.happenedAt);
        // Chronological guard: the channel is an append-only log. A reward
        // dated before the latest known reward (or ahead of its own message)
        // is a typo or an out-of-order late report — ingesting it would move
        // the queue incorrectly, so skip it and report it instead.
        const reason: SkippedRewardReason | null = isBackdatedReward(date, opts?.latestRewardDate)
          ? 'backdated'
          : isFutureReward(date, messageTimestamp)
            ? 'future'
            : null;
        if (reason) {
          skipped.push({
            rawLine: cleanedLine,
            date,
            driverName: result.driverName,
            messageId: msg.id,
            messageDate: formatDate(messageTimestamp && !Number.isNaN(messageTimestamp.getTime()) ? messageTimestamp : new Date()),
            reason,
          });
          continue;
        }
        memberNames.add(result.driverName);
        if (result.vipName) {
          memberNames.add(result.vipName);
        }

        rewards.push({
          date,
          driverName: result.driverName,
          vipName: null,
          type: 'TRAIN',
          rawText: cleanedLine,
          sourceMessageId: msg.id,
          sourceLine: lineIndex,
        });

        if (result.vipName) {
          rewards.push({
            date,
            driverName: result.driverName,
            vipName: result.vipName,
            type: 'VIP',
            rawText: cleanedLine,
            sourceMessageId: msg.id,
            sourceLine: lineIndex,
          });
        }

        parsed++;
      } else {
        failed++;
        // A failed line that still starts with a date token was meant as a
        // reward entry (wrong format). Record it for a warning; pure chatter
        // stays silent.
        if (looksLikeRewardAttempt(cleanedLine)) {
          malformed.push({
            rawLine: cleanedLine,
            messageId: msg.id,
            messageDate: formatDate(messageTimestamp && !Number.isNaN(messageTimestamp.getTime()) ? messageTimestamp : new Date()),
          });
        }
      }
    }
  }

  return { rewards, memberNames, parsed, failed, skipped, malformed };
}

// Posts reward warnings (skipped/malformed lines) to the tracking channel as
// a single message. Best-effort: failures are logged but never break
// ingestion.
async function postRewardWarnings(env: Env, skipped: SkippedRewardLine[], malformed: MalformedRewardLine[]): Promise<void> {
  const parts: string[] = [];
  if (skipped.length > 0) {
    parts.push(formatStaleWarning(
      skipped.map((s) => ({ driverName: s.driverName, rewardDateISO: s.date, messageDateISO: s.messageDate, reason: s.reason })),
    ));
  }
  if (malformed.length > 0) {
    parts.push(formatMalformedWarning(
      malformed.map((m) => ({ rawLine: m.rawLine, messageDateISO: m.messageDate })),
    ));
  }
  if (parts.length === 0) return;
  // Every part is a marker-prefixed single line, so the joined message can
  // never be parsed back as rewards.
  const res = await fetch(`https://discord.com/api/v10/channels/${env.TRACKING_CHANNEL_ID}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bot ${env.DISCORD_BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ content: parts.join('\n') }),
  });
  if (!res.ok) {
    console.error(`Reward warning post failed: ${res.status} ${await res.text()}`);
  }
}

// Check for new messages and auto-ingest if needed (background-safe)
async function autoIngestIfNeeded(store: DataStore, env: Env): Promise<{ ingested: boolean; count: number; skipped: number; malformed: number }> {
  const lastIngestionTime = await store.getLastIngestionTime();
  
  if (!lastIngestionTime) {
    return { ingested: false, count: 0, skipped: 0, malformed: 0 };
  }
  
  const allMessages = await fetchChannelMessages(env.TRACKING_CHANNEL_ID, env.DISCORD_BOT_TOKEN, 100);
  
  const newMessages = allMessages.filter(msg => 
    msg.timestamp && new Date(msg.timestamp) > new Date(lastIngestionTime)
  );
  
  if (newMessages.length === 0) {
    return { ingested: false, count: 0, skipped: 0, malformed: 0 };
  }
  
  const { rewards, memberNames, skipped, malformed } = parseMessagesIntoRewards(newMessages, {
    latestRewardDate: await store.getLatestRewardDate(),
  });
  
  if (rewards.length > 0) {
    await store.bulkEnsureMembers(Array.from(memberNames));
    await store.bulkAddRewards(rewards);
  }
  
  const latestTimestamp = newMessages[0].timestamp;
  await store.setLastIngestionTime(latestTimestamp);

  if (skipped.length > 0 || malformed.length > 0) {
    try {
      await postRewardWarnings(env, skipped, malformed);
    } catch (err) {
      console.error('Reward warning post failed:', err);
    }
  }
  
  return { ingested: true, count: rewards.length, skipped: skipped.length, malformed: malformed.length };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    console.log('=== INCOMING REQUEST ===');
    console.log('Method:', request.method);

    // GET requests serve the web dashboard (HTML page + JSON API).
    if (request.method === 'GET') {
      return handleWebRequest(request, env);
    }

    // POST to /api/* routes are web dashboard API calls (token-auth, not Discord).
    if (request.method === 'POST') {
      const reqUrl = new URL(request.url);
      if (reqUrl.pathname.startsWith('/api/')) {
        return handleWebApiPost(request, env);
      }
    }

    // Only accept POST requests for Discord interactions.
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    // Get signature headers
    const signature = request.headers.get('x-signature-ed25519');
    const timestamp = request.headers.get('x-signature-timestamp');

    if (!signature || !timestamp) {
      console.log('Missing signature headers');
      return new Response('Invalid request signature', { status: 401 });
    }

    // Verify the request
    const body = await request.clone().arrayBuffer();
    
    const isValid = await verifyKey(
      body,
      signature,
      timestamp,
      env.DISCORD_PUBLIC_KEY
    );

    if (!isValid) {
      console.log('Signature verification failed');
      return new Response('Invalid request signature', { status: 401 });
    }

    // Parse the interaction
    const interaction: any = await request.json();
    console.log('Interaction type:', interaction.type);

    // Handle PING
    if (interaction.type === InteractionType.Ping) {
      console.log('Responding with PONG');
      const response = { type: InteractionResponseType.Pong };
      console.log('Response:', JSON.stringify(response));
      return Response.json(response);
    }

    // Handle APPLICATION_COMMAND
    if (interaction.type === InteractionType.ApplicationCommand) {
      const store = new DataStore(env.DB);
      const commandName = interaction.data.name;

      switch (commandName) {
        case 'train-queue': {
          const queue = await store.getTrainQueue();
          if (queue.length === 0) {
            return Response.json({
              type: InteractionResponseType.ChannelMessageWithSource,
              data: {
                content: '🚂 **Train Queue**\n\n_Queue is empty._',
                flags: 64,
              },
            });
          }

          const headerText = `🚂 **Train Queue** _(${queue.length} member${queue.length === 1 ? '' : 's'})_\n`;
          const headerRow = ['#', 'Member', 'Wait'];
          const alignments: Array<'left' | 'right'> = ['right', 'left', 'right'];
          const rows = queue.map((entry) => [
            `${entry.position}`,
            truncateName(entry.name, 12),
            entry.daysSinceTrain == null ? '🆕' : `${entry.daysSinceTrain}d`,
          ]);

          const { message, displayed } = buildTableMessage(headerText, headerRow, rows, alignments);
          const footer = displayed < rows.length
            ? `\n_Showing ${displayed} of ${rows.length} (message limit reached)_`
            : '';

          return Response.json({
            type: InteractionResponseType.ChannelMessageWithSource,
            data: {
              content: message + footer,
              flags: 64,
            },
          });
        }

        case 'help': {
          const origin = new URL(request.url).origin;
          const token = env.WEB_READONLY_TOKEN ?? env.WEB_ACCESS_TOKEN;
          const linkLine = token
            ? `${origin}/?token=${encodeURIComponent(token)}`
            : '_(not configured — ask an admin to set `WEB_READONLY_TOKEN`)_';

          const content = [
            '🤖 **Last War Alliance Bot — Help**',
            '',
            '**Slash commands**',
            '• `/train-queue` — show the current train queue (position, member, days waiting).',
            '• `/help` — this message + link to the web dashboard.',
            '',
            '**Web dashboard (read-only)**',
            linkLine,
            '',
            'Tabs available there:',
            '• **Active players** — full roster with last train/VIP reward and days waiting.',
            '• **Train queue** — current train queue order (next driver at position 1).',
            '• **Leaderboard history** — browse past weekly leaderboards and rankings.',
            '• **Events** — view upcoming Canyon/Desert Storm events, rosters, and registrations.',
          ].join('\n');

          return Response.json({
            type: InteractionResponseType.ChannelMessageWithSource,
            data: {
              content,
              flags: 64,
            },
          });
        }

        default:
          return Response.json({
            type: InteractionResponseType.ChannelMessageWithSource,
            data: {
              content: `Unknown command: ${commandName}`,
              flags: 64,
            },
          });
      }
    }

    return new Response('Unknown interaction type', { status: 400 });
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const now = new Date(event.scheduledTime);
    const day = now.getUTCDay(); // 0=Sun,1=Mon,...,6=Sat
    // Both crons create events for NEXT week.
    const { nextMonday, weekStart } = getNextMondayWeekStart(now);
    const isoWeek = getISOWeekNumber(nextMonday);
    const eventsStore = new EventsStore(env.DB);
    const settings = await eventsStore.getEventsSettings();

    // Daily 02:00 UTC == midnight at UTC-2 (game-server time): auto-lock
    // every open event whose registration has closed, then post its roster
    // to Discord. Runs on every tick (including Fri/Sat creation runs).
    await autoLockClosedEvents(eventsStore, env, ctx, now);

    if (day === 5) {
      // Friday 0:00 UTC → Canyon Storm for next week.
      if (!settings.canyonAutoOpen) {
        console.log('[scheduled] Canyon auto-open disabled — skipping Canyon event creation');
        return;
      }
      // Registration deadline: Monday of the event week at the admin-configured
      // server-time hour (day and hour both counted in server time, UTC-2).
      const registrationClosesAt = computeRegistrationCloseTimestamp(
        weekStart, CANYON_CLOSE_DAY_OFFSET, settings.canyonCloseTime,
      );
      const teamAStartsAt = computeEventTimestamp(weekStart, CANYON_EVENT_DAY, settings.canyonATime);
      const teamBStartsAt = computeEventTimestamp(weekStart, CANYON_EVENT_DAY, settings.canyonBTime);
      const notes = 'Canyon Storm - week ' + isoWeek + '-' + nextMonday.getUTCFullYear();
      const created = await eventsStore.createEvent({
        kind: 'canyon', weekStart, teamAStartsAt, teamBStartsAt, registrationClosesAt, notes,
      });
      console.log(`[scheduled] Auto-created Canyon Storm event id=${created.id} weekStart=${weekStart} closes=${registrationClosesAt}`);

      // Post registration-open announcement to Discord — all times in server time
      // (UTC-2). In server time both Canyon slots fall on Thursday (the 03:00 game
      // slot is Thursday 23:00 server), so no next-day qualifier is needed.
      const aLabel = `Thursday ${serverWallFromGameSlot(settings.canyonATime)} server time`;
      const bLabel = `Thursday ${serverWallFromGameSlot(settings.canyonBTime)} server time`;
      const dashLink = env.WORKER_URL && env.WEB_READONLY_TOKEN
        ? `\nDashboard: ${env.WORKER_URL}?token=${env.WEB_READONLY_TOKEN}` : '';
      const postContent = `@everyone **Canyon Storm \u2014 Week ${isoWeek}** registration is now open!\nTeam A: ${aLabel}  |  Team B: ${bLabel}\nRegistration closes: Monday ${settings.canyonCloseTime} server time${dashLink}`;
      ctx.waitUntil(
        fetch(`https://discord.com/api/v10/channels/${getRosterChannel(env)}/messages`, {
          method: 'POST',
          headers: { 'Authorization': `Bot ${env.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: postContent }),
        }).then(r => { if (!r.ok) r.text().then(t => console.error(`[scheduled] Discord post failed ${r.status}: ${t}`)); })
          .catch(err => console.error('[scheduled] Discord post error:', err)),
      );
    } else if (day === 6) {
      // Saturday 0:00 UTC → Desert Storm for next week.
      // Registration deadline: Wednesday of the event week at the admin-configured
      // server-time hour (day and hour both counted in server time, UTC-2).
      const registrationClosesAt = computeRegistrationCloseTimestamp(
        weekStart, DESERT_CLOSE_DAY_OFFSET, settings.desertCloseTime,
      );
      const teamAStartsAt = computeEventTimestamp(weekStart, DESERT_EVENT_DAY, settings.desertATime);
      const teamBStartsAt = computeEventTimestamp(weekStart, DESERT_EVENT_DAY, settings.desertBTime);
      const notes = 'Desert Storm - week ' + isoWeek + '-' + nextMonday.getUTCFullYear();
      const created = await eventsStore.createEvent({
        kind: 'desert', weekStart, teamAStartsAt, teamBStartsAt, registrationClosesAt, notes,
      });
      console.log(`[scheduled] Auto-created Desert Storm event id=${created.id} weekStart=${weekStart} closes=${registrationClosesAt}`);

      // Post registration-open announcement to Discord — all times in server time
      // (UTC-2). In server time all Desert slots fall on Friday (the 03:00 game
      // slot is Friday 23:00 server), so no next-day qualifier is needed.
      const aServer = serverWallFromGameSlot(settings.desertATime);
      const bServer = serverWallFromGameSlot(settings.desertBTime);
      const aLabel = `Friday ${aServer} server time`;
      const bLabel = `Friday ${bServer} server time`;
      const dashLink = env.WORKER_URL && env.WEB_READONLY_TOKEN
        ? `\nDashboard: ${env.WORKER_URL}?token=${env.WEB_READONLY_TOKEN}` : '';
      const postContent = `@everyone **Desert Storm \u2014 Week ${isoWeek}** registration is now open!\nTeam A (slot ${aServer}): ${aLabel}  |  Team B (slot ${bServer}): ${bLabel}\nRegistration closes: Wednesday ${settings.desertCloseTime} server time${dashLink}`;
      ctx.waitUntil(
        fetch(`https://discord.com/api/v10/channels/${getRosterChannel(env)}/messages`, {
          method: 'POST',
          headers: { 'Authorization': `Bot ${env.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: postContent }),
        }).then(r => { if (!r.ok) r.text().then(t => console.error(`[scheduled] Discord post failed ${r.status}: ${t}`)); })
          .catch(err => console.error('[scheduled] Discord post error:', err)),
      );
    }
  },
};

/** Returns the ISO 8601 week number (1–53) for a given date. */
function getISOWeekNumber(d: Date): number {
  const tmp = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // Set to nearest Thursday: current date + 4 - current day number (Mon=1..Sun=7)
  const dayNum = tmp.getUTCDay() || 7; // convert Sun=0 → 7
  tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  return Math.ceil(((tmp.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

/**
 * Next Monday (00:00 UTC) from a reference date, using the same rule as the
 * Friday/Saturday cron: nextMonday = today + (8 - day) % 7.
 * Returns both the Date and the YYYY-MM-DD weekStart string.
 */
export function getNextMondayWeekStart(from: Date = new Date()): { nextMonday: Date; weekStart: string } {
  const day = from.getUTCDay(); // 0=Sun,1=Mon,...,6=Sat
  const nextMonday = new Date(from);
  nextMonday.setUTCDate(from.getUTCDate() + ((8 - day) % 7));
  nextMonday.setUTCHours(0, 0, 0, 0);
  return { nextMonday, weekStart: nextMonday.toISOString().slice(0, 10) };
}

/**
 * Builds the per-team Discord roster messages (Team A, then Team B).
 * Players are ordered by squad power (strongest first), like the web
 * interface — not by slot index. Unknown power sorts last; slot order
 * breaks ties.
 */
export function buildRosterPostMessages(
  eventLabel: string,
  kind: EventKind,
  assignments: Assignment[],
  powers?: Map<number, number>,
): string[] {
  const roleSlots = kind === 'desert' ? DS_ROLE_SLOTS : CANYON_ROLE_SLOTS;
  const byPowerDesc = (a: Assignment, b: Assignment) =>
    (powers?.get(b.memberId) ?? 0) - (powers?.get(a.memberId) ?? 0) || a.slotIndex - b.slotIndex;
  return (['A', 'B'] as const).map((team) => {
    const mains = assignments
      .filter((a) => a.team === team && a.role === 'main')
      .sort(byPowerDesc);
    const subs = assignments
      .filter((a) => a.team === team && a.role === 'sub')
      .sort(byPowerDesc);

    const rows: string[] = [];
    for (let i = 0; i < mains.length; i++) {
      const stratRole = mains[i].strategyRole ?? roleSlots[i] ?? 'main';
      rows.push(`${mains[i].memberName.padEnd(20)} ${stratRole}`);
    }
    if (subs.length > 0) {
      rows.push('--- subs ---');
      for (const a of subs) {
        rows.push(`${a.memberName.padEnd(20)} sub`);
      }
    }
    return `**${eventLabel} — Team ${team}**\n\`\`\`\n${rows.join('\n')}\n\`\`\``;
  });
}

async function postRosterToDiscord(env: Env, eventLabel: string, kind: EventKind, assignments: Assignment[], powers?: Map<number, number>): Promise<void> {
  const messages = buildRosterPostMessages(eventLabel, kind, assignments, powers);
  for (let i = 0; i < messages.length; i++) {
    const discordRes = await fetch(`https://discord.com/api/v10/channels/${getRosterChannel(env)}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bot ${env.DISCORD_BOT_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: messages[i] }),
    });
    if (!discordRes.ok) {
      const errText = await discordRes.text();
      throw new Error(`Discord rejected team ${'AB'[i]}: ${discordRes.status} ${errText}`);
    }
  }
}

function eventLabelFor(kind: EventKind, weekStart: string): string {
  return `${kind === 'canyon' ? 'Canyon' : 'Desert Storm'} — week ${weekStart}`;
}

/**
 * Auto-lock pass for the daily server-midnight tick (02:00 UTC == 00:00 at
 * UTC-2): locks every open event whose registration has closed and posts
 * its roster to Discord. Events without saved assignments are skipped (an
 * admin never built the roster) and retried on later ticks. Failures are
 * logged per event without aborting the pass.
 */
async function autoLockClosedEvents(
  eventsStore: EventsStore,
  env: Env,
  ctx: ExecutionContext,
  now: Date,
): Promise<void> {
  const nowIso = now.toISOString();
  let events;
  try {
    events = await eventsStore.listEvents();
  } catch (err) {
    console.error('[scheduled] Auto-lock pass failed to list events:', err);
    return;
  }
  for (const ev of events) {
    if (ev.status !== 'open') continue;
    if (!ev.registrationClosesAt || ev.registrationClosesAt > nowIso) continue;
    let assignments: Assignment[];
    try {
      assignments = await eventsStore.listAssignments(ev.id);
    } catch (err) {
      console.error(`[scheduled] Auto-lock of event ${ev.id} failed to load assignments:`, err);
      continue;
    }
    if (assignments.length === 0) {
      console.log(`[scheduled] Skipping auto-lock of event ${ev.id} (${ev.kind} ${ev.weekStart}): no assignments saved`);
      continue;
    }
    try {
      const { logged } = await eventsStore.lockRoster(ev.id);
      console.log(`[scheduled] Auto-locked event ${ev.id} (${ev.kind} ${ev.weekStart}), logged ${logged} outcomes`);
    } catch (err) {
      console.error(`[scheduled] Auto-lock of event ${ev.id} failed:`, err);
      continue;
    }
    const label = eventLabelFor(ev.kind, ev.weekStart);
    let powers: Map<number, number> | undefined;
    try {
      const regs = await eventsStore.listRegistrations(ev.id);
      powers = new Map(regs.map((r) => [r.memberId, r.squadPower] as const));
    } catch (err) {
      console.error(`[scheduled] Failed to load powers for event ${ev.id} roster post (posting in slot order):`, err);
    }
    // Double-post guard: skip when the roster is unchanged since the last
    // post (e.g. an admin already posted it manually).
    try {
      const postedHash = await eventsStore.getRosterPostedHash(ev.id);
      if (postedHash && postedHash === computeRosterHash(assignments)) {
        console.log(`[scheduled] Skipping roster post for event ${ev.id}: unchanged since last post`);
        continue;
      }
    } catch (err) {
      console.error(`[scheduled] Failed to load posted hash for event ${ev.id} (posting anyway):`, err);
    }
    ctx.waitUntil(
      (async () => {
        await postRosterToDiscord(env, label, ev.kind, assignments, powers);
        await eventsStore.setRosterPostedHash(ev.id, computeRosterHash(assignments));
      })()
        .then(() => console.log(`[scheduled] Posted locked roster for event ${ev.id}`))
        .catch((err) => console.error(`[scheduled] Locked-roster post failed for event ${ev.id}:`, err)),
    );
  }
}

async function fetchChannelMessages(channelId: string, token: string, totalLimit: number): Promise<DiscordChannelMessage[]> {
  const perRequestLimit = 100;
  const messages: DiscordChannelMessage[] = [];
  let before: string | undefined;

  while (messages.length < totalLimit) {
    const remaining = totalLimit - messages.length;
    const fetchCount = Math.min(remaining, perRequestLimit);
    const url = new URL(`https://discord.com/api/v10/channels/${channelId}/messages`);
    url.searchParams.set('limit', String(fetchCount));
    if (before) {
      url.searchParams.set('before', before);
    }

    const response = await fetch(url.toString(), {
      headers: {
        'Authorization': `Bot ${token}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch messages: ${response.statusText}`);
    }

    const batch = await response.json() as DiscordChannelMessage[];

    if (!Array.isArray(batch) || batch.length === 0) {
      break;
    }

    messages.push(...batch);

    if (batch.length < fetchCount) {
      break;
    }

    before = batch[batch.length - 1].id;
  }

  return messages;
}

// ---------------------------------------------------------------------------
// Web dashboard (GET) routing — token-gated HTML page + JSON API.
// ---------------------------------------------------------------------------

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function extractToken(request: Request, url: URL): string | null {
  const qs = url.searchParams.get('token');
  if (qs) return qs;
  const auth = request.headers.get('authorization');
  if (auth && /^Bearer\s+/i.test(auth)) {
    return auth.replace(/^Bearer\s+/i, '').trim();
  }
  return null;
}

type WebRole = 'admin' | 'readonly';

function authorize(token: string | null, env: Env): WebRole | null {
  if (!token) return null;
  if (env.WEB_ACCESS_TOKEN && timingSafeEqual(token, env.WEB_ACCESS_TOKEN)) return 'admin';
  if (env.WEB_READONLY_TOKEN && timingSafeEqual(token, env.WEB_READONLY_TOKEN)) return 'readonly';
  return null;
}

function hasEventsAccess(role: WebRole | null): role is 'admin' {
  return role === 'admin';
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...(init.headers || {}),
    },
  });
}

async function getReferenceDateIso(store: DataStore): Promise<string | null> {
  return store.getLatestRewardDate();
}

async function handleWebApiPost(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (!env.WEB_ACCESS_TOKEN && !env.WEB_READONLY_TOKEN) {
    return jsonResponse({ error: 'Web access is not configured. Set the WEB_ACCESS_TOKEN secret.' }, { status: 503 });
  }
  const token = extractToken(request, url);
  const role = authorize(token, env);
  if (!role) {
    return jsonResponse({ error: 'unauthorized' }, { status: 401 });
  }
  const isEventsPath = path.startsWith('/api/events/');
  if (isEventsPath) {
    // Allow any authenticated user to register; other POST routes need admin.
    if (path !== '/api/events/register' && !hasEventsAccess(role)) {
      return jsonResponse({ error: 'forbidden' }, { status: 403 });
    }
  } else if (role !== 'admin') {
    return jsonResponse({ error: 'forbidden: read-only token' }, { status: 403 });
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'invalid JSON body' }, { status: 400 });
  }

  const store = new DataStore(env.DB);

  if (path === '/api/upload-leaderboard') {
    const slug = String(body?.slug ?? '').trim();
    const title = String(body?.title ?? '').trim();
    if (!slug) return jsonResponse({ error: 'slug is required' }, { status: 400 });
    if (!title) return jsonResponse({ error: 'title is required' }, { status: 400 });

    const rawEntries = body?.entries;
    if (!Array.isArray(rawEntries) || rawEntries.length === 0) {
      return jsonResponse({ error: 'entries must be a non-empty array' }, { status: 400 });
    }

    // Accept both {Ranking, Commander, Points} and {rank, commander, points}.
    const entries: { rank: number; commander: string; points: number }[] = [];
    for (let i = 0; i < rawEntries.length; i++) {
      const e = rawEntries[i];
      const rank = Number(e?.rank ?? e?.Ranking ?? e?.ranking);
      const commander = String(e?.commander ?? e?.Commander ?? '').trim();
      const points = Number(e?.points ?? e?.Points ?? 0);
      if (!Number.isFinite(rank) || rank < 1) {
        return jsonResponse({ error: `entry ${i}: invalid rank` }, { status: 400 });
      }
      if (!commander) {
        return jsonResponse({ error: `entry ${i}: missing commander` }, { status: 400 });
      }
      if (!Number.isFinite(points) || points < 0) {
        return jsonResponse({ error: `entry ${i}: invalid points` }, { status: 400 });
      }
      entries.push({ rank: Math.floor(rank), commander, points: Math.floor(points) });
    }

    // Pre-validate: ranks must be contiguous 1..N, points must be non-increasing by rank.
    const sorted = entries.slice().sort((a, b) => a.rank - b.rank);
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i].rank !== i + 1) {
        return jsonResponse({
          error: `ranks must be contiguous starting from 1; expected ${i + 1} but found ${sorted[i].rank}`,
        }, { status: 400 });
      }
    }
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].points > sorted[i - 1].points) {
        return jsonResponse({
          error: `points must be non-increasing by rank; rank ${sorted[i].rank} (${sorted[i].points}) > rank ${sorted[i - 1].rank} (${sorted[i - 1].points})`,
        }, { status: 400 });
      }
    }

    const pointsMultiplierRaw = Number(body?.pointsMultiplier);
    const pointsMultiplier = Number.isFinite(pointsMultiplierRaw) && pointsMultiplierRaw > 0
      ? Math.floor(pointsMultiplierRaw)
      : 1;
    const weekStart = typeof body?.weekStart === 'string' ? body.weekStart : null;
    const weekEnd = typeof body?.weekEnd === 'string' ? body.weekEnd : null;
    const source = typeof body?.source === 'string' ? body.source : null;

    try {
      const result = await store.uploadLeaderboard({
        slug, title, weekStart, weekEnd, source, pointsMultiplier, entries,
      });
      return jsonResponse(result);
    } catch (err: any) {
      return jsonResponse({ error: err?.message ?? 'upload failed' }, { status: 400 });
    }
  }

  if (path === '/api/add-member') {
    const name = String(body?.name ?? '').trim();
    if (!name) return jsonResponse({ error: 'name is required' }, { status: 400 });
    try {
      const member = await store.addMember(name);
      await store.syncTrainQueue();
      return jsonResponse({ ok: true, member });
    } catch (err: any) {
      return jsonResponse({ error: err?.message ?? 'add failed' }, { status: 400 });
    }
  }

  if (path === '/api/remove-member') {
    const name = String(body?.name ?? '').trim();
    if (!name) return jsonResponse({ error: 'name is required' }, { status: 400 });
    try {
      const ok = await store.removeMember(name);
      if (!ok) {
        return jsonResponse({ error: 'member not found' }, { status: 404 });
      }
      await store.syncTrainQueue();
      return jsonResponse({ ok: true, name });
    } catch (err: any) {
      return jsonResponse({ error: err?.message ?? 'remove failed' }, { status: 400 });
    }
  }

  if (path === '/api/rename-member') {
    const id = Number(body?.id);
    const newName = String(body?.newName ?? '').trim();
    if (!Number.isFinite(id) || id < 1) return jsonResponse({ error: 'id is required' }, { status: 400 });
    if (!newName) return jsonResponse({ error: 'newName is required' }, { status: 400 });
    try {
      const ok = await store.renameMemberById(id, newName);
      if (!ok) {
        return jsonResponse({ error: 'rename failed: member not found, name unchanged, or name conflicts with another member' }, { status: 400 });
      }
      return jsonResponse({ ok: true, id, newName });
    } catch (err: any) {
      return jsonResponse({ error: err?.message ?? 'rename failed' }, { status: 400 });
    }
  }

  if (path === '/api/merge-members') {
    const target = String(body?.target ?? '').trim();
    const duplicate = String(body?.duplicate ?? '').trim();
    const pocSource = body?.pocSource === 'duplicate' ? 'duplicate' : 'target';
    if (!target) return jsonResponse({ error: 'target is required' }, { status: 400 });
    if (!duplicate) return jsonResponse({ error: 'duplicate is required' }, { status: 400 });
    if (target === duplicate) {
      return jsonResponse({ error: 'target and duplicate must differ' }, { status: 400 });
    }
    try {
      const ok = await store.mergeMembers(target, duplicate, pocSource);
      if (!ok) {
        return jsonResponse({ error: 'merge failed: one of the names was not found or they resolve to the same member' }, { status: 400 });
      }
      return jsonResponse({ ok: true, target, duplicate });
    } catch (err: any) {
      return jsonResponse({ error: err?.message ?? 'merge failed' }, { status: 400 });
    }
  }

  if (path === '/api/leaderboard-maintenance') {
    const decisions = body?.decisions;
    if (!Array.isArray(decisions)) {
      return jsonResponse({ error: 'decisions must be an array' }, { status: 400 });
    }
    const summary: { id: number; action: string; ok: boolean; message?: string }[] = [];
    for (const d of decisions) {
      const id = Number(d?.id);
      const action = String(d?.action ?? '').toLowerCase();
      if (!Number.isFinite(id) || id < 1) {
        summary.push({ id: id || 0, action, ok: false, message: 'invalid id' });
        continue;
      }
      try {
        if (action === 'keep') {
          summary.push({ id, action, ok: true });
        } else if (action === 'remove' || action === 'deactivate') {
          const ok = await store.deactivateMemberById(id);
          summary.push({ id, action, ok, message: ok ? undefined : 'member not found' });
        } else if (action === 'merge') {
          const target = String(d?.targetNormalized ?? '').trim();
          if (!target) {
            summary.push({ id, action, ok: false, message: 'missing targetNormalized' });
            continue;
          }
          // Maintenance merge: the row id is the EXISTING active member (which has
          // queue position + history) and target is the leaderboard ghost name.
          // maintenanceMerge reverses the duplicate/target roles so the existing
          // member is kept and renamed to the new leaderboard name, rather than
          // being deleted and replaced by the ghost.
          const ok = await store.maintenanceMerge(id, target);
          summary.push({ id, action, ok, message: ok ? undefined : 'merge failed' });
        } else {
          summary.push({ id, action, ok: false, message: 'unknown action' });
        }
      } catch (err: any) {
        summary.push({ id, action, ok: false, message: err?.message ?? 'error' });
      }
    }
    // Reconcile the train queue: removed members get spliced out, merged
    // members' duplicate rows get cleaned up, and any newcomers get appended.
    await store.syncTrainQueue();
    return jsonResponse({ results: summary });
  }

  if (path === '/api/delete-leaderboard') {
    const slug = String(body?.slug ?? '').trim();
    if (!slug) return jsonResponse({ error: 'slug is required' }, { status: 400 });
    try {
      const ok = await store.deleteLeaderboardBySlug(slug);
      if (!ok) return jsonResponse({ error: 'leaderboard not found' }, { status: 404 });
      return jsonResponse({ ok: true, slug });
    } catch (err: any) {
      return jsonResponse({ error: err?.message ?? 'delete failed' }, { status: 500 });
    }
  }

  if (path === '/api/queue/move') {
    const memberId = Number(body?.memberId);
    const position = Number(body?.position);
    const comment = String(body?.comment ?? '').trim();
    if (!Number.isInteger(memberId) || memberId <= 0) {
      return jsonResponse({ error: 'memberId is required' }, { status: 400 });
    }
    if (!Number.isInteger(position) || position < 1) {
      return jsonResponse({ error: 'position must be a positive integer' }, { status: 400 });
    }
    if (!comment) {
      return jsonResponse({ error: 'comment is required' }, { status: 400 });
    }
    try {
      await store.syncTrainQueue();
      const result = await store.moveQueueMember(memberId, position, comment);
      return jsonResponse({ ok: true, ...result });
    } catch (err: any) {
      return jsonResponse({ error: err?.message ?? 'move failed' }, { status: 400 });
    }
  }

  if (path === '/api/queue/bulk-move') {
    const rawIds = Array.isArray(body?.memberIds) ? body.memberIds : [];
    const memberIds = rawIds.map((v: unknown) => Number(v)).filter((n: number) => Number.isInteger(n) && n > 0);
    const direction = body?.direction === 'up' || body?.direction === 'down' ? body.direction : null;
    const spots = Number(body?.spots);
    const comment = String(body?.comment ?? '').trim();
    if (memberIds.length === 0) {
      return jsonResponse({ error: 'memberIds must be a non-empty array' }, { status: 400 });
    }
    if (!direction) {
      return jsonResponse({ error: 'direction must be "up" or "down"' }, { status: 400 });
    }
    if (!Number.isInteger(spots) || spots < 1) {
      return jsonResponse({ error: 'spots must be a positive integer' }, { status: 400 });
    }
    if (!comment) {
      return jsonResponse({ error: 'comment is required' }, { status: 400 });
    }
    try {
      await store.syncTrainQueue();
      const moves = await store.bulkMoveQueueMembers(memberIds, direction, spots, comment);
      return jsonResponse({ ok: true, moves });
    } catch (err: any) {
      return jsonResponse({ error: err?.message ?? 'bulk move failed' }, { status: 400 });
    }
  }

  if (path === '/api/queue/move-to-end') {
    const rawIds = Array.isArray(body?.memberIds) ? body.memberIds : [];
    const memberIds = rawIds.map((v: unknown) => Number(v)).filter((n: number) => Number.isInteger(n) && n > 0);
    const comment = String(body?.comment ?? '').trim();
    if (memberIds.length === 0) {
      return jsonResponse({ error: 'memberIds must be a non-empty array' }, { status: 400 });
    }
    if (!comment) {
      return jsonResponse({ error: 'comment is required' }, { status: 400 });
    }
    try {
      await store.syncTrainQueue();
      const moves = await store.moveQueueMembersToEnd(memberIds, comment);
      return jsonResponse({ ok: true, moves });
    } catch (err: any) {
      return jsonResponse({ error: err?.message ?? 'move-to-end failed' }, { status: 400 });
    }
  }

  if (path === '/api/settings') {
    if (role !== 'admin') return jsonResponse({ error: 'admin required' }, { status: 403 });
    const eventsStore = new EventsStore(env.DB);

    const patch: Partial<EventsSettings> = {};
    if ('canyonAutoOpen' in body) patch.canyonAutoOpen = Boolean(body.canyonAutoOpen);

    const canyonTimeFields: Array<keyof EventsSettings> = ['canyonATime', 'canyonBTime'];
    for (const field of canyonTimeFields) {
      if (field in body) {
        const v = body[field];
        if (!VALID_CANYON_TIMES.includes(v as string))
          return jsonResponse({ error: `${field} must be one of ${VALID_CANYON_TIMES.join(', ')}` }, { status: 400 });
        (patch as Record<string, unknown>)[field] = v;
      }
    }
    const desertTimeFields: Array<keyof EventsSettings> = ['desertATime', 'desertBTime'];
    for (const field of desertTimeFields) {
      if (field in body) {
        const v = body[field];
        if (!VALID_DESERT_TIMES.includes(v as string))
          return jsonResponse({ error: `${field} must be one of ${VALID_DESERT_TIMES.join(', ')}` }, { status: 400 });
        (patch as Record<string, unknown>)[field] = v;
      }
    }
    // Registration-close times are hour-only 'HH:00' in server time (UTC-2):
    // Monday for Canyon, Wednesday for Desert (day and hour counted in server time).
    const closeTimeFields: Array<keyof EventsSettings> = ['canyonCloseTime', 'desertCloseTime'];
    for (const field of closeTimeFields) {
      if (field in body) {
        const v = body[field];
        if (!isValidCloseTime(v))
          return jsonResponse({ error: `${field} must be HH:00 (hour only, 00:00-23:00, server time)` }, { status: 400 });
        (patch as Record<string, unknown>)[field] = v;
      }
    }

    try {
      await eventsStore.saveEventsSettings(patch);
    } catch (err: any) {
      return jsonResponse({ error: err?.message ?? 'save failed' }, { status: 400 });
    }
    const fullSettings = await eventsStore.getEventsSettings();

    // Update open events immediately when team-time fields change.
    // Registration-close changes intentionally do NOT touch already open
    // events: they keep their stored deadline, the new time applies only to
    // newly created events. This avoids resurrecting (or prematurely
    // closing) an open registration when the admin edits the default.
    const canyonTimeChanged = ['canyonATime', 'canyonBTime'].some(k => k in patch);
    const desertTimeChanged = ['desertATime', 'desertBTime'].some(k => k in patch);
    if (canyonTimeChanged) {
      const openCanyon = await eventsStore.listOpenEventsByKind('canyon');
      for (const ev of openCanyon) {
        await eventsStore.updateEventSchedule(ev.id, {
          teamAStartsAt: computeEventTimestamp(ev.weekStart, CANYON_EVENT_DAY, fullSettings.canyonATime),
          teamBStartsAt: computeEventTimestamp(ev.weekStart, CANYON_EVENT_DAY, fullSettings.canyonBTime),
        });
      }
    }
    if (desertTimeChanged) {
      const openDesert = await eventsStore.listOpenEventsByKind('desert');
      for (const ev of openDesert) {
        await eventsStore.updateEventSchedule(ev.id, {
          teamAStartsAt: computeEventTimestamp(ev.weekStart, DESERT_EVENT_DAY, fullSettings.desertATime),
          teamBStartsAt: computeEventTimestamp(ev.weekStart, DESERT_EVENT_DAY, fullSettings.desertBTime),
        });
      }
    }

    return jsonResponse({ ok: true, settings: fullSettings });
  }

  // ---- Events: POST endpoints (admin) ----
  if (path.startsWith('/api/events/')) {
    // The outer guard already enforced hasEventsAccess for /api/events/* paths.
    const eventsStore = new EventsStore(env.DB);

    if (path === '/api/events/open-canyon-now') {
      if (role !== 'admin') return jsonResponse({ error: 'admin required' }, { status: 403 });
      // Manual fallback for when canyonAutoOpen was enabled after the Friday
      // 00:00 UTC cron already ran: create the Canyon event for the upcoming
      // week (same weekStart the cron would have used).
      const settings = await eventsStore.getEventsSettings();
      const { nextMonday, weekStart } = getNextMondayWeekStart(new Date());
      const existing = (await eventsStore.listEvents()).find(
        (e) => e.kind === 'canyon' && e.weekStart === weekStart,
      );
      if (existing) {
        if (existing.status !== 'open') {
          return jsonResponse(
            { error: `canyon event for week ${weekStart} already exists and is ${existing.status}` },
            { status: 409 },
          );
        }
        return jsonResponse({ ok: true, event: existing, alreadyOpen: true, weekStart });
      }
      const registrationClosesAt = computeRegistrationCloseTimestamp(
        weekStart, CANYON_CLOSE_DAY_OFFSET, settings.canyonCloseTime,
      );
      const teamAStartsAt = computeEventTimestamp(weekStart, CANYON_EVENT_DAY, settings.canyonATime);
      const teamBStartsAt = computeEventTimestamp(weekStart, CANYON_EVENT_DAY, settings.canyonBTime);
      const isoWeek = getISOWeekNumber(nextMonday);
      const notes = 'Canyon Storm - week ' + isoWeek + '-' + nextMonday.getUTCFullYear();
      const created = await eventsStore.createEvent({
        kind: 'canyon', weekStart, teamAStartsAt, teamBStartsAt, registrationClosesAt, notes,
      });
      return jsonResponse({ ok: true, event: created, alreadyOpen: false, weekStart });
    }

    if (path === '/api/events/schedule') {
      if (role !== 'admin') return jsonResponse({ error: 'admin required' }, { status: 403 });
      const id = Number(body?.id);
      if (!Number.isInteger(id) || id < 1) return jsonResponse({ error: 'id required' }, { status: 400 });
      const fields: Record<string, unknown> = {};
      if ('teamAStartsAt' in (body ?? {})) fields.teamAStartsAt = body.teamAStartsAt ?? null;
      if ('teamBStartsAt' in (body ?? {})) fields.teamBStartsAt = body.teamBStartsAt ?? null;
      if ('registrationClosesAt' in (body ?? {})) fields.registrationClosesAt = body.registrationClosesAt ?? null;
      if ('notes' in (body ?? {})) fields.notes = body.notes ?? null;
      const ok = await eventsStore.updateEventSchedule(id, fields);
      return jsonResponse({ ok });
    }

    if (path === '/api/events/register') {
      const eventId = Number(body?.eventId);
      const memberId = Number(body?.memberId);
      if (!Number.isInteger(eventId) || eventId < 1) {
        return jsonResponse({ error: 'eventId required' }, { status: 400 });
      }
      if (!Number.isInteger(memberId) || memberId < 1) {
        return jsonResponse({ error: 'memberId required' }, { status: 400 });
      }
      const statusVal = body?.status;
      if (!isValidRegStatus(statusVal)) {
        return jsonResponse({ error: 'invalid status' }, { status: 400 });
      }
      const teamPref = body?.teamPreference ?? 'any';
      if (!isValidTeamPref(teamPref)) {
        return jsonResponse({ error: 'invalid teamPreference' }, { status: 400 });
      }
      const timeSlotRaw = body?.timeSlot ?? null;
      if (timeSlotRaw != null && !isValidTimeSlot(timeSlotRaw)) {
        return jsonResponse({ error: 'invalid timeSlot' }, { status: 400 });
      }
      const squadType = body?.squadType ?? 'tanks';
      if (!isValidSquadType(squadType)) {
        return jsonResponse({ error: 'invalid squadType' }, { status: 400 });
      }
      const squadPower = Math.max(0, Math.floor(Number(body?.squadPower) || 0));
      // Block edits to locked events (admin can still override via assignments).
      const event = await eventsStore.getEvent(eventId);
      if (!event) return jsonResponse({ error: 'event not found' }, { status: 404 });
      if (event.status === 'locked' && role !== 'admin') {
        return jsonResponse({ error: 'event is locked' }, { status: 409 });
      }
      // Server-side deadline enforcement for non-admins.
      if (
        role !== 'admin' &&
        event.registrationClosesAt &&
        new Date(event.registrationClosesAt).getTime() < Date.now()
      ) {
        return jsonResponse({ error: 'registration closed' }, { status: 409 });
      }
      try {
        const reg = await eventsStore.upsertRegistration(eventId, memberId, {
          status: statusVal,
          teamPreference: teamPref,
          timeSlot: timeSlotRaw,
          squadPower,
          squadType,
          source: role === 'admin' ? 'admin' : 'web',
          notes: typeof body?.notes === 'string' ? body.notes : null,
        });
        // Auto-ban: if this member's most recent outcome in a locked event of the same
        // kind was 'no-show', ban them automatically in this open event.
        if (statusVal === 'IN' && event.status === 'open') {
          await eventsStore.checkAndApplyNoshowBan(eventId, memberId);
        }
        return jsonResponse({ ok: true, registration: reg });
      } catch (err: any) {
        return jsonResponse({ error: err?.message ?? 'register failed' }, { status: 400 });
      }
    }

    if (path === '/api/events/unregister') {
      const eventId = Number(body?.eventId);
      const memberId = Number(body?.memberId);
      if (!Number.isInteger(eventId) || !Number.isInteger(memberId)) {
        return jsonResponse({ error: 'eventId + memberId required' }, { status: 400 });
      }
      const unregEvent = await eventsStore.getEvent(eventId);
      if (unregEvent?.status === 'locked') {
        return jsonResponse({ error: 'event is locked' }, { status: 409 });
      }
      const ok = await eventsStore.deleteRegistration(eventId, memberId);
      return jsonResponse({ ok });
    }

    if (path === '/api/events/ban') {
      if (role !== 'admin') return jsonResponse({ error: 'admin required' }, { status: 403 });
      const eventId = Number(body?.eventId);
      const memberId = Number(body?.memberId);
      const banned = Boolean(body?.banned);
      if (!Number.isInteger(eventId) || eventId < 1 || !Number.isInteger(memberId) || memberId < 1) {
        return jsonResponse({ error: 'eventId + memberId required' }, { status: 400 });
      }
      const event = await eventsStore.getEvent(eventId);
      if (!event) return jsonResponse({ error: 'event not found' }, { status: 404 });
      if (event.status === 'locked') return jsonResponse({ error: 'event is locked' }, { status: 409 });
      const ok = await eventsStore.setBan(eventId, memberId, banned);
      return jsonResponse({ ok });
    }

    if (path === '/api/events/penalize') {
      if (role !== 'admin') return jsonResponse({ error: 'admin required' }, { status: 403 });
      const eventId = Number(body?.eventId);
      const memberId = Number(body?.memberId);
      const penalized = Boolean(body?.penalized);
      if (!Number.isInteger(eventId) || eventId < 1 || !Number.isInteger(memberId) || memberId < 1) {
        return jsonResponse({ error: 'eventId + memberId required' }, { status: 400 });
      }
      const event = await eventsStore.getEvent(eventId);
      if (!event) return jsonResponse({ error: 'event not found' }, { status: 404 });
      if (event.status === 'locked') return jsonResponse({ error: 'event is locked' }, { status: 409 });
      const ok = await eventsStore.setPenalized(eventId, memberId, penalized);
      return jsonResponse({ ok });
    }

    if (path === '/api/events/suggest-roster') {
      const eventId = Number(body?.eventId);
      if (!Number.isInteger(eventId) || eventId < 1) {
        return jsonResponse({ error: 'eventId required' }, { status: 400 });
      }
      const event = await eventsStore.getEvent(eventId);
      if (!event) return jsonResponse({ error: 'event not found' }, { status: 404 });
      const [registrations, computedPriorities, previousRoles, allEvents] = await Promise.all([
        eventsStore.listRegistrations(eventId),
        eventsStore.computePriorities(eventId),
        eventsStore.getPreviousRoleMap(eventId),
        event.kind === 'desert' ? eventsStore.listEvents() : Promise.resolve([] as Awaited<ReturnType<typeof eventsStore.listEvents>>),
      ]);
      // Resolve 'any' slots/teams before passing to suggest so pool assignment is correct.
      const registrationsResolved = event.kind === 'desert'
        ? resolveAnySlots(registrations)
        : resolveAnyTeams(registrations);
      const priorityMap = new Map<number, number>(
        [...computedPriorities.entries()].map(([id, cp]) => [id, cp.priority]),
      );

      // For Desert: find the locked Canyon event of the same week and collect who played.
      let canyonPlayedIds: Set<number> | undefined;
      if (event.kind === 'desert') {
        const canyonEvent = allEvents.find(
          (e) => e.kind === 'canyon' && e.weekStart === event.weekStart && e.status === 'locked',
        );
        if (canyonEvent) {
          const canyonAssignments = await eventsStore.listAssignments(canyonEvent.id);
          canyonPlayedIds = new Set(canyonAssignments.map((a) => a.memberId));
        }
      }

      const result = suggestRoster({
        kind: event.kind,
        registrations: registrationsResolved,
        priorities: priorityMap,
        previousRoles,
        canyonPlayedIds,
        rng: seededRng(hashString(event.kind + '/' + event.weekStart)),
        sameTeamTime: getSameTeamTime(event),
      });
      if (body?.commit === true) {
        if (role !== 'admin') {
          return jsonResponse({ error: 'admin required to commit' }, { status: 403 });
        }
        const inputs: AssignmentInput[] = result.assignments.map((a) => ({
          memberId: a.memberId,
          team: a.team,
          role: a.role,
          slotIndex: a.slotIndex,
          strategyRole: a.strategyRole ?? null,
          source: 'auto',
        }));
        if (event.status === 'locked') {
          return jsonResponse({ error: 'cannot commit roster for a locked event' }, { status: 400 });
        }
        await eventsStore.replaceAssignments(eventId, inputs, { isLocked: false });
      }
      return jsonResponse({ ok: true, ...result });
    }

    if (path === '/api/events/assignments') {
      if (role !== 'admin') return jsonResponse({ error: 'admin required' }, { status: 403 });
      const eventId = Number(body?.eventId);
      if (!Number.isInteger(eventId) || eventId < 1) {
        return jsonResponse({ error: 'eventId required' }, { status: 400 });
      }
      const rawAssigns = Array.isArray(body?.assignments) ? body.assignments : [];
      const inputs: AssignmentInput[] = [];
      for (const a of rawAssigns) {
        const memberId = Number(a?.memberId);
        const team = a?.team;
        const aRole = a?.role;
        const slotIndex = Number(a?.slotIndex);
        if (!Number.isInteger(memberId) || memberId < 1) {
          return jsonResponse({ error: 'invalid assignment.memberId' }, { status: 400 });
        }
        if (team !== 'A' && team !== 'B') {
          return jsonResponse({ error: 'invalid assignment.team' }, { status: 400 });
        }
        if (aRole !== 'main' && aRole !== 'sub') {
          return jsonResponse({ error: 'invalid assignment.role' }, { status: 400 });
        }
        if (!Number.isInteger(slotIndex) || slotIndex < 1) {
          return jsonResponse({ error: 'invalid assignment.slotIndex' }, { status: 400 });
        }
        const strategyRole =
          typeof a?.strategyRole === 'string' ? a.strategyRole.trim() || null : null;
        inputs.push({
          memberId,
          team: team as AssignmentTeam,
          role: aRole as AssignmentRole,
          slotIndex,
          strategyRole,
          source: 'admin',
        });
      }
      try {
        const assignEvent = await eventsStore.getEvent(eventId);
        if (!assignEvent) return jsonResponse({ error: 'event not found' }, { status: 404 });
        if (assignEvent.status === 'locked') {
          // Locked events: only strategy_role updates are allowed.
          await eventsStore.updateStrategyRoles(
            eventId,
            inputs.map((i) => ({ memberId: i.memberId, strategyRole: i.strategyRole ?? null })),
          );
        } else {
          await eventsStore.replaceAssignments(eventId, inputs, { isLocked: false });
        }
        return jsonResponse({ ok: true });
      } catch (err: any) {
        return jsonResponse({ error: err?.message ?? 'save failed' }, { status: 400 });
      }
    }

    if (path === '/api/events/post-roster') {
      if (role !== 'admin') return jsonResponse({ error: 'admin required' }, { status: 403 });
      const eventId = Number(body?.eventId);
      if (!Number.isInteger(eventId) || eventId < 1) {
        return jsonResponse({ error: 'eventId required' }, { status: 400 });
      }
      const assignments = await eventsStore.listAssignments(eventId);
      if (assignments.length === 0) {
        return jsonResponse({ error: 'no assignments to post' }, { status: 400 });
      }
      const event = await eventsStore.getEvent(eventId);
      const eventLabel = event ? eventLabelFor(event.kind, event.weekStart) : `Event #${eventId}`;
      const kind = event?.kind ?? 'canyon';
      const powers = new Map(
        (await eventsStore.listRegistrations(eventId)).map((r) => [r.memberId, r.squadPower] as const),
      );

      try {
        await postRosterToDiscord(env, eventLabel, kind, assignments, powers);
        await eventsStore.setRosterPostedHash(eventId, computeRosterHash(assignments));
      } catch (err: any) {
        return jsonResponse({ error: err?.message ?? 'Discord post failed' }, { status: 502 });
      }
      return jsonResponse({ ok: true });
    }

    if (path === '/api/events/record-attendance') {
      if (role !== 'admin') return jsonResponse({ error: 'admin required' }, { status: 403 });
      const eventId = Number(body?.eventId);
      if (!Number.isInteger(eventId) || eventId < 1) {
        return jsonResponse({ error: 'eventId required' }, { status: 400 });
      }
      const rawIds = body?.presentMemberIds;
      if (!Array.isArray(rawIds)) {
        return jsonResponse({ error: 'presentMemberIds array required' }, { status: 400 });
      }
      const presentMemberIds: number[] = rawIds.map(Number).filter((n) => Number.isInteger(n) && n > 0);
      const attEvent = await eventsStore.getEvent(eventId);
      if (!attEvent) return jsonResponse({ error: 'event not found' }, { status: 404 });
      if (attEvent.status !== 'locked') {
        return jsonResponse({ error: 'event must be locked to record attendance' }, { status: 409 });
      }
      try {
        const result = await eventsStore.recordAttendance(eventId, presentMemberIds);
        return jsonResponse({ ok: true, ...result });
      } catch (err: any) {
        return jsonResponse({ error: err?.message ?? 'record-attendance failed' }, { status: 400 });
      }
    }

    if (path === '/api/events/substitute') {
      if (role !== 'admin') return jsonResponse({ error: 'admin required' }, { status: 403 });
      const eventId = Number(body?.eventId);
      const outMemberId = Number(body?.outMemberId);
      const inMemberId = Number(body?.inMemberId);
      if (!Number.isInteger(eventId) || eventId < 1) {
        return jsonResponse({ error: 'eventId required' }, { status: 400 });
      }
      if (!Number.isInteger(outMemberId) || outMemberId < 1) {
        return jsonResponse({ error: 'outMemberId required' }, { status: 400 });
      }
      if (!Number.isInteger(inMemberId) || inMemberId < 1) {
        return jsonResponse({ error: 'inMemberId required' }, { status: 400 });
      }
      if (outMemberId === inMemberId) {
        return jsonResponse({ error: 'out and in members must differ' }, { status: 400 });
      }
      const subEvent = await eventsStore.getEvent(eventId);
      if (!subEvent) return jsonResponse({ error: 'event not found' }, { status: 404 });
      if (subEvent.status !== 'locked') {
        return jsonResponse({ error: 'event must be locked to substitute players' }, { status: 409 });
      }
      try {
        const result = await eventsStore.substitutePlayer(eventId, outMemberId, inMemberId);
        return jsonResponse({ ok: true, ...result });
      } catch (err: any) {
        return jsonResponse({ error: err?.message ?? 'substitute failed' }, { status: 400 });
      }
    }

    if (path === '/api/events/mark-no-show') {
      if (role !== 'admin') return jsonResponse({ error: 'admin required' }, { status: 403 });
      const eventId = Number(body?.eventId);
      const memberId = Number(body?.memberId);
      if (!Number.isInteger(eventId) || !Number.isInteger(memberId)) {
        return jsonResponse({ error: 'eventId + memberId required' }, { status: 400 });
      }
      const noShowEvent = await eventsStore.getEvent(eventId);
      if (!noShowEvent) return jsonResponse({ error: 'event not found' }, { status: 404 });
      if (noShowEvent.status !== 'locked') {
        return jsonResponse({ error: 'event must be locked to mark no-shows' }, { status: 409 });
      }
      await eventsStore.markNoShow(eventId, memberId, typeof body?.comment === 'string' ? body.comment : null);
      return jsonResponse({ ok: true });
    }

    return jsonResponse({ error: 'not found' }, { status: 404 });
  }

  return jsonResponse({ error: 'not found' }, { status: 404 });
}

async function handleWebRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const isApi = path.startsWith('/api/');

  if (!env.WEB_ACCESS_TOKEN && !env.WEB_READONLY_TOKEN) {
    const msg = 'Web access is not configured. Set the WEB_ACCESS_TOKEN secret.';
    return isApi
      ? jsonResponse({ error: msg }, { status: 503 })
      : new Response(msg, { status: 503 });
  }

  const token = extractToken(request, url);
  const role = authorize(token, env);
  if (!role) {
    return isApi
      ? jsonResponse({ error: 'unauthorized' }, { status: 401 })
      : new Response('Unauthorized — append ?token=<your token>', { status: 401 });
  }

  const store = new DataStore(env.DB);

  if (path === '/' || path === '/index.html') {
    return new Response(renderPage(token!, role), {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  }

  if (path === '/api/active') {
    let ingested: { ingested: boolean; count: number } | null = null;
    if (url.searchParams.get('refresh') === '1') {
      if (role !== 'admin') {
        return jsonResponse({ error: 'forbidden: read-only token' }, { status: 403 });
      }
      try {
        ingested = await autoIngestIfNeeded(store, env);
      } catch (err) {
        console.error('Refresh ingestion failed:', err);
        ingested = { ingested: false, count: 0 };
      }
    }
    const entries = await store.getActiveMembersWithLastReward();
    const referenceDate = await getReferenceDateIso(store);
    return jsonResponse({ referenceDate, entries, ingested });
  }

  if (path === '/api/leaderboards') {
    const list = await store.listLeaderboards();
    return jsonResponse({ leaderboards: list });
  }

  if (path === '/api/leaderboard') {
    const slug = url.searchParams.get('slug');
    if (slug) {
      const data = await store.getLeaderboardBySlug(slug);
      if (!data) return jsonResponse({ error: 'not found' }, { status: 404 });
      return jsonResponse(data);
    }
    // No slug → return the latest leaderboard.
    const list = await store.listLeaderboards();
    if (list.length === 0) return jsonResponse({ leaderboard: null, entries: [] });
    const latest = await store.getLeaderboardBySlug(list[0].slug);
    return jsonResponse(latest ?? { leaderboard: null, entries: [] });
  }

  if (path === '/api/queue') {
    let ingested: { ingested: boolean; count: number } | null = null;
    if (url.searchParams.get('refresh') === '1' && role === 'admin') {
      try {
        ingested = await autoIngestIfNeeded(store, env);
      } catch (err) {
        console.error('Refresh ingestion failed:', err);
        ingested = { ingested: false, count: 0 };
      }
    }
    try {
      await store.syncTrainQueue();
    } catch (err) {
      console.error('Train queue sync failed:', err);
    }
    const [queue, log, referenceDate] = await Promise.all([
      store.getTrainQueue(),
      store.getTrainQueueLog(200),
      getReferenceDateIso(store),
    ]);
    return jsonResponse({ queue, log, role, ingested, referenceDate });
  }

  // ---- Events: GET endpoints (all authenticated roles) ----
  if (path.startsWith('/api/events')) {
    const eventsStore = new EventsStore(env.DB);
    if (path === '/api/events') {
      const events = await eventsStore.listEvents();
      return jsonResponse({ events, role });
    }
    if (path === '/api/events/active-members') {
      const list = await store.getActiveMembersWithLastReward();
      const members = await env.DB.prepare(
        'SELECT id, display_name FROM members WHERE active = 1 ORDER BY display_name COLLATE NOCASE ASC',
      ).all<{ id: number; display_name: string }>();
      // Cross-reference id -> name to match active members list.
      const idByName = new Map<string, number>();
      for (const m of members.results) idByName.set(m.display_name, m.id);
      const entries = list
        .map((e) => ({ id: idByName.get(e.name) ?? null, name: e.name }))
        .filter((e): e is { id: number; name: string } => e.id !== null);
      return jsonResponse({ members: entries });
    }
    if (path === '/api/events/detail') {
      const id = Number(url.searchParams.get('id'));
      if (!Number.isInteger(id) || id < 1) {
        return jsonResponse({ error: 'id required' }, { status: 400 });
      }
      const event = await eventsStore.getEvent(id);
      if (!event) return jsonResponse({ error: 'not found' }, { status: 404 });
      const [registrations, assignments, computedPriorities, previousBenched, previousPowers, outcomes] = await Promise.all([
        eventsStore.listRegistrations(id),
        eventsStore.listAssignments(id),
        eventsStore.computePriorities(id),
        eventsStore.getPreviousBenchedSet(id),
        eventsStore.getPreviousSquadPowers(id),
        eventsStore.getParticipationOutcomes(id),
      ]);
      // Resolve 'any' slots/teams by balancing pool sizes.
      const regsResolved = event.kind === 'desert'
        ? resolveAnySlots(registrations)
        : resolveAnyTeams(registrations);
      // Flag if a player's squad_power grew more than POWER_SPIKE_THRESHOLD_PCT vs their last
      // registration of the same event kind (visible only to admins in the dashboard).
      const POWER_SPIKE_THRESHOLD_PCT = 5;
      // Attach computed priority info to each registration for the client
      const regsWithPriority = regsResolved.map((r) => {
        const cp = computedPriorities.get(r.memberId);
        const previousPower = previousPowers.get(r.memberId) ?? null;
        const powerChangePercent =
          previousPower !== null && r.squadPower > 0
            ? Math.round(((r.squadPower - previousPower) / previousPower) * 1000) / 10
            : null;
        return {
          ...r,
          computedPriority: cp ? cp.priority : (r.status === 'IN' && r.memberActive && r.squadPower > 0 ? 1.0 : null),
          priorityParticipated: cp?.participated ?? 0,
          priorityRegistered: cp?.registered ?? 0,
          isTop6: cp?.isTop4 ?? false,
          previousPower,
          powerChangePercent,
          powerSpikeFlag: powerChangePercent !== null && powerChangePercent > POWER_SPIKE_THRESHOLD_PCT,
          powerDropFlag: powerChangePercent !== null && powerChangePercent < -POWER_SPIKE_THRESHOLD_PCT,
        };
      });
      return jsonResponse({ event, registrations: regsWithPriority, assignments, previousBenched: [...previousBenched], outcomes: Object.fromEntries(outcomes) });
    }
    return jsonResponse({ error: 'not found' }, { status: 404 });
  }

  if (path === '/api/settings') {
    if (role !== 'admin') return jsonResponse({ error: 'admin required' }, { status: 403 });
    const eventsStore = new EventsStore(env.DB);
    const settings = await eventsStore.getEventsSettings();
    // Whether Canyon registration is already open for the upcoming week —
    // the dashboard disables the "open now" button in that case.
    const { weekStart: upcomingWeekStart } = getNextMondayWeekStart(new Date());
    const upcomingCanyon = (await eventsStore.listEvents()).find(
      (e) => e.kind === 'canyon' && e.weekStart === upcomingWeekStart,
    );
    return jsonResponse({
      settings,
      canyonOpenNow: {
        weekStart: upcomingWeekStart,
        alreadyOpen: upcomingCanyon?.status === 'open',
      },
    });
  }

  if (role !== 'admin') {
    return jsonResponse({ error: 'forbidden: read-only token' }, { status: 403 });
  }

  if (path === '/api/eligible-train') {
    const rawDays = Number(url.searchParams.get('days'));
    const minDays = Number.isFinite(rawDays) && rawDays > 0
      ? Math.min(Math.floor(rawDays), 365)
      : 30;
    const all = await store.getActiveMembersWithLastReward();
    const eligible = all.filter(m => m.daysSinceTrain === null || m.daysSinceTrain >= minDays);
    return jsonResponse({ minDays, eligibleTotal: eligible.length, entries: eligible });
  }

  if (path === '/api/pick-train') {
    const rawCount = Number(url.searchParams.get('count'));
    const count = Number.isFinite(rawCount) && rawCount > 0
      ? Math.min(Math.floor(rawCount), 50)
      : 5;
    const rawDays = Number(url.searchParams.get('days'));
    const minDays = Number.isFinite(rawDays) && rawDays > 0
      ? Math.min(Math.floor(rawDays), 365)
      : 30;

    const all = await store.getActiveMembersWithLastReward();
    // Eligible = never received a train reward OR last train >= minDays ago.
    const eligible = all.filter(m => m.daysSinceTrain === null || m.daysSinceTrain >= minDays);

    // Fisher–Yates shuffle on a copy, then take first `count`.
    const pool = eligible.slice();
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const picked = pool.slice(0, count);

    return jsonResponse({
      count,
      minDays,
      eligibleTotal: eligible.length,
      entries: picked,
    });
  }

  return isApi
    ? jsonResponse({ error: 'not found' }, { status: 404 })
    : new Response('Not found', { status: 404 });
}
