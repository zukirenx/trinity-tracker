import { describe, it, expect, beforeEach } from 'vitest';
import { DataStore } from '../src/storage';
import { EventsStore, type AssignmentInput } from '../src/eventsStore';
import { createD1Mock } from './d1-mock';

async function addMember(data: DataStore, db: D1Database, name: string): Promise<number> {
  await data.addMember(name);
  const row = await db
    .prepare('SELECT id FROM members WHERE display_name = ?')
    .bind(name)
    .first<{ id: number }>();
  if (!row) throw new Error(`failed to look up member ${name}`);
  return row.id;
}

/** Create a locked event with the given main-slot assignments and return the event id. */
async function createLockedEvent(
  store: EventsStore,
  data: DataStore,
  db: D1Database,
  kind: 'canyon' | 'desert',
  weekStart: string,
  mainNames: string[],
): Promise<{ eventId: number; memberIds: Map<string, number> }> {
  const ev = await store.createEvent({ kind, weekStart });
  const memberIds = new Map<string, number>();
  const assignments: AssignmentInput[] = [];
  for (let i = 0; i < mainNames.length; i++) {
    const mid = await addMember(data, db, mainNames[i]);
    memberIds.set(mainNames[i], mid);
    await store.upsertRegistration(ev.id, mid, {
      status: 'IN',
      squadPower: 1_000_000,
      squadType: 'tanks',
    });
    assignments.push({ memberId: mid, team: 'A', role: 'main', slotIndex: i + 1 });
  }
  await store.replaceAssignments(ev.id, assignments, { isLocked: false });
  await store.lockRoster(ev.id);
  return { eventId: ev.id, memberIds };
}

