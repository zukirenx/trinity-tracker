import { describe, it, expect, beforeEach } from 'vitest';
import { DataStore } from '../src/storage';
import { EventsStore } from '../src/eventsStore';
import { createD1Mock } from './d1-mock';

function entry(rank: number, commander: string, points: number): { rank: number; commander: string; points: number } {
  return { rank, commander, points };
}

async function memberId(db: D1Database, name: string): Promise<number> {
  const row = await db.prepare('SELECT id FROM members WHERE display_name = ?').bind(name).first<{ id: number }>();
  if (!row) throw new Error(`member ${name} not found`);
  return row.id;
}

// Wraps a D1 mock and records the largest bind() payload seen. Lets tests
// prove no statement exceeds D1's ~100-variable limit (better-sqlite3 itself
// would happily accept thousands, so the limit must be asserted explicitly).
function countingDb(inner: D1Database): { db: D1Database; maxBindings: () => number } {
  let max = 0;
  const db = {
    prepare: (sql: string) => {
      const stmt = inner.prepare(sql) as unknown as Record<string, any>;
      return {
        ...stmt,
        bind: (...params: unknown[]) => {
          if (params.length > max) max = params.length;
          return stmt.bind(...params);
        },
      };
    },
    batch: (stmts: any[]) => (inner as unknown as { batch: (s: any[]) => Promise<unknown> }).batch(stmts),
  };
  return { db: db as unknown as D1Database, maxBindings: () => max };
}

