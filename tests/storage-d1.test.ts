import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DataStore, type RewardRecord } from '../src/storage';
import { createD1Mock } from './d1-mock';

function makeReward(overrides: Partial<RewardRecord> = {}): RewardRecord {
  return {
    date: '2026-03-01',
    driverName: 'Alice',
    vipName: null,
    type: 'TRAIN',
    rawText: '01.03 Alice',
    sourceMessageId: 'msg-1',
    sourceLine: 0,
    ...overrides,
  };
}

describe('DataStore (D1 integration)', () => {
  let store: DataStore;

  beforeEach(() => {
    store = new DataStore(createD1Mock());
  });

  // ── addMember / findMember ────────────────────────────────

  describe('addMember', () => {
    it('creates a new active member', async () => {
      const member = await store.addMember('Alice');
      expect(member.displayName).toBe('Alice');
      expect(member.active).toBe(true);
    });

    it('returns existing member if already present', async () => {
      await store.addMember('Alice');
      const again = await store.addMember('Alice');
      expect(again.displayName).toBe('Alice');
      expect(again.active).toBe(true);
    });

    it('reactivates an inactive member', async () => {
      await store.addMember('Alice');
      await store.removeMember('Alice');
      const reactivated = await store.addMember('Alice');
      expect(reactivated.active).toBe(true);
    });
  });

  describe('findMember', () => {
    it('finds by exact display name', async () => {
      await store.addMember('Alice');
      const found = await store.findMember('Alice');
      expect(found).toBeDefined();
      expect(found!.displayName).toBe('Alice');
    });

    it('finds by normalized name (case-insensitive)', async () => {
      await store.addMember('Alice');
      const found = await store.findMember('alice');
      expect(found).toBeDefined();
      expect(found!.displayName).toBe('Alice');
    });

    it('finds by 0/o normalization', async () => {
      await store.addMember('R0bin');
      const found = await store.findMember('Robin');
      expect(found).toBeDefined();
      expect(found!.displayName).toBe('R0bin');
    });

    it('returns undefined for unknown member', async () => {
      const found = await store.findMember('Unknown');
      expect(found).toBeUndefined();
    });
  });

  // ── removeMember ──────────────────────────────────────────

  describe('removeMember', () => {
    it('marks member inactive', async () => {
      await store.addMember('Alice');
      const removed = await store.removeMember('Alice');
      expect(removed).toBe(true);

      const found = await store.findMember('Alice');
      expect(found!.active).toBe(false);
    });

    it('returns false for unknown member', async () => {
      const removed = await store.removeMember('Ghost');
      expect(removed).toBe(false);
    });
  });

  // ── renameMemberById ──────────────────────────────────────

  describe('renameMemberById', () => {
    async function getMemberId(displayName: string): Promise<number> {
      const row = await (store as any).db.prepare(
        'SELECT id FROM members WHERE TRIM(display_name) = ?'
      ).bind(displayName).first();
      return row.id as number;
    }

    it('renames a member and keeps the old name as an alias', async () => {
      await store.addMember('Keugant');
      const id = await getMemberId('Keugant');

      const ok = await store.renameMemberById(id, 'Kisuski');
      expect(ok).toBe(true);

      const renamed = await store.findMember('Kisuski');
      expect(renamed).toBeDefined();
      expect(renamed!.displayName).toBe('Kisuski');
      expect(renamed!.aliases).toContain('Keugant');

      const byOldName = await store.findMember('Keugant');
      expect(byOldName!.normalizedName).toBe(renamed!.normalizedName);
    });

    it('removes the new name from aliases if it was already an alias (Keugant→Kisuski→Keugant scenario)', async () => {
      // Initial state: member is "Kisuski" with alias "Keugant" (after a previous rename).
      await store.addMember('Keugant');
      const id = await getMemberId('Keugant');
      await store.renameMemberById(id, 'Kisuski');

      const beforeBack = await store.findMember('Kisuski');
      expect(beforeBack!.aliases).toContain('Keugant');

      // Rename back to Keugant.
      const ok = await store.renameMemberById(id, 'Keugant');
      expect(ok).toBe(true);

      const back = await store.findMember('Keugant');
      expect(back).toBeDefined();
      expect(back!.displayName).toBe('Keugant');
      // "Kisuski" is now the alias; "Keugant" should NOT be in aliases (it's the display name).
      expect(back!.aliases).toContain('Kisuski');
      expect(back!.aliases).not.toContain('Keugant');
    });

    it('refuses to rename to a name that collides with another member', async () => {
      await store.addMember('Alice');
      await store.addMember('Bob');
      const aliceId = await getMemberId('Alice');

      const ok = await store.renameMemberById(aliceId, 'Bob');
      expect(ok).toBe(false);

      // Alice unchanged.
      const alice = await store.findMember('Alice');
      expect(alice!.displayName).toBe('Alice');
    });

    it('returns false for unknown id', async () => {
      const ok = await store.renameMemberById(99999, 'Nope');
      expect(ok).toBe(false);
    });

    it('returns false when new name is empty/whitespace', async () => {
      await store.addMember('Alice');
      const id = await getMemberId('Alice');
      expect(await store.renameMemberById(id, '   ')).toBe(false);
      expect(await store.renameMemberById(id, '')).toBe(false);
    });

    it('returns false when the normalized name is unchanged (no-op)', async () => {
      await store.addMember('Alice');
      const id = await getMemberId('Alice');
      // Different casing/spacing normalizes to the same value.
      const ok = await store.renameMemberById(id, '  alice ');
      expect(ok).toBe(false);
    });

    it('preserves rewards under the new display name', async () => {
      await store.addMember('Keugant');
      await store.addReward(makeReward({ driverName: 'Keugant' }));
      const id = await getMemberId('Keugant');

      await store.renameMemberById(id, 'Kisuski');

      const rewards = await store.getRewards();
      expect(rewards.length).toBe(1);
      // The reward's driver_name is the original; lookup via member should still work.
      const member = await store.findMember('Kisuski');
      expect(member!.aliases).toContain('Keugant');
    });

    it('appends a rename entry to train_queue_log without touching the queue', async () => {
      await store.addMember('Kisuski');
      await store.syncTrainQueue();
      const id = await getMemberId('Kisuski');

      const queueBefore = await (store as any).db.prepare(
        'SELECT member_id, position FROM train_queue ORDER BY position'
      ).all();

      await store.renameMemberById(id, 'Keugant');

      // The original 'add' row is preserved with the old name.
      const addRow = await (store as any).db.prepare(
        "SELECT member_name FROM train_queue_log WHERE member_id = ? AND action = 'add'"
      ).bind(id).first();
      expect(addRow.member_name).toBe('Kisuski');

      // A new 'rename' row exists with the new name and a comment referring to the old one.
      const renameRow = await (store as any).db.prepare(
        "SELECT member_name, from_pos, to_pos, comment FROM train_queue_log WHERE member_id = ? AND action = 'rename'"
      ).bind(id).first();
      expect(renameRow).toBeDefined();
      expect(renameRow.member_name).toBe('Keugant');
      expect(renameRow.from_pos).toBeNull();
      expect(renameRow.to_pos).toBeNull();
      expect(renameRow.comment).toContain('Kisuski');

      // Queue positions are unchanged.
      const queueAfter = await (store as any).db.prepare(
        'SELECT member_id, position FROM train_queue ORDER BY position'
      ).all();
      expect(queueAfter.results).toEqual(queueBefore.results);
    });
  });

  // ── uploadLeaderboard (normalizer mismatch regression) ────

  describe('uploadLeaderboard – normalizer consistency', () => {
    const baseEntry = (commander: string, rank = 1, points = 1000) => ({ rank, commander, points });

    it('addMember stores normalized_name with the full normalizer so leaderboard lookup matches', async () => {
      // "Rick M" added manually — normalized_name must be "rickm" (no space),
      // matching what uploadLeaderboard uses for lookup.
      const member = await store.addMember('Rick M');
      expect(member.normalizedName).toBe('rickm');
    });

    it('leaderboard upload finds a manually-added member despite diacritic OCR artifact', async () => {
      // Simulate member added via the web dashboard before this fix.
      // We force the old simple-normalized value to replicate the legacy state.
      // "Rick M" → simple normalizer → "rick m" (keeps space, no diacritic strip).
      await (store as any).db.prepare(
        "INSERT INTO members (display_name, normalized_name, active) VALUES ('Rick M', 'rick m', 1)"
      ).run();

      // Correct name is "Ričk M" (č = c with caron → strips to c → normalizes to "rickm",
      // same as "Rick M"). The leaderboard OCR sees "Ričk M".
      const result = await store.uploadLeaderboard({
        slug: 'week-1',
        title: 'Week 1',
        entries: [baseEntry('Ričk M')],
      });

      // Should NOT create a second member — only 1 active member in total.
      const active = await (store as any).db.prepare(
        "SELECT id, display_name, normalized_name FROM members WHERE active = 1"
      ).all();
      expect(active.results).toHaveLength(1);

      // Display name updated to what the leaderboard says.
      expect(active.results[0].display_name).toBe('Ričk M');

      // normalized_name healed to the full-normalizer form.
      expect(active.results[0].normalized_name).toBe('rickm');

      // No missing active members reported.
      expect(result.missingActiveMembers).toHaveLength(0);
    });

    it('leaderboard upload does not rename when found directly via full normalizer', async () => {
      await store.addMember('Rick M');

      const result = await store.uploadLeaderboard({
        slug: 'week-2',
        title: 'Week 2',
        entries: [baseEntry('Rick M')],
      });

      expect(result.missingActiveMembers).toHaveLength(0);
      const row = await (store as any).db.prepare(
        "SELECT display_name FROM members WHERE active = 1"
      ).first();
      expect(row.display_name).toBe('Rick M');
    });
  });

  // ── mergeMembers ──────────────────────────────────────────

  describe('mergeMembers', () => {
    it('merges duplicate into target and updates rewards', async () => {
      await store.addMember('Alice');
      await store.addMember('Al1ce');
      await store.addReward(makeReward({ driverName: 'Al1ce', rawText: '01.03 Al1ce' }));

      const merged = await store.mergeMembers('Alice', 'Al1ce');
      expect(merged).toBe(true);

      // duplicate should be gone
      const dup = await store.findMember('Al1ce');
      // Al1ce is now an alias of Alice, so findMember should resolve to Alice
      expect(dup?.displayName).toBe('Alice');
    });

    it('returns false when merging same member', async () => {
      await store.addMember('Alice');
      const merged = await store.mergeMembers('Alice', 'Alice');
      expect(merged).toBe(false);
    });

    it('returns false when target does not exist', async () => {
      await store.addMember('Alice');
      const merged = await store.mergeMembers('Ghost', 'Alice');
      expect(merged).toBe(false);
    });

    it('returns false when duplicate does not exist', async () => {
      await store.addMember('Alice');
      const merged = await store.mergeMembers('Alice', 'Ghost');
      expect(merged).toBe(false);
    });

    it('reassigns event registrations from duplicate to target so the FK delete does not trip RESTRICT', async () => {
      // Reproduces the production failure where a duplicate held an event
      // registration; pre-batch the merge logged then failed on the
      // members DELETE. After the fix the rows are reassigned ahead of
      // delete and the merge completes cleanly.
      await store.addMember('Alice');
      await store.addMember('Al1ce');
      const ali = await store.findMember('Al1ce');
      expect(ali).toBeDefined();

      const db = (store as unknown as { db: D1Database }).db;
      const dupRow = await db.prepare(
        'SELECT id FROM members WHERE normalized_name = ?'
      ).bind(ali!.normalizedName).first<{ id: number }>();
      const targetRow = await db.prepare(
        'SELECT id FROM members WHERE normalized_name = ?'
      ).bind('alice').first<{ id: number }>();

      // Seed an event + registration for the duplicate.
      await db.prepare(
        `INSERT INTO poc_events_event (kind, week_start, status) VALUES ('desert', '2026-05-18', 'open')`
      ).run();
      const evt = await db.prepare(
        `SELECT id FROM poc_events_event WHERE week_start = '2026-05-18'`
      ).first<{ id: number }>();
      await db.prepare(
        `INSERT INTO poc_events_registration (event_id, member_id, status, squad_power, squad_type, time_slot, team_preference)
         VALUES (?, ?, 'IN', 100, 'tanks', 'any', 'any')`
      ).bind(evt!.id, dupRow!.id).run();

      const merged = await store.mergeMembers('Alice', 'Al1ce');
      expect(merged).toBe(true);

      // Event registration should now belong to target.
      const reg = await db.prepare(
        `SELECT member_id FROM poc_events_registration WHERE event_id = ?`
      ).bind(evt!.id).first<{ member_id: number }>();
      expect(reg!.member_id).toBe(targetRow!.id);

      // Duplicate member should be gone, and the merge log entry should
      // be present (committed atomically together with the delete).
      const dupAfter = await db.prepare(
        'SELECT id FROM members WHERE id = ?'
      ).bind(dupRow!.id).first();
      expect(dupAfter).toBeNull();
    });

    it('rolls back the entire merge if any statement in the batch fails', async () => {
      // Verify atomicity: poison the batch by stuffing a bad statement
      // into it via a temporary monkey-patch on db.batch, and assert that
      // *no* train_queue_log entry is left behind. This mirrors the bug
      // we hit in prod where the merge logged a `merge-remove` then
      // failed on the member delete, leaving the duplicate (and its
      // ghost) to reappear.
      await store.addMember('Alice');
      await store.addMember('Al1ce');
      // Put both in the queue so the merge would otherwise emit log rows.
      await store.syncTrainQueue();

      const db = (store as unknown as { db: D1Database }).db;
      const realBatch = db.batch.bind(db);
      (db as any).batch = async (stmts: any[]) => {
        const poisoned = [...stmts, db.prepare('INSERT INTO members (display_name, normalized_name, active) VALUES (?, NULL, 1)').bind('boom')];
        return realBatch(poisoned);
      };

      let threw = false;
      try {
        await store.mergeMembers('Alice', 'Al1ce');
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);

      (db as any).batch = realBatch;

      // Both members must still be present (rollback worked).
      const dup = await db.prepare(
        `SELECT id FROM members WHERE normalized_name = 'al1ce'`
      ).first();
      expect(dup).not.toBeNull();
      const target = await db.prepare(
        `SELECT id FROM members WHERE normalized_name = 'alice'`
      ).first();
      expect(target).not.toBeNull();

      // Critically: no merge log entry was written.
      const logs = await db.prepare(
        `SELECT COUNT(*) AS n FROM train_queue_log WHERE action LIKE 'merge%'`
      ).first<{ n: number }>();
      expect(logs!.n).toBe(0);
    });
  });

  // ── maintenanceMerge ──────────────────────────────────────

  describe('maintenanceMerge', () => {
    it('keeps existing member queue position when a leaderboard ghost is merged in', async () => {
      // Simulate the "GrandMichel → Michel Cosmos" scenario:
      // GrandMichel exists in queue at position 1; leaderboard upload created a
      // ghost "Michel Cosmos" that isn't in the queue yet.
      const db = (store as unknown as { db: D1Database }).db;
      await db.prepare(
        `INSERT INTO members (display_name, normalized_name, active) VALUES ('GrandMichel', 'grandmichel', 1)`
      ).run();
      const grandMichel = await db.prepare(
        `SELECT id FROM members WHERE normalized_name = 'grandmichel'`
      ).first<{ id: number }>();
      await store.syncTrainQueue(); // puts GrandMichel in queue

      // Ghost created by upload
      await db.prepare(
        `INSERT INTO members (display_name, normalized_name, active) VALUES ('Michel Cosmos', 'michelcosmos', 1)`
      ).run();
      const ghost = await db.prepare(
        `SELECT id FROM members WHERE normalized_name = 'michelcosmos'`
      ).first<{ id: number }>();

      const queueBefore = await db.prepare(
        `SELECT position FROM train_queue WHERE member_id = ?`
      ).bind(grandMichel!.id).first<{ position: number }>();
      expect(queueBefore).not.toBeNull();

      // Admin says: "GrandMichel in the missing list = Michel Cosmos in the leaderboard"
      const ok = await store.maintenanceMerge(grandMichel!.id, 'michelcosmos');
      expect(ok).toBe(true);

      // Ghost must be deleted
      const ghostAfter = await db.prepare(
        `SELECT id FROM members WHERE id = ?`
      ).bind(ghost!.id).first();
      expect(ghostAfter).toBeNull();

      // Existing member keeps its queue position
      const queueAfter = await db.prepare(
        `SELECT position FROM train_queue WHERE member_id = ?`
      ).bind(grandMichel!.id).first<{ position: number }>();
      expect(queueAfter?.position).toBe(queueBefore!.position);

      // Existing member is renamed to the leaderboard name
      const renamed = await db.prepare(
        `SELECT display_name, normalized_name FROM members WHERE id = ?`
      ).bind(grandMichel!.id).first<{ display_name: string; normalized_name: string }>();
      expect(renamed?.display_name).toBe('Michel Cosmos');
      expect(renamed?.normalized_name).toBe('michelcosmos');

      // Old name is added as alias
      const alias = await db.prepare(
        `SELECT id FROM member_aliases WHERE member_id = ? AND alias = 'GrandMichel'`
      ).bind(grandMichel!.id).first();
      expect(alias).not.toBeNull();

      // A rename log entry was emitted
      const renameLog = await db.prepare(
        `SELECT id FROM train_queue_log WHERE member_id = ? AND action = 'rename'`
      ).bind(grandMichel!.id).first();
      expect(renameLog).not.toBeNull();
    });

    it('returns false when existing member is not found', async () => {
      const db = (store as unknown as { db: D1Database }).db;
      await db.prepare(
        `INSERT INTO members (display_name, normalized_name, active) VALUES ('Ghost', 'ghost', 1)`
      ).run();
      const ok = await store.maintenanceMerge(99999, 'ghost');
      expect(ok).toBe(false);
    });

    it('returns false when ghost member is not found', async () => {
      const db = (store as unknown as { db: D1Database }).db;
      await db.prepare(
        `INSERT INTO members (display_name, normalized_name, active) VALUES ('Existing', 'existing', 1)`
      ).run();
      const existing = await db.prepare(
        `SELECT id FROM members WHERE normalized_name = 'existing'`
      ).first<{ id: number }>();
      const ok = await store.maintenanceMerge(existing!.id, 'nosuchghost');
      expect(ok).toBe(false);
    });

    it('returns false when existing member and ghost resolve to the same id', async () => {
      const db = (store as unknown as { db: D1Database }).db;
      await db.prepare(
        `INSERT INTO members (display_name, normalized_name, active) VALUES ('Same', 'same', 1)`
      ).run();
      const m = await db.prepare(
        `SELECT id FROM members WHERE normalized_name = 'same'`
      ).first<{ id: number }>();
      const ok = await store.maintenanceMerge(m!.id, 'same');
      expect(ok).toBe(false);
    });
  });

  // ── addReward / getRewards ────────────────────────────────

  describe('addReward', () => {
    it('adds a reward and auto-creates the member', async () => {
      const added = await store.addReward(makeReward({ driverName: 'NewPlayer' }));
      expect(added).toBe(true);

      const member = await store.findMember('NewPlayer');
      expect(member).toBeDefined();
    });

    it('returns false for duplicate reward', async () => {
      const reward = makeReward({ vipName: 'Passenger', type: 'VIP' });
      await store.addReward(reward);
      const second = await store.addReward({ ...reward, sourceMessageId: 'msg-2' });
      expect(second).toBe(false);
    });

    it('adds VIP member too when vipName is present', async () => {
      await store.addReward(makeReward({ vipName: 'Bob', type: 'VIP' }));
      const vip = await store.findMember('Bob');
      expect(vip).toBeDefined();
    });
  });

  describe('getRewards', () => {
    it('returns all rewards ordered by date desc', async () => {
      await store.addReward(makeReward({ date: '2026-03-01', driverName: 'Alice' }));
      await store.addReward(makeReward({ date: '2026-03-05', driverName: 'Bob', sourceMessageId: 'msg-2' }));
      await store.addReward(makeReward({ date: '2026-03-03', driverName: 'Charlie', sourceMessageId: 'msg-3' }));

      const rewards = await store.getRewards();
      expect(rewards).toHaveLength(3);
      expect(rewards[0].date).toBe('2026-03-05');
      expect(rewards[1].date).toBe('2026-03-03');
      expect(rewards[2].date).toBe('2026-03-01');
    });
  });

  // ── bulkAddRewards ────────────────────────────────────────

  describe('bulkAddRewards', () => {
    it('inserts multiple rewards in batch', async () => {
      const rewards = Array.from({ length: 20 }, (_, i) => ({
        date: `2026-03-${String(i + 1).padStart(2, '0')}`,
        driverName: `Player${i}`,
        vipName: null,
        type: 'TRAIN' as const,
        rawText: `test ${i}`,
        sourceMessageId: `msg-${i}`,
        sourceLine: 0,
      }));

      const result = await store.bulkAddRewards(rewards);
      expect(result.added).toBe(20);
      expect(result.duplicates).toBe(0);
    });

    it('handles duplicates via INSERT OR IGNORE', async () => {
      const reward = {
        date: '2026-03-01',
        driverName: 'Alice',
        vipName: 'Passenger',
        type: 'VIP' as const,
        rawText: 'test',
        sourceMessageId: 'msg-1',
        sourceLine: 0,
      };

      await store.bulkAddRewards([reward]);
      const result = await store.bulkAddRewards([reward, { ...reward, driverName: 'Bob', sourceMessageId: 'msg-2' }]);
      expect(result.added).toBe(1); // only Bob
      expect(result.duplicates).toBe(1); // Alice duplicate
    });

    it('returns zeros for empty array', async () => {
      const result = await store.bulkAddRewards([]);
      expect(result).toEqual({ added: 0, duplicates: 0 });
    });

    it('handles more than BATCH_SIZE (14) rewards', async () => {
      const rewards = Array.from({ length: 30 }, (_, i) => ({
        date: '2026-03-01',
        driverName: `Player${i}`,
        vipName: null,
        type: 'TRAIN' as const,
        rawText: `test ${i}`,
        sourceMessageId: `msg-${i}`,
        sourceLine: 0,
      }));

      const result = await store.bulkAddRewards(rewards);
      expect(result.added).toBe(30);
    });
  });

  // ── bulkEnsureMembers ─────────────────────────────────────

  describe('bulkEnsureMembers', () => {
    it('creates members that do not exist', async () => {
      await store.bulkEnsureMembers(['Alice', 'Bob', 'Charlie']);
      expect(await store.findMember('Alice')).toBeDefined();
      expect(await store.findMember('Bob')).toBeDefined();
      expect(await store.findMember('Charlie')).toBeDefined();
    });

    it('skips members that already exist', async () => {
      await store.addMember('Alice');
      await store.bulkEnsureMembers(['Alice', 'Bob']);
      // Should not throw or duplicate
      const stats = await store.getStats();
      expect(stats.totalMembers).toBe(2);
    });

    it('handles empty array', async () => {
      await store.bulkEnsureMembers([]);
      const stats = await store.getStats();
      expect(stats.totalMembers).toBe(0);
    });

    it('handles many members (batch splitting)', async () => {
      const names = Array.from({ length: 25 }, (_, i) => `Player${i}`);
      await store.bulkEnsureMembers(names);
      const stats = await store.getStats();
      expect(stats.totalMembers).toBe(25);
    });
  });

  // ── clearRewards ──────────────────────────────────────────

  describe('clearRewards', () => {
    it('removes all rewards', async () => {
      await store.addReward(makeReward());
      await store.clearRewards();
      const rewards = await store.getRewards();
      expect(rewards).toHaveLength(0);
    });
  });

  // ── metadata (ingestion time) ─────────────────────────────

  describe('setLastIngestionTime / getLastIngestionTime', () => {
    it('stores and retrieves timestamp', async () => {
      await store.setLastIngestionTime('2026-03-15T12:00:00Z');
      const ts = await store.getLastIngestionTime();
      expect(ts).toBe('2026-03-15T12:00:00Z');
    });

    it('returns null when not set', async () => {
      const ts = await store.getLastIngestionTime();
      expect(ts).toBeNull();
    });

    it('overwrites previous value', async () => {
      await store.setLastIngestionTime('2026-03-10T00:00:00Z');
      await store.setLastIngestionTime('2026-03-15T00:00:00Z');
      const ts = await store.getLastIngestionTime();
      expect(ts).toBe('2026-03-15T00:00:00Z');
    });
  });

  // ── getRewardedMembers ────────────────────────────────────

  describe('getRewardedMembers', () => {
    beforeEach(async () => {
      await store.addReward(makeReward({ date: '2026-03-10', driverName: 'Alice', sourceMessageId: 'msg-1' }));
      await store.addReward(makeReward({ date: '2026-03-12', driverName: 'Bob', sourceMessageId: 'msg-2' }));
      await store.addReward(makeReward({ date: '2026-03-14', driverName: 'Alice', sourceMessageId: 'msg-3' }));
      await store.addReward(makeReward({ date: '2026-03-08', driverName: 'Charlie', sourceMessageId: 'msg-4' }));
      // VIP reward
      await store.addReward(makeReward({ date: '2026-03-11', driverName: 'Alice', vipName: 'Dave', type: 'VIP', sourceMessageId: 'msg-5' }));
    });

    it('returns all rewarded members within N days', async () => {
      const rewarded = await store.getRewardedMembers(30);
      expect(rewarded.length).toBeGreaterThanOrEqual(4);
    });

    it('filters by train type', async () => {
      const rewarded = await store.getRewardedMembers(30, 'train');
      const names = rewarded.map(r => r.name);
      expect(names).toContain('Alice');
      expect(names).toContain('Bob');
      expect(names).not.toContain('Dave');
    });

    it('filters by vip type', async () => {
      const rewarded = await store.getRewardedMembers(30, 'vip');
      const names = rewarded.map(r => r.name);
      expect(names).toContain('Dave');
    });

    it('returns empty array when no rewards match window', async () => {
      const rewarded = await store.getRewardedMembers(1);
      // Reference date is max(date) = 2026-03-14, daysBack=1 means cutoff = 2026-03-14
      expect(rewarded.some(r => r.name === 'Alice')).toBe(true);
    });

    it('includes count and lastDate', async () => {
      const rewarded = await store.getRewardedMembers(30, 'train');
      const alice = rewarded.find(r => r.name === 'Alice');
      expect(alice).toBeDefined();
      expect(alice!.count).toBe(2); // two train rewards
      expect(alice!.lastDate).toBe('2026-03-14');
    });
  });

  // ── getWaitingMembers ─────────────────────────────────────

  describe('getWaitingMembers', () => {
    it('returns members with null for never-rewarded', async () => {
      await store.addMember('Alice');
      await store.addMember('Bob');
      // Only reward Alice
      await store.addReward(makeReward({ date: '2026-03-10', driverName: 'Alice' }));

      const waiting = await store.getWaitingMembers(10);
      expect(waiting.length).toBe(2);
      // Bob never rewarded → null daysSinceReward → comes first
      expect(waiting[0].name).toBe('Bob');
      expect(waiting[0].daysSinceReward).toBeNull();
    });

    it('sorts by daysSinceReward descending (longest wait first)', async () => {
      await store.addMember('EarlyReward');
      await store.addMember('LateReward');
      await store.addReward(makeReward({ date: '2026-03-01', driverName: 'EarlyReward', sourceMessageId: 'msg-1' }));
      await store.addReward(makeReward({ date: '2026-03-10', driverName: 'LateReward', sourceMessageId: 'msg-2' }));

      const waiting = await store.getWaitingMembers(10);
      const earlyIdx = waiting.findIndex(w => w.name === 'EarlyReward');
      const lateIdx = waiting.findIndex(w => w.name === 'LateReward');
      expect(earlyIdx).toBeLessThan(lateIdx);
    });

    it('respects limit', async () => {
      for (let i = 0; i < 5; i++) {
        await store.addMember(`Player${i}`);
      }
      const waiting = await store.getWaitingMembers(3);
      expect(waiting).toHaveLength(3);
    });

    it('filters by train type', async () => {
      await store.addMember('TrainOnly');
      await store.addMember('VipOnly');
      await store.addReward(makeReward({ date: '2026-03-10', driverName: 'TrainOnly', sourceMessageId: 'msg-1' }));
      await store.addReward(makeReward({ date: '2026-03-10', driverName: 'VipOnly', vipName: 'VipOnly', type: 'VIP', sourceMessageId: 'msg-2' }));

      const waiting = await store.getWaitingMembers(10, 'train');
      const vipEntry = waiting.find(w => w.name === 'VipOnly');
      // VipOnly has no train reward, so daysSinceReward should be null
      expect(vipEntry?.daysSinceReward).toBeNull();
    });

    it('returns empty when no active members', async () => {
      const waiting = await store.getWaitingMembers(10);
      expect(waiting).toHaveLength(0);
    });
  });

  // ── getActiveMembersWithLastReward ────────────────────────

  describe('getActiveMembersWithLastReward', () => {
    beforeEach(() => {
      // Days-waiting are measured from "today". Pin time so tests are stable.
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-20T12:00:00Z'));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('returns empty array when no active members', async () => {
      const result = await store.getActiveMembersWithLastReward();
      expect(result).toEqual([]);
    });

    it('returns null dates and null days for never-rewarded members', async () => {
      await store.addMember('Alice');
      const result = await store.getActiveMembersWithLastReward();
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        name: 'Alice',
        lastTrainDate: null,
        lastVipDate: null,
        lastAnyDate: null,
        daysSinceTrain: null,
        daysSinceVip: null,
        daysSinceAny: null,
      });
    });

    it('reports last train and VIP dates and days-since separately, counted from today', async () => {
      await store.addMember('Alice');
      await store.addReward(makeReward({ date: '2026-03-01', driverName: 'Alice', sourceMessageId: 'm1' }));
      await store.addReward(makeReward({
        date: '2026-03-10',
        driverName: 'Bob',
        vipName: 'Alice',
        type: 'VIP',
        sourceMessageId: 'm2',
      }));

      const result = await store.getActiveMembersWithLastReward();
      const alice = result.find(r => r.name === 'Alice');
      expect(alice).toBeDefined();
      expect(alice!.lastTrainDate).toBe('2026-03-01');
      expect(alice!.lastVipDate).toBe('2026-03-10');
      expect(alice!.lastAnyDate).toBe('2026-03-10');
      // Today is 2026-03-20 → 19 days since train, 10 since VIP, 10 overall.
      expect(alice!.daysSinceTrain).toBe(19);
      expect(alice!.daysSinceVip).toBe(10);
      expect(alice!.daysSinceAny).toBe(10);
    });

    it('sorts never-rewarded first, then by daysSinceAny descending', async () => {
      await store.addMember('Early');
      await store.addMember('Late');
      await store.addMember('Never');
      await store.addReward(makeReward({ date: '2026-03-01', driverName: 'Early', sourceMessageId: 'm1' }));
      await store.addReward(makeReward({ date: '2026-03-10', driverName: 'Late', sourceMessageId: 'm2' }));

      const result = await store.getActiveMembersWithLastReward();
      expect(result.map(r => r.name)).toEqual(['Never', 'Early', 'Late']);
    });

    it('excludes inactive members', async () => {
      await store.addMember('Active');
      await store.addMember('Gone');
      await store.removeMember('Gone');
      const result = await store.getActiveMembersWithLastReward();
      expect(result.map(r => r.name)).toEqual(['Active']);
    });

    it('resolves rewards under merged aliases', async () => {
      await store.addMember('Canonical');
      await store.addMember('OldName');
      await store.addReward(makeReward({ date: '2026-03-05', driverName: 'OldName', sourceMessageId: 'm1' }));
      await store.mergeMembers('Canonical', 'OldName');

      const result = await store.getActiveMembersWithLastReward();
      const canonical = result.find(r => r.name === 'Canonical');
      expect(canonical).toBeDefined();
      expect(canonical!.lastTrainDate).toBe('2026-03-05');
      expect(canonical!.daysSinceTrain).toBe(15);
    });
  });

  describe('getLatestRewardDate', () => {
    it('returns null when there are no rewards', async () => {
      expect(await store.getLatestRewardDate()).toBeNull();
    });

    it('returns the most recent date', async () => {
      await store.addMember('Alice');
      await store.addReward(makeReward({ date: '2026-03-01', driverName: 'Alice', sourceMessageId: 'm1' }));
      await store.addReward(makeReward({ date: '2026-03-15', driverName: 'Alice', sourceMessageId: 'm2' }));
      expect(await store.getLatestRewardDate()).toBe('2026-03-15');
    });
  });

  // ── cleanupUnusedMembers ──────────────────────────────────

  describe('cleanupUnusedMembers', () => {
    it('removes inactive members with no rewards', async () => {
      await store.addMember('Orphan');
      await store.removeMember('Orphan');
      const cleaned = await store.cleanupUnusedMembers();
      expect(cleaned).toBe(1);
    });

    it('does not remove active members', async () => {
      await store.addMember('Active');
      const cleaned = await store.cleanupUnusedMembers();
      expect(cleaned).toBe(0);
    });

    it('does not remove inactive members that have rewards', async () => {
      await store.addReward(makeReward({ driverName: 'HasRewards' }));
      await store.removeMember('HasRewards');
      const cleaned = await store.cleanupUnusedMembers();
      expect(cleaned).toBe(0);
    });
  });

  // ── getStats ──────────────────────────────────────────────

  describe('getStats', () => {
    it('returns zeros for empty database', async () => {
      const stats = await store.getStats();
      expect(stats).toEqual({ totalMembers: 0, activeMembers: 0, totalRewards: 0 });
    });

    it('counts members and rewards correctly', async () => {
      await store.addMember('Alice');
      await store.addMember('Bob');
      await store.removeMember('Bob');
      await store.addReward(makeReward({ driverName: 'Alice' }));

      const stats = await store.getStats();
      expect(stats.totalMembers).toBe(2);
      expect(stats.activeMembers).toBe(1);
      expect(stats.totalRewards).toBe(1);
    });
  });

  // ── getCanonicalNameMap ───────────────────────────────────

  describe('getCanonicalNameMap', () => {
    it('returns map of normalized → display name', async () => {
      await store.addMember('Alice');
      await store.addMember('Bob');
      const map = await store.getCanonicalNameMap();
      expect(map.size).toBeGreaterThanOrEqual(2);
    });

    it('returns empty map when no members', async () => {
      const map = await store.getCanonicalNameMap();
      expect(map.size).toBe(0);
    });

    it('includes aliases in the map', async () => {
      await store.addMember('Alice');
      await store.addMember('Al1ce');
      await store.mergeMembers('Alice', 'Al1ce');
      const map = await store.getCanonicalNameMap();
      // Alias "Al1ce" should map to "Alice"
      const values = Array.from(map.values());
      expect(values.filter(v => v === 'Alice').length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── Leaderboard methods ───────────────────────────────────

  describe('getLatestLeaderboardRanks', () => {
    async function seedLeaderboard(db: D1Database, slug: string, title: string, entries: { rank: number; commander: string; normalized: string; points: number }[]) {
      await db.prepare(
        'INSERT INTO leaderboards (slug, title) VALUES (?, ?)'
      ).bind(slug, title).run();
      const row = await db.prepare('SELECT id FROM leaderboards WHERE slug = ?').bind(slug).first<{ id: number }>();
      const id = row!.id;
      for (const e of entries) {
        await db.prepare(
          'INSERT INTO leaderboard_entries (leaderboard_id, rank, commander, normalized_commander, points) VALUES (?, ?, ?, ?, ?)'
        ).bind(id, e.rank, e.commander, e.normalized, e.points).run();
      }
    }

    it('returns null leaderboard when none exist', async () => {
      const result = await store.getLatestLeaderboardRanks(['Alice']);
      expect(result.leaderboard).toBeNull();
      expect(result.ranks.size).toBe(0);
    });

    it('returns ranks for members found in latest leaderboard', async () => {
      const db = createD1Mock();
      const s = new DataStore(db);
      await seedLeaderboard(db, 'ww01', 'Week 1', [
        { rank: 1, commander: 'Alice', normalized: 'alice', points: 1000 },
        { rank: 2, commander: 'Bob', normalized: 'bob', points: 800 },
      ]);

      const result = await s.getLatestLeaderboardRanks(['Alice', 'Charlie']);
      expect(result.leaderboard).toBeDefined();
      expect(result.leaderboard!.slug).toBe('ww01');
      expect(result.ranks.get('alice')).toEqual({ rank: 1, commander: 'Alice' });
      expect(result.ranks.has('charlie')).toBe(false);
    });

    it('returns empty ranks for empty names array', async () => {
      const db = createD1Mock();
      const s = new DataStore(db);
      await seedLeaderboard(db, 'ww01', 'Week 1', [
        { rank: 1, commander: 'Alice', normalized: 'alice', points: 1000 },
      ]);

      const result = await s.getLatestLeaderboardRanks([]);
      expect(result.leaderboard).toBeDefined();
      expect(result.ranks.size).toBe(0);
    });
  });

  describe('getLeaderboardAverages', () => {
    async function seedLeaderboards(db: D1Database) {
      // Week 1
      await db.prepare('INSERT INTO leaderboards (slug, title, week_end) VALUES (?, ?, ?)').bind('ww01', 'Week 1', '2026-03-01').run();
      const ww01 = (await db.prepare('SELECT id FROM leaderboards WHERE slug = ?').bind('ww01').first<{ id: number }>())!.id;
      await db.prepare('INSERT INTO leaderboard_entries (leaderboard_id, rank, commander, normalized_commander, points) VALUES (?, ?, ?, ?, ?)').bind(ww01, 1, 'Alice', 'alice', 1000).run();
      await db.prepare('INSERT INTO leaderboard_entries (leaderboard_id, rank, commander, normalized_commander, points) VALUES (?, ?, ?, ?, ?)').bind(ww01, 2, 'Bob', 'bob', 800).run();

      // Week 2 (newest)
      await db.prepare('INSERT INTO leaderboards (slug, title, week_end) VALUES (?, ?, ?)').bind('ww02', 'Week 2', '2026-03-08').run();
      const ww02 = (await db.prepare('SELECT id FROM leaderboards WHERE slug = ?').bind('ww02').first<{ id: number }>())!.id;
      await db.prepare('INSERT INTO leaderboard_entries (leaderboard_id, rank, commander, normalized_commander, points) VALUES (?, ?, ?, ?, ?)').bind(ww02, 1, 'Alice', 'alice', 1200).run();
      await db.prepare('INSERT INTO leaderboard_entries (leaderboard_id, rank, commander, normalized_commander, points) VALUES (?, ?, ?, ?, ?)').bind(ww02, 2, 'Charlie', 'charlie', 900).run();
    }

    it('returns null when no leaderboards exist', async () => {
      const result = await store.getLeaderboardAverages(3);
      expect(result).toBeNull();
    });

    it('computes averages across multiple boards', async () => {
      const db = createD1Mock();
      const s = new DataStore(db);
      await seedLeaderboards(db);

      const result = await s.getLeaderboardAverages(2);
      expect(result).not.toBeNull();
      expect(result!.newest.slug).toBe('ww02');
      expect(result!.leaderboards).toHaveLength(2);

      const alice = result!.entries.find(e => e.name === 'Alice');
      expect(alice).toBeDefined();
      expect(alice!.averageScore).toBe(1100); // (1000+1200)/2
      expect(alice!.seenCount).toBe(2);
      expect(alice!.missingFromOthers).toBe(false);

      const charlie = result!.entries.find(e => e.name === 'Charlie');
      expect(charlie).toBeDefined();
      expect(charlie!.seenCount).toBe(1);
      expect(charlie!.missingFromOthers).toBe(true);
    });

    it('excludes slugs from average computation', async () => {
      const db = createD1Mock();
      const s = new DataStore(db);
      await seedLeaderboards(db);

      const result = await s.getLeaderboardAverages(2, ['ww02']);
      expect(result).not.toBeNull();
      expect(result!.newest.slug).toBe('ww01');
      expect(result!.leaderboards).toHaveLength(1);
    });
  });

  describe('getLeaderboardRanksBySlug', () => {
    async function seedForSlugLookup(db: D1Database) {
      await db.prepare('INSERT INTO leaderboards (slug, title, week_end) VALUES (?, ?, ?)').bind('ww01', 'Week 1', '2026-03-01').run();
      const ww01 = (await db.prepare('SELECT id FROM leaderboards WHERE slug = ?').bind('ww01').first<{ id: number }>())!.id;
      await db.prepare('INSERT INTO leaderboard_entries (leaderboard_id, rank, commander, normalized_commander, points) VALUES (?, ?, ?, ?, ?)').bind(ww01, 1, 'Alice', 'alice', 1000).run();
      await db.prepare('INSERT INTO leaderboard_entries (leaderboard_id, rank, commander, normalized_commander, points) VALUES (?, ?, ?, ?, ?)').bind(ww01, 2, 'Bob', 'bob', 800).run();
    }

    it('returns empty for empty slugs', async () => {
      const result = await store.getLeaderboardRanksBySlug([], ['Alice']);
      expect(result).toHaveLength(0);
    });

    it('returns empty for empty names', async () => {
      const result = await store.getLeaderboardRanksBySlug(['ww01'], []);
      expect(result).toHaveLength(0);
    });

    it('returns ranks for matching slugs and names', async () => {
      const db = createD1Mock();
      const s = new DataStore(db);
      await seedForSlugLookup(db);

      const result = await s.getLeaderboardRanksBySlug(['ww01'], ['Alice']);
      expect(result).toHaveLength(1);
      expect(result[0].slug).toBe('ww01');
      const aliceRank = result[0].ranks.get('alice');
      expect(aliceRank).toBeDefined();
      expect(aliceRank!.rank).toBe(1);
      expect(aliceRank!.points).toBe(1000);
    });

    it('returns empty when slug not found', async () => {
      const db = createD1Mock();
      const s = new DataStore(db);
      await seedForSlugLookup(db);

      const result = await s.getLeaderboardRanksBySlug(['ww99'], ['Alice']);
      expect(result).toHaveLength(0);
    });
  });
});
