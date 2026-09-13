import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DataStore, type RewardRecord } from '../src/storage';

interface MockRewardRow {
  id: number;
  date: string;
  driver_name: string;
  vip_name: string | null;
  type: 'TRAIN' | 'VIP';
  raw_text: string;
  source_message_id: string;
  source_line: number;
}

interface MockMemberRow {
  id: number;
  display_name: string;
  normalized_name: string;
  active: number;
}

function createMockDb() {
  let rewardId = 1;
  let memberId = 1;
  const rewards: MockRewardRow[] = [];
  const members: MockMemberRow[] = [];

  function computeRewardedMembers(cutoffDate: string, type: 'train' | 'vip' | undefined) {
    const filtered = rewards.filter(row => row.date >= cutoffDate && (
      type === 'train'
        ? row.type === 'TRAIN'
        : type === 'vip'
          ? row.type === 'VIP' && row.vip_name !== null
          : (row.type === 'TRAIN' || (row.type === 'VIP' && row.vip_name !== null))
    ));

    const grouped = new Map<string, { count: number; lastDate: string }>();

    for (const row of filtered) {
      const recipient = row.type === 'TRAIN' ? row.driver_name : row.vip_name;
      if (!recipient) continue;

      const entry = grouped.get(recipient) ?? { count: 0, lastDate: row.date };
      entry.count += 1;
      if (row.date > entry.lastDate) {
        entry.lastDate = row.date;
      }
      grouped.set(recipient, entry);
    }

    return Array.from(grouped.entries())
      .map(([name, info]) => ({ name, count: info.count, last_date: info.lastDate }))
      .sort((a, b) => {
        if (a.last_date !== b.last_date) return a.last_date > b.last_date ? -1 : 1;
        if (a.count !== b.count) return b.count - a.count;
        return a.name.localeCompare(b.name);
      });
  }

  function buildExecutors(sql: string, params: any[]) {
    const run = async () => {
      if (sql.startsWith('INSERT INTO rewards')) {
        const [date, driverName, vipName, type, rawText, sourceMessageId, sourceLine] = params;
        const duplicate = rewards.find(row =>
          row.date === date &&
          row.driver_name === driverName &&
          row.vip_name === (vipName ?? null) &&
          row.type === type
        );

        if (duplicate) {
          throw new Error('UNIQUE constraint failed: rewards.date, rewards.driver_name, rewards.vip_name, rewards.type');
        }

        rewards.push({
          id: rewardId++,
          date,
          driver_name: driverName,
          vip_name: vipName ?? null,
          type,
          raw_text: rawText,
          source_message_id: sourceMessageId,
          source_line: sourceLine,
        });

        return { meta: { changes: 1 } } as const;
      }

      if (sql.startsWith('INSERT INTO members')) {
        const [displayName, normalizedName] = params;
        const existing = members.find(m => m.normalized_name === normalizedName);
        if (!existing) {
          members.push({ id: memberId++, display_name: displayName, normalized_name: normalizedName, active: 1 });
          return { meta: { changes: 1 } } as const;
        }
        return { meta: { changes: 0 } } as const;
      }

      if (sql.startsWith('UPDATE members SET active = 1')) {
        const [id] = params;
        const member = members.find(m => m.id === id);
        if (member) {
          member.active = 1;
          return { meta: { changes: 1 } } as const;
        }
        return { meta: { changes: 0 } } as const;
      }

      return { meta: { changes: 0 } } as const;
    };

    const all = async <T>() => {
      if (sql.startsWith('SELECT id, display_name, normalized_name, active FROM members')) {
        const [normalized] = params;
        const matched = members.filter(m => m.normalized_name === normalized);
        return { results: matched as T[] };
      }

      if (sql.startsWith('SELECT alias FROM member_aliases')) {
        return { results: [] as T[] };
      }

      if (sql.includes('SELECT MAX(date) as latest FROM rewards')) {
        if (rewards.length === 0) {
          return { results: [{ latest: null }] as T[] };
        }
        const latest = rewards.reduce((max, row) => (row.date > max ? row.date : max), rewards[0].date);
        return { results: [{ latest }] as T[] };
      }

      if (sql.startsWith('SELECT normalized_name FROM members')) {
        const normalizeds = params as string[];
        const matched = members.filter(m => normalizeds.includes(m.normalized_name)).map(m => ({ normalized_name: m.normalized_name }));
        return { results: matched as T[] };
      }

      if (sql.includes('CASE') && sql.includes('FROM rewards')) {
        const [cutoffDate] = params;
        let type: 'train' | 'vip' | undefined;
        if (sql.includes("AND type = 'TRAIN'")) {
          type = 'train';
        } else if (sql.includes("AND type = 'VIP' AND vip_name IS NOT NULL")) {
          type = 'vip';
        }
        const results = computeRewardedMembers(cutoffDate, type);
        return { results: results as T[] };
      }

      if (sql.startsWith("SELECT LOWER(TRIM(REPLACE(alias, '  ', ' ')))")) {
        return { results: [] as T[] };
      }

      return { results: [] as T[] };
    };

    const first = async <T>() => {
      if (sql.startsWith('SELECT id FROM members WHERE normalized_name = ?')) {
        const [normalized] = params;
        const member = members.find(m => m.normalized_name === normalized);
        return member ? ({ id: member.id } as T) : undefined;
      }

      const result = await all<T>();
      return result.results[0];
    };

    return { run, all, first };
  }

  return {
    prepare(sql: string) {
      const defaultExecutors = buildExecutors(sql, []);
      return {
        bind(...params: any[]) {
          return buildExecutors(sql, params);
        },
        run: defaultExecutors.run,
        all: defaultExecutors.all,
        first: defaultExecutors.first,
      };
    },
  };
}

function createTrainReward(date: string, driverName: string, overrides: Partial<RewardRecord> = {}): RewardRecord {
  return {
    date,
    driverName,
    type: 'TRAIN',
    rawText: `${date} ${driverName}`,
    sourceMessageId: overrides.sourceMessageId ?? `msg-${date}-${driverName}`,
    sourceLine: overrides.sourceLine ?? 0,
    vipName: overrides.vipName,
  };
}

describe('DataStore getRewardedMembers', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns all members within the requested day window even when system time is far in the future', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-12-31T00:00:00Z'));

    const store = new DataStore(createMockDb() as any);
    for (let i = 0; i < 21; i++) {
      const day = String(i + 1).padStart(2, '0');
      const reward = createTrainReward(`2024-12-${day}`, `Driver ${i}`);
      const added = await store.addReward(reward);
      expect(added).toBe(true);
    }

    const rewarded = await store.getRewardedMembers(21, 'train');
    expect(rewarded).toHaveLength(21);
    expect(rewarded[0].lastDate).toBe('2024-12-21');
    expect(rewarded[rewarded.length - 1].lastDate).toBe('2024-12-01');
  });

  it('de-duplicates rewards with identical details regardless of source', async () => {
    const store = new DataStore(createMockDb() as any);
    const first = createTrainReward('2024-12-16', 'Calioholic', { sourceMessageId: 'msg-1' });
    const duplicate = createTrainReward('2024-12-16', 'Calioholic', { sourceMessageId: 'msg-2', sourceLine: 5 });

    expect(await store.addReward(first)).toBe(true);
    expect(await store.addReward(duplicate)).toBe(false);

    const rewarded = await store.getRewardedMembers(30, 'train');
    expect(rewarded).toHaveLength(1);
    expect(rewarded[0]).toEqual({ name: 'Calioholic', count: 1, lastDate: '2024-12-16' });
  });
});