describe('attendance recording', () => {
  let db: D1Database;
  let data: DataStore;
  let store: EventsStore;

  beforeEach(() => {
    db = createD1Mock();
    data = new DataStore(db);
    store = new EventsStore(db);
  });

  it('throws if event is not locked', async () => {
    const ev = await store.createEvent({ kind: 'canyon', weekStart: '2025-06-02' });
    await expect(store.recordAttendance(ev.id, [])).rejects.toThrow('must be locked');
  });

  it('marks absent mains as no-show and present mains remain played-main', async () => {
    const { eventId, memberIds } = await createLockedEvent(
      store, data, db, 'canyon', '2025-06-02', ['Alice', 'Bob', 'Carol'],
    );
    const aliceId = memberIds.get('Alice')!;
    const bobId = memberIds.get('Bob')!;
    const carolId = memberIds.get('Carol')!;

    const result = await store.recordAttendance(eventId, [aliceId, carolId]);
    expect(result.noShowIds).toEqual([bobId]);

    const outcomes = await store.getParticipationOutcomes(eventId);
    expect(outcomes.get(aliceId)).toBe('played-main');
    expect(outcomes.get(bobId)).toBe('no-show');
    expect(outcomes.get(carolId)).toBe('played-main');
  });

  it('sets attendanceRecorded on the event', async () => {
    const { eventId, memberIds } = await createLockedEvent(
      store, data, db, 'canyon', '2025-06-02', ['Alice'],
    );
    const ev0 = await store.getEvent(eventId);
    expect(ev0!.attendanceRecorded).toBe(false);

    await store.recordAttendance(eventId, [memberIds.get('Alice')!]);
    const ev1 = await store.getEvent(eventId);
    expect(ev1!.attendanceRecorded).toBe(true);
  });

  it('re-running recordAttendance can restore a no-show to played-main', async () => {
    const { eventId, memberIds } = await createLockedEvent(
      store, data, db, 'canyon', '2025-06-02', ['Alice', 'Bob'],
    );
    const aliceId = memberIds.get('Alice')!;
    const bobId = memberIds.get('Bob')!;

    // First pass: Bob is absent.
    await store.recordAttendance(eventId, [aliceId]);
    expect((await store.getParticipationOutcomes(eventId)).get(bobId)).toBe('no-show');

    // Second pass: admin corrects — Bob was actually present.
    await store.recordAttendance(eventId, [aliceId, bobId]);
    expect((await store.getParticipationOutcomes(eventId)).get(bobId)).toBe('played-main');
  });

  it('tracks subs too — absent subs get no-show but are NOT banned', async () => {
    const ev = await store.createEvent({ kind: 'canyon', weekStart: '2025-06-02' });
    const aliceId = await addMember(data, db, 'Alice');
    const bobId = await addMember(data, db, 'Bob');
    await store.upsertRegistration(ev.id, aliceId, { status: 'IN', squadPower: 1_000_000, squadType: 'tanks' });
    await store.upsertRegistration(ev.id, bobId, { status: 'IN', squadPower: 900_000, squadType: 'tanks' });
    await store.replaceAssignments(ev.id, [
      { memberId: aliceId, team: 'A', role: 'main', slotIndex: 1 },
      { memberId: bobId, team: 'A', role: 'sub', slotIndex: 21 },
    ], { isLocked: false });
    await store.lockRoster(ev.id);

    // Create next event and register Bob.
    const nextEv = await store.createEvent({ kind: 'canyon', weekStart: '2025-06-09' });
    await store.upsertRegistration(nextEv.id, bobId, { status: 'IN', squadPower: 900_000, squadType: 'tanks' });

    // Alice (main) absent, Bob (sub) absent — present list is empty.
    const result = await store.recordAttendance(ev.id, []);

    // Both are in noShowIds.
    expect(result.noShowIds).toContain(aliceId);
    expect(result.noShowIds).toContain(bobId);

    const outcomes = await store.getParticipationOutcomes(ev.id);
    expect(outcomes.get(aliceId)).toBe('no-show');
    expect(outcomes.get(bobId)).toBe('no-show');

    // Bob is a sub — he must NOT be banned in the next event.
    const regs = await store.listRegistrations(nextEv.id);
    expect(regs.find(r => r.memberId === bobId)!.isBanned).toBe(false);

    // Alice (main) — she would be banned if registered in next event.
    // (Not registered here, so check via checkAndApplyNoshowBan.)
    await store.upsertRegistration(nextEv.id, aliceId, { status: 'IN', squadPower: 1_000_000, squadType: 'tanks' });
    const aliceBanned = await store.checkAndApplyNoshowBan(nextEv.id, aliceId);
    expect(aliceBanned).toBe(true);
  });

  it('auto-bans no-show mains in an already-open next event', async () => {
    const { eventId, memberIds } = await createLockedEvent(
      store, data, db, 'canyon', '2025-06-02', ['Alice', 'Bob'],
    );
    const aliceId = memberIds.get('Alice')!;
    const bobId = memberIds.get('Bob')!;

    // Create the next open event and register both players.
    const nextEv = await store.createEvent({ kind: 'canyon', weekStart: '2025-06-09' });
    await store.upsertRegistration(nextEv.id, aliceId, { status: 'IN', squadPower: 1_000_000, squadType: 'tanks' });
    await store.upsertRegistration(nextEv.id, bobId, { status: 'IN', squadPower: 900_000, squadType: 'tanks' });

    // Record attendance: Bob absent.
    const result = await store.recordAttendance(eventId, [aliceId]);
    expect(result.bannedInEventId).toBe(nextEv.id);
    expect(result.bannedCount).toBe(1);

    const regs = await store.listRegistrations(nextEv.id);
    const alice = regs.find((r) => r.memberId === aliceId)!;
    const bob = regs.find((r) => r.memberId === bobId)!;
    expect(alice.isBanned).toBe(false);
    expect(bob.isBanned).toBe(true);
  });

  it('does not ban if no-show player is not registered in the next event', async () => {
    const { eventId, memberIds } = await createLockedEvent(
      store, data, db, 'canyon', '2025-06-02', ['Alice', 'Bob'],
    );
    const aliceId = memberIds.get('Alice')!;
    const bobId = memberIds.get('Bob')!;

    // Next event exists but Bob is not registered.
    const nextEv = await store.createEvent({ kind: 'canyon', weekStart: '2025-06-09' });
    await store.upsertRegistration(nextEv.id, aliceId, { status: 'IN', squadPower: 1_000_000, squadType: 'tanks' });

    const result = await store.recordAttendance(eventId, [aliceId]);
    expect(result.noShowIds).toContain(bobId);
    expect(result.bannedCount).toBe(0); // Bob not registered, so 0 bans applied immediately.
    expect(result.bannedInEventId).toBe(nextEv.id); // event reference still returned
  });

  it('unbans a player in the next event when corrected to present', async () => {
    const { eventId, memberIds } = await createLockedEvent(
      store, data, db, 'canyon', '2025-06-02', ['Alice', 'Bob'],
    );
    const aliceId = memberIds.get('Alice')!;
    const bobId = memberIds.get('Bob')!;

    const nextEv = await store.createEvent({ kind: 'canyon', weekStart: '2025-06-09' });
    await store.upsertRegistration(nextEv.id, aliceId, { status: 'IN', squadPower: 1_000_000, squadType: 'tanks' });
    await store.upsertRegistration(nextEv.id, bobId, { status: 'IN', squadPower: 900_000, squadType: 'tanks' });

    // Mark Bob absent → he gets banned.
    await store.recordAttendance(eventId, [aliceId]);
    expect((await store.listRegistrations(nextEv.id)).find(r => r.memberId === bobId)!.isBanned).toBe(true);

    // Correct: Bob was actually present.
    await store.recordAttendance(eventId, [aliceId, bobId]);
    expect((await store.listRegistrations(nextEv.id)).find(r => r.memberId === bobId)!.isBanned).toBe(false);
  });
});

