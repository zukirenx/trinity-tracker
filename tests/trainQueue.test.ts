import { describe, it, expect, beforeEach } from 'vitest';
import { DataStore } from '../src/storage';
import { createD1Mock } from './d1-mock';

// Helpers ─────────────────────────────────────────────────────────────────

async function seedQueueMembers(store: DataStore, names: string[]): Promise<Map<string, number>> {
  // Sort to match the deterministic order syncTrainQueue uses (alphabetical).
  for (const name of names) {
    await store.addMember(name);
  }
  await store.syncTrainQueue();
  const queue = await store.getTrainQueue();
  const idByName = new Map<string, number>();
  for (const row of queue) idByName.set(row.name, row.memberId);
  return idByName;
}

async function getQueueByName(store: DataStore): Promise<string[]> {
  const queue = await store.getTrainQueue();
  return queue.map(r => r.name);
}

async function getQueuePositions(store: DataStore): Promise<Map<string, number>> {
  const queue = await store.getTrainQueue();
  const out = new Map<string, number>();
  for (const r of queue) out.set(r.name, r.position);
  return out;
}

// Tests ───────────────────────────────────────────────────────────────────

describe('Train queue', () => {
  let store: DataStore;

  beforeEach(() => {
    store = new DataStore(createD1Mock());
  });

  // ── syncTrainQueue ──────────────────────────────────────────────────────

  describe('syncTrainQueue', () => {
    it('seeds active members in alphabetical order at contiguous positions', async () => {
      await store.addMember('Charlie');
      await store.addMember('Alice');
      await store.addMember('Bob');
      await store.syncTrainQueue();

      const queue = await store.getTrainQueue();
      expect(queue.map(r => r.name)).toEqual(['Alice', 'Bob', 'Charlie']);
      expect(queue.map(r => r.position)).toEqual([1, 2, 3]);
    });

    it('is idempotent on repeated runs', async () => {
      await store.addMember('Alice');
      await store.addMember('Bob');
      await store.syncTrainQueue();
      await store.syncTrainQueue();
      await store.syncTrainQueue();
      const queue = await store.getTrainQueue();
      expect(queue).toHaveLength(2);
      expect(queue.map(r => r.position)).toEqual([1, 2]);
    });

    it('appends new active members at the end', async () => {
      await store.addMember('Alice');
      await store.addMember('Bob');
      await store.syncTrainQueue();
      await store.addMember('Charlie');
      await store.syncTrainQueue();

      const queue = await store.getTrainQueue();
      expect(queue.map(r => r.name)).toEqual(['Alice', 'Bob', 'Charlie']);
      expect(queue.find(r => r.name === 'Charlie')?.position).toBe(3);
    });

    it('logs an "add" entry for each newcomer', async () => {
      await store.addMember('Alice');
      await store.syncTrainQueue();
      const log = await store.getTrainQueueLog();
      const adds = log.filter(e => e.action === 'add');
      expect(adds).toHaveLength(1);
      expect(adds[0].memberName).toBe('Alice');
      expect(adds[0].fromPos).toBeNull();
      expect(adds[0].toPos).toBe(1);
    });

    it('removes inactive members and logs a "remove" entry', async () => {
      const ids = await seedQueueMembers(store, ['Alice', 'Bob', 'Charlie']);
      await store.deactivateMemberById(ids.get('Bob')!);
      await store.syncTrainQueue();

      const queue = await store.getTrainQueue();
      expect(queue.map(r => r.name)).toEqual(['Alice', 'Charlie']);
      expect(queue.map(r => r.position)).toEqual([1, 2]);

      const log = await store.getTrainQueueLog();
      const removes = log.filter(e => e.action === 'remove');
      expect(removes).toHaveLength(1);
      expect(removes[0].memberName).toBe('Bob');
      expect(removes[0].fromPos).toBe(2);
      expect(removes[0].toPos).toBeNull();
    });

    it('removes multiple inactive members sequentially, logging accurate pre-renumber positions', async () => {
      // Regression: when two members were inactivated together, the second
      // removal used to log a stale (post-shift) position. We now process
      // removals one at a time, re-reading the live position each time.
      const ids = await seedQueueMembers(store, ['Alice', 'Bob', 'Charlie', 'Dave', 'Eve']);
      // Inactivate Bob (pos 2) and Dave (pos 4).
      await store.deactivateMemberById(ids.get('Bob')!);
      await store.deactivateMemberById(ids.get('Dave')!);
      await store.syncTrainQueue();

      const queue = await store.getTrainQueue();
      expect(queue.map(r => r.name)).toEqual(['Alice', 'Charlie', 'Eve']);
      expect(queue.map(r => r.position)).toEqual([1, 2, 3]);

      const removes = (await store.getTrainQueueLog())
        .filter(e => e.action === 'remove')
        .sort((a, b) => a.id - b.id);
      expect(removes).toHaveLength(2);
      // Bob is removed first (lower position); Dave's position becomes 3
      // after Bob is removed and the queue is renumbered.
      expect(removes[0].memberName).toBe('Bob');
      expect(removes[0].fromPos).toBe(2);
      expect(removes[1].memberName).toBe('Dave');
      expect(removes[1].fromPos).toBe(3);
    });

    it('keeps existing members in their positions when a newcomer is added', async () => {
      const ids = await seedQueueMembers(store, ['Alice', 'Bob']);
      await store.addMember('Charlie');
      await store.syncTrainQueue();
      const positions = await getQueuePositions(store);
      expect(positions.get('Alice')).toBe(1);
      expect(positions.get('Bob')).toBe(2);
      expect(positions.get('Charlie')).toBe(3);
      // sanity: ids preserved
      expect(ids.get('Alice')).toBeDefined();
    });
  });

  // ── mergeMembers (name-based) ───────────────────────────────────────────

  describe('mergeMembers — queue handling', () => {
    it('both in queue: target inherits the earlier slot and duplicate is removed', async () => {
      await seedQueueMembers(store, ['Alice', 'Bob', 'Charlie', 'Dave']);
      // Charlie (pos 3) is the rename of Bob (pos 2): merging Bob ← Charlie
      // means target=Bob (keep), duplicate=Charlie. Target should keep min(2,3)=2.
      const ok = await store.mergeMembers('Bob', 'Charlie');
      expect(ok).toBe(true);

      const queue = await store.getTrainQueue();
      expect(queue.map(r => r.name)).toEqual(['Alice', 'Bob', 'Dave']);
      expect(queue.map(r => r.position)).toEqual([1, 2, 3]);
    });

    it('both in queue: target moves to duplicate slot when duplicate had lower pos', async () => {
      await seedQueueMembers(store, ['Alice', 'Bob', 'Charlie', 'Dave']);
      // Merging Charlie (pos 3) ← Alice (pos 1): keep min(3,1)=1, Charlie ends at pos 1.
      const ok = await store.mergeMembers('Charlie', 'Alice');
      expect(ok).toBe(true);

      const queue = await store.getTrainQueue();
      expect(queue.map(r => r.name)).toEqual(['Charlie', 'Bob', 'Dave']);
      expect(queue.map(r => r.position)).toEqual([1, 2, 3]);
    });

    it('both in queue: logs merge-remove for duplicate and merge-move for target', async () => {
      await seedQueueMembers(store, ['Alice', 'Bob', 'Charlie']);
      // Alice (pos 1) ← Charlie (pos 3): Alice stays at 1, Charlie removed at 3.
      // Since the target did not move, no merge-move should be logged.
      await store.mergeMembers('Alice', 'Charlie');

      const log = await store.getTrainQueueLog();
      const removes = log.filter(e => e.action === 'merge-remove');
      const moves = log.filter(e => e.action === 'merge-move');
      expect(removes).toHaveLength(1);
      expect(removes[0].memberName).toBe('Charlie');
      expect(removes[0].fromPos).toBe(3);
      expect(removes[0].toPos).toBeNull();
      expect(moves).toHaveLength(0);
    });

    it('both in queue: logs merge-move when target inherits an earlier slot', async () => {
      await seedQueueMembers(store, ['Alice', 'Bob', 'Charlie']);
      // Charlie (pos 3) ← Alice (pos 1): Charlie inherits pos 1.
      // For replay-consistency, the merge-move's from_pos is the target's
      // position AFTER the duplicate has been spliced out — here that is
      // pos 2 (target_old=3 − 1, because dup_pos=1 < target_old).
      await store.mergeMembers('Charlie', 'Alice');

      const log = await store.getTrainQueueLog();
      const removes = log.filter(e => e.action === 'merge-remove');
      const moves = log.filter(e => e.action === 'merge-move');
      expect(removes).toHaveLength(1);
      expect(removes[0].memberName).toBe('Alice');
      expect(removes[0].fromPos).toBe(1);
      expect(moves).toHaveLength(1);
      expect(moves[0].memberName).toBe('Charlie');
      expect(moves[0].fromPos).toBe(2);
      expect(moves[0].toPos).toBe(1);
    });

    it('only duplicate in queue: slot is transferred to target', async () => {
      // Seed queue then add a target that is NOT in the queue.
      await seedQueueMembers(store, ['Alice', 'Bob']);
      await store.addMember('RenamedBob');
      // Remove RenamedBob from the queue without syncing yet — easiest is to
      // just merge before sync runs. To exercise the "only duplicate" branch
      // we need RenamedBob to be a member but not in train_queue, while
      // Bob (the duplicate) IS in the queue.
      // Setup achieved: Alice & Bob seeded; RenamedBob just added (not yet in queue).
      const ok = await store.mergeMembers('RenamedBob', 'Bob');
      expect(ok).toBe(true);

      const queue = await store.getTrainQueue();
      expect(queue.map(r => r.name)).toEqual(['Alice', 'RenamedBob']);
      expect(queue.map(r => r.position)).toEqual([1, 2]);

      // For replay-consistency this is recorded as merge-remove(dup) + add(target).
      const log = await store.getTrainQueueLog();
      const moves = log.filter(e => e.action === 'merge-move');
      const mergeRemoves = log.filter(e => e.action === 'merge-remove');
      const adds = log.filter(e => e.action === 'add' && e.memberName === 'RenamedBob');
      expect(moves).toHaveLength(0);
      expect(mergeRemoves).toHaveLength(1);
      expect(mergeRemoves[0].memberName).toBe('Bob');
      expect(mergeRemoves[0].fromPos).toBe(2);
      expect(adds).toHaveLength(1);
      expect(adds[0].toPos).toBe(2);
    });

  });

  // ── mergeMemberById (id-based, used by web maintenance flow) ────────────

  describe('mergeMemberById — queue handling', () => {
    it('regression: rename via maintenance flow transfers queue slot and logs entries', async () => {
      // This reproduces the production bug: Lloydji (rename to UptheTigers).
      // Without the fix, deleting the duplicate member triggered ON DELETE
      // CASCADE on train_queue, silently removing the duplicate's row with
      // no log entry and leaving the target at the end of the queue.
      const ids = await seedQueueMembers(store, ['Alice', 'Bob', 'Charlie', 'Dave']);
      // Simulate the leaderboard upload: a new member "RenamedBob" is added
      // at the end of the queue.
      await store.addMember('RenamedBob');
      await store.syncTrainQueue();
      const queueAfterAdd = await getQueueByName(store);
      expect(queueAfterAdd).toEqual(['Alice', 'Bob', 'Charlie', 'Dave', 'RenamedBob']);
      const renamedBobId = (await store.getTrainQueue())
        .find(r => r.name === 'RenamedBob')!.memberId;
      void renamedBobId;

      // Operator chooses "merge Bob into RenamedBob" via the maintenance UI.
      // The endpoint calls mergeMemberById(duplicateId=Bob, targetNormalized='renamedbob').
      const ok = await store.mergeMemberById(ids.get('Bob')!, 'renamedbob');
      expect(ok).toBe(true);

      const queue = await store.getTrainQueue();
      // RenamedBob should now occupy Bob's old slot (pos 2), not the end.
      expect(queue.map(r => r.name)).toEqual(['Alice', 'RenamedBob', 'Charlie', 'Dave']);
      expect(queue.map(r => r.position)).toEqual([1, 2, 3, 4]);

      const log = await store.getTrainQueueLog();
      const removes = log.filter(e => e.action === 'merge-remove');
      const moves = log.filter(e => e.action === 'merge-move');
      expect(removes).toHaveLength(1);
      expect(removes[0].memberName).toBe('Bob');
      expect(removes[0].fromPos).toBe(2);
      expect(moves).toHaveLength(1);
      expect(moves[0].memberName).toBe('RenamedBob');
      // dup_pos(2) < target_old(5), so replay-consistent from_pos is 5−1=4.
      expect(moves[0].fromPos).toBe(4);
      expect(moves[0].toPos).toBe(2);
    });

    it('only duplicate in queue: slot is transferred to the target', async () => {
      const ids = await seedQueueMembers(store, ['Alice', 'Bob']);
      await store.addMember('RenamedBob'); // not yet in queue

      const ok = await store.mergeMemberById(ids.get('Bob')!, 'renamedbob');
      expect(ok).toBe(true);

      const queue = await store.getTrainQueue();
      expect(queue.map(r => r.name)).toEqual(['Alice', 'RenamedBob']);
      expect(queue.map(r => r.position)).toEqual([1, 2]);

      // Recorded as merge-remove(Bob) + add(RenamedBob) for strict replay.
      const log = await store.getTrainQueueLog();
      const moves = log.filter(e => e.action === 'merge-move');
      const mergeRemoves = log.filter(e => e.action === 'merge-remove');
      const adds = log.filter(e => e.action === 'add' && e.memberName === 'RenamedBob');
      expect(moves).toHaveLength(0);
      expect(mergeRemoves).toHaveLength(1);
      expect(mergeRemoves[0].memberName).toBe('Bob');
      expect(mergeRemoves[0].fromPos).toBe(2);
      expect(adds).toHaveLength(1);
      expect(adds[0].toPos).toBe(2);
    });

    it('neither in queue: merge succeeds without queue changes or log entries', async () => {
      await store.addMember('Ghost');
      await store.addMember('Spectre');
      // No syncTrainQueue: neither is in the queue.
      const ghost = await store.findMember('Ghost');
      // Look up id via direct query through getActiveMembersWithLastReward isn't
      // helpful; use a fresh seed then deactivate so they're not in queue.
      // Simpler: add a third member, sync, then test mergeMemberById on the
      // two queue-less members.
      void ghost;
      // Recreate a fresh store for cleanliness.
      const store2 = new DataStore(createD1Mock());
      await store2.addMember('Ghost');
      await store2.addMember('Spectre');
      // Fetch ids via members table through a tiny indirect path: syncTrainQueue
      // would add them, but we want them OUT of the queue. Solution: sync,
      // capture ids, then deactivate both, sync again so they leave the queue.
      await store2.syncTrainQueue();
      const fullQueue = await store2.getTrainQueue();
      const ghostId = fullQueue.find(r => r.name === 'Ghost')!.memberId;
      await store2.deactivateMemberById(ghostId);
      await store2.deactivateMemberById(fullQueue.find(r => r.name === 'Spectre')!.memberId);
      await store2.syncTrainQueue();
      expect((await store2.getTrainQueue())).toEqual([]);

      // Reactivate so members exist as active rows but are not in the queue.
      // (For this branch we just need them out of train_queue.)
      const logBefore = (await store2.getTrainQueueLog()).length;
      const ok = await store2.mergeMemberById(ghostId, 'spectre');
      expect(ok).toBe(true);
      const logAfter = (await store2.getTrainQueueLog()).length;
      // No new queue log entries (only alias/rewards updates).
      expect(logAfter).toBe(logBefore);
    });

    it('returns false when target normalized name does not exist', async () => {
      const ids = await seedQueueMembers(store, ['Alice', 'Bob']);
      const ok = await store.mergeMemberById(ids.get('Bob')!, 'nobody');
      expect(ok).toBe(false);
      // Queue untouched.
      const queue = await store.getTrainQueue();
      expect(queue.map(r => r.name)).toEqual(['Alice', 'Bob']);
    });

    it('returns false when duplicate id is unknown', async () => {
      await seedQueueMembers(store, ['Alice', 'Bob']);
      const ok = await store.mergeMemberById(9999, 'alice');
      expect(ok).toBe(false);
    });

    it('returns false when target and duplicate are the same member', async () => {
      const ids = await seedQueueMembers(store, ['Alice']);
      const ok = await store.mergeMemberById(ids.get('Alice')!, 'alice');
      expect(ok).toBe(false);
    });

    it('moves duplicate display name onto target as an alias', async () => {
      const ids = await seedQueueMembers(store, ['Alice', 'Bob']);
      await store.addMember('RenamedBob');
      await store.mergeMemberById(ids.get('Bob')!, 'renamedbob');

      // Looking up the old name should now resolve to RenamedBob.
      const found = await store.findMember('Bob');
      expect(found?.displayName).toBe('RenamedBob');
    });
  });

  // ── Combined scenario: remove + merge in one sync, like the upload flow ──

  describe('upload flow: deactivate + merge interaction', () => {
    it('removes an inactive member with a log entry and then merges a rename correctly', async () => {
      const ids = await seedQueueMembers(store, ['Alice', 'Bob', 'Charlie', 'Dave', 'Eve']);
      // Simulate leaderboard upload adding a new commander at the end.
      await store.addMember('RenamedDave');
      await store.syncTrainQueue();

      // Operator decisions: remove Bob (left alliance) and merge Dave → RenamedDave.
      // Step 1: deactivate Bob then sync (this is what the maintenance flow does
      // for "remove" decisions — sets active=0; syncTrainQueue logs the removal).
      await store.deactivateMemberById(ids.get('Bob')!);
      await store.syncTrainQueue();

      // Step 2: merge Dave (duplicate) into RenamedDave (target).
      await store.mergeMemberById(ids.get('Dave')!, 'renameddave');

      const queue = await store.getTrainQueue();
      // Original: A B C D E. After Bob removal: A C D E RenamedDave.
      // After merge Dave→RenamedDave (Dave at pos 3, RenamedDave at pos 5):
      // RenamedDave inherits pos 3.
      expect(queue.map(r => r.name)).toEqual(['Alice', 'Charlie', 'RenamedDave', 'Eve']);
      expect(queue.map(r => r.position)).toEqual([1, 2, 3, 4]);

      const log = await store.getTrainQueueLog();
      const removes = log.filter(e => e.action === 'remove');
      const mergeRemoves = log.filter(e => e.action === 'merge-remove');
      const mergeMoves = log.filter(e => e.action === 'merge-move');
      expect(removes).toHaveLength(1);
      expect(removes[0].memberName).toBe('Bob');
      expect(mergeRemoves).toHaveLength(1);
      expect(mergeRemoves[0].memberName).toBe('Dave');
      expect(mergeRemoves[0].fromPos).toBe(3);
      expect(mergeMoves).toHaveLength(1);
      expect(mergeMoves[0].memberName).toBe('RenamedDave');
      // dup_pos(3) < target_old(5), so replay-consistent from_pos is 5−1=4.
      expect(mergeMoves[0].fromPos).toBe(4);
      expect(mergeMoves[0].toPos).toBe(3);
    });
  });

  // ── bulkMoveQueueMembers ────────────────────────────────────────────────

  describe('bulkMoveQueueMembers', () => {
    it('keeps two tail members in place when both are moved down by 1', async () => {
      // Regression: previously, processing the last member first clamped it
      // to its current position (no-op), but the second-to-last member still
      // saw an unclamped target and got swapped with the last one.
      const ids = await seedQueueMembers(store, ['Alice', 'Bob', 'Charlie', 'Dave', 'Eve']);
      const before = await getQueueByName(store);
      expect(before).toEqual(['Alice', 'Bob', 'Charlie', 'Dave', 'Eve']);

      const moves = await store.bulkMoveQueueMembers(
        [ids.get('Dave')!, ids.get('Eve')!],
        'down',
        1,
        'test',
      );

      expect(moves).toEqual([]);
      const after = await getQueueByName(store);
      expect(after).toEqual(['Alice', 'Bob', 'Charlie', 'Dave', 'Eve']);
      const log = await store.getTrainQueueLog();
      expect(log.filter(e => e.action === 'manual-move')).toHaveLength(0);
    });

    it('keeps two head members in place when both are moved up by 1', async () => {
      const ids = await seedQueueMembers(store, ['Alice', 'Bob', 'Charlie', 'Dave']);
      const moves = await store.bulkMoveQueueMembers(
        [ids.get('Alice')!, ids.get('Bob')!],
        'up',
        1,
        'test',
      );

      expect(moves).toEqual([]);
      expect(await getQueueByName(store)).toEqual(['Alice', 'Bob', 'Charlie', 'Dave']);
      const log = await store.getTrainQueueLog();
      expect(log.filter(e => e.action === 'manual-move')).toHaveLength(0);
    });

    it('keeps all selected tail members in place when shifted down beyond the end', async () => {
      const ids = await seedQueueMembers(store, ['Alice', 'Bob', 'Charlie', 'Dave', 'Eve']);
      const moves = await store.bulkMoveQueueMembers(
        [ids.get('Charlie')!, ids.get('Dave')!, ids.get('Eve')!],
        'down',
        2,
        'test',
      );

      expect(moves).toEqual([]);
      expect(await getQueueByName(store)).toEqual(['Alice', 'Bob', 'Charlie', 'Dave', 'Eve']);
    });

    it('moves a non-blocked member down while keeping a tail member fixed', async () => {
      // Bob can move down 2 (to pos 4); Eve is already at the tail and stays.
      const ids = await seedQueueMembers(store, ['Alice', 'Bob', 'Charlie', 'Dave', 'Eve']);
      const moves = await store.bulkMoveQueueMembers(
        [ids.get('Bob')!, ids.get('Eve')!],
        'down',
        2,
        'test',
      );

      // Only Bob should have moved.
      expect(moves.map(m => m.displayName)).toEqual(['Bob']);
      expect(moves[0].fromPos).toBe(2);
      expect(moves[0].toPos).toBe(4);
      expect(await getQueueByName(store)).toEqual(['Alice', 'Charlie', 'Dave', 'Bob', 'Eve']);
    });
  });

  // ── position numbering regression ──────────────────────────────────────────

  describe('getTrainQueue position numbering', () => {
    it('returns contiguous 1..N positions when multiple members rotate out in one sync', async () => {
      // Regression: when several train rewards arrived at once (e.g. from a
      // batch Discord ingest), syncTrainQueue rotated multiple members to the
      // end in one call. A race or partial-write could leave the DB with gaps
      // or duplicates. getTrainQueue must always expose clean 1..N regardless.
      const ids = await seedQueueMembers(store, ['Alice', 'Bob', 'Charlie', 'Dave', 'Eve']);

      // Simulate three members receiving a train reward on the same day.
      const db = (store as any).db as D1Database;
      const aliceId  = ids.get('Alice')!;
      const charlieId = ids.get('Charlie')!;
      const eveId    = ids.get('Eve')!;
      await db.prepare(
        `INSERT INTO rewards (date, driver_name, vip_name, type, raw_text, source_message_id, source_line)
         VALUES (?, ?, NULL, 'TRAIN', '', 'msg1', 1)`
      ).bind('2026-06-01', 'Alice').run();
      await db.prepare(
        `INSERT INTO rewards (date, driver_name, vip_name, type, raw_text, source_message_id, source_line)
         VALUES (?, ?, NULL, 'TRAIN', '', 'msg2', 1)`
      ).bind('2026-06-01', 'Charlie').run();
      await db.prepare(
        `INSERT INTO rewards (date, driver_name, vip_name, type, raw_text, source_message_id, source_line)
         VALUES (?, ?, NULL, 'TRAIN', '', 'msg3', 1)`
      ).bind('2026-06-01', 'Eve').run();

      await store.syncTrainQueue();

      const queue = await store.getTrainQueue();
      expect(queue.length).toBe(5);
      expect(queue.map(r => r.position)).toEqual([1, 2, 3, 4, 5]);
      // The three rewarded members should be at the tail (in reward-date order,
      // ties broken by original position: Alice(1) < Charlie(3) < Eve(5)).
      expect(queue.map(r => r.name)).toEqual(['Bob', 'Dave', 'Alice', 'Charlie', 'Eve']);
      void aliceId; void charlieId; void eveId;
    });

    it('returns contiguous 1..N positions even when DB positions have a gap and a duplicate', async () => {
      // Regression: the previous code returned raw DB position values. If the
      // DB had been corrupted (e.g. gap at 1, two members at 100) the display
      // would show missing and duplicate numbers. Now getTrainQueue derives
      // positions from row index so the display is always correct.
      await seedQueueMembers(store, ['Alice', 'Bob', 'Charlie']);

      // Directly corrupt the DB: set positions to 0, 2, 2 (gap + duplicate).
      const db = (store as any).db as D1Database;
      const rows = await db.prepare(
        'SELECT member_id FROM train_queue ORDER BY position ASC'
      ).all<{ member_id: number }>();
      const [r0, r1, r2] = rows.results;
      await db.prepare('UPDATE train_queue SET position = 0 WHERE member_id = ?').bind(r0.member_id).run();
      await db.prepare('UPDATE train_queue SET position = 2 WHERE member_id = ?').bind(r1.member_id).run();
      await db.prepare('UPDATE train_queue SET position = 2 WHERE member_id = ?').bind(r2.member_id).run();

      const queue = await store.getTrainQueue();
      expect(queue.length).toBe(3);
      // Must always be 1, 2, 3 — never 0, 2, 2.
      expect(queue.map(r => r.position)).toEqual([1, 2, 3]);
    });

    it('excludes inactive members from renumbering so active positions stay contiguous', async () => {
      // Regression: applyQueueMove previously had no WHERE m.active = 1 filter.
      // An inactive member still in train_queue would occupy a slot in the
      // renumber snapshot, shifting active members' positions by 1 and leaving
      // a gap. getTrainQueue (active-only) then showed no "1st place".
      const ids = await seedQueueMembers(store, ['Alice', 'Bob', 'Charlie', 'Dave']);
      // Alice=1, Bob=2, Charlie=3, Dave=4.

      // Deactivate Alice (pos 1) without calling syncTrainQueue — she stays in
      // train_queue with position 1, simulating the gap between deactivation
      // and the next scheduled sync.
      await store.deactivateMemberById(ids.get('Alice')!);

      // moveQueueMember → applyQueueMove: move Dave to position 1.
      // Without the fix, Alice (inactive, pos 1) was included in the snapshot,
      // so the renumbered active positions were 2, 3, 4, 1 instead of 1, 2, 3, 1.
      await store.moveQueueMember(ids.get('Dave')!, 1, 'promote Dave');

      // Alice is still in train_queue (sync not yet called), but inactive.
      // Active-only view must show exactly 3 members at positions 1, 2, 3
      // in the order: Dave(1), Bob(2), Charlie(3).
      const queue = await store.getTrainQueue();
      expect(queue.length).toBe(3);
      expect(queue.map(r => r.position)).toEqual([1, 2, 3]);
      expect(queue.map(r => r.name)).toEqual(['Dave', 'Bob', 'Charlie']);
    });
  });
});
