import { describe, it, expect } from 'vitest';
import worker, { type Env, buildRosterPostMessages, getNextMondayWeekStart } from '../src/index';
import { renderPage } from '../src/web/page';
import { PAGE_STYLES } from '../src/web/page/styles';
import { CLIENT_ROSTER } from '../src/web/page/client/roster';
import { EventsStore, computeRosterHash } from '../src/eventsStore';
import { DataStore } from '../src/storage';
import type { Assignment } from '../src/eventsStore';
import { createD1Mock } from './d1-mock';

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DISCORD_PUBLIC_KEY: 'pk',
    DISCORD_BOT_TOKEN: 'bt',
    DISCORD_APPLICATION_ID: 'app',
    TRACKING_CHANNEL_ID: 'ch',
    GUILD_ID: 'g',
    DB: createD1Mock(),
    WEB_ACCESS_TOKEN: 'secret-token',
    ...overrides,
  } as Env;
}

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

async function makeRosteredEvent(env: Env, weekStart: string, closesAt: string | null) {
  const es = new EventsStore(env.DB);
  const ds = new DataStore(env.DB);
  const ev = await es.createEvent({ kind: 'canyon', weekStart, registrationClosesAt: closesAt, notes: null });
  await ds.addMember('AutoLockPlayer');
  const mRow = await env.DB.prepare('SELECT id FROM members WHERE display_name = ?')
    .bind('AutoLockPlayer')
    .first<{ id: number }>();
  await es.upsertRegistration(ev.id, mRow!.id, { status: 'IN', squadPower: 100, squadType: 'tanks' });
  await es.replaceAssignments(
    ev.id,
    [{ memberId: mRow!.id, team: 'A', role: 'main', slotIndex: 1 }],
    { isLocked: false },
  );
  return ev;
}

function stubFetchOk(calls: string[]) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    calls.push(String((init?.body as { content?: unknown })?.content ?? init?.body ?? ''));
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = realFetch;
  };
}

