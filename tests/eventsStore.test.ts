import { describe, it, expect, beforeEach } from 'vitest';
import { DataStore } from '../src/storage';
import { EventsStore, computeRosterHash, computeRegistrationCloseTimestamp, isValidCloseTime, migrateLegacyCloseTimeToServer, serverWallFromGameSlot, resolveAnySlots, resolveAnyTeams, CANYON_CLOSE_DAY_OFFSET, DESERT_CLOSE_DAY_OFFSET, type Assignment, type Registration, type TimeSlot } from '../src/eventsStore';
import { createD1Mock } from './d1-mock';

async function addMemberId(data: DataStore, db: D1Database, name: string): Promise<number> {
  await data.addMember(name);
  const row = await db
    .prepare('SELECT id FROM members WHERE display_name = ?')
    .bind(name)
    .first<{ id: number }>();
  if (!row) throw new Error(`failed to look up member ${name}`);
  return row.id;
}

describe('EventsStore', () => {
  let db: D1Database;
  let data: DataStore;
  let store: EventsStore;

  beforeEach(() => {
    db = createD1Mock();
    data = new DataStore(db);
    store = new EventsStore(db);
  });

  describe('createEvent', () => {
    it('creates a Canyon event with default status open', async () => {
      const ev = await store.createEvent({ kind: 'canyon', weekStart: '2025-01-06' });
      expect(ev.id).toBeGreaterThan(0);
      expect(ev.kind).toBe('canyon');
      expect(ev.status).toBe('open');
    });

    it('is idempotent on (kind, week_start) — second call returns same id', async () => {
      const a = await store.createEvent({ kind: 'desert', weekStart: '2025-01-13' });
      const b = await store.createEvent({
        kind: 'desert',
        weekStart: '2025-01-13',
        notes: 'updated',
      });
      expect(b.id).toBe(a.id);
      expect(b.notes).toBe('updated');
    });

    it('rejects an invalid kind', async () => {
      await expect(
        // @ts-expect-error invalid kind on purpose
        store.createEvent({ kind: 'galaxy', weekStart: '2025-01-06' }),
      ).rejects.toThrow();
    });
  });

  describe('upsertRegistration', () => {
    it('rejects IN status with squad_power <= 0', async () => {
      const ev = await store.createEvent({ kind: 'canyon', weekStart: '2025-01-06' });
      const mid = await addMemberId(data, db, 'Alice');
      await expect(
        store.upsertRegistration(ev.id, mid, {
          status: 'IN',
          squadPower: 0,
          squadType: 'tanks',
        }),
      ).rejects.toThrow(/squadPower/);
    });

    it('is idempotent and updates fields on conflict', async () => {
      const ev = await store.createEvent({ kind: 'canyon', weekStart: '2025-01-06' });
      const mid = await addMemberId(data, db, 'Alice');
      const r1 = await store.upsertRegistration(ev.id, mid, {
        status: 'IN',
        squadPower: 100,
        squadType: 'tanks',
      });
      const r2 = await store.upsertRegistration(ev.id, mid, {
        status: 'MAYBE',
        squadPower: 200,
        squadType: 'air',
      });
      expect(r2.id).toBe(r1.id);
      expect(r2.status).toBe('MAYBE');
      expect(r2.squadPower).toBe(200);
      expect(r2.squadType).toBe('air');
      const list = await store.listRegistrations(ev.id);
      expect(list).toHaveLength(1);
    });

    it('joins member display_name into listRegistrations', async () => {
      const ev = await store.createEvent({ kind: 'canyon', weekStart: '2025-01-06' });
      const mid = await addMemberId(data, db, 'Bob');
      await store.upsertRegistration(ev.id, mid, {
        status: 'IN',
        squadPower: 50,
        squadType: 'tanks',
      });
      const list = await store.listRegistrations(ev.id);
      expect(list[0].memberName).toBe('Bob');
      expect(list[0].memberActive).toBe(true);
    });
  });

  describe('FK cascade', () => {
    it('deletes registrations + assignments + log when event is deleted', async () => {
      const ev = await store.createEvent({ kind: 'canyon', weekStart: '2025-01-06' });
      const mid = await addMemberId(data, db, 'Alice');
      await store.upsertRegistration(ev.id, mid, {
        status: 'IN',
        squadPower: 100,
        squadType: 'tanks',
      });
      await store.replaceAssignments(
        ev.id,
        [{ memberId: mid, team: 'A', role: 'main', slotIndex: 1 }],
        { isLocked: false },
      );
      await store.markNoShow(ev.id, mid);
      await db.prepare('DELETE FROM poc_events_event WHERE id = ?').bind(ev.id).run();
      expect((await store.listRegistrations(ev.id))).toHaveLength(0);
      expect((await store.listAssignments(ev.id))).toHaveLength(0);
      const logRows = await db
        .prepare('SELECT COUNT(*) as c FROM poc_events_participation_log WHERE event_id = ?')
        .bind(ev.id)
        .first<{ c: number }>();
      expect(logRows!.c).toBe(0);
    });
  });

  describe('replaceAssignments', () => {
    it('rejects duplicate memberId in same event', async () => {
      const ev = await store.createEvent({ kind: 'canyon', weekStart: '2025-01-06' });
      const mid = await addMemberId(data, db, 'Alice');
      await expect(
        store.replaceAssignments(
          ev.id,
          [
            { memberId: mid, team: 'A', role: 'main', slotIndex: 1 },
            { memberId: mid, team: 'B', role: 'main', slotIndex: 1 },
          ],
          { isLocked: false },
        ),
      ).rejects.toThrow(/duplicate memberId/);
    });

    it('rejects duplicate team/slot in same event', async () => {
      const ev = await store.createEvent({ kind: 'canyon', weekStart: '2025-01-06' });
      const m1 = await addMemberId(data, db, 'Alice');
      const m2 = await addMemberId(data, db, 'Bob');
      await expect(
        store.replaceAssignments(
          ev.id,
          [
            { memberId: m1, team: 'A', role: 'main', slotIndex: 1 },
            { memberId: m2, team: 'A', role: 'main', slotIndex: 1 },
          ],
          { isLocked: false },
        ),
      ).rejects.toThrow(/duplicate team\/slot/);
    });
  });

  describe('lockRoster', () => {
    it('writes participation log + locks assignments + sets event status', async () => {
      const ev = await store.createEvent({ kind: 'canyon', weekStart: '2025-01-06' });
      const m1 = await addMemberId(data, db, 'Played-Main');
      const m2 = await addMemberId(data, db, 'Played-Sub');
      const m3 = await addMemberId(data, db, 'Rejected');
      const m4 = await addMemberId(data, db, 'Opted-Out');
      await store.upsertRegistration(ev.id, m1, { status: 'IN', squadPower: 100, squadType: 'tanks' });
      await store.upsertRegistration(ev.id, m2, { status: 'IN', squadPower: 100, squadType: 'tanks' });
      await store.upsertRegistration(ev.id, m3, { status: 'IN', squadPower: 100, squadType: 'tanks' });
      await store.upsertRegistration(ev.id, m4, { status: 'OUT', squadPower: 1, squadType: 'tanks' });
      await store.replaceAssignments(
        ev.id,
        [
          { memberId: m1, team: 'A', role: 'main', slotIndex: 1 },
          { memberId: m2, team: 'A', role: 'sub', slotIndex: 21 },
        ],
        { isLocked: false },
      );
      const res = await store.lockRoster(ev.id);
      expect(res.logged).toBe(4);
      const refreshed = await store.getEvent(ev.id);
      expect(refreshed!.status).toBe('locked');
      const log = await db
        .prepare(
          'SELECT member_id, outcome FROM poc_events_participation_log WHERE event_id = ? ORDER BY member_id ASC',
        )
        .bind(ev.id)
        .all<{ member_id: number; outcome: string }>();
      const byMember = new Map(log.results.map((r) => [r.member_id, r.outcome]));
      expect(byMember.get(m1)).toBe('played-main');
      expect(byMember.get(m2)).toBe('played-sub');
      expect(byMember.get(m3)).toBe('rejected');
      expect(byMember.get(m4)).toBe('opted-out');
      const assigns = await store.listAssignments(ev.id);
      expect(assigns.every((a) => a.isLocked)).toBe(true);
    });

    it('banned IN player gets outcome "banned" instead of rejected/played', async () => {
      const ev = await store.createEvent({ kind: 'desert', weekStart: '2025-01-06' });
      const mBanned = await addMemberId(data, db, 'Banned');
      const mNormal = await addMemberId(data, db, 'Normal');
      await store.upsertRegistration(ev.id, mBanned, { status: 'IN', squadPower: 100, squadType: 'tanks' });
      await store.upsertRegistration(ev.id, mNormal, { status: 'IN', squadPower: 100, squadType: 'tanks' });
      await store.setBan(ev.id, mBanned, true);
      // Normal player assigned, banned player not
      await store.replaceAssignments(ev.id, [
        { memberId: mNormal, team: 'A', role: 'main', slotIndex: 1 },
      ], { isLocked: false });
      await store.lockRoster(ev.id);
      const log = await db
        .prepare('SELECT member_id, outcome FROM poc_events_participation_log WHERE event_id = ? ORDER BY member_id ASC')
        .bind(ev.id)
        .all<{ member_id: number; outcome: string }>();
      const byMember = new Map(log.results.map((r) => [r.member_id, r.outcome]));
      expect(byMember.get(mBanned)).toBe('banned');
      expect(byMember.get(mNormal)).toBe('played-main');
    });
  });

  describe('setBan', () => {
    it('sets and unsets isBanned on a registration', async () => {
      const ev = await store.createEvent({ kind: 'desert', weekStart: '2025-02-03' });
      const mid = await addMemberId(data, db, 'Target');
      await store.upsertRegistration(ev.id, mid, { status: 'IN', squadPower: 200, squadType: 'air' });
      let regs = await store.listRegistrations(ev.id);
      expect(regs[0].isBanned).toBe(false);
      await store.setBan(ev.id, mid, true);
      regs = await store.listRegistrations(ev.id);
      expect(regs[0].isBanned).toBe(true);
      await store.setBan(ev.id, mid, false);
      regs = await store.listRegistrations(ev.id);
      expect(regs[0].isBanned).toBe(false);
    });
  });

  describe('setPenalized', () => {
    it('sets and unsets isPenalized on a registration', async () => {
      const ev = await store.createEvent({ kind: 'desert', weekStart: '2025-02-10' });
      const mid = await addMemberId(data, db, 'PenaltyTarget');
      await store.upsertRegistration(ev.id, mid, { status: 'IN', squadPower: 300, squadType: 'air' });
      let regs = await store.listRegistrations(ev.id);
      expect(regs[0].isPenalized).toBe(false);
      await store.setPenalized(ev.id, mid, true);
      regs = await store.listRegistrations(ev.id);
      expect(regs[0].isPenalized).toBe(true);
      await store.setPenalized(ev.id, mid, false);
      regs = await store.listRegistrations(ev.id);
      expect(regs[0].isPenalized).toBe(false);
    });
  });

  describe('computePriorities — ban', () => {
    it('banned outcome counts as participated (priority does not improve)', async () => {
      const evPast = await store.createEvent({ kind: 'desert', weekStart: '2025-01-06' });
      const evNow  = await store.createEvent({ kind: 'desert', weekStart: '2025-01-13' });
      const mid = await addMemberId(data, db, 'BannedPlayer');
      // Seed 4 stronger players in the same pool (timeSlot '22') so BannedPlayer is NOT top-4
      for (let i = 0; i < 4; i++) {
        const sid = await addMemberId(data, db, `BanStrong${i}`);
        await store.upsertRegistration(evNow.id, sid, {
          status: 'IN', squadPower: 99999 - i, squadType: 'tanks', timeSlot: '22',
        });
      }
      await store.upsertRegistration(evNow.id, mid, { status: 'IN', squadPower: 100, squadType: 'tanks', timeSlot: '22' });
      // Past event: 'banned' outcome
      await db.prepare(`INSERT INTO poc_events_participation_log (event_id, member_id, outcome) VALUES (?, ?, 'banned')`).bind(evPast.id, mid).run();
      await db.prepare(`UPDATE poc_events_event SET status = 'locked' WHERE id = ?`).bind(evPast.id).run();
      const priorities = await store.computePriorities(evNow.id);
      const cp = priorities.get(mid)!;
      expect(cp).toBeDefined();
      // participated=1, registered=1 → 1 - 1/1 = 0.0  (ban counts as played, so priority is lowest)
      expect(cp.participated).toBe(1);
      expect(cp.registered).toBe(1);
      expect(cp.priority).toBe(0.0);
    });
  });

  describe('computePriorities — penalized', () => {
    it('penalized registration multiplies base priority by 0.8', async () => {
      const evPast1 = await store.createEvent({ kind: 'desert', weekStart: '2025-01-06' });
      const evPast2 = await store.createEvent({ kind: 'desert', weekStart: '2025-01-01' });
      const evNow   = await store.createEvent({ kind: 'desert', weekStart: '2025-01-13' });
      const mid = await addMemberId(data, db, 'PenalizedPlayer');
      // Seed 4 stronger players so PenalizedPlayer is NOT top-4
      for (let i = 0; i < 4; i++) {
        const sid = await addMemberId(data, db, `PenStrong${i}`);
        await store.upsertRegistration(evNow.id, sid, {
          status: 'IN', squadPower: 99999 - i, squadType: 'tanks', timeSlot: '22',
        });
      }
      await store.upsertRegistration(evNow.id, mid, { status: 'IN', squadPower: 100, squadType: 'tanks', timeSlot: '22' });
      await store.setPenalized(evNow.id, mid, true);
      // Two locked past events: played-main once, rejected once → registered=2, participated=1 → base=0.50
      await db.prepare(`UPDATE poc_events_event SET status = 'locked' WHERE id IN (?, ?)`).bind(evPast1.id, evPast2.id).run();
      await db.prepare(`INSERT INTO poc_events_participation_log (event_id, member_id, outcome) VALUES (?, ?, 'played-main')`).bind(evPast1.id, mid).run();
      await db.prepare(`INSERT INTO poc_events_participation_log (event_id, member_id, outcome) VALUES (?, ?, 'rejected')`).bind(evPast2.id, mid).run();
      const priorities = await store.computePriorities(evNow.id);
      const cp = priorities.get(mid)!;
      expect(cp).toBeDefined();
      // base = 1 - 1/2 = 0.50; penalty × 0.8 → 0.40
      expect(cp.participated).toBe(1);
      expect(cp.registered).toBe(2);
      expect(cp.priority).toBe(0.40);
    });

    it('penalized with no history: base=1.0 × 0.8 = 0.80', async () => {
      const evNow = await store.createEvent({ kind: 'desert', weekStart: '2025-01-13' });
      const mid = await addMemberId(data, db, 'PenNoHistory');
      // Seed 4 stronger players
      for (let i = 0; i < 4; i++) {
        const sid = await addMemberId(data, db, `PenH${i}`);
        await store.upsertRegistration(evNow.id, sid, {
          status: 'IN', squadPower: 99999 - i, squadType: 'tanks', timeSlot: '22',
        });
      }
      await store.upsertRegistration(evNow.id, mid, { status: 'IN', squadPower: 100, squadType: 'tanks', timeSlot: '22' });
      await store.setPenalized(evNow.id, mid, true);
      const priorities = await store.computePriorities(evNow.id);
      const cp = priorities.get(mid)!;
      // no history → base = 1.0; penalty × 0.8 → 0.80
      expect(cp.participated).toBe(0);
      expect(cp.registered).toBe(0);
      expect(cp.priority).toBe(0.80);
    });
  });

  describe('computePriorities', () => {
    // Helper: register N dummy members with higher power into the same team/pool
    // so that the test subject is pushed out of top-6.
    async function seedStrongerPlayers(
      eventId: number,
      team: 'A' | 'B',
      count: number,
    ): Promise<void> {
      for (let i = 0; i < count; i++) {
        const sid = await addMemberId(data, db, `Strong${i}`);
        await store.upsertRegistration(eventId, sid, {
          status: 'IN',
          squadPower: 99999 - i,
          squadType: 'tanks',
          teamPreference: team,
        });
      }
    }

    it('only counts locked events before the current event week_start', async () => {
      // Three events in chronological order: week1 (locked), week2 (the event we
      // are computing priorities for), week3 (locked — must NOT influence week2's priorities).
      const evWeek1 = await store.createEvent({ kind: 'canyon', weekStart: '2025-01-06' });
      const evWeek2 = await store.createEvent({ kind: 'canyon', weekStart: '2025-01-13' });
      const evWeek3 = await store.createEvent({ kind: 'canyon', weekStart: '2025-01-20' });
      const mid = await addMemberId(data, db, 'Alice');

      // Register Alice in week2 with 6 stronger players so she is NOT top-6.
      await seedStrongerPlayers(evWeek2.id, 'A', 6);
      await store.upsertRegistration(evWeek2.id, mid, { status: 'IN', squadPower: 100, squadType: 'tanks', teamPreference: 'A' });

      // Lock week1: Alice was rejected.
      await db.prepare(`INSERT INTO poc_events_participation_log (event_id, member_id, outcome) VALUES (?, ?, 'rejected')`).bind(evWeek1.id, mid).run();
      await db.prepare(`UPDATE poc_events_event SET status = 'locked' WHERE id = ?`).bind(evWeek1.id).run();

      // Lock week3: Alice played-main (FUTURE event relative to week2 — must be ignored).
      await db.prepare(`INSERT INTO poc_events_participation_log (event_id, member_id, outcome) VALUES (?, ?, 'played-main')`).bind(evWeek3.id, mid).run();
      await db.prepare(`UPDATE poc_events_event SET status = 'locked' WHERE id = ?`).bind(evWeek3.id).run();

      // Only week1 (rejected) should be visible: participated=0, registered=1 → 1.0.
      // If week3 were included: registered=2, participated=1 → 0.5.
      const priorities = await store.computePriorities(evWeek2.id);
      const cp = priorities.get(mid);
      expect(cp).toBeDefined();
      expect(cp!.isTop4).toBe(false);
      expect(cp!.participated).toBe(0);
      expect(cp!.registered).toBe(1);
      expect(cp!.priority).toBe(1.0); // 1 - 0/1 = 1.0
    });

    it('returns 1.0 for players with no history', async () => {
      const ev = await store.createEvent({ kind: 'canyon', weekStart: '2025-01-06' });
      const mid = await addMemberId(data, db, 'Bob');
      await seedStrongerPlayers(ev.id, 'A', 6);
      await store.upsertRegistration(ev.id, mid, { status: 'IN', squadPower: 100, squadType: 'tanks', teamPreference: 'A' });
      const priorities = await store.computePriorities(ev.id);
      const cp = priorities.get(mid)!;
      expect(cp.isTop4).toBe(false);
      expect(cp.priority).toBe(1.0);
    });

    it('computes fractional priority from history', async () => {
      const evPast1 = await store.createEvent({ kind: 'canyon', weekStart: '2025-01-06' });
      const evPast2 = await store.createEvent({ kind: 'canyon', weekStart: '2024-12-30' });
      const evPast3 = await store.createEvent({ kind: 'canyon', weekStart: '2024-12-23' });
      const evNow  = await store.createEvent({ kind: 'canyon', weekStart: '2025-01-13' });
      const mid = await addMemberId(data, db, 'Carol');
      await seedStrongerPlayers(evNow.id, 'A', 6);
      await store.upsertRegistration(evNow.id, mid, { status: 'IN', squadPower: 100, squadType: 'tanks', teamPreference: 'A' });
      // 2 played-main + 1 rejected = participated=2, registered=3 → 1 - 2/3 = 0.33
      // Each in a separate past event (one outcome per event per member enforced by UNIQUE index).
      for (const [evId, outcome] of [[evPast1.id, 'played-main'], [evPast2.id, 'played-main'], [evPast3.id, 'rejected']] as const) {
        await db.prepare(`INSERT INTO poc_events_participation_log (event_id, member_id, outcome) VALUES (?, ?, ?)`).bind(evId, mid, outcome).run();
        await db.prepare(`UPDATE poc_events_event SET status = 'locked' WHERE id = ?`).bind(evId).run();
      }
      const priorities = await store.computePriorities(evNow.id);
      const cp = priorities.get(mid)!;
      expect(cp.isTop4).toBe(false);
      expect(cp.participated).toBe(2);
      expect(cp.registered).toBe(3);
      expect(cp.priority).toBe(0.33);
    });
  });

  describe('resetAll', () => {
    it('clears every poc_events_* table without touching members', async () => {
      const ev = await store.createEvent({ kind: 'canyon', weekStart: '2025-01-06' });
      const mid = await addMemberId(data, db, 'Alice');
      await store.upsertRegistration(ev.id, mid, {
        status: 'IN',
        squadPower: 100,
        squadType: 'tanks',
      });
      await store.replaceAssignments(
        ev.id,
        [{ memberId: mid, team: 'A', role: 'main', slotIndex: 1 }],
        { isLocked: false },
      );
      await store.markNoShow(ev.id, mid);
      await store.resetAll();
      expect(await store.listEvents()).toEqual([]);
      const mem = await db.prepare('SELECT COUNT(*) c FROM members').first<{ c: number }>();
      expect(mem!.c).toBe(1);
    });
  });

  describe('lockRoster — empty assignments guard', () => {
    it('throws when no assignments have been saved', async () => {
      const ev = await store.createEvent({ kind: 'canyon', weekStart: '2025-02-03' });
      const mid = await addMemberId(data, db, 'LockEmpty');
      await store.upsertRegistration(ev.id, mid, { status: 'IN', squadPower: 100, squadType: 'tanks' });
      await expect(store.lockRoster(ev.id)).rejects.toThrow('cannot lock: no assignments saved');
    });
  });

  describe('markNoShow — upsert on locked event', () => {
    it('updates outcome to no-show on a locked event without crashing', async () => {
      const ev = await store.createEvent({ kind: 'canyon', weekStart: '2025-02-10' });
      const mid = await addMemberId(data, db, 'NoShowPlayer');
      await store.upsertRegistration(ev.id, mid, { status: 'IN', squadPower: 100, squadType: 'tanks' });
      await store.replaceAssignments(ev.id, [{ memberId: mid, team: 'A', role: 'main', slotIndex: 1 }], { isLocked: false });
      await store.lockRoster(ev.id);
      // Locked: participation log has 'played-main'. markNoShow should update it to 'no-show'.
      await expect(store.markNoShow(ev.id, mid, 'absent')).resolves.not.toThrow();
      const row = await db
        .prepare('SELECT outcome, comment FROM poc_events_participation_log WHERE event_id = ? AND member_id = ?')
        .bind(ev.id, mid)
        .first<{ outcome: string; comment: string | null }>();
      expect(row!.outcome).toBe('no-show');
      expect(row!.comment).toBe('absent');
    });

    it('calling markNoShow twice updates in place (only one row per member)', async () => {
      const ev = await store.createEvent({ kind: 'canyon', weekStart: '2025-02-17' });
      const mid = await addMemberId(data, db, 'DoubleNoShow');
      await store.upsertRegistration(ev.id, mid, { status: 'IN', squadPower: 100, squadType: 'tanks' });
      await store.replaceAssignments(ev.id, [{ memberId: mid, team: 'A', role: 'main', slotIndex: 1 }], { isLocked: false });
      await store.lockRoster(ev.id);
      await store.markNoShow(ev.id, mid, 'first');
      await store.markNoShow(ev.id, mid, 'second');
      const rows = await db
        .prepare('SELECT COUNT(*) c FROM poc_events_participation_log WHERE event_id = ? AND member_id = ?')
        .bind(ev.id, mid)
        .first<{ c: number }>();
      expect(rows!.c).toBe(1);
    });
  });

  describe('computePriorities — banned player excluded from top-4', () => {
    it('banned player does not occupy a top-4 slot', async () => {
      const evNow = await store.createEvent({ kind: 'desert', weekStart: '2025-03-03' });
      // 3 strong players + 1 banned high-power + 1 fifth player, all in pool A (slot 22)
      for (let i = 0; i < 3; i++) {
        const sid = await addMemberId(data, db, `BanTop${i}`);
        await store.upsertRegistration(evNow.id, sid, {
          status: 'IN', squadPower: 99999 - i, squadType: 'tanks', timeSlot: '22',
        });
      }
      const mBanned = await addMemberId(data, db, 'BannedTop');
      await store.upsertRegistration(evNow.id, mBanned, {
        status: 'IN', squadPower: 5000, squadType: 'tanks', timeSlot: '22',
      });
      await store.setBan(evNow.id, mBanned, true);
      const m5th = await addMemberId(data, db, 'FifthPlayer');
      await store.upsertRegistration(evNow.id, m5th, {
        status: 'IN', squadPower: 100, squadType: 'tanks', timeSlot: '22',
      });
      const priorities = await store.computePriorities(evNow.id);
      // Banned player should be excluded entirely
      expect(priorities.get(mBanned)).toBeUndefined();
      // FifthPlayer fills the 4th slot (banned is excluded), so isTop4 = true
      const cp5th = priorities.get(m5th)!;
      expect(cp5th).toBeDefined();
      expect(cp5th.isTop4).toBe(true);
      expect(cp5th.priority).toBe(1.0);
    });
  });

  // ---------------------------------------------------------------------------
  // getPreviousSquadPowers
  // ---------------------------------------------------------------------------
  describe('getPreviousSquadPowers', () => {
    it('returns empty map when there are no prior events of the same kind', async () => {
      const ev = await store.createEvent({ kind: 'canyon', weekStart: '2025-01-06' });
      const mid = await addMemberId(data, db, 'Alice');
      await store.upsertRegistration(ev.id, mid, { status: 'IN', squadPower: 40_000_000, squadType: 'tanks' });
      const prev = await store.getPreviousSquadPowers(ev.id);
      expect(prev.size).toBe(0);
    });

    it('returns the most recent prior power for a member who registered in an earlier event', async () => {
      const ev1 = await store.createEvent({ kind: 'desert', weekStart: '2025-01-06' });
      const ev2 = await store.createEvent({ kind: 'desert', weekStart: '2025-01-13' });
      const mid = await addMemberId(data, db, 'Bob');
      await store.upsertRegistration(ev1.id, mid, { status: 'IN', squadPower: 40_000_000, squadType: 'tanks' });
      await store.upsertRegistration(ev2.id, mid, { status: 'IN', squadPower: 43_000_000, squadType: 'tanks' });
      const prev = await store.getPreviousSquadPowers(ev2.id);
      expect(prev.get(mid)).toBe(40_000_000);
    });

    it('picks the most recent prior event when a member has multiple prior registrations', async () => {
      const ev1 = await store.createEvent({ kind: 'canyon', weekStart: '2025-01-06' });
      const ev2 = await store.createEvent({ kind: 'canyon', weekStart: '2025-01-13' });
      const ev3 = await store.createEvent({ kind: 'canyon', weekStart: '2025-01-20' });
      const mid = await addMemberId(data, db, 'Carol');
      await store.upsertRegistration(ev1.id, mid, { status: 'IN', squadPower: 38_000_000, squadType: 'tanks' });
      await store.upsertRegistration(ev2.id, mid, { status: 'IN', squadPower: 41_000_000, squadType: 'tanks' });
      await store.upsertRegistration(ev3.id, mid, { status: 'IN', squadPower: 44_000_000, squadType: 'tanks' });
      // ev3 should see ev2 (41M) as most recent prior, not ev1 (38M)
      const prev = await store.getPreviousSquadPowers(ev3.id);
      expect(prev.get(mid)).toBe(41_000_000);
    });

    it('does not cross event kinds — desert prior does not appear for canyon current', async () => {
      const desertEv = await store.createEvent({ kind: 'desert', weekStart: '2025-01-06' });
      const canyonEv = await store.createEvent({ kind: 'canyon', weekStart: '2025-01-13' });
      const mid = await addMemberId(data, db, 'Dave');
      await store.upsertRegistration(desertEv.id, mid, { status: 'IN', squadPower: 40_000_000, squadType: 'tanks' });
      await store.upsertRegistration(canyonEv.id, mid, { status: 'IN', squadPower: 45_000_000, squadType: 'tanks' });
      const prev = await store.getPreviousSquadPowers(canyonEv.id);
      expect(prev.get(mid)).toBeUndefined();
    });

    it('member absent from current event is not included in result', async () => {
      const ev1 = await store.createEvent({ kind: 'canyon', weekStart: '2025-01-06' });
      const ev2 = await store.createEvent({ kind: 'canyon', weekStart: '2025-01-13' });
      const midA = await addMemberId(data, db, 'Eve');
      const midB = await addMemberId(data, db, 'Frank');
      await store.upsertRegistration(ev1.id, midA, { status: 'IN', squadPower: 40_000_000, squadType: 'tanks' });
      await store.upsertRegistration(ev1.id, midB, { status: 'IN', squadPower: 35_000_000, squadType: 'tanks' });
      // Only Eve registers for ev2
      await store.upsertRegistration(ev2.id, midA, { status: 'IN', squadPower: 42_000_000, squadType: 'tanks' });
      const prev = await store.getPreviousSquadPowers(ev2.id);
      expect(prev.get(midA)).toBe(40_000_000);
      // Frank is in ev1 but not ev2, so he should not appear
      expect(prev.get(midB)).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// resolveAnySlots — pure function tests (no DB)
// ---------------------------------------------------------------------------
function mkReg(id: number, slot: TimeSlot | null, active = true, status: Registration['status'] = 'IN', power = 100): Registration {
  return {
    id, eventId: 1, memberId: id, memberName: `P${id}`,
    memberActive: active, status, teamPreference: 'any',
    resolvedTeamPreference: null,
    timeSlot: slot, resolvedTimeSlot: null,
    squadPower: power, squadType: 'tanks', source: 'web',
    priority: null, isBanned: false, isPenalized: false, notes: null,
    createdAt: '2025-01-01', updatedAt: '2025-01-01',
  };
}

describe('resolveAnySlots', () => {
  it('leaves explicit 13/22 slots unchanged and resolvedTimeSlot null', () => {
    const regs = [mkReg(1, '22'), mkReg(2, '13')];
    const result = resolveAnySlots(regs);
    expect(result[0].timeSlot).toBe('22');
    expect(result[0].resolvedTimeSlot).toBeNull();
    expect(result[1].timeSlot).toBe('13');
    expect(result[1].resolvedTimeSlot).toBeNull();
  });

  it('assigns any to the smaller pool (ties go to 22)', () => {
    const regs = [mkReg(1, 'any'), mkReg(2, 'any')];
    const result = resolveAnySlots(regs);
    // Both start at 0/0 — first gets 22 (tie), second gets 13
    expect(result[0].resolvedTimeSlot).toBe('22');
    expect(result[1].resolvedTimeSlot).toBe('13');
  });

  it('fills the smaller pool when explicit slots are unbalanced', () => {
    // Two explicit 22s, one explicit 13, then two 'any'
    const regs = [mkReg(1, '22'), mkReg(2, '22'), mkReg(3, '13'), mkReg(4, 'any'), mkReg(5, 'any')];
    const result = resolveAnySlots(regs);
    // After explicit: count22=2 count13=1 → first 'any' goes to 13 → now 2/2 → second 'any' goes to 22
    expect(result[3].resolvedTimeSlot).toBe('13');
    expect(result[4].resolvedTimeSlot).toBe('22');
  });

  it('does not resolve any for OUT/MAYBE or inactive or zero-power registrations', () => {
    const regs = [
      mkReg(1, 'any', true, 'OUT'),
      mkReg(2, 'any', false),
      mkReg(3, 'any', true, 'IN', 0),
    ];
    const result = resolveAnySlots(regs);
    for (const r of result) {
      expect(r.resolvedTimeSlot).toBeNull();
    }
  });

  it('does not mutate the input array', () => {
    const regs = [mkReg(1, 'any')];
    const result = resolveAnySlots(regs);
    expect(result[0]).not.toBe(regs[0]);
    expect(regs[0].resolvedTimeSlot).toBeNull();
  });
});

describe('resolveAnyTeams', () => {
  it('leaves explicit A/B preferences unchanged and resolvedTeamPreference null', () => {
    const regs = [mkReg(1, '22' as TimeSlot, true, 'IN', 100), mkReg(2, '13' as TimeSlot, true, 'IN', 100)];
    // Use mkReg with explicit teamPreferences by overriding manually
    const r1 = { ...regs[0], teamPreference: 'A' as const, timeSlot: null };
    const r2 = { ...regs[1], teamPreference: 'B' as const, timeSlot: null };
    const result = resolveAnyTeams([r1, r2]);
    expect(result[0].resolvedTeamPreference).toBeNull();
    expect(result[1].resolvedTeamPreference).toBeNull();
  });

  it('assigns any to the smaller team (ties go to A)', () => {
    const regs = [mkReg(1, null), mkReg(2, null)];
    const result = resolveAnyTeams(regs);
    expect(result[0].resolvedTeamPreference).toBe('A');
    expect(result[1].resolvedTeamPreference).toBe('B');
  });

  it('fills the smaller team when explicit preferences are unbalanced', () => {
    const r1 = { ...mkReg(1, null), teamPreference: 'A' as const };
    const r2 = { ...mkReg(2, null), teamPreference: 'A' as const };
    const r3 = { ...mkReg(3, null), teamPreference: 'B' as const };
    const r4 = mkReg(4, null); // any → should go to B (A=2, B=1)
    const r5 = mkReg(5, null); // any → should go to A (A=2, B=2)
    const result = resolveAnyTeams([r1, r2, r3, r4, r5]);
    expect(result[3].resolvedTeamPreference).toBe('B');
    expect(result[4].resolvedTeamPreference).toBe('A');
  });

  it('does not resolve any for OUT/MAYBE, inactive, or zero-power registrations', () => {
    const regs = [
      mkReg(1, null, true, 'OUT'),
      mkReg(2, null, false),
      mkReg(3, null, true, 'IN', 0),
    ];
    const result = resolveAnyTeams(regs);
    for (const r of result) {
      expect(r.resolvedTeamPreference).toBeNull();
    }
  });

  it('does not mutate the input array', () => {
    const regs = [mkReg(1, null)];
    const result = resolveAnyTeams(regs);
    expect(result[0]).not.toBe(regs[0]);
    expect(regs[0].resolvedTeamPreference).toBeNull();
  });
});

// ── mergeMembers + poc tables ──────────────────────────────────────────────
describe('mergeMembers — poc table absorption', () => {
  let db: D1Database;
  let data: DataStore;
  let store: EventsStore;

  beforeEach(() => {
    db = createD1Mock();
    data = new DataStore(db);
    store = new EventsStore(db);
  });

  it('does not throw UNIQUE constraint when both members have a participation_log row for the same event', async () => {
    // Regression: absorbPocRowsStatements previously did a plain UPDATE on
    // poc_events_participation_log which would fail with UNIQUE(event_id,member_id).
    const midA = await addMemberId(data, db, 'Michel');
    const midB = await addMemberId(data, db, 'Commandant');

    const ev = await store.createEvent({ kind: 'canyon', weekStart: '2025-01-06' });

    // Register both for the same event, lock it so participation_log rows exist.
    await store.upsertRegistration(ev.id, midA, { status: 'IN', squadPower: 100, squadType: 'tanks' });
    await store.upsertRegistration(ev.id, midB, { status: 'IN', squadPower: 200, squadType: 'air' });
    await store.replaceAssignments(ev.id, [
      { memberId: midA, team: 'A', role: 'main', slotIndex: 1 },
      { memberId: midB, team: 'A', role: 'main', slotIndex: 2 },
    ], { isLocked: false });
    await store.lockRoster(ev.id);

    // Verify both have participation_log entries for that event.
    const logBefore = await db
      .prepare('SELECT member_id FROM poc_events_participation_log WHERE event_id = ?')
      .bind(ev.id)
      .all<{ member_id: number }>();
    expect(logBefore.results.map(r => r.member_id).sort()).toEqual([midA, midB].sort());

    // Merge Commandant (duplicate) into Michel (target) — must not throw.
    await expect(data.mergeMembers('Michel', 'Commandant')).resolves.toBe(true);

    // After merge: only Michel's member_id remains in the log (target wins on conflict).
    const logAfter = await db
      .prepare('SELECT member_id FROM poc_events_participation_log WHERE event_id = ?')
      .bind(ev.id)
      .all<{ member_id: number }>();
    expect(logAfter.results.map(r => r.member_id)).toEqual([midA]);
  });

  it('pocSource=target: target registration wins when both are registered for same event', async () => {
    const midA = await addMemberId(data, db, 'Michel');
    const midB = await addMemberId(data, db, 'Commandant');

    const ev = await store.createEvent({ kind: 'canyon', weekStart: '2025-01-06' });
    await store.upsertRegistration(ev.id, midA, { status: 'IN', squadPower: 100, squadType: 'tanks' });
    await store.upsertRegistration(ev.id, midB, { status: 'IN', squadPower: 200, squadType: 'air' });

    await data.mergeMembers('Michel', 'Commandant', 'target');

    // Registration should now belong to Michel with his original squad_power=100.
    const reg = await db
      .prepare('SELECT member_id, squad_power FROM poc_events_registration WHERE event_id = ?')
      .bind(ev.id)
      .first<{ member_id: number; squad_power: number }>();
    expect(reg?.member_id).toBe(midA);
    expect(reg?.squad_power).toBe(100);
  });

  it('pocSource=duplicate: duplicate registration wins when both are registered for same event', async () => {
    const midA = await addMemberId(data, db, 'Michel');
    const midB = await addMemberId(data, db, 'Commandant');

    const ev = await store.createEvent({ kind: 'canyon', weekStart: '2025-01-06' });
    await store.upsertRegistration(ev.id, midA, { status: 'IN', squadPower: 100, squadType: 'tanks' });
    await store.upsertRegistration(ev.id, midB, { status: 'IN', squadPower: 200, squadType: 'air' });

    await data.mergeMembers('Michel', 'Commandant', 'duplicate');

    // Registration should now belong to Michel but carry Commandant's squad_power=200.
    const reg = await db
      .prepare('SELECT member_id, squad_power FROM poc_events_registration WHERE event_id = ?')
      .bind(ev.id)
      .first<{ member_id: number; squad_power: number }>();
    expect(reg?.member_id).toBe(midA);
    expect(reg?.squad_power).toBe(200);
  });

  it('pocSource=duplicate: moves non-conflicting registration from duplicate to target', async () => {
    const midA = await addMemberId(data, db, 'Michel');
    const midB = await addMemberId(data, db, 'Commandant');

    const ev1 = await store.createEvent({ kind: 'canyon', weekStart: '2025-01-06' });
    const ev2 = await store.createEvent({ kind: 'canyon', weekStart: '2025-01-13' });

    // Michel is only registered for ev1; Commandant only for ev2.
    await store.upsertRegistration(ev1.id, midA, { status: 'IN', squadPower: 100, squadType: 'tanks' });
    await store.upsertRegistration(ev2.id, midB, { status: 'IN', squadPower: 200, squadType: 'air' });

    await data.mergeMembers('Michel', 'Commandant', 'duplicate');

    const regs = await db
      .prepare('SELECT event_id, squad_power FROM poc_events_registration WHERE member_id = ? ORDER BY event_id')
      .bind(midA)
      .all<{ event_id: number; squad_power: number }>();
    expect(regs.results).toHaveLength(2);
    expect(regs.results[0]).toMatchObject({ event_id: ev1.id, squad_power: 100 });
    expect(regs.results[1]).toMatchObject({ event_id: ev2.id, squad_power: 200 });
  });
});

// ── substitutePlayer ───────────────────────────────────────────────────────
describe('EventsStore.substitutePlayer', () => {
  let db: D1Database;
  let data: DataStore;
  let store: EventsStore;

  beforeEach(() => {
    db = createD1Mock();
    data = new DataStore(db);
    store = new EventsStore(db);
  });

  async function setupLockedEvent() {
    const ev = await store.createEvent({ kind: 'desert', weekStart: '2025-01-13' });
    const mOut = await addMemberId(data, db, 'OutPlayer');
    const mIn = await addMemberId(data, db, 'InPlayer');
    await store.upsertRegistration(ev.id, mOut, { status: 'IN', squadPower: 100, squadType: 'tanks' });
    await store.upsertRegistration(ev.id, mIn, { status: 'IN', squadPower: 80, squadType: 'air' });
    await store.replaceAssignments(
      ev.id,
      [{ memberId: mOut, team: 'A', role: 'main', slotIndex: 3, strategyRole: 'assassin / silo' }],
      { isLocked: false },
    );
    await store.lockRoster(ev.id);
    return { ev, mOut, mIn };
  }

  it('removes outgoing assignment, deletes their participation_log (void), inserts incoming assignment and played-main outcome', async () => {
    const { ev, mOut, mIn } = await setupLockedEvent();

    const result = await store.substitutePlayer(ev.id, mOut, mIn);
    expect(result.team).toBe('A');
    expect(result.role).toBe('main');
    expect(result.slotIndex).toBe(3);
    expect(result.strategyRole).toBe('assassin / silo');

    // outgoing player's participation_log must be GONE (voided)
    const outLog = await db
      .prepare('SELECT * FROM poc_events_participation_log WHERE event_id = ? AND member_id = ?')
      .bind(ev.id, mOut)
      .first();
    expect(outLog).toBeNull();

    // outgoing player's assignment must be gone
    const outAssign = await db
      .prepare('SELECT * FROM poc_events_assignment WHERE event_id = ? AND member_id = ?')
      .bind(ev.id, mOut)
      .first();
    expect(outAssign).toBeNull();

    // incoming player's participation_log must be played-main
    const inLog = await db
      .prepare('SELECT outcome FROM poc_events_participation_log WHERE event_id = ? AND member_id = ?')
      .bind(ev.id, mIn)
      .first<{ outcome: string }>();
    expect(inLog!.outcome).toBe('played-main');

    // incoming player's assignment must be present with correct slot
    const inAssign = await db
      .prepare('SELECT team, role, slot_index, strategy_role, is_locked, member_name_snapshot FROM poc_events_assignment WHERE event_id = ? AND member_id = ?')
      .bind(ev.id, mIn)
      .first<{ team: string; role: string; slot_index: number; strategy_role: string | null; is_locked: number; member_name_snapshot: string | null }>();
    expect(inAssign).not.toBeNull();
    expect(inAssign!.team).toBe('A');
    expect(inAssign!.role).toBe('main');
    expect(inAssign!.slot_index).toBe(3);
    expect(inAssign!.strategy_role).toBe('assassin / silo');
    expect(inAssign!.is_locked).toBe(1);
    expect(inAssign!.member_name_snapshot).toBe('InPlayer');
  });

  it('outgoing player priority ratio is unaffected (they are absent from participation_log)', async () => {
    const { ev, mOut, mIn } = await setupLockedEvent();
    await store.substitutePlayer(ev.id, mOut, mIn);

    // No participation_log row for mOut in this event → they don't count in priority calc.
    const logCount = await db
      .prepare('SELECT COUNT(*) c FROM poc_events_participation_log WHERE event_id = ? AND member_id = ?')
      .bind(ev.id, mOut)
      .first<{ c: number }>();
    expect(logCount!.c).toBe(0);
  });

  it('sub slot: incoming player gets played-sub outcome', async () => {
    const ev = await store.createEvent({ kind: 'desert', weekStart: '2025-01-20' });
    const mOut = await addMemberId(data, db, 'SubOut');
    const mIn = await addMemberId(data, db, 'SubIn');
    await store.upsertRegistration(ev.id, mOut, { status: 'IN', squadPower: 60, squadType: 'tanks' });
    await store.upsertRegistration(ev.id, mIn, { status: 'IN', squadPower: 55, squadType: 'air' });
    await store.replaceAssignments(
      ev.id,
      [{ memberId: mOut, team: 'B', role: 'sub', slotIndex: 22 }],
      { isLocked: false },
    );
    await store.lockRoster(ev.id);

    await store.substitutePlayer(ev.id, mOut, mIn);

    const inLog = await db
      .prepare('SELECT outcome FROM poc_events_participation_log WHERE event_id = ? AND member_id = ?')
      .bind(ev.id, mIn)
      .first<{ outcome: string }>();
    expect(inLog!.outcome).toBe('played-sub');
  });

  it('throws when event is not locked', async () => {
    const ev = await store.createEvent({ kind: 'desert', weekStart: '2025-01-27' });
    const m1 = await addMemberId(data, db, 'P1');
    const m2 = await addMemberId(data, db, 'P2');
    await expect(store.substitutePlayer(ev.id, m1, m2)).rejects.toThrow('must be locked');
  });

  it('throws when outgoing player has no assignment', async () => {
    const ev = await store.createEvent({ kind: 'desert', weekStart: '2025-02-03' });
    const mOut = await addMemberId(data, db, 'NoAssign');
    const mIn = await addMemberId(data, db, 'InPlayer2');
    await store.upsertRegistration(ev.id, mOut, { status: 'IN', squadPower: 100, squadType: 'tanks' });
    await store.upsertRegistration(ev.id, mIn, { status: 'IN', squadPower: 80, squadType: 'air' });
    await store.replaceAssignments(ev.id, [], { isLocked: false });
    // Can't lock with 0 assignments, so manually set status and insert a dummy assignment for locking to succeed
    const mDummy = await addMemberId(data, db, 'Dummy');
    await store.upsertRegistration(ev.id, mDummy, { status: 'IN', squadPower: 200, squadType: 'tanks' });
    await store.replaceAssignments(ev.id, [{ memberId: mDummy, team: 'A', role: 'main', slotIndex: 1 }], { isLocked: false });
    await store.lockRoster(ev.id);
    await expect(store.substitutePlayer(ev.id, mOut, mIn)).rejects.toThrow('no assignment');
  });

  it('throws when incoming player is already assigned', async () => {
    const ev = await store.createEvent({ kind: 'desert', weekStart: '2025-02-10' });
    const m1 = await addMemberId(data, db, 'A1');
    const m2 = await addMemberId(data, db, 'A2');
    await store.upsertRegistration(ev.id, m1, { status: 'IN', squadPower: 100, squadType: 'tanks' });
    await store.upsertRegistration(ev.id, m2, { status: 'IN', squadPower: 90, squadType: 'air' });
    await store.replaceAssignments(
      ev.id,
      [
        { memberId: m1, team: 'A', role: 'main', slotIndex: 1 },
        { memberId: m2, team: 'A', role: 'main', slotIndex: 2 },
      ],
      { isLocked: false },
    );
    await store.lockRoster(ev.id);
    await expect(store.substitutePlayer(ev.id, m1, m2)).rejects.toThrow('already assigned');
  });

  it('upserts participation_log when incoming player already has a rejected outcome', async () => {
    // InPlayer was rejected (benched) in the same event. substitutePlayer should
    // update their outcome to played-main rather than insert a second row.
    const { ev, mOut, mIn } = await setupLockedEvent();
    // mIn already has 'rejected' from lockRoster (they were registered IN but not assigned)
    const preSub = await db
      .prepare('SELECT outcome FROM poc_events_participation_log WHERE event_id = ? AND member_id = ?')
      .bind(ev.id, mIn)
      .first<{ outcome: string }>();
    expect(preSub!.outcome).toBe('rejected');

    await store.substitutePlayer(ev.id, mOut, mIn);

    const postSub = await db
      .prepare('SELECT outcome FROM poc_events_participation_log WHERE event_id = ? AND member_id = ?')
      .bind(ev.id, mIn)
      .first<{ outcome: string }>();
    expect(postSub!.outcome).toBe('played-main');
    // Still only one row
    const rowCount = await db
      .prepare('SELECT COUNT(*) c FROM poc_events_participation_log WHERE event_id = ? AND member_id = ?')
      .bind(ev.id, mIn)
      .first<{ c: number }>();
    expect(rowCount!.c).toBe(1);
  });
});

describe('computeRosterHash', () => {
  function assignment(overrides: Partial<Assignment>): Assignment {
    return {
      id: 1,
      eventId: 1,
      memberId: 1,
      memberName: 'Alice',
      team: 'A',
      role: 'main',
      slotIndex: 1,
      strategyRole: null,
      isLocked: false,
      source: 'auto',
      ...overrides,
    };
  }

  it('is stable regardless of input order', () => {
    const a = [
      assignment({ memberId: 1, memberName: 'Alice' }),
      assignment({ id: 2, memberId: 2, memberName: 'Bob', team: 'B', slotIndex: 1 }),
    ];
    const b = [a[1], a[0]];
    expect(computeRosterHash(a)).toBe(computeRosterHash(b));
  });

  it('changes when team, role, name or strategy role changes', () => {
    const base = [assignment({ memberId: 1 })];
    const baseHash = computeRosterHash(base);
    expect(computeRosterHash([assignment({ memberId: 1, team: 'B' })])).not.toBe(baseHash);
    expect(computeRosterHash([assignment({ memberId: 1, role: 'sub' })])).not.toBe(baseHash);
    expect(computeRosterHash([assignment({ memberId: 1, memberName: 'Alicia' })])).not.toBe(baseHash);
    expect(computeRosterHash([assignment({ memberId: 1, strategyRole: 'silo' })])).not.toBe(baseHash);
    expect(computeRosterHash([assignment({ memberId: 1, slotIndex: 2 })])).not.toBe(baseHash);
  });

  it('ignores row ids and lock flags', () => {
    const a = [assignment({ id: 1, isLocked: false, source: 'auto' })];
    const b = [assignment({ id: 99, isLocked: true, source: 'admin' })];
    expect(computeRosterHash(a)).toBe(computeRosterHash(b));
  });

  it('round-trips through get/setRosterPostedHash', async () => {
    const db = createD1Mock();
    const store = new EventsStore(db);
    const ev = await store.createEvent({ kind: 'canyon', weekStart: '2026-06-01' });
    expect(await store.getRosterPostedHash(ev.id)).toBeNull();
    await store.setRosterPostedHash(ev.id, 'abc123');
    expect(await store.getRosterPostedHash(ev.id)).toBe('abc123');
  });
});

describe('registration close-time settings (server time, hour-only)', () => {
  it('isValidCloseTime accepts hour-only HH:00 and rejects minutes/garbage', () => {
    expect(isValidCloseTime('00:00')).toBe(true);
    expect(isValidCloseTime('12:00')).toBe(true);
    expect(isValidCloseTime('23:00')).toBe(true);
    expect(isValidCloseTime('08:00')).toBe(true);
    expect(isValidCloseTime('08:30')).toBe(false);
    expect(isValidCloseTime('23:59')).toBe(false);
    expect(isValidCloseTime('24:00')).toBe(false);
    expect(isValidCloseTime('12:0')).toBe(false);
    expect(isValidCloseTime('12')).toBe(false);
    expect(isValidCloseTime('')).toBe(false);
    expect(isValidCloseTime(null)).toBe(false);
    expect(isValidCloseTime(undefined)).toBe(false);
    expect(isValidCloseTime(1200)).toBe(false);
  });

  it('computeRegistrationCloseTimestamp counts day+hour in server time (UTC-2 → UTC +2h)', () => {
    // weekStart 2026-06-01 is a Monday. Server 12:00 = 14:00 UTC same day.
    expect(computeRegistrationCloseTimestamp('2026-06-01', CANYON_CLOSE_DAY_OFFSET, '12:00'))
      .toBe('2026-06-01T14:00:00.000Z');
    expect(computeRegistrationCloseTimestamp('2026-06-01', DESERT_CLOSE_DAY_OFFSET, '12:00'))
      .toBe('2026-06-03T14:00:00.000Z');
    expect(computeRegistrationCloseTimestamp('2026-06-01', CANYON_CLOSE_DAY_OFFSET, '20:00'))
      .toBe('2026-06-01T22:00:00.000Z');
    // Server 23:00 overflows into the next UTC day — the instant is what matters.
    expect(computeRegistrationCloseTimestamp('2026-06-01', CANYON_CLOSE_DAY_OFFSET, '23:00'))
      .toBe('2026-06-02T01:00:00.000Z');
    // Server midnight Monday = 02:00 UTC Monday (same calendar day, no ambiguity).
    expect(computeRegistrationCloseTimestamp('2026-06-01', CANYON_CLOSE_DAY_OFFSET, '00:00'))
      .toBe('2026-06-01T02:00:00.000Z');
  });

  it('serverWallFromGameSlot maps game slots (UTC+2) to server walls (UTC-2)', () => {
    expect(serverWallFromGameSlot('16:00')).toBe('12:00');
    expect(serverWallFromGameSlot('03:00')).toBe('23:00');
    expect(serverWallFromGameSlot('13:00')).toBe('09:00');
    expect(serverWallFromGameSlot('22:00')).toBe('18:00');
  });

  it('migrateLegacyCloseTimeToServer preserves the instant (UTC − 2h, truncated to hour)', () => {
    expect(migrateLegacyCloseTimeToServer('12:00')).toBe('10:00');
    expect(migrateLegacyCloseTimeToServer('00:00')).toBe('22:00');
    expect(migrateLegacyCloseTimeToServer('08:30')).toBe('06:00');
    expect(migrateLegacyCloseTimeToServer('02:15')).toBe('00:00');
  });

  it('getEventsSettings defaults close times to 12:00 server time', async () => {
    const db = createD1Mock();
    const store = new EventsStore(db);
    const s = await store.getEventsSettings();
    expect(s.canyonCloseTime).toBe('12:00');
    expect(s.desertCloseTime).toBe('12:00');
  });

  it('saveEventsSettings round-trips hour-only server close times', async () => {
    const db = createD1Mock();
    const store = new EventsStore(db);
    await store.saveEventsSettings({ canyonCloseTime: '20:00', desertCloseTime: '08:00' });
    const s = await store.getEventsSettings();
    expect(s.canyonCloseTime).toBe('20:00');
    expect(s.desertCloseTime).toBe('08:00');
  });

  it('saveEventsSettings rejects minute-granularity and garbage close times', async () => {
    const db = createD1Mock();
    const store = new EventsStore(db);
    await expect(store.saveEventsSettings({ canyonCloseTime: '24:00' })).rejects.toThrow();
    await expect(store.saveEventsSettings({ desertCloseTime: 'nope' })).rejects.toThrow();
    await expect(store.saveEventsSettings({ canyonCloseTime: '20:30' })).rejects.toThrow();
  });

  it('migrates legacy UTC close values to instant-preserving server hours', async () => {
    const db = createD1Mock();
    const store = new EventsStore(db);
    // Legacy keys from before the server-time switch (UTC 'HH:MM').
    await db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('setting:canyon_close_time', '12:00')").run();
    await db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('setting:desert_close_time', '08:30')").run();
    const s = await store.getEventsSettings();
    // 12:00 UTC = 10:00 server; 08:30 UTC → 06:00 server (truncated to hour).
    expect(s.canyonCloseTime).toBe('10:00');
    expect(s.desertCloseTime).toBe('06:00');
  });

  it('new server-time keys win over legacy UTC keys', async () => {
    const db = createD1Mock();
    const store = new EventsStore(db);
    await db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('setting:canyon_close_time', '12:00')").run();
    await store.saveEventsSettings({ canyonCloseTime: '20:00' });
    const s = await store.getEventsSettings();
    expect(s.canyonCloseTime).toBe('20:00');
  });

  it('saving removes the legacy UTC keys (one-way migration)', async () => {
    const db = createD1Mock();
    const store = new EventsStore(db);
    await db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('setting:canyon_close_time', '12:00')").run();
    await store.saveEventsSettings({ canyonCloseTime: '20:00' });
    const row = await db.prepare("SELECT value FROM metadata WHERE key = 'setting:canyon_close_time'").first<{ value: string }>();
    expect(row).toBeNull();
  });

  it('falls back to 12:00 when stored metadata is invalid', async () => {
    const db = createD1Mock();
    const store = new EventsStore(db);
    await db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('setting:canyon_close_hour', 'bogus')").run();
    await db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('setting:desert_close_hour', '99:99')").run();
    const s = await store.getEventsSettings();
    expect(s.canyonCloseTime).toBe('12:00');
    expect(s.desertCloseTime).toBe('12:00');
  });
});

