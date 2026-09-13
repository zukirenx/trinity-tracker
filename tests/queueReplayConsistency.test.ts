import { describe, it, expect, beforeEach } from 'vitest';
import { DataStore } from '../src/storage';
import { createD1Mock } from './d1-mock';

// ─── Strict replay helper ──────────────────────────────────────────────────
// Mirrors the production deploy verifier (scripts/verify-queue-log-replay.cjs):
// replays every train_queue_log entry chronologically onto an empty queue
// with NO force-apply, then asserts the final state equals the live train_queue.
// Tests that go through any queue-mutating code path SHOULD finish by calling
// this so we catch any new code that emits an incorrect (or missing)
// train_queue_log entry.

async function assertQueueLogReplayable(db: D1Database): Promise<void> {
  const logRes = await db.prepare(
    `SELECT id, ts, member_id, member_name, action, from_pos, to_pos
     FROM train_queue_log ORDER BY ts, id`
  ).all<{
    id: number; ts: string; member_id: number; member_name: string;
    action: string; from_pos: number | null; to_pos: number | null;
  }>();

  const order: number[] = [];
  for (const r of logRes.results) {
    switch (r.action) {
      case 'add': {
        const toPos = r.to_pos == null ? order.length + 1 : r.to_pos;
        if (toPos < 1 || toPos > order.length + 1) {
          throw new Error(`id ${r.id} add: to_pos ${toPos} out of range (size=${order.length})`);
        }
        order.splice(toPos - 1, 0, r.member_id);
        break;
      }
      case 'remove':
      case 'merge-remove': {
        if (r.from_pos == null) throw new Error(`id ${r.id} ${r.action}: from_pos is NULL`);
        if (order[r.from_pos - 1] !== r.member_id) {
          throw new Error(
            `id ${r.id} ${r.action} ${r.member_name}: expected member ${r.member_id} at pos ${r.from_pos}, got ${order[r.from_pos - 1]}`
          );
        }
        order.splice(r.from_pos - 1, 1);
        break;
      }
      case 'auto-train':
      case 'manual-move':
      case 'merge-move': {
        if (r.from_pos == null || r.to_pos == null) {
          throw new Error(`id ${r.id} ${r.action}: from_pos/to_pos must not be NULL`);
        }
        if (order[r.from_pos - 1] !== r.member_id) {
          throw new Error(
            `id ${r.id} ${r.action} ${r.member_name}: expected member ${r.member_id} at pos ${r.from_pos}, got ${order[r.from_pos - 1]}`
          );
        }
        order.splice(r.from_pos - 1, 1);
        order.splice(r.to_pos - 1, 0, r.member_id);
        break;
      }
      default:
        throw new Error(`id ${r.id}: unknown action ${r.action}`);
    }
  }

  const liveRes = await db.prepare(
    'SELECT member_id, position FROM train_queue ORDER BY position'
  ).all<{ member_id: number; position: number }>();
  const live = liveRes.results.map(r => r.member_id);
  expect(order).toEqual(live);
}

