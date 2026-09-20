import { describe, it, expect } from 'vitest';
import worker, { type Env } from '../src/index';
import { EventsStore } from '../src/eventsStore';
import { createD1Mock } from './d1-mock';

function makeEnv(): Env {
  return {
    DISCORD_PUBLIC_KEY: 'pk',
    DISCORD_BOT_TOKEN: 'bt',
    DISCORD_APPLICATION_ID: 'app',
    TRACKING_CHANNEL_ID: 'ch',
    GUILD_ID: 'g',
    DB: createD1Mock(),
    WEB_ACCESS_TOKEN: 'secret-token',
    WEB_READONLY_TOKEN: 'readonly-token',
  } as Env;
}

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

async function postApi(env: Env, path: string, body: unknown, token = 'secret-token'): Promise<Response> {
  return worker.fetch(
    new Request(`https://example.com${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }),
    env,
    ctx,
  );
}

async function getApi(env: Env, path: string, token = 'secret-token'): Promise<Response> {
  const sep = path.includes('?') ? '&' : '?';
  return worker.fetch(new Request(`https://example.com${path}${sep}token=${token}`), env, ctx);
}

async function postJson(env: Env, path: string, body: unknown, token = 'secret-token'): Promise<{ status: number; data: any }> {
  const res = await postApi(env, path, body, token);
  return { status: res.status, data: await res.json() };
}

async function activeIds(env: Env): Promise<Map<string, number>> {
  const res = await getApi(env, '/api/active');
  const data = (await res.json()) as { entries: Array<{ id: number; name: string }> };
  return new Map(data.entries.map((e) => [e.name, e.id] as const));
}

async function queueNames(env: Env): Promise<string[]> {
  const res = await getApi(env, '/api/queue');
  const data = (await res.json()) as { queue: Array<{ name: string }> };
  return data.queue.map((q) => q.name);
}

// Strict replay check (mirrors scripts/verify-queue-log-replay.cjs).
async function assertQueueLogReplayable(db: D1Database): Promise<void> {
  const logRes = await db.prepare(
    `SELECT id, ts, member_id, member_name, action, from_pos, to_pos
     FROM train_queue_log ORDER BY ts, id`,
  ).all<{
    id: number; ts: string; member_id: number; member_name: string;
    action: string; from_pos: number | null; to_pos: number | null;
  }>();
  const order: number[] = [];
  for (const r of logRes.results) {
    switch (r.action) {
      case 'add': {
        const toPos = r.to_pos == null ? order.length + 1 : r.to_pos;
        if (toPos < 1 || toPos > order.length + 1) throw new Error(`id ${r.id} add out of range`);
        order.splice(toPos - 1, 0, r.member_id);
        break;
      }
      case 'remove':
      case 'merge-remove': {
        if (r.from_pos == null || order[r.from_pos - 1] !== r.member_id) {
          throw new Error(`id ${r.id} ${r.action}: member mismatch`);
        }
        order.splice(r.from_pos - 1, 1);
        break;
      }
      case 'auto-train':
      case 'manual-move':
      case 'merge-move': {
        if (r.from_pos == null || r.to_pos == null || order[r.from_pos - 1] !== r.member_id) {
          throw new Error(`id ${r.id} ${r.action}: member mismatch`);
        }
        order.splice(r.from_pos - 1, 1);
        order.splice(r.to_pos - 1, 0, r.member_id);
        break;
      }
      case 'rename':
        break;
      default:
        throw new Error(`id ${r.id}: unknown action ${r.action}`);
    }
  }
  const liveRes = await db.prepare('SELECT member_id FROM train_queue ORDER BY position').all<{ member_id: number }>();
  expect(order).toEqual(liveRes.results.map((r) => r.member_id));
}

const Q1_ENTRIES = [
  { rank: 1, commander: 'Bravo', points: 9_000_000 },
  { rank: 2, commander: 'Carl', points: 8_000_000 },
  { rank: 3, commander: 'Dan', points: 7_000_000 },
  { rank: 4, commander: 'Echo', points: 6_000_000 },
  { rank: 5, commander: 'Alpha', points: 1_000_000 },
];

const MIN_CFG = {
  minEnabled: true, minPoints: 5_000_000, belowMinPenalty: 2,
  maxEnabled: false, streakThreshold: 2,
};

describe('score review API: queue penalties', () => {
  it('uploads open a pending review; preview/apply moves the queue down; replay stays clean', async () => {
    const env = makeEnv();
    for (const name of ['Alpha', 'Bravo', 'Carl', 'Dan', 'Echo']) {
      const r = await postApi(env, '/api/add-member', { name });
      expect(r.status).toBe(200);
    }
    expect(await queueNames(env)).toEqual(['Alpha', 'Bravo', 'Carl', 'Dan', 'Echo']);

    const up = await postJson(env, '/api/upload-leaderboard', { slug: 'q1', title: 'Q1', entries: Q1_ENTRIES });
    expect(up.status).toBe(200);
    expect(up.data.scoreReviewPending).toBe(true);

    const pending = (await (await getApi(env, '/api/leaderboard-score-pending')).json()) as {
      pending: Array<{ slug: string; penaltiesStatus: string; bansStatus: string }>;
    };
    expect(pending.pending.map((p) => p.slug)).toContain('q1');

    const preview = await postJson(env, '/api/leaderboard-score-preview', { slug: 'q1', config: MIN_CFG });
    expect(preview.status).toBe(200);
    expect(preview.data.penalties).toHaveLength(1);
    expect(preview.data.penalties[0]).toMatchObject({ commander: 'Alpha', penalty: 2, reason: 'below-min' });
    expect(preview.data.regulars).toEqual([]);

    const apply = await postJson(env, '/api/leaderboard-score-apply', { slug: 'q1', config: MIN_CFG });
    expect(apply.status).toBe(200);
    expect(apply.data.moves).toHaveLength(1);
    expect(apply.data.moves[0]).toMatchObject({ fromPos: 1, toPos: 3 });
    expect(await queueNames(env)).toEqual(['Bravo', 'Carl', 'Alpha', 'Dan', 'Echo']);
    await assertQueueLogReplayable(env.DB);

    // Double-apply is blocked.
    const again = await postJson(env, '/api/leaderboard-score-apply', { slug: 'q1', config: MIN_CFG });
    expect(again.status).toBe(409);

    // Min-only config yields no regulars, so bans were auto-skipped on apply
    // and the review is fully done (no longer pending).
    expect(apply.data.bansAutoSkipped).toBe(true);
    const gone = (await (await getApi(env, '/api/leaderboard-score-pending')).json()) as {
      pending: Array<{ slug: string }>;
    };
    expect(gone.pending.map((p) => p.slug)).not.toContain('q1');
  });

  it('auto-skips bans on apply when the config yields no regulars', async () => {
    const env = makeEnv();
    const up = await postJson(env, '/api/upload-leaderboard', { slug: 'auto1', title: 'Auto1', entries: Q1_ENTRIES });
    expect(up.status).toBe(200);
    // Min-only config: no max rule, so no capped hits and no regulars possible.
    const apply = await postJson(env, '/api/leaderboard-score-apply', { slug: 'auto1', config: MIN_CFG });
    expect(apply.status).toBe(200);
    expect(apply.data.bansAutoSkipped).toBe(true);

    const status = (await (await getApi(env, '/api/leaderboard-score-status?slug=auto1')).json()) as {
      review: { penaltiesStatus: string; bansStatus: string };
    };
    expect(status.review).toEqual({ penaltiesStatus: 'done', bansStatus: 'skipped' });
    const pending = (await (await getApi(env, '/api/leaderboard-score-pending')).json()) as {
      pending: Array<{ slug: string }>;
    };
    expect(pending.pending.map((p) => p.slug)).not.toContain('auto1');
  });

  it('rejects invalid configs and unknown leaderboards', async () => {
    const env = makeEnv();
    const up = await postJson(env, '/api/upload-leaderboard', { slug: 'v1', title: 'V1', entries: Q1_ENTRIES });
    expect(up.status).toBe(200);
    const bad = await postJson(env, '/api/leaderboard-score-preview', {
      slug: 'v1',
      config: { ...MIN_CFG, maxEnabled: true, maxPoints: 1_000_000 },
    });
    expect(bad.status).toBe(400);
    const missing = await postJson(env, '/api/leaderboard-score-preview', { slug: 'nope', config: MIN_CFG });
    expect(missing.status).toBe(404);
  });

  it('requires admin for all score endpoints', async () => {
    const env = makeEnv();
    await postApi(env, '/api/upload-leaderboard', { slug: 'r1', title: 'R1', entries: Q1_ENTRIES });
    for (const [method, path, body] of [
      ['POST', '/api/leaderboard-score-preview', { slug: 'r1', config: MIN_CFG }],
      ['POST', '/api/leaderboard-score-apply', { slug: 'r1', config: MIN_CFG }],
      ['POST', '/api/leaderboard-score-bans', { slug: 'r1', config: MIN_CFG, memberIds: [] }],
      ['POST', '/api/leaderboard-score-skip', { slug: 'r1', scope: 'all' }],
    ] as const) {
      const res = await postApi(env, path, body, 'readonly-token');
      expect(res.status, `${method} ${path}`).toBe(403);
    }
    expect((await getApi(env, '/api/leaderboard-score-pending', 'readonly-token')).status).toBe(403);
    expect((await getApi(env, '/api/leaderboard-score-status?slug=r1', 'readonly-token')).status).toBe(403);
  });
});

describe('score review API: regular offenders and DS bans', () => {
  const MAX_CFG = {
    minEnabled: false, maxEnabled: true, maxPoints: 10_000_000,
    severeStep: 1_000_000, maxCap: 5, streakThreshold: 2,
  };

  async function setupTwoBoards(env: Env): Promise<{ whaleId: number; zedId: number }> {
    const b1 = await postJson(env, '/api/upload-leaderboard', {
      slug: 'b1', title: 'B1', weekStart: '2026-01-01', weekEnd: '2026-01-07',
      entries: [
        { rank: 1, commander: 'Whale', points: 15_000_000 },
        { rank: 2, commander: 'Zed', points: 100 },
      ],
    });
    expect(b1.status).toBe(200);
    const a1 = await postJson(env, '/api/leaderboard-score-apply', { slug: 'b1', config: MAX_CFG });
    expect(a1.status).toBe(200);
    expect(a1.data.penalties).toHaveLength(1);
    expect(a1.data.penalties[0]).toMatchObject({ commander: 'Whale', penalty: 5 });

    const b2 = await postJson(env, '/api/upload-leaderboard', {
      slug: 'b2', title: 'B2', weekStart: '2026-01-08', weekEnd: '2026-01-14',
      entries: [
        { rank: 1, commander: 'Whale', points: 16_000_000 },
        { rank: 2, commander: 'Zed', points: 100 },
      ],
    });
    expect(b2.status).toBe(200);
    const ids = await activeIds(env);
    return { whaleId: ids.get('Whale')!, zedId: ids.get('Zed')! };
  }

  it('lists regulars with streaks and bans only the next open-registration DS, once', async () => {
    const env = makeEnv();
    const { whaleId, zedId } = await setupTwoBoards(env);
    expect(whaleId).toBeGreaterThan(0);
    expect(zedId).toBeGreaterThan(0);

    const events = new EventsStore(env.DB);
    const closedDs = await events.createEvent({
      kind: 'desert', weekStart: '2026-06-01',
      registrationClosesAt: '2000-01-01T00:00:00.000Z', notes: null,
    });
    const openDs = await events.createEvent({
      kind: 'desert', weekStart: '2026-06-08',
      registrationClosesAt: '2999-01-01T00:00:00.000Z', notes: null,
    });
    // Whale is registered in both events before the confirm.
    for (const ev of [closedDs, openDs]) {
      const r = await postApi(env, '/api/events/register', {
        eventId: ev.id, memberId: whaleId, status: 'IN', squadPower: 100, squadType: 'tanks', timeSlot: '22',
      });
      expect(r.status).toBe(200);
    }

    const preview = await postJson(env, '/api/leaderboard-score-preview', { slug: 'b2', config: MAX_CFG });
    expect(preview.status).toBe(200);
    expect(preview.data.regulars).toHaveLength(1);
    expect(preview.data.regulars[0]).toMatchObject({ commander: 'Whale', streak: 2, alreadyBanned: false });
    expect(preview.data.targetDesert?.id).toBe(openDs.id);
    expect(preview.data.closedDesert?.id).toBe(closedDs.id);

    const bans = await postJson(env, '/api/leaderboard-score-bans', {
      slug: 'b2', config: MAX_CFG, memberIds: [whaleId],
    });
    expect(bans.status).toBe(200);
    expect(bans.data.bannedNow).toEqual([whaleId]);
    expect(bans.data.targetDesert?.id).toBe(openDs.id);

    const regsOpen = await events.listRegistrations(openDs.id);
    expect(regsOpen.find((r) => r.memberId === whaleId)?.isBanned).toBe(true);
    // The closed-registration event is unaffected.
    const regsClosed = await events.listRegistrations(closedDs.id);
    expect(regsClosed.find((r) => r.memberId === whaleId)?.isBanned).toBe(false);

    // Confirming bans for this board twice is blocked.
    const again = await postJson(env, '/api/leaderboard-score-bans', {
      slug: 'b2', config: MAX_CFG, memberIds: [whaleId],
    });
    expect(again.status).toBe(409);

    // A non-regular member cannot be banned through this endpoint.
    const b3 = await postJson(env, '/api/upload-leaderboard', {
      slug: 'b3', title: 'B3', weekStart: '2026-01-15', weekEnd: '2026-01-21',
      entries: [
        { rank: 1, commander: 'Whale', points: 16_000_000 },
        { rank: 2, commander: 'Zed', points: 100 },
      ],
    });
    expect(b3.status).toBe(200);
    const outsider = await postJson(env, '/api/leaderboard-score-bans', {
      slug: 'b3', config: MAX_CFG, memberIds: [zedId],
    });
    expect(outsider.status).toBe(400);

    // Banning with an empty selection just marks bans skipped/done without touching events.
    const none = await postJson(env, '/api/leaderboard-score-bans', { slug: 'b3', config: MAX_CFG, memberIds: [] });
    expect(none.status).toBe(200);
    expect(none.data.bannedNow).toEqual([]);
  });

  it('keeps reviews with pending bans resumable until skipped', async () => {
    const env = makeEnv();
    await setupTwoBoards(env);
    // Apply penalties for b2 with a regular present -> bans stay pending.
    const apply = await postJson(env, '/api/leaderboard-score-apply', { slug: 'b2', config: MAX_CFG });
    expect(apply.status).toBe(200);
    expect(apply.data.bansAutoSkipped).toBeFalsy();
    const pending = (await (await getApi(env, '/api/leaderboard-score-pending')).json()) as {
      pending: Array<{ slug: string; bansStatus: string }>;
    };
    const row = pending.pending.find((p) => p.slug === 'b2');
    expect(row?.bansStatus).toBe('pending');

    const skip = await postJson(env, '/api/leaderboard-score-skip', { slug: 'b2', scope: 'bans' });
    expect(skip.status).toBe(200);
    const gone = (await (await getApi(env, '/api/leaderboard-score-pending')).json()) as {
      pending: Array<{ slug: string }>;
    };
    expect(gone.pending.map((p) => p.slug)).not.toContain('b2');
  });

  it('late registrants are banned automatically after the confirm', async () => {
    const env = makeEnv();
    const { whaleId } = await setupTwoBoards(env);
    const events = new EventsStore(env.DB);
    const openDs = await events.createEvent({
      kind: 'desert', weekStart: '2026-06-08',
      registrationClosesAt: '2999-01-01T00:00:00.000Z', notes: null,
    });
    // Confirm while Whale has NOT registered yet.
    const bans = await postJson(env, '/api/leaderboard-score-bans', {
      slug: 'b2', config: MAX_CFG, memberIds: [whaleId],
    });
    expect(bans.status).toBe(200);
    expect(bans.data.queued).toEqual([whaleId]);

    // Late sign-up triggers the ban hook.
    const reg = await postApi(env, '/api/events/register', {
      eventId: openDs.id, memberId: whaleId, status: 'IN', squadPower: 100, squadType: 'tanks', timeSlot: '22',
    });
    expect(reg.status).toBe(200);
    const regs = await events.listRegistrations(openDs.id);
    expect(regs.find((r) => r.memberId === whaleId)?.isBanned).toBe(true);
    await assertQueueLogReplayable(env.DB);
  });

  it('status endpoint exposes defaults and review state for resume', async () => {
    const env = makeEnv();
    await postApi(env, '/api/upload-leaderboard', { slug: 's1', title: 'S1', entries: Q1_ENTRIES });
    const res = await getApi(env, '/api/leaderboard-score-status?slug=s1');
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      defaults: Record<string, number | null>;
      review: { penaltiesStatus: string; bansStatus: string };
    };
    expect(data.review).toEqual({ penaltiesStatus: 'pending', bansStatus: 'pending' });
    expect(data.defaults.minPoints).toBe(7_200_000);
    expect(data.defaults.maxCap).toBe(5);
  });
});

describe('score settings API', () => {
  it('round-trips score defaults and accepts M-suffix input', async () => {
    const env = makeEnv();
    const res = await postJson(env, '/api/settings', {
      scoreMinPoints: '5M',
      scoreBelowPenalty: 2,
      scoreMaxPoints: '12M',
      scoreSevereStep: '2M',
      scoreMaxCap: 3,
      scoreStreakThreshold: 3,
    });
    expect(res.status).toBe(200);
    expect(res.data.settings.scoreMinPoints).toBe(5_000_000);
    expect(res.data.settings.scoreBelowPenalty).toBe(2);
    expect(res.data.settings.scoreMaxPoints).toBe(12_000_000);
    expect(res.data.settings.scoreSevereStep).toBe(2_000_000);
    expect(res.data.settings.scoreMaxCap).toBe(3);
    expect(res.data.settings.scoreStreakThreshold).toBe(3);

    const get = (await (await getApi(env, '/api/settings')).json()) as { settings: Record<string, unknown> };
    expect(get.settings.scoreMinPoints).toBe(5_000_000);

    // Unsetting the max stores null; invalid values are rejected.
    const unset = await postJson(env, '/api/settings', { scoreMaxPoints: null });
    expect(unset.status).toBe(200);
    expect(unset.data.settings.scoreMaxPoints).toBeNull();
    for (const bad of [{ scoreMaxCap: 0 }, { scoreStreakThreshold: 99 }, { scoreBelowPenalty: -1 }, { scoreMaxPoints: 'abc' }]) {
      const r = await postJson(env, '/api/settings', bad);
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
  });
});
