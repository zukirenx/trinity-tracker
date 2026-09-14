// Events store for Canyon Storm / Desert Storm roster management.

export type EventKind = 'canyon' | 'desert';
export type EventStatus = 'open' | 'locked' | 'archived';
export type RegistrationStatus = 'IN' | 'OUT' | 'MAYBE';
export type TeamPreference = 'any' | 'A' | 'B';
export type TimeSlot = '13' | '22' | 'any';
export type SquadType = 'tanks' | 'air' | 'missiles';
export type AssignmentTeam = 'A' | 'B';
export type AssignmentRole = 'main' | 'sub';
export type EventOutcome = 'played-main' | 'played-sub' | 'rejected' | 'opted-out' | 'no-show' | 'banned';

export interface EvEvent {
  id: number;
  kind: EventKind;
  weekStart: string;
  teamAStartsAt: string | null;
  teamBStartsAt: string | null;
  registrationClosesAt: string | null;
  status: EventStatus;
  notes: string | null;
  attendanceRecorded: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Registration {
  id: number;
  eventId: number;
  memberId: number;
  memberName: string;
  memberActive: boolean;
  status: RegistrationStatus;
  teamPreference: TeamPreference;
  // Resolved team for Canyon 'any' registrations: 'A' or 'B' after balancing.
  // Null when teamPreference is already 'A' or 'B', or when not a Canyon event.
  resolvedTeamPreference: 'A' | 'B' | null;
  timeSlot: TimeSlot | null;
  // Resolved slot for 'any' registrations: '13' or '22' after balancing.
  // Null when timeSlot is already '13' or '22', or when not a Desert event.
  resolvedTimeSlot: '13' | '22' | null;
  squadPower: number;
  squadType: SquadType;
  source: 'web' | 'admin';
  notes: string | null;
  priority: number | null;
  isBanned: boolean;
  isPenalized: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Assignment {
  id: number;
  eventId: number;
  memberId: number;
  memberName: string;
  team: AssignmentTeam;
  role: AssignmentRole;
  slotIndex: number;
  strategyRole: string | null;
  isLocked: boolean;
  source: 'auto' | 'admin';
}

export interface AssignmentInput {
  memberId: number;
  team: AssignmentTeam;
  role: AssignmentRole;
  slotIndex: number;
  strategyRole?: string | null;
  source?: 'auto' | 'admin';
}

// Computed float priority 0..1. 1.0 = never missed (or no history). 0 = always missed.
// Top-4-by-power players per team always receive 1.0 regardless of history.
export interface ComputedPriority {
  memberId: number;
  priority: number; // 0..1, rounded to 2 decimal places
  participated: number;
  registered: number;
  isTop4: boolean;
}

export interface EventsSettings {
  canyonAutoOpen: boolean;
  canyonATime: string; // '16:00' or '03:00' (CET, i.e. CEST = UTC+2)
  canyonBTime: string;
  desertATime: string; // '13:00' | '22:00' | '03:00' (CET)
  desertBTime: string;
  canyonCloseTime: string; // 'HH:00', hour-only wall time in SERVER time — Monday of the event week
  desertCloseTime: string; // 'HH:00', hour-only wall time in SERVER time — Wednesday of the event week
}

export const VALID_CANYON_TIMES: readonly string[] = ['16:00', '03:00'];
export const VALID_DESERT_TIMES: readonly string[] = ['13:00', '22:00', '03:00'];

/**
 * Single timezone for everything in Settings: game-server time, UTC-2, fixed
 * (no DST, no ambiguity about which calendar day an hour belongs to).
 * Match slots are stored canonically as game times (UTC+2 fixed) but presented
 * in Settings as their server-time equivalents; registration-close hours are
 * stored directly as server-time wall hours.
 */
export const SERVER_TZ_LABEL = 'server time (UTC-2)';
/** Server (UTC-2) wall equivalents of the canonical game slots (UTC+2 fixed): game − 4 h. */
export const GAME_SLOT_TO_SERVER: Readonly<Record<string, string>> = {
  '16:00': '12:00',
  '03:00': '23:00',
  '13:00': '09:00',
  '22:00': '18:00',
};

/** Registration closes Monday / Wednesday 12:00 server time by default. */
export const DEFAULT_CANYON_CLOSE_TIME = '12:00';
export const DEFAULT_DESERT_CLOSE_TIME = '12:00';

/** Day offsets from weekStart (Monday) for the registration deadline (server days). */
export const CANYON_CLOSE_DAY_OFFSET = 0; // Monday
export const DESERT_CLOSE_DAY_OFFSET = 2; // Wednesday

/** Hour-only close times: 'HH:00', 00–23, in server time. */
const CLOSE_HOUR_RE = /^([01]\d|2[0-3]):00$/;
/** Legacy (UTC, minute-granularity) close values from before the server-time switch. */
const LEGACY_CLOSE_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isValidCloseTime(v: unknown): v is string {
  return typeof v === 'string' && CLOSE_HOUR_RE.test(v);
}

/**
 * Convert a legacy UTC 'HH:MM' close value to the instant-preserving server-time
 * hour ('HH:00'): server = UTC − 2 h, minutes truncated to hour granularity.
 * E.g. '12:00' UTC → '10:00' server; '00:30' UTC → '22:00' server (previous day's
 * 22:00 server = 00:00 UTC, so the 00:30 deadline moves ≤1 h earlier — acceptable
 * for a deprecated one-way migration of a days-old setting).
 */
export function migrateLegacyCloseTimeToServer(utcHHMM: string): string {
  const h = Number(utcHHMM.slice(0, 2));
  return `${String((h - 2 + 24) % 24).padStart(2, '0')}:00`;
}

/**
 * Map a canonical game slot ('HH:MM', UTC+2 fixed) to its server-time (UTC-2)
 * wall equivalent for display in Settings and Discord posts. Game − 4 h.
 */
export function serverWallFromGameSlot(gameTimeHHMM: string): string {
  const h = Number(gameTimeHHMM.slice(0, 2));
  const m = gameTimeHHMM.slice(3, 5);
  return `${String((h - 4 + 24) % 24).padStart(2, '0')}:${m}`;
}

/** Canyon Storm always plays on Thursday (Mon = 0 … Sun = 6). */
export const CANYON_EVENT_DAY = 3;
/** Desert Storm always plays on Friday. */
export const DESERT_EVENT_DAY = 4;

/**
 * Deterministic hash (FNV-1a, hex) of a roster post's visible content:
 * member names, teams, roles, slots and strategy roles, sorted. Row ids and
 * timestamps are excluded, so re-saving an unchanged roster yields the same
 * hash. Used to skip duplicate Discord roster posts.
 */
export function computeRosterHash(assignments: Assignment[]): string {
  const rows = assignments.map(
    (a) => [a.memberName, a.team, a.role, a.slotIndex, a.strategyRole ?? ''] as const,
  );
  rows.sort((x, y) => {
    for (let i = 0; i < x.length; i++) {
      if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
    }
    return 0;
  });
  const s = JSON.stringify(rows);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Compute the UTC ISO timestamp for an event given the fixed event-day-of-week
 * and the time expressed in CET (CEST = UTC+2, the player-facing timezone).
 *
 * The game server runs at UTC-2, which is 4 h behind CEST.  For the night slot
 * ('03:00 CET') the server clock still shows the base event day (e.g. Thursday
 * 23:00 UTC-2 for Canyon), but in CET this appears as 03:00 the NEXT calendar
 * day (Friday 01:00 UTC).  All other allowed times are daytime and fall on the
 * same calendar day in both CET and UTC.
 */
export function computeEventTimestamp(
  weekStartIso: string,
  eventDayOfWeek: number,
  cetTimeHHMM: string,
): string {
  const [hStr, mStr] = cetTimeHHMM.split(':');
  const h = Number(hStr);
  const m = Number(mStr) || 0;
  // 03:00 CET is the night slot: it lands on the next calendar day in UTC
  // (server Thu 23:00 UTC-2 = Fri 01:00 UTC = Fri 03:00 CET for Canyon).
  const utcDay = h === 3 ? eventDayOfWeek + 1 : eventDayOfWeek;
  const d = new Date(weekStartIso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + utcDay);
  d.setUTCHours(h - 2, m, 0, 0); // CET (UTC+2) → UTC: subtract 2 h
  return d.toISOString();
}

/**
 * Compute the UTC ISO timestamp for a registration deadline.
 *
 * weekStartIso is the Monday (YYYY-MM-DD) of the event week, dayOffset is 0
 * for Monday (Canyon) or 2 for Wednesday (Desert), and serverTimeHHMM is an
 * hour-only 'HH:00' wall time in SERVER time (UTC-2 fixed). Both the day and
 * the hour are counted in server time, so there is never ambiguity about
 * which calendar day an early-morning hour belongs to.
 * Server → UTC is +2 h (setUTCHours overflow into the next UTC day is fine —
 * the instant is what auto-lock compares).
 */
export function computeRegistrationCloseTimestamp(
  weekStartIso: string,
  dayOffset: number,
  serverTimeHHMM: string,
): string {
  const h = Number(serverTimeHHMM.slice(0, 2));
  const d = new Date(weekStartIso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + dayOffset);
  d.setUTCHours(h + 2, 0, 0, 0); // server (UTC-2) → UTC: add 2 h
  return d.toISOString();
}

/**
 * Returns true when both teams play at the same UTC date+hour, false when
 * different, and undefined when either timestamp is missing.
 */
export function getSameTeamTime(event: EvEvent): boolean | undefined {
  if (!event.teamAStartsAt || !event.teamBStartsAt) return undefined;
  const a = new Date(event.teamAStartsAt);
  const b = new Date(event.teamBStartsAt);
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate() &&
    a.getUTCHours() === b.getUTCHours()
  );
}

const VALID_KINDS: readonly EventKind[] = ['canyon', 'desert'];
const VALID_REG_STATUS: readonly RegistrationStatus[] = ['IN', 'OUT', 'MAYBE'];
const VALID_TEAM_PREF: readonly TeamPreference[] = ['any', 'A', 'B'];
const VALID_TIME_SLOT: readonly TimeSlot[] = ['13', '22', 'any'];
const VALID_SQUAD_TYPE: readonly SquadType[] = ['tanks', 'air', 'missiles'];

export function isValidKind(v: unknown): v is EventKind {
  return typeof v === 'string' && (VALID_KINDS as readonly string[]).includes(v);
}
export function isValidRegStatus(v: unknown): v is RegistrationStatus {
  return typeof v === 'string' && (VALID_REG_STATUS as readonly string[]).includes(v);
}
export function isValidTeamPref(v: unknown): v is TeamPreference {
  return typeof v === 'string' && (VALID_TEAM_PREF as readonly string[]).includes(v);
}
export function isValidTimeSlot(v: unknown): v is TimeSlot {
  return typeof v === 'string' && (VALID_TIME_SLOT as readonly string[]).includes(v);
}
export function isValidSquadType(v: unknown): v is SquadType {
  return typeof v === 'string' && (VALID_SQUAD_TYPE as readonly string[]).includes(v);
}

interface EventRow {
  id: number;
  kind: string;
  week_start: string;
  team_a_starts_at: string | null;
  team_b_starts_at: string | null;
  registration_closes_at: string | null;
  status: string;
  notes: string | null;
  attendance_recorded: number;
  created_at: string;
  updated_at: string;
}

function mapEvent(row: EventRow): EvEvent {
  return {
    id: row.id,
    kind: row.kind as EventKind,
    weekStart: row.week_start,
    teamAStartsAt: row.team_a_starts_at,
    teamBStartsAt: row.team_b_starts_at,
    registrationClosesAt: row.registration_closes_at,
    status: row.status as EventStatus,
    notes: row.notes,
    attendanceRecorded: Boolean(row.attendance_recorded),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class EventsStore {
  constructor(private db: D1Database) {}

  async createEvent(input: {
    kind: EventKind;
    weekStart: string;
    teamAStartsAt?: string | null;
    teamBStartsAt?: string | null;
    registrationClosesAt?: string | null;
    notes?: string | null;
  }): Promise<EvEvent> {
    if (!isValidKind(input.kind)) throw new Error('invalid kind');
    if (!input.weekStart) throw new Error('weekStart required');
    const res = await this.db
      .prepare(
        `INSERT INTO poc_events_event
           (kind, week_start, team_a_starts_at, team_b_starts_at, registration_closes_at, notes)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(kind, week_start) DO UPDATE SET
           team_a_starts_at = excluded.team_a_starts_at,
           team_b_starts_at = excluded.team_b_starts_at,
           registration_closes_at = excluded.registration_closes_at,
           notes = excluded.notes,
           updated_at = datetime('now')
         RETURNING id, kind, week_start, team_a_starts_at, team_b_starts_at,
                   registration_closes_at, status, notes, attendance_recorded, created_at, updated_at`,
      )
      .bind(
        input.kind,
        input.weekStart,
        input.teamAStartsAt ?? null,
        input.teamBStartsAt ?? null,
        input.registrationClosesAt ?? null,
        input.notes ?? null,
      )
      .first<EventRow>();
    if (!res) throw new Error('createEvent failed');
    return mapEvent(res);
  }

  async listEvents(): Promise<EvEvent[]> {
    const rows = await this.db
      .prepare(
        `SELECT id, kind, week_start, team_a_starts_at, team_b_starts_at,
                registration_closes_at, status, notes, attendance_recorded, created_at, updated_at
         FROM poc_events_event
         ORDER BY week_start DESC, kind DESC`,
      )
      .all<EventRow>();
    return rows.results.map(mapEvent);
  }

  async getEvent(id: number): Promise<EvEvent | null> {
    const row = await this.db
      .prepare(
        `SELECT id, kind, week_start, team_a_starts_at, team_b_starts_at,
                registration_closes_at, status, notes, attendance_recorded, created_at, updated_at
         FROM poc_events_event WHERE id = ?`,
      )
      .bind(id)
      .first<EventRow>();
    return row ? mapEvent(row) : null;
  }

  async updateEventSchedule(
    id: number,
    fields: {
      teamAStartsAt?: string | null;
      teamBStartsAt?: string | null;
      registrationClosesAt?: string | null;
      notes?: string | null;
    },
  ): Promise<boolean> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    if ('teamAStartsAt' in fields) {
      sets.push('team_a_starts_at = ?');
      vals.push(fields.teamAStartsAt ?? null);
    }
    if ('teamBStartsAt' in fields) {
      sets.push('team_b_starts_at = ?');
      vals.push(fields.teamBStartsAt ?? null);
    }
    if ('registrationClosesAt' in fields) {
      sets.push('registration_closes_at = ?');
      vals.push(fields.registrationClosesAt ?? null);
    }
    if ('notes' in fields) {
      sets.push('notes = ?');
      vals.push(fields.notes ?? null);
    }
    if (sets.length === 0) return false;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    const res = await this.db
      .prepare(`UPDATE poc_events_event SET ${sets.join(', ')} WHERE id = ?`)
      .bind(...vals)
      .run();
    return (res.meta?.changes ?? 0) > 0;
  }

  /** Hash of the last roster posted to Discord (null when never posted). */
  async getRosterPostedHash(eventId: number): Promise<string | null> {
    const row = await this.db
      .prepare('SELECT roster_posted_hash FROM poc_events_event WHERE id = ?')
      .bind(eventId)
      .first<{ roster_posted_hash: string | null }>();
    return row?.roster_posted_hash ?? null;
  }

  async setRosterPostedHash(eventId: number, hash: string): Promise<void> {
    await this.db
      .prepare("UPDATE poc_events_event SET roster_posted_hash = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(hash, eventId)
      .run();
  }

  async upsertRegistration(
    eventId: number,
    memberId: number,
    fields: {
      status: RegistrationStatus;
      teamPreference?: TeamPreference | null;
      timeSlot?: TimeSlot | null;
      squadPower: number;
      squadType: SquadType;
      source?: 'web' | 'admin';
      notes?: string | null;
    },
  ): Promise<Registration> {
    if (!isValidRegStatus(fields.status)) throw new Error('invalid status');
    if (fields.teamPreference != null && !isValidTeamPref(fields.teamPreference)) {
      throw new Error('invalid teamPreference');
    }
    if (fields.timeSlot != null && !isValidTimeSlot(fields.timeSlot)) {
      throw new Error('invalid timeSlot');
    }
    if (!isValidSquadType(fields.squadType)) throw new Error('invalid squadType');
    const power = Math.max(0, Math.floor(Number(fields.squadPower) || 0));
    if (fields.status === 'IN' && power <= 0) {
      throw new Error('squadPower must be > 0 when status is IN');
    }

    const event = await this.getEvent(eventId);
    if (!event) throw new Error('event not found');

    // Canyon team assignment happens at suggest time, not at registration.
    // Always store 'any' for Canyon; resolveAnyTeams() balances at read time.
    const resolvedTeamPref = fields.teamPreference ?? 'any';

    await this.db
      .prepare(
        `INSERT INTO poc_events_registration
           (event_id, member_id, status, team_preference, time_slot,
            squad_power, squad_type, source, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(event_id, member_id) DO UPDATE SET
           status = excluded.status,
           team_preference = excluded.team_preference,
           time_slot = excluded.time_slot,
           squad_power = excluded.squad_power,
           squad_type = excluded.squad_type,
           source = excluded.source,
           notes = excluded.notes,
           updated_at = datetime('now')`,
      )
      .bind(
        eventId,
        memberId,
        fields.status,
        resolvedTeamPref,
        fields.timeSlot ?? null,
        power,
        fields.squadType,
        fields.source ?? 'web',
        fields.notes ?? null,
      )
      .run();
    const list = await this.listRegistrations(eventId);
    const row = list.find((r) => r.memberId === memberId);
    if (!row) throw new Error('upsertRegistration: post-insert lookup failed');
    return row;
  }

  async listRegistrations(eventId: number): Promise<Registration[]> {
    const rows = await this.db
      .prepare(
        `SELECT r.id, r.event_id, r.member_id, r.status, r.team_preference,
                r.time_slot, r.squad_power, r.squad_type, r.source, r.notes,
                r.priority, r.is_banned, r.is_penalized, r.created_at, r.updated_at,
                m.display_name AS member_name, m.active AS member_active
         FROM poc_events_registration r
         JOIN members m ON m.id = r.member_id
         WHERE r.event_id = ?
         ORDER BY r.status ASC, m.display_name ASC`,
      )
      .bind(eventId)
      .all<{
        id: number;
        event_id: number;
        member_id: number;
        status: string;
        team_preference: string | null;
        time_slot: string | null;
        squad_power: number;
        squad_type: string;
        source: string;
        notes: string | null;
        priority: number | null;
        is_banned: number;
        is_penalized: number;
        created_at: string;
        updated_at: string;
        member_name: string;
        member_active: number;
      }>();
    return rows.results.map((r) => ({
      id: r.id,
      eventId: r.event_id,
      memberId: r.member_id,
      memberName: r.member_name,
      memberActive: Boolean(r.member_active),
      status: r.status as RegistrationStatus,
      teamPreference: (r.team_preference as TeamPreference) ?? 'any',
      resolvedTeamPreference: null,
      timeSlot: r.time_slot as TimeSlot | null,
      resolvedTimeSlot: null,
      squadPower: r.squad_power,
      squadType: r.squad_type as SquadType,
      source: r.source as 'web' | 'admin',
      notes: r.notes,
      priority: r.priority ?? null,
      isBanned: Boolean(r.is_banned),
      isPenalized: Boolean(r.is_penalized),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  async deleteRegistration(eventId: number, memberId: number): Promise<boolean> {
    const res = await this.db
      .prepare('DELETE FROM poc_events_registration WHERE event_id = ? AND member_id = ?')
      .bind(eventId, memberId)
      .run();
    return (res.meta?.changes ?? 0) > 0;
  }

  /**
   * For each member registered in the given event, returns their squad_power from
   * the most recent *prior* event of the same kind. Used to flag unexpected power spikes.
   * Members with no prior registration of the same kind are absent from the map.
   */
  async getPreviousSquadPowers(eventId: number): Promise<Map<number, number>> {
    const rows = await this.db
      .prepare(
        `WITH cur AS (
           SELECT kind, week_start FROM poc_events_event WHERE id = ?
         ),
         ranked AS (
           SELECT r.member_id, r.squad_power,
                  ROW_NUMBER() OVER (PARTITION BY r.member_id ORDER BY e.week_start DESC) AS rn
           FROM poc_events_registration r
           JOIN poc_events_event e ON r.event_id = e.id
           WHERE e.kind = (SELECT kind FROM cur)
             AND e.week_start < (SELECT week_start FROM cur)
             AND r.squad_power > 0
             AND r.member_id IN (SELECT member_id FROM poc_events_registration WHERE event_id = ?)
         )
         SELECT member_id, squad_power FROM ranked WHERE rn = 1`,
      )
      .bind(eventId, eventId)
      .all<{ member_id: number; squad_power: number }>();
    return new Map(rows.results.map((r) => [r.member_id, r.squad_power]));
  }

  async setBan(eventId: number, memberId: number, banned: boolean): Promise<boolean> {
    const res = await this.db
      .prepare(
        `UPDATE poc_events_registration SET is_banned = ?, updated_at = datetime('now')
         WHERE event_id = ? AND member_id = ?`,
      )
      .bind(banned ? 1 : 0, eventId, memberId)
      .run();
    return (res.meta?.changes ?? 0) > 0;
  }

  async setPenalized(eventId: number, memberId: number, penalized: boolean): Promise<boolean> {
    const res = await this.db
      .prepare(
        `UPDATE poc_events_registration SET is_penalized = ?, updated_at = datetime('now')
         WHERE event_id = ? AND member_id = ?`,
      )
      .bind(penalized ? 1 : 0, eventId, memberId)
      .run();
    return (res.meta?.changes ?? 0) > 0;
  }

  async listAssignments(eventId: number): Promise<Assignment[]> {
    const rows = await this.db
      .prepare(
        `SELECT a.id, a.event_id, a.member_id, a.team, a.role, a.slot_index,
                a.strategy_role, a.is_locked, a.source,
                COALESCE(a.member_name_snapshot, m.display_name) AS member_name
         FROM poc_events_assignment a
         LEFT JOIN members m ON m.id = a.member_id
         WHERE a.event_id = ?
         ORDER BY a.team ASC, a.role ASC, a.slot_index ASC`,
      )
      .bind(eventId)
      .all<{
        id: number;
        event_id: number;
        member_id: number;
        team: string;
        role: string;
        slot_index: number;
        strategy_role: string | null;
        is_locked: number;
        source: string;
        member_name: string;
      }>();
    return rows.results.map((r) => ({
      id: r.id,
      eventId: r.event_id,
      memberId: r.member_id,
      memberName: r.member_name,
      team: r.team as AssignmentTeam,
      role: r.role as AssignmentRole,
      slotIndex: r.slot_index,
      strategyRole: r.strategy_role,
      isLocked: Boolean(r.is_locked),
      source: r.source as 'auto' | 'admin',
    }));
  }

  async replaceAssignments(
    eventId: number,
    assignments: AssignmentInput[],
    opts: { isLocked: boolean },
  ): Promise<void> {
    // Validate slot uniqueness + member uniqueness before touching the DB.
    const memberSeen = new Set<number>();
    const slotSeen = new Set<string>();
    for (const a of assignments) {
      if (memberSeen.has(a.memberId)) {
        throw new Error(`duplicate memberId in assignments: ${a.memberId}`);
      }
      memberSeen.add(a.memberId);
      const slotKey = `${a.team}#${a.slotIndex}`;
      if (slotSeen.has(slotKey)) {
        throw new Error(`duplicate team/slot in assignments: ${slotKey}`);
      }
      slotSeen.add(slotKey);
    }
    const statements: D1PreparedStatement[] = [];
    statements.push(
      this.db.prepare('DELETE FROM poc_events_assignment WHERE event_id = ?').bind(eventId),
    );
    for (const a of assignments) {
      statements.push(
        this.db
          .prepare(
            `INSERT INTO poc_events_assignment
               (event_id, member_id, team, role, slot_index, strategy_role, is_locked, source)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            eventId,
            a.memberId,
            a.team,
            a.role,
            a.slotIndex,
            a.strategyRole ?? null,
            opts.isLocked ? 1 : 0,
            a.source ?? 'auto',
          ),
      );
    }
    await this.db.batch(statements);
  }

  // Lock: write a participation_log row for every registration of the event,
  // then mark assignments locked and event status = 'locked'.
  // Idempotent: if the event is already locked this is a no-op (returns logged=0).
  async lockRoster(eventId: number): Promise<{ logged: number }> {
    const event = await this.getEvent(eventId);
    if (!event) throw new Error('event not found');
    if (event.status === 'locked') return { logged: 0 };
    const regs = await this.listRegistrations(eventId);
    const assigns = await this.listAssignments(eventId);
    const assignByMember = new Map(assigns.map((a) => [a.memberId, a] as const));
    if (assigns.length === 0) {
      throw new Error('cannot lock: no assignments saved — save the roster before locking');
    }

    const statements: D1PreparedStatement[] = [];
    let logged = 0;
    for (const r of regs) {
      let outcome: EventOutcome;
      if (r.status === 'OUT' || r.status === 'MAYBE') {
        outcome = 'opted-out';
      } else if (r.isBanned) {
        outcome = 'banned';
      } else {
        const a = assignByMember.get(r.memberId);
        if (!a) outcome = 'rejected';
        else outcome = a.role === 'main' ? 'played-main' : 'played-sub';
      }
      statements.push(
        this.db
          .prepare(
            `INSERT OR IGNORE INTO poc_events_participation_log (event_id, member_id, outcome)
             VALUES (?, ?, ?)`,
          )
          .bind(eventId, r.memberId, outcome),
      );
      logged += 1;
    }
    // Snapshot display names into assignment rows so they survive member deactivation/deletion.
    for (const a of assigns) {
      statements.push(
        this.db
          .prepare(
            `UPDATE poc_events_assignment
             SET is_locked = 1, member_name_snapshot = ?, updated_at = datetime('now')
             WHERE id = ?`,
          )
          .bind(a.memberName, a.id),
      );
    }
    statements.push(
      this.db
        .prepare(
          `UPDATE poc_events_event SET status = 'locked', updated_at = datetime('now')
           WHERE id = ?`,
        )
        .bind(eventId),
    );
    await this.db.batch(statements);
    return { logged };
  }

  // Substitute an assigned player in a locked event.
  // outMemberId: the player being replaced — their participation_log row is DELETED so this
  //   event will not count against (or for) their priority ratio at all.
  // inMemberId: the substitute — inherits the same team/role/slot/strategyRole;
  //   their participation_log is upserted to played-main or played-sub accordingly.
  // Throws if the event is not locked, outMemberId has no assignment, or inMemberId is
  // already assigned in this event.
  async substitutePlayer(
    eventId: number,
    outMemberId: number,
    inMemberId: number,
  ): Promise<{ team: AssignmentTeam; role: AssignmentRole; slotIndex: number; strategyRole: string | null }> {
    const event = await this.getEvent(eventId);
    if (!event) throw new Error('event not found');
    if (event.status !== 'locked') throw new Error('event must be locked to substitute players');

    interface AssignRow {
      team: string;
      role: string;
      slot_index: number;
      strategy_role: string | null;
    }
    const outAssign = await this.db
      .prepare('SELECT team, role, slot_index, strategy_role FROM poc_events_assignment WHERE event_id = ? AND member_id = ?')
      .bind(eventId, outMemberId)
      .first<AssignRow>();
    if (!outAssign) throw new Error('outgoing player has no assignment in this event');

    const inAssignExists = await this.db
      .prepare('SELECT id FROM poc_events_assignment WHERE event_id = ? AND member_id = ?')
      .bind(eventId, inMemberId)
      .first<{ id: number }>();
    if (inAssignExists) throw new Error('incoming player is already assigned in this event');

    const inMember = await this.db
      .prepare('SELECT display_name FROM members WHERE id = ?')
      .bind(inMemberId)
      .first<{ display_name: string }>();
    if (!inMember) throw new Error('incoming player not found');

    const newOutcome: EventOutcome = outAssign.role === 'main' ? 'played-main' : 'played-sub';

    await this.db.batch([
      // Void the outgoing player: delete participation_log so this event is excluded
      // from their priority ratio entirely.
      this.db
        .prepare('DELETE FROM poc_events_participation_log WHERE event_id = ? AND member_id = ?')
        .bind(eventId, outMemberId),
      // Remove outgoing player's assignment.
      this.db
        .prepare('DELETE FROM poc_events_assignment WHERE event_id = ? AND member_id = ?')
        .bind(eventId, outMemberId),
      // Upsert incoming player's participation_log.
      this.db
        .prepare(
          `INSERT INTO poc_events_participation_log (event_id, member_id, outcome)
           VALUES (?, ?, ?)
           ON CONFLICT(event_id, member_id) DO UPDATE SET outcome = excluded.outcome, ts = datetime('now')`,
        )
        .bind(eventId, inMemberId, newOutcome),
      // Insert incoming player's assignment, inheriting the outgoing player's slot.
      this.db
        .prepare(
          `INSERT INTO poc_events_assignment
           (event_id, member_id, team, role, slot_index, strategy_role, is_locked, source, member_name_snapshot)
           VALUES (?, ?, ?, ?, ?, ?, 1, 'admin', ?)`,
        )
        .bind(eventId, inMemberId, outAssign.team, outAssign.role, outAssign.slot_index, outAssign.strategy_role, inMember.display_name),
    ]);

    return {
      team: outAssign.team as AssignmentTeam,
      role: outAssign.role as AssignmentRole,
      slotIndex: outAssign.slot_index,
      strategyRole: outAssign.strategy_role,
    };
  }

  async markNoShow(eventId: number, memberId: number, comment?: string | null): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO poc_events_participation_log (event_id, member_id, outcome, comment)
         VALUES (?, ?, 'no-show', ?)
         ON CONFLICT(event_id, member_id) DO UPDATE SET
           outcome = 'no-show',
           comment = excluded.comment,
           ts = datetime('now')`,
      )
      .bind(eventId, memberId, comment ?? null)
      .run();
  }

  // For locked events: only update strategy_role for existing assignments.
  // Does not add, remove, or change team/role/slot of any player.
  async updateStrategyRoles(
    eventId: number,
    patches: { memberId: number; strategyRole: string | null }[],
  ): Promise<void> {
    if (patches.length === 0) return;
    const statements = patches.map((p) =>
      this.db
        .prepare(
          'UPDATE poc_events_assignment SET strategy_role = ? WHERE event_id = ? AND member_id = ?',
        )
        .bind(p.strategyRole, eventId, p.memberId),
    );
    await this.db.batch(statements);
  }

  // Compute float priorities (0..1) for all eligible registrations of an event.
  // Formula: priority = 1 - (participated / registered) across ALL closed+locked events.
  // "participated" = played-main or played-sub. "registered" = any participation_log row.
  // Players with no history get priority 1.0.
  // Top 4 by squad power per team always get 1.0 regardless of history.
  async computePriorities(eventId: number): Promise<Map<number, ComputedPriority>> {
    const event = await this.getEvent(eventId);
    if (!event) throw new Error('event not found');
    const regs = await this.listRegistrations(eventId);
    const eligible = regs.filter(
      (r) => r.status === 'IN' && r.memberActive && r.squadPower > 0 && !r.isBanned,
    );
    if (eligible.length === 0) return new Map();

    // Determine top-4 per team. Canyon uses team_preference (already auto-assigned A/B).
    // Desert uses time_slot. Any remaining 'any' flex go to smaller pool.
    const poolA: Registration[] = [];
    const poolB: Registration[] = [];
    const flex: Registration[] = [];
    // Resolve 'any' assignments before computing top-4 pools.
    const eligibleResolved = event.kind === 'desert'
      ? resolveAnySlots(eligible)
      : resolveAnyTeams(eligible);
    for (const r of eligibleResolved) {
      if (event.kind === 'desert') {
        const slot = r.timeSlot === 'any' ? (r.resolvedTimeSlot ?? null) : r.timeSlot;
        if (slot === '22') poolA.push(r);
        else if (slot === '13') poolB.push(r);
        else flex.push(r);
      } else {
        const team = r.teamPreference === 'any' ? (r.resolvedTeamPreference ?? null) : r.teamPreference;
        if (team === 'A') poolA.push(r);
        else if (team === 'B') poolB.push(r);
        else flex.push(r);
      }
    }
    for (const r of flex) {
      if (poolA.length <= poolB.length) poolA.push(r);
      else poolB.push(r);
    }
    const sortByPower = (a: Registration, b: Registration) =>
      b.squadPower !== a.squadPower
        ? b.squadPower - a.squadPower
        : a.memberName.localeCompare(b.memberName);
    poolA.sort(sortByPower);
    poolB.sort(sortByPower);
    const top4Ids = new Set<number>();
    for (const r of poolA.slice(0, 4)) top4Ids.add(r.memberId);
    for (const r of poolB.slice(0, 4)) top4Ids.add(r.memberId);

    // Fetch participation history across ALL closed+locked events for eligible members.
    const memberIds = eligible.map((r) => r.memberId);
    const placeholders = memberIds.map(() => '?').join(',');
    const historyRows = await this.db
      .prepare(
        `SELECT p.member_id, p.outcome
         FROM poc_events_participation_log p
         JOIN poc_events_event e ON e.id = p.event_id
         WHERE p.member_id IN (${placeholders})
           AND e.status = 'locked'
           AND e.week_start < ?`,
      )
      .bind(...memberIds, event.weekStart)
      .all<{ member_id: number; outcome: string }>();

    const participatedCount = new Map<number, number>();
    const registeredCount = new Map<number, number>();
    for (const id of memberIds) {
      participatedCount.set(id, 0);
      registeredCount.set(id, 0);
    }
    for (const row of historyRows.results) {
      registeredCount.set(row.member_id, (registeredCount.get(row.member_id) ?? 0) + 1);
      if (row.outcome === 'played-main' || row.outcome === 'played-sub' || row.outcome === 'banned') {
        participatedCount.set(row.member_id, (participatedCount.get(row.member_id) ?? 0) + 1);
      }
    }

    const result = new Map<number, ComputedPriority>();
    for (const r of eligible) {
      const isTop4 = top4Ids.has(r.memberId);
      let priority: number;
      if (isTop4) {
        priority = 1.0;
      } else {
        const reg = registeredCount.get(r.memberId) ?? 0;
        const part = participatedCount.get(r.memberId) ?? 0;
        const base = reg === 0 ? 1.0 : Math.round((1 - part / reg) * 100) / 100;
        priority = r.isPenalized ? Math.round(base * 0.8 * 100) / 100 : base;
      }
      result.set(r.memberId, {
        memberId: r.memberId,
        priority,
        participated: participatedCount.get(r.memberId) ?? 0,
        registered: registeredCount.get(r.memberId) ?? 0,
        isTop4,
      });
    }
    return result;
  }

  // Returns the role (main/sub) each member had in the most recent locked event of the same kind.
  async getPreviousRoleMap(eventId: number): Promise<Map<number, AssignmentRole>> {
    const event = await this.getEvent(eventId);
    if (!event) return new Map();
    const prev = await this.db
      .prepare(
        `SELECT id FROM poc_events_event
         WHERE kind = ? AND status = 'locked' AND id != ?
         ORDER BY week_start DESC, id DESC LIMIT 1`,
      )
      .bind(event.kind, eventId)
      .first<{ id: number }>();
    if (!prev) return new Map();
    const rows = await this.db
      .prepare(
        `SELECT member_id, outcome FROM poc_events_participation_log WHERE event_id = ?`,
      )
      .bind(prev.id)
      .all<{ member_id: number; outcome: string }>();
    const result = new Map<number, AssignmentRole>();
    for (const r of rows.results) {
      if (r.outcome === 'played-main') result.set(r.member_id, 'main');
      else if (r.outcome === 'played-sub') result.set(r.member_id, 'sub');
    }
    return result;
  }

  // Returns the set of member_ids who had outcome='rejected' (benched/not picked)
  // in the most recent locked event of the same kind.
  async getPreviousBenchedSet(eventId: number): Promise<Set<number>> {
    const event = await this.getEvent(eventId);
    if (!event) return new Set();
    const prev = await this.db
      .prepare(
        `SELECT id FROM poc_events_event
         WHERE kind = ? AND status = 'locked' AND id != ?
         ORDER BY week_start DESC, id DESC LIMIT 1`,
      )
      .bind(event.kind, eventId)
      .first<{ id: number }>();
    if (!prev) return new Set();
    const rows = await this.db
      .prepare(
        `SELECT member_id FROM poc_events_participation_log
         WHERE event_id = ? AND outcome = 'rejected'`,
      )
      .bind(prev.id)
      .all<{ member_id: number }>();
    return new Set(rows.results.map((r) => r.member_id));
  }

  async resetAll(): Promise<void> {
    // Order matters because of FK ON DELETE CASCADE chains.
    await this.db.batch([
      this.db.prepare('DELETE FROM poc_events_participation_log'),
      this.db.prepare('DELETE FROM poc_events_assignment'),
      this.db.prepare('DELETE FROM poc_events_registration'),
      this.db.prepare('DELETE FROM poc_events_event'),
    ]);
  }

  // Returns the participation log for an event: memberId → outcome.
  async getParticipationOutcomes(eventId: number): Promise<Map<number, EventOutcome>> {
    const rows = await this.db
      .prepare('SELECT member_id, outcome FROM poc_events_participation_log WHERE event_id = ?')
      .bind(eventId)
      .all<{ member_id: number; outcome: string }>();
    return new Map(rows.results.map((r) => [r.member_id, r.outcome as EventOutcome]));
  }

  // Record attendance for a locked event. presentMemberIds is the set of assigned players
  // (mains and subs) who physically showed up.
  // - Absent mains: outcome updated to 'no-show'; auto-banned in the next open event.
  // - Absent subs: outcome updated to 'no-show'; no banning.
  // - Present mains/subs (restored): outcome reverted to 'played-main'/'played-sub'.
  // Returns { noShowIds (all roles), bannedInEventId, bannedCount (mains only) }.
  async recordAttendance(
    eventId: number,
    presentMemberIds: number[],
  ): Promise<{ noShowIds: number[]; bannedInEventId: number | null; bannedCount: number }> {
    const event = await this.getEvent(eventId);
    if (!event) throw new Error('event not found');
    if (event.status !== 'locked') throw new Error('event must be locked to record attendance');

    const assignments = await this.listAssignments(eventId);
    const mainIds = assignments.filter((a) => a.role === 'main').map((a) => a.memberId);
    const subIds = assignments.filter((a) => a.role === 'sub').map((a) => a.memberId);

    const presentSet = new Set(presentMemberIds);
    const noShowMainIds = mainIds.filter((id) => !presentSet.has(id));
    const presentMainIds = mainIds.filter((id) => presentSet.has(id));
    const noShowSubIds = subIds.filter((id) => !presentSet.has(id));
    const presentSubIds = subIds.filter((id) => presentSet.has(id));

    const noShowIds = [...noShowMainIds, ...noShowSubIds];

    const statements: D1PreparedStatement[] = [];

    // Mains: absent → no-show, present → played-main (restore).
    for (const id of noShowMainIds) {
      statements.push(
        this.db
          .prepare(
            `UPDATE poc_events_participation_log
             SET outcome = 'no-show', ts = datetime('now')
             WHERE event_id = ? AND member_id = ? AND outcome = 'played-main'`,
          )
          .bind(eventId, id),
      );
    }
    for (const id of presentMainIds) {
      statements.push(
        this.db
          .prepare(
            `UPDATE poc_events_participation_log
             SET outcome = 'played-main', ts = datetime('now')
             WHERE event_id = ? AND member_id = ? AND outcome = 'no-show'`,
          )
          .bind(eventId, id),
      );
    }
    // Subs: absent → no-show, present → played-sub (restore). No banning.
    for (const id of noShowSubIds) {
      statements.push(
        this.db
          .prepare(
            `UPDATE poc_events_participation_log
             SET outcome = 'no-show', ts = datetime('now')
             WHERE event_id = ? AND member_id = ? AND outcome = 'played-sub'`,
          )
          .bind(eventId, id),
      );
    }
    for (const id of presentSubIds) {
      statements.push(
        this.db
          .prepare(
            `UPDATE poc_events_participation_log
             SET outcome = 'played-sub', ts = datetime('now')
             WHERE event_id = ? AND member_id = ? AND outcome = 'no-show'`,
          )
          .bind(eventId, id),
      );
    }

    // Mark attendance as recorded on the event.
    statements.push(
      this.db
        .prepare(
          `UPDATE poc_events_event
           SET attendance_recorded = 1, updated_at = datetime('now')
           WHERE id = ?`,
        )
        .bind(eventId),
    );

    await this.db.batch(statements);

    // Find the most recent open event of the same kind to apply auto-bans.
    const openEvent = await this.db
      .prepare(
        `SELECT id FROM poc_events_event
         WHERE kind = ? AND status = 'open' AND id != ?
         ORDER BY week_start DESC, id DESC LIMIT 1`,
      )
      .bind(event.kind, eventId)
      .first<{ id: number }>();

    let bannedInEventId: number | null = null;
    let bannedCount = 0;

    if (openEvent) {
      const banStatements: D1PreparedStatement[] = [];
      for (const id of noShowMainIds) {
        // Ban no-show mains who are already registered as IN in the open event.
        banStatements.push(
          this.db
            .prepare(
              `UPDATE poc_events_registration
               SET is_banned = 1, updated_at = datetime('now')
               WHERE event_id = ? AND member_id = ? AND status = 'IN'`,
            )
            .bind(openEvent.id, id),
        );
      }
      for (const id of presentMainIds) {
        // Unban present mains (undo a previously applied auto-ban).
        banStatements.push(
          this.db
            .prepare(
              `UPDATE poc_events_registration
               SET is_banned = 0, updated_at = datetime('now')
               WHERE event_id = ? AND member_id = ? AND status = 'IN'`,
            )
            .bind(openEvent.id, id),
        );
      }
      const results = await this.db.batch(banStatements);
      // Count how many no-show bans were actually applied (rows with changes).
      const banResults = results.slice(0, noShowMainIds.length);
      bannedCount = banResults.reduce((sum, r) => sum + (r.meta?.changes ?? 0), 0);
      if (noShowMainIds.length > 0) bannedInEventId = openEvent.id;
    }

    return { noShowIds, bannedInEventId, bannedCount };
  }

  // If the member had a main no-show in the immediately preceding locked event of the same
  // kind, automatically set is_banned = 1 on their registration.
  // "Immediately preceding" = the most recent locked event by week_start, unconditionally —
  // if the player has no record there the ban window has passed (applicable only once, only
  // for the next event after the no-show).
  // Called after upsertRegistration when status = 'IN' on an open event.
  // Returns true if a ban was applied.
  async checkAndApplyNoshowBan(eventId: number, memberId: number): Promise<boolean> {
    const event = await this.getEvent(eventId);
    if (!event || event.status !== 'open') return false;

    // Step 1: find the most recent locked event of the same kind (regardless of participation).
    const prevEvent = await this.db
      .prepare(
        `SELECT e.id FROM poc_events_event e
         WHERE e.kind = ? AND e.status = 'locked' AND e.id != ?
         ORDER BY e.week_start DESC, e.id DESC LIMIT 1`,
      )
      .bind(event.kind, eventId)
      .first<{ id: number }>();

    if (!prevEvent) return false;

    // Step 2: check if the player had a no-show as a main in that specific event.
    // LEFT JOIN so benched players (no assignment row) are included; their role will be NULL.
    const lastRecord = await this.db
      .prepare(
        `SELECT p.outcome, a.role AS assignment_role
         FROM poc_events_participation_log p
         LEFT JOIN poc_events_assignment a ON a.event_id = p.event_id AND a.member_id = p.member_id
         WHERE p.event_id = ? AND p.member_id = ?`,
      )
      .bind(prevEvent.id, memberId)
      .first<{ outcome: string; assignment_role: string | null }>();

    if (lastRecord?.outcome === 'no-show' && lastRecord?.assignment_role === 'main') {
      const res = await this.db
        .prepare(
          `UPDATE poc_events_registration
           SET is_banned = 1, updated_at = datetime('now')
           WHERE event_id = ? AND member_id = ?`,
        )
        .bind(eventId, memberId)
        .run();
      return (res.meta?.changes ?? 0) > 0;
    }
    return false;
  }

  // ── Settings ──────────────────────────────────────────────────────────────
  // Persisted in the metadata table with a 'setting:' key prefix.

  /** Resolve a stored close value: the new hour-only server key wins; a legacy
   * UTC 'HH:MM' key is migrated one-way (instant-preserving); else default.
   * The key name disambiguates: a legacy key is always UTC, even when its value
   * happens to look hour-only (e.g. '12:00' UTC → '10:00' server). */
  private resolveCloseTime(
    stored: string | undefined,
    legacyStored: string | undefined,
    fallback: string,
  ): string {
    if (stored !== undefined) {
      return isValidCloseTime(stored) ? stored : fallback;
    }
    if (legacyStored !== undefined && LEGACY_CLOSE_TIME_RE.test(legacyStored)) {
      return migrateLegacyCloseTimeToServer(legacyStored);
    }
    return fallback;
  }

  async getEventsSettings(): Promise<EventsSettings> {
    const keys = [
      'setting:canyon_auto_open',
      'setting:canyon_a_time',
      'setting:canyon_b_time',
      'setting:desert_a_time',
      'setting:desert_b_time',
      'setting:canyon_close_hour',
      'setting:desert_close_hour',
      // Legacy keys (UTC 'HH:MM') from before the server-time switch — read for
      // one-way migration only, never written anymore.
      'setting:canyon_close_time',
      'setting:desert_close_time',
    ];
    const rows = await this.db
      .prepare(`SELECT key, value FROM metadata WHERE key IN (${keys.map(() => '?').join(',')})`)
      .bind(...keys)
      .all<{ key: string; value: string }>();
    const m = new Map(rows.results.map((r) => [r.key, r.value]));
    return {
      canyonAutoOpen: m.get('setting:canyon_auto_open') !== '0',
      canyonATime: m.get('setting:canyon_a_time') ?? '16:00',
      canyonBTime: m.get('setting:canyon_b_time') ?? '16:00',
      desertATime: m.get('setting:desert_a_time') ?? '22:00',
      desertBTime: m.get('setting:desert_b_time') ?? '13:00',
      canyonCloseTime: this.resolveCloseTime(
        m.get('setting:canyon_close_hour'),
        m.get('setting:canyon_close_time'),
        DEFAULT_CANYON_CLOSE_TIME,
      ),
      desertCloseTime: this.resolveCloseTime(
        m.get('setting:desert_close_hour'),
        m.get('setting:desert_close_time'),
        DEFAULT_DESERT_CLOSE_TIME,
      ),
    };
  }

  async saveEventsSettings(patch: Partial<EventsSettings>): Promise<void> {
    const pairs: [string, string][] = [];
    if (patch.canyonAutoOpen !== undefined)
      pairs.push(['setting:canyon_auto_open', patch.canyonAutoOpen ? '1' : '0']);
    if (patch.canyonATime !== undefined)
      pairs.push(['setting:canyon_a_time', patch.canyonATime]);
    if (patch.canyonBTime !== undefined)
      pairs.push(['setting:canyon_b_time', patch.canyonBTime]);
    if (patch.desertATime !== undefined)
      pairs.push(['setting:desert_a_time', patch.desertATime]);
    if (patch.desertBTime !== undefined)
      pairs.push(['setting:desert_b_time', patch.desertBTime]);
    if (patch.canyonCloseTime !== undefined) {
      if (!isValidCloseTime(patch.canyonCloseTime)) throw new Error('invalid canyonCloseTime');
      pairs.push(['setting:canyon_close_hour', patch.canyonCloseTime]);
    }
    if (patch.desertCloseTime !== undefined) {
      if (!isValidCloseTime(patch.desertCloseTime)) throw new Error('invalid desertCloseTime');
      pairs.push(['setting:desert_close_hour', patch.desertCloseTime]);
    }
    if (pairs.length === 0) return;
    const stmts = pairs.map(([k, v]) =>
      this.db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').bind(k, v),
    );
    // Drop legacy UTC keys once the server-time value is saved — migration is one-way.
    if (patch.canyonCloseTime !== undefined) {
      stmts.push(this.db.prepare("DELETE FROM metadata WHERE key = 'setting:canyon_close_time'"));
    }
    if (patch.desertCloseTime !== undefined) {
      stmts.push(this.db.prepare("DELETE FROM metadata WHERE key = 'setting:desert_close_time'"));
    }
    await this.db.batch(stmts);
  }

  /** List open events for a given kind (used by settings update). */
  async listOpenEventsByKind(kind: EventKind): Promise<EvEvent[]> {
    const rows = await this.db
      .prepare(
        `SELECT id, kind, week_start, team_a_starts_at, team_b_starts_at,
                registration_closes_at, status, notes, attendance_recorded, created_at, updated_at
         FROM poc_events_event WHERE kind = ? AND status = 'open'
         ORDER BY week_start DESC`,
      )
      .bind(kind)
      .all<EventRow>();
    return rows.results.map(mapEvent);
  }
}

// Resolve 'any' Canyon team preferences by balancing pool sizes at read time.
// Only affects IN+active+power>0 registrations with teamPreference === 'any'.
// Returns a new array — the DB value is never changed.
// Ties (equal counts) go to 'A'.
export function resolveAnyTeams(registrations: Registration[]): Registration[] {
  let countA = 0;
  let countB = 0;
  for (const r of registrations) {
    if (r.status !== 'IN' || !r.memberActive || r.squadPower <= 0) continue;
    if (r.teamPreference === 'A') countA++;
    else if (r.teamPreference === 'B') countB++;
  }
  return registrations.map((r) => {
    if (r.teamPreference !== 'any' || r.status !== 'IN' || !r.memberActive || r.squadPower <= 0) {
      return r;
    }
    const resolved: 'A' | 'B' = countA <= countB ? 'A' : 'B';
    if (resolved === 'A') countA++;
    else countB++;
    return { ...r, resolvedTeamPreference: resolved };
  });
}

// Resolve 'any' Desert time slots by balancing pool sizes.
// Processes registrations in registration order (by id/createdAt as returned
// by listRegistrations) so the assignment is deterministic and stable.
// Returns a new array with resolvedTimeSlot filled for eligible IN players.
// Non-Desert registrations, non-IN status, or explicit '13'/'22' slots are
// left with resolvedTimeSlot = null.
export function resolveAnySlots(registrations: Registration[]): Registration[] {
  let count13 = 0;
  let count22 = 0;
  // Count the explicitly chosen slots first so flex players fill the gap.
  for (const r of registrations) {
    if (r.status !== 'IN' || !r.memberActive || r.squadPower <= 0) continue;
    if (r.timeSlot === '13') count13++;
    else if (r.timeSlot === '22') count22++;
  }
  return registrations.map((r) => {
    if (r.timeSlot !== 'any' || r.status !== 'IN' || !r.memberActive || r.squadPower <= 0) {
      return r;
    }
    // Assign to the smaller pool; ties go to 22 (team A).
    const resolved: '13' | '22' = count13 < count22 ? '13' : '22';
    if (resolved === '13') count13++;
    else count22++;
    return { ...r, resolvedTimeSlot: resolved };
  });
}