// Minimal leaderboard entry builder.
function entry(rank: number, commander: string, points = 100): { rank: number; commander: string; points: number } {
  return { rank, commander, points };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('Queue log replay-consistency after leaderboard flows', () => {
  let db: D1Database;
  let store: DataStore;

  beforeEach(() => {
    db = createD1Mock();
    store = new DataStore(db);
  });

  it('replays cleanly after first-ever leaderboard upload + sync', async () => {
    await store.uploadLeaderboard({
      slug: 'wk1', title: 'Week 1', source: 'test',
      entries: [entry(1, 'Alice'), entry(2, 'Bob'), entry(3, 'Charlie')],
    });
    await store.syncTrainQueue();

    const queue = await store.getTrainQueue();
    expect(queue.map(r => r.name).sort()).toEqual(['Alice', 'Bob', 'Charlie']);
    await assertQueueLogReplayable(db);
  });

  it('replays cleanly when a second upload introduces additional members', async () => {
    await store.uploadLeaderboard({
      slug: 'wk1', title: 'Week 1', source: 'test',
      entries: [entry(1, 'Alice'), entry(2, 'Bob')],
    });
    await store.syncTrainQueue();

    await store.uploadLeaderboard({
      slug: 'wk2', title: 'Week 2', source: 'test',
      entries: [entry(1, 'Alice'), entry(2, 'Bob'), entry(3, 'Charlie'), entry(4, 'Dave')],
    });
    await store.syncTrainQueue();

    const queue = await store.getTrainQueue();
    expect(queue).toHaveLength(4);
    await assertQueueLogReplayable(db);
  });

  it('replays cleanly when maintenance deactivates a missing-active member', async () => {
    await store.uploadLeaderboard({
      slug: 'wk1', title: 'Week 1', source: 'test',
      entries: [entry(1, 'Alice'), entry(2, 'Bob'), entry(3, 'Charlie')],
    });
    await store.syncTrainQueue();

    // Bob no longer on the new leaderboard.
    const result = await store.uploadLeaderboard({
      slug: 'wk2', title: 'Week 2', source: 'test',
      entries: [entry(1, 'Alice'), entry(2, 'Charlie')],
    });
    expect(result.missingActiveMembers.map(m => m.displayName)).toContain('Bob');

    // Operator picks "deactivate" for Bob (the maintenance endpoint path).
    const bob = result.missingActiveMembers.find(m => m.displayName === 'Bob')!;
    const ok = await store.deactivateMemberById(bob.id);
    expect(ok).toBe(true);
    await store.syncTrainQueue();

    const queue = await store.getTrainQueue();
    expect(queue.map(r => r.name).sort()).toEqual(['Alice', 'Charlie']);
    await assertQueueLogReplayable(db);
  });

  it('replays cleanly when maintenance merges a duplicate (rename) into the new name', async () => {
    // Initial roster contains "Bob".
    await store.uploadLeaderboard({
      slug: 'wk1', title: 'Week 1', source: 'test',
      entries: [entry(1, 'Alice'), entry(2, 'Bob'), entry(3, 'Charlie')],
    });
    await store.syncTrainQueue();

    // New upload: Bob has been renamed to "Robert" — appears as a new commander,
    // and old "Bob" is reported in missingActiveMembers.
    const result = await store.uploadLeaderboard({
      slug: 'wk2', title: 'Week 2', source: 'test',
      entries: [entry(1, 'Alice'), entry(2, 'Robert'), entry(3, 'Charlie')],
    });
    const missingBob = result.missingActiveMembers.find(m => m.displayName === 'Bob');
    expect(missingBob).toBeDefined();

    // Operator picks "merge" — duplicate=Bob, target normalized name='robert'.
    // This goes through mergeMemberById, which must update queue + emit logs.
    const ok = await store.mergeMemberById(missingBob!.id, 'robert');
    expect(ok).toBe(true);

    // Sync to bring queue in line with active membership.
    await store.syncTrainQueue();

    const queue = await store.getTrainQueue();
    const names = queue.map(r => r.name).sort();
    expect(names).toEqual(['Alice', 'Charlie', 'Robert']);
    // Robert should sit in Bob's old slot (pos 2), since merge inherits min position.
    expect(queue.find(r => r.name === 'Robert')?.position).toBe(2);

    await assertQueueLogReplayable(db);
  });

  it('replays cleanly through a mixed maintenance batch (keep + merge + deactivate)', async () => {
    await store.uploadLeaderboard({
      slug: 'wk1', title: 'Week 1', source: 'test',
      entries: [
        entry(1, 'Alice'), entry(2, 'Bob'), entry(3, 'Charlie'),
        entry(4, 'Dave'), entry(5, 'Eve'),
      ],
    });
    await store.syncTrainQueue();

    // Week 2: Bob renamed to "Robert", Charlie quit, Eve stays, plus new "Frank".
    const result = await store.uploadLeaderboard({
      slug: 'wk2', title: 'Week 2', source: 'test',
      entries: [
        entry(1, 'Alice'), entry(2, 'Robert'), entry(3, 'Dave'),
        entry(4, 'Eve'), entry(5, 'Frank'),
      ],
    });
    const missingByName = new Map(result.missingActiveMembers.map(m => [m.displayName, m]));
    expect(missingByName.has('Bob')).toBe(true);
    expect(missingByName.has('Charlie')).toBe(true);

    // Maintenance decisions:
    //   Bob -> merge into 'robert'
    //   Charlie -> deactivate
    await store.mergeMemberById(missingByName.get('Bob')!.id, 'robert');
    await store.deactivateMemberById(missingByName.get('Charlie')!.id);
    await store.syncTrainQueue();

    const queue = await store.getTrainQueue();
    const names = queue.map(r => r.name).sort();
    expect(names).toEqual(['Alice', 'Dave', 'Eve', 'Frank', 'Robert']);
    await assertQueueLogReplayable(db);
  });

  it('does NOT spawn a ghost member when a leaderboard row matches an existing alias', async () => {
    // After a merge, "Bob" is an alias of "Robert". Re-uploading a board
    // that contains "Bob" used to insert a fresh ghost member because the
    // upload only checked normalized_name on members. The ghost would then
    // get re-added to the queue on every sync, corrupting the queue log.
    await store.uploadLeaderboard({
      slug: 'wk1', title: 'Week 1', source: 'test',
      entries: [entry(1, 'Alice'), entry(2, 'Bob'), entry(3, 'Charlie')],
    });
    await store.syncTrainQueue();

    // Operator merges Bob into Robert (so 'Bob' becomes an alias of Robert).
    const beforeMembers = await db.prepare(
      `SELECT id, display_name FROM members ORDER BY id`
    ).all<{ id: number; display_name: string }>();
    const bob = beforeMembers.results.find(m => m.display_name === 'Bob');
    expect(bob).toBeDefined();
    // Simulate the rename by adding a Robert and merging Bob -> robert.
    await db.prepare(
      `INSERT INTO members (display_name, normalized_name, active) VALUES ('Robert', 'robert', 1)`
    ).run();
    const ok = await store.mergeMemberById(bob!.id, 'robert');
    expect(ok).toBe(true);

    const memberCountAfterMerge = await db.prepare(
      `SELECT COUNT(*) AS n FROM members`
    ).first<{ n: number }>();

    // Now re-upload a board that still contains "Bob" (e.g., OCR'd from an
    // older leaderboard image, or someone retyped the old spelling).
    await store.uploadLeaderboard({
      slug: 'wk2', title: 'Week 2', source: 'test',
      entries: [entry(1, 'Alice'), entry(2, 'Bob'), entry(3, 'Charlie')],
    });
    await store.syncTrainQueue();

    const memberCountAfterReupload = await db.prepare(
      `SELECT COUNT(*) AS n FROM members`
    ).first<{ n: number }>();
    expect(memberCountAfterReupload!.n).toBe(memberCountAfterMerge!.n);

    // Robert (canonical) should be in the queue, Bob should not exist as
    // a separate member.
    const queue = await store.getTrainQueue();
    expect(queue.map(r => r.name).sort()).toEqual(['Alice', 'Charlie', 'Robert']);
    await assertQueueLogReplayable(db);
  });

  it('replays cleanly when a merged duplicate sits ABOVE the target in the queue', async () => {
    // Seed with two members so we can have the duplicate above the target.
    // 'aaa' will sort to position 1, 'zzz' to position 2.
    await store.uploadLeaderboard({
      slug: 'wk1', title: 'Week 1', source: 'test',
      entries: [entry(1, 'aaa'), entry(2, 'zzz')],
    });
    await store.syncTrainQueue();

    // Both members are in the queue. Merge 'aaa' (pos 1, duplicate) into
    // 'zzz' (pos 2, target). After splicing 'aaa' out, target should sit at
    // pos 1. This exercises the dup_pos < target_old branch where from_pos
    // shifts up by one at replay time.
    const queue = await store.getTrainQueue();
    const aaaId = queue.find(r => r.name === 'aaa')!.memberId;
    const ok = await store.mergeMemberById(aaaId, 'zzz');
    expect(ok).toBe(true);

    const after = await store.getTrainQueue();
    expect(after.map(r => r.name)).toEqual(['zzz']);
    expect(after[0].position).toBe(1);

    await assertQueueLogReplayable(db);
  });
});

// ─── Auto-train rotation replay tests ──────────────────────────────────────
// These specifically guard the from_pos correctness when multiple members are
// rotated to the end in a single syncTrainQueue call (the concurrent-request
// race that historically produced wrong from_pos values is prevented by using
// db.batch() for each rotation, making each SELECT+UPDATE+INSERT atomic).

describe('Auto-train log replay consistency', () => {
  let db: D1Database;
  let store: DataStore;

  beforeEach(async () => {
    db = createD1Mock();
    store = new DataStore(db);
  });

  function addTrainReward(driverName: string, date: string, msgId: string) {
    return db.prepare(
      `INSERT INTO rewards (date, driver_name, vip_name, type, raw_text, source_message_id, source_line)
       VALUES (?, ?, NULL, 'TRAIN', '', ?, 1)`
    ).bind(date, driverName, msgId).run();
  }

  it('produces correct from_pos when two members rotate in the same sync call', async () => {
    // Regression: concurrent syncTrainQueue calls used non-atomic SELECT+N×UPDATE,
    // leaving position gaps and logging wrong from_pos values.
    // E.g. after rotating member A (pos 1→end), member B slides to pos 1, but a
    // concurrent call that read a stale snapshot would still record B's from_pos as 2.
    //
    // Queue: Alice(1) Bob(2) Charlie(3)
    // Rotate Alice and Bob on the same date — both slide through positions as
    // each is moved, so their from_pos values must reflect the post-previous-move state.
    await store.addMember('Alice');
    await store.addMember('Bob');
    await store.addMember('Charlie');
    await store.syncTrainQueue(); // seed: Alice=1, Bob=2, Charlie=3

    await addTrainReward('Alice', '2026-01-01', 'msg1');
    await addTrainReward('Bob',   '2026-01-01', 'msg2');
    await store.syncTrainQueue();

    // Alice (pos 1) rotates first (same date, lower oldPos); Bob slides to pos 1
    // then rotates; Charlie ends at pos 1.
    const queue = await store.getTrainQueue();
    expect(queue.map(r => r.name)).toEqual(['Charlie', 'Alice', 'Bob']);
    expect(queue.map(r => r.position)).toEqual([1, 2, 3]);

    const log = (await store.getTrainQueueLog())
      .filter(e => e.action === 'auto-train')
      .sort((a, b) => a.id - b.id); // chronological order
    expect(log).toHaveLength(2);
    // Alice was at pos 1 when rotated.
    expect(log[0].memberName).toBe('Alice');
    expect(log[0].fromPos).toBe(1);
    expect(log[0].toPos).toBe(3);
    // After Alice's rotation Bob slid to pos 1 — from_pos must be 1, not 2.
    expect(log[1].memberName).toBe('Bob');
    expect(log[1].fromPos).toBe(1);
    expect(log[1].toPos).toBe(3);

    await assertQueueLogReplayable(db);
  });

  it('produces correct from_pos when three members rotate in the same sync call', async () => {
    await store.addMember('Alice');
    await store.addMember('Bob');
    await store.addMember('Charlie');
    await store.addMember('Dave');
    await store.addMember('Eve');
    await store.syncTrainQueue(); // seed: Alice=1 Bob=2 Charlie=3 Dave=4 Eve=5

    await addTrainReward('Alice',   '2026-01-01', 'msg1');
    await addTrainReward('Charlie', '2026-01-01', 'msg2');
    await addTrainReward('Eve',     '2026-01-01', 'msg3');
    await store.syncTrainQueue();

    // Rotation order (same date, sorted by oldPos): Alice(1) → Charlie(3) → Eve(5)
    // After Alice: [Bob=1, Charlie=2, Dave=3, Eve=4, Alice=5]
    // After Charlie: [Bob=1, Dave=2, Eve=3, Alice=4, Charlie=5]
    // After Eve: [Bob=1, Dave=2, Alice=3, Charlie=4, Eve=5]
    const queue = await store.getTrainQueue();
    expect(queue.map(r => r.name)).toEqual(['Bob', 'Dave', 'Alice', 'Charlie', 'Eve']);
    expect(queue.map(r => r.position)).toEqual([1, 2, 3, 4, 5]);

    const log = (await store.getTrainQueueLog())
      .filter(e => e.action === 'auto-train')
      .sort((a, b) => a.id - b.id); // chronological order
    expect(log).toHaveLength(3);
    // Alice (original pos 1) rotates first.
    expect(log[0]).toMatchObject({ memberName: 'Alice',   fromPos: 1, toPos: 5 });
    // After Alice moves: Bob@1, Charlie@2, Dave@3, Eve@4, Alice@5
    // Charlie's rank is now 2 (one member before it: Bob).
    expect(log[1]).toMatchObject({ memberName: 'Charlie', fromPos: 2, toPos: 5 });
    // After Charlie moves: Bob@1, Dave@2, Eve@3, Alice@4, Charlie@5
    // Eve's rank is now 3 (two members before it: Bob, Dave).
    expect(log[2]).toMatchObject({ memberName: 'Eve',     fromPos: 3, toPos: 5 });

    await assertQueueLogReplayable(db);
  });
});