describe('score reviews (store level)', () => {
  let db: D1Database;
  let store: DataStore;
  let events: EventsStore;

  beforeEach(() => {
    db = createD1Mock();
    store = new DataStore(db);
    events = new EventsStore(db);
  });

  it('creates and lists pending reviews, then clears them', async () => {
    const up = await store.uploadLeaderboard({
      slug: 'wk1', title: 'Week 1', source: 'test',
      entries: [entry(1, 'Alice', 100), entry(2, 'Bob', 90)],
    });
    await store.ensureScoreReview('wk1', up.leaderboardId);
    let pending = await store.listPendingScoreReviews();
    expect(pending.map((p) => p.slug)).toEqual(['wk1']);

    await store.setScoreReviewStatus('wk1', 'penalties_status', 'done');
    pending = await store.listPendingScoreReviews();
    // Bans still pending -> still listed.
    expect(pending.map((p) => p.slug)).toEqual(['wk1']);

    await store.setScoreReviewStatus('wk1', 'bans_status', 'skipped');
    pending = await store.listPendingScoreReviews();
    expect(pending).toEqual([]);
  });

  it('tracks capped-max streaks across consecutive leaderboards', async () => {
    const b1 = await store.uploadLeaderboard({
      slug: 's1', title: 'S1', source: 'test', weekStart: '2026-01-01', weekEnd: '2026-01-07',
      entries: [entry(1, 'Whale', 15_000_000), entry(2, 'Minnow', 100)],
    });
    const b2 = await store.uploadLeaderboard({
      slug: 's2', title: 'S2', source: 'test', weekStart: '2026-01-08', weekEnd: '2026-01-14',
      entries: [entry(1, 'Whale', 16_000_000), entry(2, 'Minnow', 100)],
    });
    const whaleId = await memberId(db, 'Whale');

    // Week 1: Whale capped (raw 6 > cap 5).
    await store.saveScorePenalties(b1.leaderboardId, [{
      memberId: whaleId, normalized: 'whale', commander: 'Whale',
      points: 15_000_000, rawPenalty: 6, appliedPenalty: 5, capped: true, reason: 'above-max',
    }]);

    // Week 2 preview (Whale capped again) -> streak 2.
    const streaks = await store.getCappedStreaks(b2.leaderboardId, [{ normalized: 'whale', memberId: whaleId }]);
    expect(streaks.get('whale')).toBe(2);

    // A third board where Whale is NOT capped breaks the streak.
    const b3 = await store.uploadLeaderboard({
      slug: 's3', title: 'S3', source: 'test', weekStart: '2026-01-15', weekEnd: '2026-01-21',
      entries: [entry(1, 'Whale', 9_000_000), entry(2, 'Minnow', 100)],
    });
    const fresh = await store.getCappedStreaks(b3.leaderboardId, [{ normalized: 'whale', memberId: whaleId }]);
    expect(fresh.get('whale')).toBe(1);
  });

  it('survives D1 variable limits with many boards and candidates (chunked IN queries)', async () => {
    // 40 boards + 40 candidate norms + 40 member ids = ~119 bindings, well
    // over D1's ~100 variable limit. The counting wrapper fails the test if
    // any single statement binds more than 80 variables.
    const ids: number[] = [];
    for (let i = 0; i < 40; i++) {
      const slug = `chunk-${i}`;
      await db.prepare('INSERT INTO leaderboards (slug, title) VALUES (?, ?)').bind(slug, slug).run();
      const row = await db.prepare('SELECT id FROM leaderboards WHERE slug = ?').bind(slug).first<{ id: number }>();
      ids.push(row!.id);
    }
    const newest = ids[ids.length - 1];
    const counted = countingDb(db);
    const countedStore = new DataStore(counted.db);
    const candidates = Array.from({ length: 40 }, (_, i) => ({ normalized: `ghost${i}`, memberId: 1000 + i }));
    const streaks = await countedStore.getCappedStreaks(newest, candidates);
    expect(streaks.size).toBe(40);
    for (const s of streaks.values()) expect(s).toBe(1);
    expect(counted.maxBindings()).toBeLessThanOrEqual(80);

    // Correctness across chunk boundaries: whale capped on every board.
    for (const id of ids) {
      await store.saveScorePenalties(id, [{
        memberId: null, normalized: 'whale', commander: 'Whale',
        points: 15_000_000, rawPenalty: 6, appliedPenalty: 5, capped: true, reason: 'above-max',
      }]);
    }
    const whale = await countedStore.getCappedStreaks(newest, [{ normalized: 'whale', memberId: null }]);
    expect(whale.get('whale')).toBe(40);
    expect(counted.maxBindings()).toBeLessThanOrEqual(80);
  });

  it('chunks the ban-confirm member lookup (120 ids stay under the D1 limit)', async () => {
    const names = Array.from({ length: 120 }, (_, i) => `BanTarget${i}`);
    await store.bulkEnsureMembers(names);
    const rows = await db.prepare('SELECT id FROM members ORDER BY id').all<{ id: number }>();
    const ids = rows.results.map((r) => r.id);
    expect(ids.length).toBeGreaterThanOrEqual(120);

    const counted = countingDb(db);
    const countedEvents = new EventsStore(counted.db);
    const res = await countedEvents.confirmScoreDsBans({ sourceSlug: 'many', memberIds: ids.slice(0, 120), targetEventId: null });
    expect(res.queued.length).toBe(120);
    expect(counted.maxBindings()).toBeLessThanOrEqual(50);
  });

  it('refuses to save penalties twice for the same leaderboard', async () => {
    const b = await store.uploadLeaderboard({
      slug: 'dup', title: 'Dup', source: 'test',
      entries: [entry(1, 'Solo', 10)],
    });
    const soloId = await memberId(db, 'Solo');
    await store.saveScorePenalties(b.leaderboardId, [{
      memberId: soloId, normalized: 'solo', commander: 'Solo',
      points: 10, rawPenalty: 1, appliedPenalty: 1, capped: false, reason: 'below-min',
    }]);
    expect(await store.hasScorePenalties(b.leaderboardId)).toBe(true);
    await expect(store.saveScorePenalties(b.leaderboardId, [{
      memberId: soloId, normalized: 'solo', commander: 'Solo',
      points: 10, rawPenalty: 1, appliedPenalty: 1, capped: false, reason: 'below-min',
    }])).rejects.toThrow(/already applied/);
  });

  it('round-trips score defaults through settings', async () => {
    const before = await events.getEventsSettings();
    expect(before.scoreMinPoints).toBe(7_200_000);
    expect(before.scoreMaxPoints).toBeNull();
    expect(before.scoreMaxCap).toBe(5);
    expect(before.scoreStreakThreshold).toBe(2);

    await events.saveEventsSettings({
      scoreMinPoints: 5_000_000,
      scoreBelowPenalty: 2,
      scoreMaxPoints: 12_000_000,
      scoreSevereStep: 2_000_000,
      scoreMaxCap: 3,
      scoreStreakThreshold: 3,
    });
    const after = await events.getEventsSettings();
    expect(after.scoreMinPoints).toBe(5_000_000);
    expect(after.scoreBelowPenalty).toBe(2);
    expect(after.scoreMaxPoints).toBe(12_000_000);
    expect(after.scoreSevereStep).toBe(2_000_000);
    expect(after.scoreMaxCap).toBe(3);
    expect(after.scoreStreakThreshold).toBe(3);

    // Unsetting the max stores empty -> read back as null.
    await events.saveEventsSettings({ scoreMaxPoints: null });
    expect((await events.getEventsSettings()).scoreMaxPoints).toBeNull();

    await expect(events.saveEventsSettings({ scoreMaxCap: 0 })).rejects.toThrow();
    await expect(events.saveEventsSettings({ scoreStreakThreshold: 99 })).rejects.toThrow();
  });

  it('finds the next open-registration desert, ignoring closed ones', async () => {
    const closed = await events.createEvent({
      kind: 'desert', weekStart: '2026-06-01',
      registrationClosesAt: '2000-01-01T00:00:00.000Z', notes: null,
    });
    const open = await events.createEvent({
      kind: 'desert', weekStart: '2026-06-08',
      registrationClosesAt: '2999-01-01T00:00:00.000Z', notes: null,
    });
    const next = await events.findNextDesertWithOpenRegistration();
    expect(next?.id).toBe(open.id);
    const latestClosed = await events.findLatestClosedDesert();
    expect(latestClosed?.id).toBe(closed.id);
  });

  it('bans confirmed offenders once, immediately when registered', async () => {
    await store.uploadLeaderboard({
      slug: 'ban1', title: 'Ban1', source: 'test',
      entries: [entry(1, 'Offender', 15_000_000), entry(2, 'Calm', 100)],
    });
    const offId = await memberId(db, 'Offender');
    const open = await events.createEvent({
      kind: 'desert', weekStart: '2026-06-08',
      registrationClosesAt: '2999-01-01T00:00:00.000Z', notes: null,
    });
    await events.upsertRegistration(open.id, offId, { status: 'IN', squadPower: 100, squadType: 'tanks' });

    const first = await events.confirmScoreDsBans({ sourceSlug: 'ban1', memberIds: [offId], targetEventId: open.id });
    expect(first.bannedNow).toEqual([offId]);
    const regs = await events.listRegistrations(open.id);
    expect(regs.find((r) => r.memberId === offId)?.isBanned).toBe(true);

    // A second leaderboard confirming the same player for the same event bans once.
    const second = await events.confirmScoreDsBans({ sourceSlug: 'ban2', memberIds: [offId], targetEventId: open.id });
    expect(second.alreadyBanned).toEqual([offId]);
    expect(second.bannedNow).toEqual([]);
  });

  it('catches late registrants via the score-ban hook', async () => {
    await store.uploadLeaderboard({
      slug: 'late1', title: 'Late1', source: 'test',
      entries: [entry(1, 'LateReg', 15_000_000), entry(2, 'Calm', 100)],
    });
    const lateId = await memberId(db, 'LateReg');
    const open = await events.createEvent({
      kind: 'desert', weekStart: '2026-06-08',
      registrationClosesAt: '2999-01-01T00:00:00.000Z', notes: null,
    });
    // Confirm before the player registers -> queued for the event.
    const res = await events.confirmScoreDsBans({ sourceSlug: 'late1', memberIds: [lateId], targetEventId: open.id });
    expect(res.queued).toEqual([lateId]);

    await events.upsertRegistration(open.id, lateId, { status: 'IN', squadPower: 50, squadType: 'tanks' });
    expect(await events.checkAndApplyScoreBan(open.id, lateId)).toBe(true);
    const regs = await events.listRegistrations(open.id);
    expect(regs.find((r) => r.memberId === lateId)?.isBanned).toBe(true);
  });

  it('queues bans with no open desert and attaches them to the next one', async () => {
    await store.uploadLeaderboard({
      slug: 'q1', title: 'Q1', source: 'test',
      entries: [entry(1, 'Queued', 15_000_000), entry(2, 'Calm', 100)],
    });
    const qId = await memberId(db, 'Queued');
    const res = await events.confirmScoreDsBans({ sourceSlug: 'q1', memberIds: [qId], targetEventId: null });
    expect(res.queued).toEqual([qId]);

    const fresh = await events.createEvent({
      kind: 'desert', weekStart: '2026-07-01',
      registrationClosesAt: '2999-01-01T00:00:00.000Z', notes: null,
    });
    await events.upsertRegistration(fresh.id, qId, { status: 'IN', squadPower: 50, squadType: 'tanks' });
    expect(await events.attachQueuedScoreBansToDesert(fresh.id)).toBe(1);
    const regs = await events.listRegistrations(fresh.id);
    expect(regs.find((r) => r.memberId === qId)?.isBanned).toBe(true);
    // Attaching again is a no-op (once-only).
    expect(await events.attachQueuedScoreBansToDesert(fresh.id)).toBe(0);
  });
});