describe('checkAndApplyNoshowBan', () => {
  let db: D1Database;
  let data: DataStore;
  let store: EventsStore;

  beforeEach(() => {
    db = createD1Mock();
    data = new DataStore(db);
    store = new EventsStore(db);
  });

  it('applies ban when member had no-show in most recent locked event of same kind', async () => {
    const { eventId, memberIds } = await createLockedEvent(
      store, data, db, 'canyon', '2025-06-02', ['Alice'],
    );
    const aliceId = memberIds.get('Alice')!;

    // Record attendance: Alice was absent.
    await store.recordAttendance(eventId, []);

    // Alice registers for the next open event.
    const nextEv = await store.createEvent({ kind: 'canyon', weekStart: '2025-06-09' });
    await store.upsertRegistration(nextEv.id, aliceId, { status: 'IN', squadPower: 1_000_000, squadType: 'tanks' });

    const banned = await store.checkAndApplyNoshowBan(nextEv.id, aliceId);
    expect(banned).toBe(true);
    const regs = await store.listRegistrations(nextEv.id);
    expect(regs.find(r => r.memberId === aliceId)!.isBanned).toBe(true);
  });

  it('does not ban when last outcome was played-main', async () => {
    const { eventId, memberIds } = await createLockedEvent(
      store, data, db, 'canyon', '2025-06-02', ['Alice'],
    );
    const aliceId = memberIds.get('Alice')!;

    // Alice showed up (no attendance recording needed — default is played-main after lock).
    // No recordAttendance call, so outcome stays played-main.

    const nextEv = await store.createEvent({ kind: 'canyon', weekStart: '2025-06-09' });
    await store.upsertRegistration(nextEv.id, aliceId, { status: 'IN', squadPower: 1_000_000, squadType: 'tanks' });

    const banned = await store.checkAndApplyNoshowBan(nextEv.id, aliceId);
    expect(banned).toBe(false);
    const regs = await store.listRegistrations(nextEv.id);
    expect(regs.find(r => r.memberId === aliceId)!.isBanned).toBe(false);
  });

  it('does not ban for a different event kind', async () => {
    const { eventId, memberIds } = await createLockedEvent(
      store, data, db, 'canyon', '2025-06-02', ['Alice'],
    );
    const aliceId = memberIds.get('Alice')!;
    await store.recordAttendance(eventId, []); // Alice absent from canyon.

    // Alice registers for a desert event (different kind) — should not be banned.
    const desertEv = await store.createEvent({ kind: 'desert', weekStart: '2025-06-09' });
    await store.upsertRegistration(desertEv.id, aliceId, { status: 'IN', squadPower: 1_000_000, squadType: 'tanks' });

    const banned = await store.checkAndApplyNoshowBan(desertEv.id, aliceId);
    expect(banned).toBe(false);
  });

  it('does not ban when the no-show was as a sub (only main no-shows trigger ban)', async () => {
    // Set up: Bob is a sub in the previous event and was absent.
    const ev = await store.createEvent({ kind: 'canyon', weekStart: '2025-06-02' });
    const aliceId = await addMember(data, db, 'Alice');
    const bobId = await addMember(data, db, 'Bob');
    await store.upsertRegistration(ev.id, aliceId, { status: 'IN', squadPower: 1_000_000, squadType: 'tanks' });
    await store.upsertRegistration(ev.id, bobId, { status: 'IN', squadPower: 900_000, squadType: 'tanks' });
    await store.replaceAssignments(ev.id, [
      { memberId: aliceId, team: 'A', role: 'main', slotIndex: 1 },
      { memberId: bobId, team: 'A', role: 'sub', slotIndex: 21 },
    ], { isLocked: false });
    await store.lockRoster(ev.id);
    // Mark both absent (Bob is a sub).
    await store.recordAttendance(ev.id, []);
    expect((await store.getParticipationOutcomes(ev.id)).get(bobId)).toBe('no-show');

    // Bob registers for the next event — should NOT be banned (he was a sub, not a main).
    const nextEv = await store.createEvent({ kind: 'canyon', weekStart: '2025-06-09' });
    await store.upsertRegistration(nextEv.id, bobId, { status: 'IN', squadPower: 900_000, squadType: 'tanks' });

    const banned = await store.checkAndApplyNoshowBan(nextEv.id, bobId);
    expect(banned).toBe(false);
    expect((await store.listRegistrations(nextEv.id)).find(r => r.memberId === bobId)!.isBanned).toBe(false);
  });

  it('does not ban when player was benched in the most recent event (even if older no-show exists)', async () => {
    // Regression: INNER JOIN on assignments would skip the bench event and find the older
    // no-show, incorrectly triggering a ban. LEFT JOIN + checking the most recent event fixes this.
    const ev1 = await store.createEvent({ kind: 'canyon', weekStart: '2025-06-02' });
    const aliceId = await addMember(data, db, 'Alice');
    await store.upsertRegistration(ev1.id, aliceId, { status: 'IN', squadPower: 1_000_000, squadType: 'tanks' });
    await store.replaceAssignments(ev1.id, [
      { memberId: aliceId, team: 'A', role: 'main', slotIndex: 1 },
    ], { isLocked: false });
    await store.lockRoster(ev1.id);
    // Alice was absent from event 1.
    await store.recordAttendance(ev1.id, []);

    // Event 2: Alice is registered and registered as IN, but ends up benched (no assignment).
    const ev2 = await store.createEvent({ kind: 'canyon', weekStart: '2025-06-09' });
    await store.upsertRegistration(ev2.id, aliceId, { status: 'IN', squadPower: 1_000_000, squadType: 'tanks' });
    // Lock with no assignments for Alice → she gets 'rejected' outcome.
    const carolId = await addMember(data, db, 'Carol');
    await store.upsertRegistration(ev2.id, carolId, { status: 'IN', squadPower: 500_000, squadType: 'tanks' });
    await store.replaceAssignments(ev2.id, [
      { memberId: carolId, team: 'A', role: 'main', slotIndex: 1 },
    ], { isLocked: false });
    await store.lockRoster(ev2.id);
    expect((await store.getParticipationOutcomes(ev2.id)).get(aliceId)).toBe('rejected');

    // Event 3: Alice registers — most recent event has her as 'rejected' (benched), not no-show.
    const ev3 = await store.createEvent({ kind: 'canyon', weekStart: '2025-06-16' });
    await store.upsertRegistration(ev3.id, aliceId, { status: 'IN', squadPower: 1_000_000, squadType: 'tanks' });

    const banned = await store.checkAndApplyNoshowBan(ev3.id, aliceId);
    expect(banned).toBe(false);
    expect((await store.listRegistrations(ev3.id)).find(r => r.memberId === aliceId)!.isBanned).toBe(false);
  });

  it('does not apply ban when event is not open', async () => {
    const { eventId, memberIds } = await createLockedEvent(
      store, data, db, 'canyon', '2025-06-02', ['Alice'],
    );
    const aliceId = memberIds.get('Alice')!;
    await store.recordAttendance(eventId, []);

    // Calling on the locked event itself should be a no-op.
    const banned = await store.checkAndApplyNoshowBan(eventId, aliceId);
    expect(banned).toBe(false);
  });

  it('does not ban when player skipped the week after no-show (ban window expired)', async () => {
    // Week 1: Alice no-shows.
    const { eventId: ev1Id, memberIds } = await createLockedEvent(
      store, data, db, 'canyon', '2025-06-02', ['Alice'],
    );
    const aliceId = memberIds.get('Alice')!;
    await store.recordAttendance(ev1Id, []);
    expect((await store.getParticipationOutcomes(ev1Id)).get(aliceId)).toBe('no-show');

    // Week 2 (ban week): Alice does NOT register — event is created and locked without her.
    const bobId = await addMember(data, db, 'Bob');
    const ev2 = await store.createEvent({ kind: 'canyon', weekStart: '2025-06-09' });
    await store.upsertRegistration(ev2.id, bobId, { status: 'IN', squadPower: 900_000, squadType: 'tanks' });
    await store.replaceAssignments(ev2.id, [
      { memberId: bobId, team: 'A', role: 'main', slotIndex: 1 },
    ], { isLocked: false });
    await store.lockRoster(ev2.id);

    // Week 3: Alice registers again — ban window has passed, she should NOT be banned.
    const ev3 = await store.createEvent({ kind: 'canyon', weekStart: '2025-06-16' });
    await store.upsertRegistration(ev3.id, aliceId, { status: 'IN', squadPower: 1_000_000, squadType: 'tanks' });

    const banned = await store.checkAndApplyNoshowBan(ev3.id, aliceId);
    expect(banned).toBe(false);
    expect((await store.listRegistrations(ev3.id)).find(r => r.memberId === aliceId)!.isBanned).toBe(false);
  });

  it('does not ban again when no-show ban was already applied in the immediately following event', async () => {
    // Week 1: Alice no-shows.
    const { eventId: ev1Id, memberIds } = await createLockedEvent(
      store, data, db, 'canyon', '2025-06-02', ['Alice'],
    );
    const aliceId = memberIds.get('Alice')!;
    await store.recordAttendance(ev1Id, []);

    // Week 2: Alice registers and is auto-banned, then the event is locked (with another
    // member assigned so lockRoster doesn't reject the empty-roster guard).
    const bobId = await addMember(data, db, 'Bob');
    const ev2 = await store.createEvent({ kind: 'canyon', weekStart: '2025-06-09' });
    await store.upsertRegistration(ev2.id, aliceId, { status: 'IN', squadPower: 1_000_000, squadType: 'tanks' });
    await store.upsertRegistration(ev2.id, bobId, { status: 'IN', squadPower: 900_000, squadType: 'tanks' });
    const bannedWeek2 = await store.checkAndApplyNoshowBan(ev2.id, aliceId);
    expect(bannedWeek2).toBe(true);
    await store.replaceAssignments(ev2.id, [
      { memberId: bobId, team: 'A', role: 'main', slotIndex: 1 },
    ], { isLocked: false });
    await store.lockRoster(ev2.id); // ev2 is now locked; Alice has is_banned=1 but no participation log entry yet

    // Week 3: Alice registers again — ban should NOT apply (already applied once).
    const ev3 = await store.createEvent({ kind: 'canyon', weekStart: '2025-06-16' });
    await store.upsertRegistration(ev3.id, aliceId, { status: 'IN', squadPower: 1_000_000, squadType: 'tanks' });

    const bannedWeek3 = await store.checkAndApplyNoshowBan(ev3.id, aliceId);
    expect(bannedWeek3).toBe(false);
    expect((await store.listRegistrations(ev3.id)).find(r => r.memberId === aliceId)!.isBanned).toBe(false);
  });
});