describe('Worker web routing', () => {
  it('returns 503 when WEB_ACCESS_TOKEN is unset', async () => {
    const env = makeEnv({ WEB_ACCESS_TOKEN: undefined });
    const res = await worker.fetch(new Request('https://example.com/'), env, ctx);
    expect(res.status).toBe(503);
  });

  it('returns 401 for GET / without token', async () => {
    const env = makeEnv();
    const res = await worker.fetch(new Request('https://example.com/'), env, ctx);
    expect(res.status).toBe(401);
  });

  it('returns 401 for GET / with wrong token', async () => {
    const env = makeEnv();
    const res = await worker.fetch(new Request('https://example.com/?token=nope'), env, ctx);
    expect(res.status).toBe(401);
  });

  it('serves HTML for GET / with valid token (query)', async () => {
    const env = makeEnv();
    const res = await worker.fetch(new Request('https://example.com/?token=secret-token'), env, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain('<title>Trinity Alliance Tracker</title>');
  });

  it('rendered page has valid JS syntax in all <script> blocks', async () => {
    const env = makeEnv();
    const res = await worker.fetch(new Request('https://example.com/?token=secret-token'), env, ctx);
    const body = await res.text();
    const scriptRe = /<script(?:\s[^>]*)?>([^]*?)<\/script>/gi;
    let match: RegExpExecArray | null;
    while ((match = scriptRe.exec(body)) !== null) {
      const src = match[1].trim();
      if (!src) continue;
      expect(() => new Function(src), `Syntax error in <script> block starting: ${src.slice(0, 80)}`).not.toThrow();
    }
  });

  it('rendered page contains no null bytes or stray control characters', async () => {
    // Catches template-literal escape sequences (\x00, \x7F, etc.) being
    // evaluated at render time and embedded as raw bytes in the HTML — null
    // bytes corrupt the browser HTML parser even when JS syntax is valid.
    const env = makeEnv();
    const res = await worker.fetch(new Request('https://example.com/?token=secret-token'), env, ctx);
    const body = await res.text();
    // Allow tab (0x09), LF (0x0A), CR (0x0D) — everything else below 0x20
    // and DEL (0x7F) has no place in rendered HTML.
    const badChars = body.match(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g);
    if (badChars) {
      const codes = [...new Set(badChars)].map(c => `U+${c.charCodeAt(0).toString(16).padStart(4, '0').toUpperCase()}`).join(', ');
      expect.fail(`Rendered page contains control characters: ${codes}`);
    }
  });

  it('token with special chars is embedded correctly (no double-encoding)', async () => {
    const env = makeEnv({ WEB_ACCESS_TOKEN: 'tok&en<test>' });
    const res = await worker.fetch(
      new Request('https://example.com/?token=tok%26en%3Ctest%3E'),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    // The JS variable must hold the raw token value, not HTML-encoded entities
    expect(body).not.toContain('tok&amp;en');
    expect(body).toContain('tok\\u0026en');
  });

  it('accepts Authorization: Bearer for API', async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request('https://example.com/api/active', {
        headers: { Authorization: 'Bearer secret-token' },
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { entries: unknown[] };
    expect(body.entries).toEqual([]);
  });

  it('returns 401 JSON for API without token', async () => {
    const env = makeEnv();
    const res = await worker.fetch(new Request('https://example.com/api/active'), env, ctx);
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
  });

  it('returns pick-train JSON with default count and minDays', async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request('https://example.com/api/pick-train?token=secret-token'),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { count: number; minDays: number; eligibleTotal: number; entries: unknown[] };
    expect(body.count).toBe(5);
    expect(body.minDays).toBe(30);
    expect(body.eligibleTotal).toBe(0);
    expect(body.entries).toEqual([]);
  });

  it('pick-train clamps count and days, returns eligible members', async () => {
    const env = makeEnv();
    const { DataStore } = await import('../src/storage');
    const store = new DataStore(env.DB);
    for (const name of ['Alice', 'Bob', 'Carol', 'Dave']) {
      await store.addMember(name);
    }
    // No rewards → everyone is eligible (daysSinceTrain is null).
    const res = await worker.fetch(
      new Request('https://example.com/api/pick-train?count=999&days=0&token=secret-token'),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { count: number; minDays: number; eligibleTotal: number; entries: Array<{ name: string }> };
    expect(body.count).toBe(50);          // clamped from 999
    expect(body.minDays).toBe(30);        // fell back to default when 0/invalid
    expect(body.eligibleTotal).toBe(4);
    expect(body.entries).toHaveLength(4);
    const names = body.entries.map(e => e.name).sort();
    expect(names).toEqual(['Alice', 'Bob', 'Carol', 'Dave']);
  });

  it('returns 404 JSON for unknown api path', async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request('https://example.com/api/nope?token=secret-token'),
      env,
      ctx,
    );
    expect(res.status).toBe(404);
  });

  it('returns 405 for non-GET non-POST methods', async () => {
    const env = makeEnv();
    const res = await worker.fetch(new Request('https://example.com/', { method: 'PUT' }), env, ctx);
    expect(res.status).toBe(405);
  });

  it('GET /api/queue without refresh skips ingestion (ingested=null)', async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request('https://example.com/api/queue?token=secret-token'),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { queue: unknown[]; log: unknown[]; ingested: unknown };
    expect(body.ingested).toBeNull();
  });

  it('GET /api/queue?refresh=1 triggers ingestion for admin token', async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request('https://example.com/api/queue?refresh=1&token=secret-token'),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { ingested: { ingested: boolean; count: number } | null };
    // No lastIngestionTime is set → autoIngestIfNeeded returns
    // { ingested: false, count: 0 } without contacting Discord. The key
    // assertion is that `ingested` is not null, proving the refresh branch ran.
    expect(body.ingested).not.toBeNull();
    expect(body.ingested?.ingested).toBe(false);
    expect(body.ingested?.count).toBe(0);
  });

  it('GET /api/queue?refresh=1 skips ingestion for read-only token', async () => {
    const env = makeEnv({ WEB_READONLY_TOKEN: 'readonly-token' });
    const res = await worker.fetch(
      new Request('https://example.com/api/queue?refresh=1&token=readonly-token'),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { role: string; ingested: unknown };
    expect(body.role).toBe('readonly');
    expect(body.ingested).toBeNull();
  });

  it('POST /api/add-member adds a player and appends them to the queue', async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request('https://example.com/api/add-member', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret-token' },
        body: JSON.stringify({ name: 'Newbie' }),
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; member: { displayName: string } };
    expect(body.ok).toBe(true);
    expect(body.member.displayName).toBe('Newbie');

    const { DataStore } = await import('../src/storage');
    const store = new DataStore(env.DB);
    const queue = await store.getTrainQueue();
    expect(queue.map((q) => q.name)).toContain('Newbie');
  });

  it('POST /api/add-member returns 400 when name is missing', async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request('https://example.com/api/add-member', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret-token' },
        body: JSON.stringify({ name: '   ' }),
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it('POST /api/add-member returns 403 for read-only token', async () => {
    const env = makeEnv({ WEB_READONLY_TOKEN: 'readonly-token' });
    const res = await worker.fetch(
      new Request('https://example.com/api/add-member', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer readonly-token' },
        body: JSON.stringify({ name: 'Newbie' }),
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(403);
  });

  it('POST /api/remove-member deactivates a player and removes them from the queue', async () => {
    const env = makeEnv();
    const { DataStore } = await import('../src/storage');
    const store = new DataStore(env.DB);
    await store.addMember('Alice');
    await store.addMember('Bob');
    await store.syncTrainQueue();
    expect((await store.getTrainQueue()).map((q) => q.name)).toEqual(['Alice', 'Bob']);

    const res = await worker.fetch(
      new Request('https://example.com/api/remove-member', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret-token' },
        body: JSON.stringify({ name: 'Alice' }),
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; name: string };
    expect(body.ok).toBe(true);
    expect(body.name).toBe('Alice');

    const queueNow = await store.getTrainQueue();
    expect(queueNow.map((q) => q.name)).toEqual(['Bob']);
  });

  it('POST /api/remove-member returns 404 for unknown name', async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request('https://example.com/api/remove-member', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret-token' },
        body: JSON.stringify({ name: 'Ghost' }),
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(404);
  });

  it('POST /api/remove-member returns 400 when name is missing', async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request('https://example.com/api/remove-member', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret-token' },
        body: JSON.stringify({}),
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it('POST /api/remove-member returns 403 for read-only token', async () => {
    const env = makeEnv({ WEB_READONLY_TOKEN: 'readonly-token' });
    const res = await worker.fetch(
      new Request('https://example.com/api/remove-member', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer readonly-token' },
        body: JSON.stringify({ name: 'Alice' }),
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(403);
  });

  // ── Events role matrix ────────────────────────────────────────────
  describe('Events role matrix', () => {
    function evEnv() {
      return makeEnv({
        WEB_READONLY_TOKEN: 'readonly-token',
      });
    }

    it('GET /api/events returns 200 for admin', async () => {
      const env = evEnv();
      const res = await worker.fetch(
        new Request('https://example.com/api/events?token=secret-token'),
        env,
        ctx,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { events: unknown[] };
      expect(Array.isArray(body.events)).toBe(true);
    });

    it('GET /api/events returns 200 for readonly', async () => {
      const env = evEnv();
      const res = await worker.fetch(
        new Request('https://example.com/api/events?token=readonly-token'),
        env,
        ctx,
      );
      expect(res.status).toBe(200);
    });

    it('GET /api/events returns 401 without token', async () => {
      const env = evEnv();
      const res = await worker.fetch(
        new Request('https://example.com/api/events'),
        env,
        ctx,
      );
      expect(res.status).toBe(401);
    });

    it('POST /api/events/ban allows admin to set ban flag', async () => {
      const env = evEnv();
      await env.DB.prepare(
        "INSERT INTO poc_events_event (kind, week_start, status) VALUES ('desert', '2025-02-03', 'open')"
      ).run();
      const evRow = await env.DB.prepare("SELECT id FROM poc_events_event WHERE week_start = '2025-02-03'").first<{ id: number }>();
      const { DataStore } = await import('../src/storage');
      const ds = new DataStore(env.DB);
      await ds.addMember('BanTarget');
      const mRow = await env.DB.prepare('SELECT id FROM members WHERE display_name = ?').bind('BanTarget').first<{ id: number }>();
      await env.DB.prepare(
        `INSERT INTO poc_events_registration (event_id, member_id, status, squad_power, squad_type) VALUES (?, ?, 'IN', 100, 'tanks')`
      ).bind(evRow!.id, mRow!.id).run();

      const res = await worker.fetch(
        new Request('https://example.com/api/events/ban', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret-token' },
          body: JSON.stringify({ eventId: evRow!.id, memberId: mRow!.id, banned: true }),
        }),
        env,
        ctx,
      );
      expect(res.status).toBe(200);
      const row = await env.DB
        .prepare('SELECT is_banned FROM poc_events_registration WHERE event_id = ? AND member_id = ?')
        .bind(evRow!.id, mRow!.id)
        .first<{ is_banned: number }>();
      expect(row!.is_banned).toBe(1);
    });

    it('POST /api/events/ban returns 403 for non-admin', async () => {
      const env = evEnv();
      const res = await worker.fetch(
        new Request('https://example.com/api/events/ban', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer readonly-token' },
          body: JSON.stringify({ eventId: 1, memberId: 1, banned: true }),
        }),
        env,
        ctx,
      );
      expect(res.status).toBe(403);
    });

    it('POST /api/events/ban returns 409 when event is locked', async () => {
      const env = evEnv();
      await env.DB.prepare(
        "INSERT INTO poc_events_event (kind, week_start, status) VALUES ('desert', '2025-03-03', 'locked')"
      ).run();
      const evRow = await env.DB.prepare("SELECT id FROM poc_events_event WHERE week_start = '2025-03-03'").first<{ id: number }>();
      const res = await worker.fetch(
        new Request('https://example.com/api/events/ban', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret-token' },
          body: JSON.stringify({ eventId: evRow!.id, memberId: 1, banned: true }),
        }),
        env,
        ctx,
      );
      expect(res.status).toBe(409);
    });

    it('POST /api/events/penalize allows admin to set penalized flag', async () => {
      const env = evEnv();
      await env.DB.prepare(
        "INSERT INTO poc_events_event (kind, week_start, status) VALUES ('desert', '2025-04-07', 'open')"
      ).run();
      const evRow = await env.DB.prepare("SELECT id FROM poc_events_event WHERE week_start = '2025-04-07'").first<{ id: number }>();
      const { DataStore } = await import('../src/storage');
      const ds = new DataStore(env.DB);
      await ds.addMember('PenalizeTarget');
      const mRow = await env.DB.prepare('SELECT id FROM members WHERE display_name = ?').bind('PenalizeTarget').first<{ id: number }>();
      await env.DB.prepare(
        `INSERT INTO poc_events_registration (event_id, member_id, status, squad_power, squad_type) VALUES (?, ?, 'IN', 150, 'tanks')`
      ).bind(evRow!.id, mRow!.id).run();

      const res = await worker.fetch(
        new Request('https://example.com/api/events/penalize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret-token' },
          body: JSON.stringify({ eventId: evRow!.id, memberId: mRow!.id, penalized: true }),
        }),
        env,
        ctx,
      );
      expect(res.status).toBe(200);
      const row = await env.DB
        .prepare('SELECT is_penalized FROM poc_events_registration WHERE event_id = ? AND member_id = ?')
        .bind(evRow!.id, mRow!.id)
        .first<{ is_penalized: number }>();
      expect(row!.is_penalized).toBe(1);
    });

    it('POST /api/events/penalize returns 403 for non-admin', async () => {
      const env = evEnv();
      const res = await worker.fetch(
        new Request('https://example.com/api/events/penalize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer readonly-token' },
          body: JSON.stringify({ eventId: 1, memberId: 1, penalized: true }),
        }),
        env,
        ctx,
      );
      expect(res.status).toBe(403);
    });

    it('POST /api/events/penalize returns 409 when event is locked', async () => {
      const env = evEnv();
      await env.DB.prepare(
        "INSERT INTO poc_events_event (kind, week_start, status) VALUES ('desert', '2025-04-14', 'locked')"
      ).run();
      const evRow = await env.DB.prepare("SELECT id FROM poc_events_event WHERE week_start = '2025-04-14'").first<{ id: number }>();
      const res = await worker.fetch(
        new Request('https://example.com/api/events/penalize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret-token' },
          body: JSON.stringify({ eventId: evRow!.id, memberId: 1, penalized: true }),
        }),
        env,
        ctx,
      );
      expect(res.status).toBe(409);
    });

    it('POST /api/events/unregister returns 409 for locked event', async () => {
      const env = evEnv();
      await env.DB.prepare(
        "INSERT INTO poc_events_event (kind, week_start, status) VALUES ('canyon', '2025-05-05', 'locked')"
      ).run();
      const evRow = await env.DB.prepare("SELECT id FROM poc_events_event WHERE week_start = '2025-05-05'").first<{ id: number }>();
      const res = await worker.fetch(
        new Request('https://example.com/api/events/unregister', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret-token' },
          body: JSON.stringify({ eventId: evRow!.id, memberId: 1 }),
        }),
        env,
        ctx,
      );
      expect(res.status).toBe(409);
    });

    it('POST /api/events/mark-no-show returns 409 for non-locked event', async () => {
      const env = evEnv();
      await env.DB.prepare(
        "INSERT INTO poc_events_event (kind, week_start, status) VALUES ('canyon', '2025-05-12', 'open')"
      ).run();
      const evRow = await env.DB.prepare("SELECT id FROM poc_events_event WHERE week_start = '2025-05-12'").first<{ id: number }>();
      const res = await worker.fetch(
        new Request('https://example.com/api/events/mark-no-show', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret-token' },
          body: JSON.stringify({ eventId: evRow!.id, memberId: 1 }),
        }),
        env,
        ctx,
      );
      expect(res.status).toBe(409);
    });

    it('POST /api/events/record-attendance returns 409 for non-locked event', async () => {
      const env = evEnv();
      await env.DB.prepare(
        "INSERT INTO poc_events_event (kind, week_start, status) VALUES ('canyon', '2025-05-26', 'open')"
      ).run();
      const evRow = await env.DB.prepare("SELECT id FROM poc_events_event WHERE week_start = '2025-05-26'").first<{ id: number }>();
      const res = await worker.fetch(
        new Request('https://example.com/api/events/record-attendance', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret-token' },
          body: JSON.stringify({ eventId: evRow!.id, presentMemberIds: [] }),
        }),
        env,
        ctx,
      );
      expect(res.status).toBe(409);
    });

    it('POST /api/events/record-attendance returns 403 for non-admin', async () => {
      const env = evEnv();
      const res = await worker.fetch(
        new Request('https://example.com/api/events/record-attendance', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer readonly-token' },
          body: JSON.stringify({ eventId: 1, presentMemberIds: [] }),
        }),
        env,
        ctx,
      );
      expect(res.status).toBe(403);
    });

    it('POST /api/events/lock is gone (locking is automatic now)', async () => {
      const env = evEnv();
      const res = await worker.fetch(
        new Request('https://example.com/api/events/lock', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret-token' },
          body: JSON.stringify({ eventId: 1 }),
        }),
        env,
        ctx,
      );
      expect(res.status).toBe(404);
    });

    it('POST /api/events/substitute returns 403 for non-admin', async () => {
      const env = evEnv();
      const res = await worker.fetch(
        new Request('https://example.com/api/events/substitute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer readonly-token' },
          body: JSON.stringify({ eventId: 1, outMemberId: 1, inMemberId: 2 }),
        }),
        env,
        ctx,
      );
      expect(res.status).toBe(403);
    });

    it('POST /api/events/substitute returns 409 for non-locked event', async () => {
      const env = evEnv();
      await env.DB.prepare(
        "INSERT INTO poc_events_event (kind, week_start, status) VALUES ('desert', '2025-06-02', 'open')"
      ).run();
      const evRow = await env.DB.prepare("SELECT id FROM poc_events_event WHERE week_start = '2025-06-02'").first<{ id: number }>();
      const res = await worker.fetch(
        new Request('https://example.com/api/events/substitute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret-token' },
          body: JSON.stringify({ eventId: evRow!.id, outMemberId: 1, inMemberId: 2 }),
        }),
        env,
        ctx,
      );
      expect(res.status).toBe(409);
    });
  });
  describe('scheduled handler', () => {
    it('auto-creates a Desert Storm event for the next ISO week on Saturday', async () => {
      const env = makeEnv();
      // Saturday 2026-05-30 00:00 UTC → next Monday is 2026-06-01 (week 23)
      const event = {
        scheduledTime: new Date('2026-05-30T00:00:00Z').getTime(),
        cron: '0 0 * * SAT',
      } as ScheduledEvent;
      await worker.scheduled(event, env, ctx);
      const row = await env.DB.prepare(
        "SELECT kind, week_start, registration_closes_at, notes FROM poc_events_event WHERE kind = 'desert' AND week_start = '2026-06-01'",
      ).first<{ kind: string; week_start: string; registration_closes_at: string | null; notes: string | null }>();
      expect(row).toBeTruthy();
      expect(row!.kind).toBe('desert');
      expect(row!.week_start).toBe('2026-06-01');
      // Registration closes Wednesday 12:00 server time = 14:00 UTC (Mon 2026-06-01 + 2d = Wed 2026-06-03)
      expect(row!.registration_closes_at).toBe('2026-06-03T14:00:00.000Z');
      // Notes contain week number: next Monday 2026-06-01 is ISO week 23
      expect(row!.notes).toBe('Desert Storm - week 23-2026');
    });

    it('auto-creates a Canyon Storm event for the next ISO week on Friday', async () => {
      const env = makeEnv();
      // Friday 2026-05-29 00:00 UTC → next Monday is 2026-06-01 (week 23)
      const event = {
        scheduledTime: new Date('2026-05-29T00:00:00Z').getTime(),
        cron: '0 0 * * FRI',
      } as ScheduledEvent;
      await worker.scheduled(event, env, ctx);
      const row = await env.DB.prepare(
        "SELECT kind, week_start, registration_closes_at, notes FROM poc_events_event WHERE kind = 'canyon' AND week_start = '2026-06-01'",
      ).first<{ kind: string; week_start: string; registration_closes_at: string | null; notes: string | null }>();
      expect(row).toBeTruthy();
      expect(row!.kind).toBe('canyon');
      expect(row!.week_start).toBe('2026-06-01');
      // Registration closes Monday 12:00 server time = 14:00 UTC (2026-06-01)
      expect(row!.registration_closes_at).toBe('2026-06-01T14:00:00.000Z');
      expect(row!.notes).toBe('Canyon Storm - week 23-2026');
    });

    it('is idempotent (upserts on conflict)', async () => {
      const env = makeEnv();
      const event = {
        scheduledTime: new Date('2026-05-30T00:00:00Z').getTime(),
        cron: '0 0 * * SAT',
      } as ScheduledEvent;
      await worker.scheduled(event, env, ctx);
      await worker.scheduled(event, env, ctx); // second call should not throw
      const rows = await env.DB.prepare(
        "SELECT id FROM poc_events_event WHERE kind = 'desert' AND week_start = '2026-06-01'",
      ).all();
      expect(rows.results.length).toBe(1);
    });

    it('skips Canyon event creation when canyon_auto_open is 0', async () => {
      const env = makeEnv();
      // Disable auto-open
      await env.DB.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('setting:canyon_auto_open', '0')").run();
      const event = {
        scheduledTime: new Date('2026-05-29T00:00:00Z').getTime(),
        cron: '0 0 * * FRI',
      } as ScheduledEvent;
      await worker.scheduled(event, env, ctx);
      const row = await env.DB.prepare(
        "SELECT id FROM poc_events_event WHERE kind = 'canyon' AND week_start = '2026-06-01'",
      ).first();
      expect(row).toBeNull();
    });

    it('populates team timestamps from settings on Canyon creation', async () => {
      const env = makeEnv();
      // Canyon always plays Thursday (Mon+3). Team A: 16:00 CET = Thu 14:00 UTC.
      // Team B: 03:00 CET = the NEXT day (Fri 01:00 UTC) because 03:00 is the
      // night slot (server Thu 23:00 UTC-2 appears as Fri 03:00 CET).
      await env.DB.batch([
        env.DB.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('setting:canyon_a_time', '16:00')"),
        env.DB.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('setting:canyon_b_time', '03:00')"),
      ]);
      const event = {
        scheduledTime: new Date('2026-05-29T00:00:00Z').getTime(),
        cron: '0 0 * * FRI',
      } as ScheduledEvent;
      await worker.scheduled(event, env, ctx);
      // weekStart = 2026-06-01 (Mon). Thursday = Mon+3 = 2026-06-04.
      // 16:00 CET → 14:00 UTC → Thu 2026-06-04T14:00:00.000Z
      // 03:00 CET → next day (Fri Mon+4) 01:00 UTC → 2026-06-05T01:00:00.000Z
      const row = await env.DB.prepare(
        "SELECT team_a_starts_at, team_b_starts_at FROM poc_events_event WHERE kind = 'canyon' AND week_start = '2026-06-01'",
      ).first<{ team_a_starts_at: string; team_b_starts_at: string }>();
      expect(row).toBeTruthy();
      expect(row!.team_a_starts_at).toBe('2026-06-04T14:00:00.000Z');
      expect(row!.team_b_starts_at).toBe('2026-06-05T01:00:00.000Z');
    });

    function wednesday2am() {
      // Wednesday 02:00 UTC (server midnight): no creation branch runs.
      return {
        scheduledTime: new Date('2026-06-03T02:00:00Z').getTime(),
        cron: '0 2 * * *',
      } as ScheduledEvent;
    }

    it('auto-locks an open event past registration close and posts its roster', async () => {
      const env = makeEnv();
      const ev = await makeRosteredEvent(env, '2026-06-01', '2026-06-01T12:00:00.000Z');
      const posted: string[] = [];
      const restore = stubFetchOk(posted);
      try {
        await worker.scheduled(wednesday2am(), env, ctx);
      } finally {
        restore();
      }
      const row = await env.DB.prepare('SELECT status FROM poc_events_event WHERE id = ?')
        .bind(ev.id)
        .first<{ status: string }>();
      expect(row!.status).toBe('locked');
      // Team A + Team B roster posts.
      expect(posted).toHaveLength(2);
      expect(posted[0]).toContain('Team A');
      expect(posted[1]).toContain('Team B');
      expect(posted[0]).toContain('AutoLockPlayer');
    });

    it('leaves open events with a future close untouched', async () => {
      const env = makeEnv();
      const ev = await makeRosteredEvent(env, '2026-06-08', '2026-06-08T12:00:00.000Z');
      const posted: string[] = [];
      const restore = stubFetchOk(posted);
      try {
        await worker.scheduled(wednesday2am(), env, ctx);
      } finally {
        restore();
      }
      const row = await env.DB.prepare('SELECT status FROM poc_events_event WHERE id = ?')
        .bind(ev.id)
        .first<{ status: string }>();
      expect(row!.status).toBe('open');
      expect(posted).toHaveLength(0);
    });

    it('skips auto-lock for events with no saved assignments', async () => {
      const env = makeEnv();
      const es = new EventsStore(env.DB);
      const ev = await es.createEvent({
        kind: 'desert',
        weekStart: '2026-06-01',
        registrationClosesAt: '2026-06-03T12:00:00.000Z',
        notes: null,
      });
      await worker.scheduled(wednesday2am(), env, ctx);
      const row = await env.DB.prepare('SELECT status FROM poc_events_event WHERE id = ?')
        .bind(ev.id)
        .first<{ status: string }>();
      expect(row!.status).toBe('open');
    });

    it('leaves already-locked events alone (no re-post)', async () => {
      const env = makeEnv();
      const ev = await makeRosteredEvent(env, '2026-06-01', '2026-06-01T12:00:00.000Z');
      await env.DB.prepare("UPDATE poc_events_event SET status = 'locked' WHERE id = ?").bind(ev.id).run();
      const posted: string[] = [];
      const restore = stubFetchOk(posted);
      try {
        await worker.scheduled(wednesday2am(), env, ctx);
      } finally {
        restore();
      }
      const row = await env.DB.prepare('SELECT status FROM poc_events_event WHERE id = ?')
        .bind(ev.id)
        .first<{ status: string }>();
      expect(row!.status).toBe('locked');
      expect(posted).toHaveLength(0);
    });

    it('auto-lock skips posting when the roster is unchanged since manual post', async () => {
      const env = makeEnv();
      const ev = await makeRosteredEvent(env, '2026-06-01', '2026-06-01T12:00:00.000Z');
      // Manual post first (stores the hash).
      const restorePost = stubFetchOk([]);
      try {
        const res = await worker.fetch(
          new Request('https://example.com/api/events/post-roster', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret-token' },
            body: JSON.stringify({ eventId: ev.id }),
          }),
          env,
          ctx,
        );
        expect(res.status).toBe(200);
      } finally {
        restorePost();
      }
      // Auto-lock tick: locks, but posts nothing.
      const posted: string[] = [];
      const restore = stubFetchOk(posted);
      try {
        await worker.scheduled(wednesday2am(), env, ctx);
      } finally {
        restore();
      }
      const row = await env.DB.prepare('SELECT status FROM poc_events_event WHERE id = ?')
        .bind(ev.id)
        .first<{ status: string }>();
      expect(row!.status).toBe('locked');
      expect(posted).toHaveLength(0);
    });

    it('auto-lock posts when the roster changed after the manual post', async () => {
      const env = makeEnv();
      const ev = await makeRosteredEvent(env, '2026-06-01', '2026-06-01T12:00:00.000Z');
      const restorePost = stubFetchOk([]);
      const es = new EventsStore(env.DB);
      const ds = new DataStore(env.DB);
      try {
        const res = await worker.fetch(
          new Request('https://example.com/api/events/post-roster', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret-token' },
            body: JSON.stringify({ eventId: ev.id }),
          }),
          env,
          ctx,
        );
        expect(res.status).toBe(200);
      } finally {
        restorePost();
      }
      // Change the roster: move the player to team B.
      const mRow = await env.DB.prepare('SELECT id FROM members WHERE display_name = ?')
        .bind('AutoLockPlayer')
        .first<{ id: number }>();
      await ds.addMember('SecondPlayer');
      const m2 = await env.DB.prepare('SELECT id FROM members WHERE display_name = ?')
        .bind('SecondPlayer')
        .first<{ id: number }>();
      await es.upsertRegistration(ev.id, m2!.id, { status: 'IN', squadPower: 50, squadType: 'tanks' });
      await es.replaceAssignments(
        ev.id,
        [
          { memberId: mRow!.id, team: 'B', role: 'main', slotIndex: 1 },
          { memberId: m2!.id, team: 'A', role: 'main', slotIndex: 1 },
        ],
        { isLocked: false },
      );
      const posted: string[] = [];
      const restore = stubFetchOk(posted);
      try {
        await worker.scheduled(wednesday2am(), env, ctx);
      } finally {
        restore();
      }
      expect(posted).toHaveLength(2);
      expect(posted.join('\n')).toContain('SecondPlayer');
    });

    it('POST /api/events/post-roster posts both teams', async () => {
      const env = makeEnv();
      const ev = await makeRosteredEvent(env, '2026-06-01', '2026-06-01T12:00:00.000Z');
      const posted: string[] = [];
      const restore = stubFetchOk(posted);
      let res: Response;
      try {
        res = await worker.fetch(
          new Request('https://example.com/api/events/post-roster', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret-token' },
            body: JSON.stringify({ eventId: ev.id }),
          }),
          env,
          ctx,
        );
      } finally {
        restore();
      }
      expect(res!.status).toBe(200);
      expect(posted).toHaveLength(2);
      expect(posted[0]).toContain('Canyon');
      expect(posted[0]).toContain('AutoLockPlayer');
      expect(posted[1]).toContain('Team B');
      // The posted roster hash is stored for the double-post guard.
      const es = new EventsStore(env.DB);
      const stored = await es.getRosterPostedHash(ev.id);
      expect(stored).toBe(computeRosterHash(await es.listAssignments(ev.id)));
    });

    it('POST /api/events/post-roster returns 502 when Discord rejects', async () => {
      const env = makeEnv();
      const ev = await makeRosteredEvent(env, '2026-06-01', '2026-06-01T12:00:00.000Z');
      const realFetch = globalThis.fetch;
      let res: Response;
      try {
        globalThis.fetch = (async () => new Response('nope', { status: 500 })) as typeof fetch;
        res = await worker.fetch(
          new Request('https://example.com/api/events/post-roster', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret-token' },
            body: JSON.stringify({ eventId: ev.id }),
          }),
          env,
          ctx,
        );
      } finally {
        globalThis.fetch = realFetch;
      }
      expect(res!.status).toBe(502);
      const body = await res!.json() as { error: string };
      expect(body.error).toContain('team A');
    });
  });

  describe('roster post formatting', () => {
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

    it('renders mains with strategy roles and a subs section', () => {
      const msgs = buildRosterPostMessages('Canyon — week 2026-06-01', 'canyon', [
        assignment({ memberId: 1, memberName: 'Alice', team: 'A', role: 'main', slotIndex: 1, strategyRole: 'assassin / silo' }),
        assignment({ id: 2, memberId: 2, memberName: 'Bob', team: 'A', role: 'sub', slotIndex: 21 }),
        assignment({ id: 3, memberId: 3, memberName: 'Cara', team: 'B', role: 'main', slotIndex: 1, strategyRole: null }),
      ]);
      expect(msgs).toHaveLength(2);
      expect(msgs[0]).toContain('**Canyon — week 2026-06-01 — Team A**');
      expect(msgs[0]).toContain('Alice');
      expect(msgs[0]).toContain('assassin / silo');
      expect(msgs[0]).toContain('--- subs ---');
      expect(msgs[0]).toContain('Bob');
      expect(msgs[1]).toContain('Team B');
      // Canyon slot fallback for a main without explicit strategy role.
      expect(msgs[1]).toContain('power tower / virus lab');
    });

    it('uses desert role slots for desert events', () => {
      const msgs = buildRosterPostMessages('Desert Storm — week 2026-06-01', 'desert', [
        assignment({ memberName: 'Dan', team: 'A', role: 'main', slotIndex: 1, strategyRole: null }),
      ]);
      expect(msgs[0]).toContain('assassin / silo');
    });

    it('orders players by squad power like the web interface', () => {
      const msgs = buildRosterPostMessages(
        'Canyon — week 2026-06-01',
        'canyon',
        [
          assignment({ memberId: 1, memberName: 'Weak', team: 'A', role: 'main', slotIndex: 1 }),
          assignment({ id: 2, memberId: 2, memberName: 'Strong', team: 'A', role: 'main', slotIndex: 2 }),
          assignment({ id: 3, memberId: 3, memberName: 'SubWeak', team: 'A', role: 'sub', slotIndex: 21 }),
          assignment({ id: 4, memberId: 4, memberName: 'SubStrong', team: 'A', role: 'sub', slotIndex: 22 }),
        ],
        new Map([
          [1, 10],
          [2, 99],
          [3, 5],
          [4, 50],
        ]),
      );
      const teamA = msgs[0];
      // Strongest main first despite the higher slot index; same for subs.
      expect(teamA.indexOf('Strong')).toBeLessThan(teamA.indexOf('Weak'));
      const subsPart = teamA.slice(teamA.indexOf('--- subs ---'));
      expect(subsPart.indexOf('SubStrong')).toBeLessThan(subsPart.indexOf('SubWeak'));
    });

    it('falls back to slot order on equal or unknown power', () => {
      const msgs = buildRosterPostMessages(
        'Canyon — week 2026-06-01',
        'canyon',
        [
          assignment({ memberId: 1, memberName: 'First', team: 'B', role: 'main', slotIndex: 1 }),
          assignment({ id: 2, memberId: 2, memberName: 'Second', team: 'B', role: 'main', slotIndex: 2 }),
          assignment({ id: 3, memberId: 3, memberName: 'Third', team: 'B', role: 'main', slotIndex: 3 }),
        ],
        new Map([
          [1, 50],
          [2, 50], // tie with First → slot order wins
        ]), // Third has unknown power and sorts last
      );
      const teamB = msgs[1];
      expect(teamB.indexOf('First')).toBeLessThan(teamB.indexOf('Second'));
      expect(teamB.indexOf('Second')).toBeLessThan(teamB.indexOf('Third'));
    });
  });

  // ── Settings API ─────────────────────────────────────────────────────────
  describe('Settings API', () => {
    it('GET /api/settings returns defaults when nothing is stored', async () => {
      const env = makeEnv();
      const res = await worker.fetch(
        new Request('https://example.com/api/settings?token=secret-token'),
        env,
        ctx,
      );
      expect(res.status).toBe(200);
      const body = await res.json() as { settings: Record<string, unknown> };
      expect(body.settings.canyonAutoOpen).toBe(true);
      expect(body.settings.canyonATime).toBe('16:00');
      expect(body.settings.desertATime).toBe('22:00');
      expect(body.settings.canyonCloseTime).toBe('12:00');
      expect(body.settings.desertCloseTime).toBe('12:00');
    });

    it('GET /api/settings returns 403 for readonly token', async () => {
      const env = makeEnv({ WEB_READONLY_TOKEN: 'readonly-token' });
      const res = await worker.fetch(
        new Request('https://example.com/api/settings?token=readonly-token'),
        env,
        ctx,
      );
      expect(res.status).toBe(403);
    });

    it('GET /api/settings reports canyonOpenNow=false when nothing is open', async () => {
      const env = makeEnv();
      const res = await worker.fetch(
        new Request('https://example.com/api/settings?token=secret-token'),
        env,
        ctx,
      );
      expect(res.status).toBe(200);
      const body = await res.json() as { canyonOpenNow: { weekStart: string; alreadyOpen: boolean } };
      expect(body.canyonOpenNow.weekStart).toBe(getNextMondayWeekStart(new Date()).weekStart);
      expect(body.canyonOpenNow.alreadyOpen).toBe(false);
    });

    it('GET /api/settings reports canyonOpenNow=true when Canyon is open for the upcoming week', async () => {
      const env = makeEnv();
      const { weekStart } = getNextMondayWeekStart(new Date());
      await env.DB.prepare(
        "INSERT INTO poc_events_event (kind, week_start, status) VALUES ('canyon', ?, 'open')",
      ).bind(weekStart).run();
      const res = await worker.fetch(
        new Request('https://example.com/api/settings?token=secret-token'),
        env,
        ctx,
      );
      const body = await res.json() as { canyonOpenNow: { weekStart: string; alreadyOpen: boolean } };
      expect(body.canyonOpenNow).toEqual({ weekStart, alreadyOpen: true });
    });

    it('GET /api/settings reports canyonOpenNow=false for locked or other-week events', async () => {
      const env = makeEnv();
      const { weekStart } = getNextMondayWeekStart(new Date());
      // Locked event for the upcoming week + open event for another week.
      await env.DB.batch([
        env.DB.prepare("INSERT INTO poc_events_event (kind, week_start, status) VALUES ('canyon', ?, 'locked')").bind(weekStart),
        env.DB.prepare("INSERT INTO poc_events_event (kind, week_start, status) VALUES ('canyon', '2000-01-03', 'open')"),
      ]);
      const res = await worker.fetch(
        new Request('https://example.com/api/settings?token=secret-token'),
        env,
        ctx,
      );
      const body = await res.json() as { canyonOpenNow: { weekStart: string; alreadyOpen: boolean } };
      expect(body.canyonOpenNow).toEqual({ weekStart, alreadyOpen: false });
    });

    it('POST /api/settings saves and round-trips correctly', async () => {
      const env = makeEnv();
      const res = await worker.fetch(
        new Request('https://example.com/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret-token' },
          body: JSON.stringify({
            canyonAutoOpen: false,
            canyonATime: '03:00',
            canyonBTime: '16:00',
            desertATime: '13:00',
            desertBTime: '22:00',
            canyonCloseTime: '20:00',
            desertCloseTime: '08:00',
          }),
        }),
        env,
        ctx,
      );
      expect(res.status).toBe(200);
      const body = await res.json() as { ok: boolean; settings: Record<string, unknown> };
      expect(body.ok).toBe(true);
      expect(body.settings.canyonAutoOpen).toBe(false);
      expect(body.settings.canyonATime).toBe('03:00');
      expect(body.settings.desertBTime).toBe('22:00');
      expect(body.settings.canyonCloseTime).toBe('20:00');
      expect(body.settings.desertCloseTime).toBe('08:00');

      // Verify GET returns updated values
      const res2 = await worker.fetch(
        new Request('https://example.com/api/settings?token=secret-token'),
        env,
        ctx,
      );
      const body2 = await res2.json() as { settings: Record<string, unknown> };
      expect(body2.settings.canyonAutoOpen).toBe(false);
      expect(body2.settings.canyonATime).toBe('03:00');
      expect(body2.settings.canyonCloseTime).toBe('20:00');
      expect(body2.settings.desertCloseTime).toBe('08:00');
    });

    it('POST /api/settings returns 400 for invalid time value', async () => {
      const env = makeEnv();
      const res = await worker.fetch(
        new Request('https://example.com/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret-token' },
          body: JSON.stringify({ canyonATime: '12:00' }), // not a valid canyon time
        }),
        env,
        ctx,
      );
      expect(res.status).toBe(400);
    });


    it('POST /api/settings returns 403 for readonly token', async () => {
      const env = makeEnv({ WEB_READONLY_TOKEN: 'readonly-token' });
      const res = await worker.fetch(
        new Request('https://example.com/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer readonly-token' },
          body: JSON.stringify({ canyonAutoOpen: false }),
        }),
        env,
        ctx,
      );
      expect(res.status).toBe(403);
    });

    it('POST /api/settings immediately updates open Canyon event timestamps', async () => {
      const env = makeEnv();
      // Create an open Canyon event for week 2026-06-01
      await env.DB.prepare(
        "INSERT INTO poc_events_event (kind, week_start, status) VALUES ('canyon', '2026-06-01', 'open')",
      ).run();
      // Save time settings: A=16:00 CET (Thu 14:00 UTC), B=03:00 CET (Fri 01:00 UTC, next day)
      await worker.fetch(
        new Request('https://example.com/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret-token' },
          body: JSON.stringify({ canyonATime: '16:00', canyonBTime: '03:00' }),
        }),
        env,
        ctx,
      );
      // Thursday (Mon+3=2026-06-04): 16:00 CET = 14:00 UTC
      // 03:00 CET night slot = Friday (Mon+4=2026-06-05) 01:00 UTC
      const row = await env.DB.prepare(
        "SELECT team_a_starts_at, team_b_starts_at FROM poc_events_event WHERE kind = 'canyon' AND week_start = '2026-06-01'",
      ).first<{ team_a_starts_at: string; team_b_starts_at: string }>();
      expect(row!.team_a_starts_at).toBe('2026-06-04T14:00:00.000Z');
      expect(row!.team_b_starts_at).toBe('2026-06-05T01:00:00.000Z');
    });

    it('POST /api/events/open-canyon-now creates the upcoming Canyon event', async () => {
      const env = makeEnv();
      const res = await worker.fetch(
        new Request('https://example.com/api/events/open-canyon-now', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret-token' },
          body: JSON.stringify({}),
        }),
        env,
        ctx,
      );
      expect(res.status).toBe(200);
      const body = await res.json() as { ok: boolean; alreadyOpen: boolean; weekStart: string; event: { kind: string; weekStart: string; status: string } };
      expect(body.ok).toBe(true);
      expect(body.alreadyOpen).toBe(false);
      // Expected weekStart = next Monday from now (same rule as the Friday cron).
      const now = new Date();
      const nextMonday = new Date(now);
      nextMonday.setUTCDate(now.getUTCDate() + ((8 - now.getUTCDay()) % 7));
      const expectedWeekStart = nextMonday.toISOString().slice(0, 10);
      expect(body.weekStart).toBe(expectedWeekStart);
      expect(body.event.kind).toBe('canyon');
      const row = await env.DB.prepare(
        "SELECT kind, week_start, status, registration_closes_at FROM poc_events_event WHERE kind = 'canyon' AND week_start = ?",
      ).bind(expectedWeekStart).first<{ kind: string; week_start: string; status: string; registration_closes_at: string }>();
      expect(row).toBeTruthy();
      expect(row!.status).toBe('open');
      // Default: Monday 12:00 server time = 14:00 UTC.
      expect(row!.registration_closes_at).toBe(`${expectedWeekStart}T14:00:00.000Z`);
    });

    it('POST /api/events/open-canyon-now is idempotent when already open', async () => {
      const env = makeEnv();
      const req = () => new Request('https://example.com/api/events/open-canyon-now', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret-token' },
        body: JSON.stringify({}),
      });
      const first = await worker.fetch(req(), env, ctx);
      expect(first.status).toBe(200);
      const second = await worker.fetch(req(), env, ctx);
      expect(second.status).toBe(200);
      const body = await second.json() as { ok: boolean; alreadyOpen: boolean };
      expect(body.ok).toBe(true);
      expect(body.alreadyOpen).toBe(true);
      const rows = await env.DB.prepare(
        "SELECT id FROM poc_events_event WHERE kind = 'canyon'",
      ).all();
      expect(rows.results.length).toBe(1);
    });

    it('POST /api/events/open-canyon-now returns 409 when the event is locked', async () => {
      const env = makeEnv();
      const now = new Date();
      const nextMonday = new Date(now);
      nextMonday.setUTCDate(now.getUTCDate() + ((8 - now.getUTCDay()) % 7));
      const expectedWeekStart = nextMonday.toISOString().slice(0, 10);
      await env.DB.prepare(
        "INSERT INTO poc_events_event (kind, week_start, status) VALUES ('canyon', ?, 'locked')",
      ).bind(expectedWeekStart).run();
      const res = await worker.fetch(
        new Request('https://example.com/api/events/open-canyon-now', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret-token' },
          body: JSON.stringify({}),
        }),
        env,
        ctx,
      );
      expect(res.status).toBe(409);
    });

    it('POST /api/events/open-canyon-now returns 403 for readonly token', async () => {
      const env = makeEnv({ WEB_READONLY_TOKEN: 'readonly-token' });
      const res = await worker.fetch(
        new Request('https://example.com/api/events/open-canyon-now', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer readonly-token' },
          body: JSON.stringify({}),
        }),
        env,
        ctx,
      );
      expect(res.status).toBe(403);
    });

    it('POST /api/events/open-canyon-now returns 401 without token', async () => {
      const env = makeEnv();
      const res = await worker.fetch(
        new Request('https://example.com/api/events/open-canyon-now', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }),
        env,
        ctx,
      );
      expect(res.status).toBe(401);
    });

    it('readonly users see only the timezone setting (event times hidden)', async () => {
      const env = makeEnv({ WEB_READONLY_TOKEN: 'readonly-token' });
      const res = await worker.fetch(
        new Request('https://example.com/?token=readonly-token'),
        env,
        ctx,
      );
      expect(res.status).toBe(200);
      const body = await res.text();
      // The `hidden` attribute must beat inline display:flex styles.
      expect(body).toContain('[hidden] { display: none !important; }');
      const panel = body.slice(
        body.indexOf('id="panel-settings"'),
        body.indexOf('id="panel-settings"') + 8000,
      );
      // Timezone selector stays visible to everyone.
      expect(panel).toContain('id="settings-tz"');
      // Canyon + Desert headers and cards are hidden for readonly …
      expect(panel).toContain('data-i18n="settings.canyon.title">Canyon Storm</h2>');
      const hiddenCards = panel.match(/<div class="ev-card"[^>]* hidden[^>]*>/g) ?? [];
      expect(hiddenCards.length).toBe(2);
      // … but still rendered (hidden, not removed) incl. the manual open button.
      expect(panel).toContain('id="settings-canyon-open-now"');
      expect(panel).toContain('id="settings-canyon-a-time"');
      expect(panel).toContain('id="settings-desert-a-time"');
    });

    it('admin users see event time settings and the open-now button', async () => {
      const env = makeEnv();
      const res = await worker.fetch(
        new Request('https://example.com/?token=secret-token'),
        env,
        ctx,
      );
      expect(res.status).toBe(200);
      const body = await res.text();
      const panel = body.slice(
        body.indexOf('id="panel-settings"'),
        body.indexOf('id="panel-settings"') + 8000,
      );
      expect(panel).toContain('id="settings-canyon-open-now"');
      const hiddenCards = panel.match(/<div class="ev-card"[^>]* hidden[^>]*>/g) ?? [];
      expect(hiddenCards.length).toBe(0);
    });

    it('roster has no Lock button but shows the admin workflow note', async () => {
      const env = makeEnv();
      const adminRes = await worker.fetch(
        new Request('https://example.com/?token=secret-token'),
        env,
        ctx,
      );
      const adminBody = await adminRes.text();
      expect(adminBody).not.toContain('id="ev-lock"');
      expect(adminBody).toContain('id="ev-roster-admin-note"');

      const roEnv = makeEnv({ WEB_READONLY_TOKEN: 'readonly-token' });
      const roRes = await worker.fetch(new Request('https://example.com/?token=readonly-token'), roEnv, ctx);
      const roBody = await roRes.text();
      expect(roBody).not.toContain('id="ev-lock"');
      expect(roBody).not.toContain('ev-roster-admin-note');
    });

    it('roster compact view is available to every role', async () => {
      const env = makeEnv();
      const adminBody = await (
        await worker.fetch(new Request('https://example.com/?token=secret-token'), env, ctx)
      ).text();
      expect(adminBody).toContain('id="ev-compact"');
      expect(adminBody).toContain('id="ev-compact-modal"');

      const roEnv = makeEnv({ WEB_READONLY_TOKEN: 'readonly-token' });
      const roBody = await (
        await worker.fetch(new Request('https://example.com/?token=readonly-token'), roEnv, ctx)
      ).text();
      expect(roBody).toContain('id="ev-compact"');
      expect(roBody).toContain('id="ev-compact-modal"');
      // Compact view shows one team at a time (full-width rows, full role
      // names) with an A/B toggle — no truncated side-by-side columns.
      expect(adminBody).toContain('id="ev-compact-team"');
      expect(adminBody).toContain('id="ev-compact-team-a"');
      expect(adminBody).toContain('id="ev-compact-team-b"');
      expect(roBody).toContain('id="ev-compact-team"');
      expect(adminBody).not.toContain('ev-compact-legend');
      expect(adminBody).not.toContain('COMPACT_ROLE_CODES');
    });

    it('registration admin actions stay on one row (Ban / P / × never stack)', () => {
      expect(CLIENT_ROSTER).toContain('<td class="ev-actions">');
      expect(PAGE_STYLES).toContain('.ev-actions, .ev-actions button');
    });

    it('events roster toolbar has phone rules for even button rows', async () => {
      const env = makeEnv();
      const html = await (
        await worker.fetch(new Request('https://example.com/?token=secret-token'), env, ctx)
      ).text();
      expect(html).toContain('class="ev-toolbar"');
      // Title + status go full-width, spacer hides, buttons pair up evenly.
      expect(PAGE_STYLES).toContain('.ev-toolbar > h3, .ev-toolbar > #ev-roster-status');
      expect(PAGE_STYLES).toContain('.ev-toolbar > .spacer');
      expect(PAGE_STYLES).toContain('.ev-toolbar > button');
    });

    it('POST /api/settings returns 400 for invalid close time', async () => {
      const env = makeEnv();
      for (const bad of [{ canyonCloseTime: '24:00' }, { desertCloseTime: 'nope' }, { canyonCloseTime: '12:0' }, { canyonCloseTime: '20:30' }, { desertCloseTime: '08:15' }]) {
        const res = await worker.fetch(
          new Request('https://example.com/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret-token' },
            body: JSON.stringify(bad),
          }),
          env,
          ctx,
        );
        expect(res.status).toBe(400);
      }
    });

    it('scheduled Canyon creation uses the configured server-time close hour', async () => {
      const env = makeEnv();
      await env.DB.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('setting:canyon_close_hour', '20:00')").run();
      const event = {
        scheduledTime: new Date('2026-05-29T00:00:00Z').getTime(),
        cron: '0 0 * * FRI',
      } as ScheduledEvent;
      const posted: string[] = [];
      const restore = stubFetchOk(posted);
      try {
        await worker.scheduled(event, env, ctx);
      } finally {
        restore();
      }
      const row = await env.DB.prepare(
        "SELECT registration_closes_at FROM poc_events_event WHERE kind = 'canyon' AND week_start = '2026-06-01'",
      ).first<{ registration_closes_at: string }>();
      // Monday of event week at 20:00 server time = 22:00 UTC.
      expect(row!.registration_closes_at).toBe('2026-06-01T22:00:00.000Z');
      // Discord announcement is fully in server time (slots + close, no CET mix).
      expect(posted.join('\n')).toContain('Registration closes: Monday 20:00 server time');
      expect(posted.join('\n')).toContain('server time');
      expect(posted.join('\n')).not.toContain('CET');
      expect(posted.join('\n')).not.toContain('UTC');
    });

    it('scheduled Desert creation uses the configured server-time close hour', async () => {
      const env = makeEnv();
      await env.DB.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('setting:desert_close_hour', '08:00')").run();
      const event = {
        scheduledTime: new Date('2026-05-30T00:00:00Z').getTime(),
        cron: '0 0 * * SAT',
      } as ScheduledEvent;
      const posted: string[] = [];
      const restore = stubFetchOk(posted);
      try {
        await worker.scheduled(event, env, ctx);
      } finally {
        restore();
      }
      const row = await env.DB.prepare(
        "SELECT registration_closes_at FROM poc_events_event WHERE kind = 'desert' AND week_start = '2026-06-01'",
      ).first<{ registration_closes_at: string }>();
      // Wednesday of event week at 08:00 server time = 10:00 UTC.
      expect(row!.registration_closes_at).toBe('2026-06-03T10:00:00.000Z');
      expect(posted.join('\n')).toContain('Registration closes: Wednesday 08:00 server time');
    });

    it('scheduled Desert announcement shows slots in server time on Friday', async () => {
      const env = makeEnv();
      await env.DB.batch([
        env.DB.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('setting:desert_a_time', '22:00')"),
        env.DB.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('setting:desert_b_time', '13:00')"),
      ]);
      const event = {
        scheduledTime: new Date('2026-05-30T00:00:00Z').getTime(),
        cron: '0 0 * * SAT',
      } as ScheduledEvent;
      const posted: string[] = [];
      const restore = stubFetchOk(posted);
      try {
        await worker.scheduled(event, env, ctx);
      } finally {
        restore();
      }
      // 22:00 game = Friday 18:00 server; 13:00 game = Friday 09:00 server.
      const text = posted.join('\n');
      expect(text).toContain('Friday 18:00 server time');
      expect(text).toContain('Friday 09:00 server time');
    });

    it('changing close-time settings does not rewrite already open events', async () => {
      const env = makeEnv();
      await env.DB.prepare(
        "INSERT INTO poc_events_event (kind, week_start, status, registration_closes_at) VALUES ('canyon', '2026-06-01', 'open', '2026-06-01T12:00:00.000Z')",
      ).run();
      const res = await worker.fetch(
        new Request('https://example.com/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret-token' },
          body: JSON.stringify({ canyonCloseTime: '20:00' }),
        }),
        env,
        ctx,
      );
      expect(res.status).toBe(200);
      const row = await env.DB.prepare(
        "SELECT registration_closes_at FROM poc_events_event WHERE kind = 'canyon' AND week_start = '2026-06-01'",
      ).first<{ registration_closes_at: string }>();
      // Already open event keeps its stored deadline; the new default applies to future events only.
      expect(row!.registration_closes_at).toBe('2026-06-01T12:00:00.000Z');
    });

    it('POST /api/events/open-canyon-now uses the configured server-time close hour', async () => {
      const env = makeEnv();
      await env.DB.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('setting:canyon_close_hour', '18:00')").run();
      const res = await worker.fetch(
        new Request('https://example.com/api/events/open-canyon-now', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret-token' },
          body: JSON.stringify({}),
        }),
        env,
        ctx,
      );
      expect(res.status).toBe(200);
      const body = await res.json() as { ok: boolean; weekStart: string };
      const row = await env.DB.prepare(
        "SELECT registration_closes_at FROM poc_events_event WHERE kind = 'canyon' AND week_start = ?",
      ).bind(body.weekStart).first<{ registration_closes_at: string }>();
      // Monday 18:00 server time = 20:00 UTC.
      expect(row!.registration_closes_at).toBe(`${body.weekStart}T20:00:00.000Z`);
    });

    it('open-now button has explicit disabled styling (inline styles beat native graying)', async () => {
      const env = makeEnv();
      const res = await worker.fetch(
        new Request('https://example.com/?token=secret-token'),
        env,
        ctx,
      );
      const html = await res.text();
      const script = html.slice(html.indexOf('<script>'));
      // The disabled attribute alone is invisible on this button (custom inline
      // background/color), so the client must also fade it + change the cursor.
      expect(script).toContain('settings-canyon-open-now');
      expect(script).toContain('not-allowed');
      expect(script).toContain('settingsSetOpenNowDisabled');
    });

    it('settings page is fully in server time with hour-only close selects', async () => {
      const env = makeEnv();
      const res = await worker.fetch(
        new Request('https://example.com/?token=secret-token'),
        env,
        ctx,
      );
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('id="settings-canyon-close-time"');
      expect(html).toContain('id="settings-desert-close-time"');
      expect(html).toContain('data-i18n="settings.regCloseCanyon"');
      expect(html).toContain('data-i18n="settings.regCloseDesert"');
      expect(html).toContain('data-i18n="settings.regCloseHelp"');
      // Hour-only selects (00–23 as 'HH:00'), no minute-granularity time inputs.
      expect(html).not.toContain('type="time"');
      expect(html).toContain('<option value="00:00">00</option>');
      expect(html).toContain('<option value="23:00">23</option>');
      // Match slots shown in server time (values stay canonical game times).
      expect(html).toContain('<option value="16:00">12:00</option>');
      expect(html).toContain('<option value="03:00">23:00</option>');
      expect(html).toContain('<option value="22:00">18:00</option>');
      expect(html).toContain('<option value="13:00">09:00</option>');
    });
  });

  describe('getNextMondayWeekStart', () => {
    it('returns the same day on Monday', () => {
      expect(getNextMondayWeekStart(new Date('2026-06-01T12:00:00Z')).weekStart).toBe('2026-06-01');
    });

    it('returns +3 days on Friday and +2 on Saturday', () => {
      expect(getNextMondayWeekStart(new Date('2026-05-29T00:00:00Z')).weekStart).toBe('2026-06-01');
      expect(getNextMondayWeekStart(new Date('2026-05-30T00:00:00Z')).weekStart).toBe('2026-06-01');
    });

    it('returns +1 day on Sunday and +6 on Tuesday', () => {
      expect(getNextMondayWeekStart(new Date('2026-05-31T12:00:00Z')).weekStart).toBe('2026-06-01');
      expect(getNextMondayWeekStart(new Date('2026-06-02T12:00:00Z')).weekStart).toBe('2026-06-08');
    });

    it('renderPage hides admin settings cards for readonly role', () => {
      const adminHtml = renderPage('tok', 'admin');
      const readonlyHtml = renderPage('tok', 'readonly');
      expect(adminHtml).not.toMatch(/<div class="ev-card"[^>]* hidden[^>]*>\s*<label/);
      expect(readonlyHtml).toMatch(/<div class="ev-card"[^>]* hidden[^>]*>\s*<label/);
      // Timezone selector is present for both roles.
      expect(readonlyHtml).toContain('id="settings-tz"');
      expect(adminHtml).toContain('id="settings-tz"');
    });
  });
});
