import { describe, it, expect } from 'vitest';
import { suggestRoster } from '../src/utils/eventSuggest';
import type {
  Registration,
  SquadType,
  TeamPreference,
  TimeSlot,
} from '../src/eventsStore';

function mkReg(
  id: number,
  name: string,
  power: number,
  opts: Partial<
    Pick<
      Registration,
      'status' | 'memberActive' | 'teamPreference' | 'resolvedTeamPreference' | 'timeSlot' | 'resolvedTimeSlot' | 'squadType' | 'isBanned'
    >
  > = {},
): Registration {
  return {
    id,
    eventId: 1,
    memberId: id,
    memberName: name,
    memberActive: opts.memberActive ?? true,
    status: opts.status ?? 'IN',
    teamPreference: (opts.teamPreference ?? 'any') as TeamPreference,
    resolvedTeamPreference: opts.resolvedTeamPreference ?? null,
    timeSlot: (opts.timeSlot ?? null) as TimeSlot | null,
    resolvedTimeSlot: opts.resolvedTimeSlot ?? null,
    squadPower: power,
    squadType: (opts.squadType ?? 'tanks') as SquadType,
    source: 'web',
    priority: null,
    isBanned: opts.isBanned ?? false,
    isPenalized: false,
    notes: null,
    createdAt: '2025-01-01',
    updatedAt: '2025-01-01',
  };
}

const noPrev = new Map<number, 'main' | 'sub'>();

describe('suggestRoster (Canyon)', () => {
  it('returns no assignments when there are no eligible registrants', () => {
    const res = suggestRoster({ kind: 'canyon', registrations: [], priorities: new Map(), previousRoles: noPrev });
    expect(res.assignments).toEqual([]);
    expect(res.unassigned).toEqual([]);
    expect(res.warnings.length).toBeGreaterThan(0);
  });

  it('assigns high-priority players as mains across both teams', () => {
    const regs: Registration[] = [];
    for (let i = 1; i <= 10; i++) {
      regs.push(mkReg(i, `P${String(i).padStart(2, '0')}`, 100 - i));
    }
    // First 6 get priority 1.0, rest get 0.0
    const priorities = new Map<number, number>();
    for (let i = 1; i <= 10; i++) priorities.set(i, i <= 6 ? 1.0 : 0.0);
    const res = suggestRoster({ kind: 'canyon', registrations: regs, priorities, previousRoles: noPrev });
    const highPrioMembers = res.assignments
      .filter((a) => (priorities.get(a.memberId) ?? 1.0) === 1.0)
      .map((a) => a.memberId)
      .sort((a, b) => a - b);
    expect(highPrioMembers).toEqual([1, 2, 3, 4, 5, 6]);
    // All priority-1.0 players should be mains
    for (const a of res.assignments.filter((a) => (priorities.get(a.memberId) ?? 1.0) === 1.0)) {
      expect(a.role).toBe('main');
    }
    // Priority-1.0 split between teams
    const aHigh = res.assignments.filter((a) => a.team === 'A' && (priorities.get(a.memberId) ?? 1.0) === 1.0).length;
    const bHigh = res.assignments.filter((a) => a.team === 'B' && (priorities.get(a.memberId) ?? 1.0) === 1.0).length;
    expect(aHigh).toBeGreaterThan(0);
    expect(bHigh).toBeGreaterThan(0);
    expect(aHigh + bHigh).toBe(6);
  });

  it('excludes OUT, MAYBE, inactive members, and zero-power IN members', () => {
    const regs = [
      mkReg(1, 'IN-ok', 100),
      mkReg(2, 'OUT', 100, { status: 'OUT' }),
      mkReg(3, 'MAYBE', 100, { status: 'MAYBE' }),
      mkReg(4, 'Inactive', 100, { memberActive: false }),
    ];
    const res = suggestRoster({ kind: 'canyon', registrations: regs, priorities: new Map(), previousRoles: noPrev });
    expect(res.assignments.map((a) => a.memberId)).toEqual([1]);
  });

  it('is deterministic when given the same rng seed', () => {
    const regs = [
      mkReg(1, 'Charlie', 50),
      mkReg(2, 'Alice', 50),
      mkReg(3, 'Bob', 50),
    ];
    const priorities = new Map([[1, 0.5], [2, 0.5], [3, 0.5]]);
    const fixedRng = () => 0.42;
    const r1 = suggestRoster({ kind: 'canyon', registrations: regs, priorities, previousRoles: noPrev, rng: fixedRng });
    const r2 = suggestRoster({ kind: 'canyon', registrations: regs, priorities, previousRoles: noPrev, rng: fixedRng });
    expect(r1.assignments.map((a) => a.memberId)).toEqual(r2.assignments.map((a) => a.memberId));
  });

  it('higher priority players are selected before lower ones', () => {
    const regs: Registration[] = [];
    for (let i = 1; i <= 44; i++) {
      regs.push(mkReg(i, `P${String(i).padStart(2, '0')}`, 100));
    }
    // Add one high-priority player with lower power
    regs.push(mkReg(45, 'HighPrio', 10));
    const priorities = new Map<number, number>();
    for (let i = 1; i <= 44; i++) priorities.set(i, 0.2); // low priority
    priorities.set(45, 0.9); // high priority

    const res = suggestRoster({ kind: 'canyon', registrations: regs, priorities, previousRoles: noPrev });
    const highPrio = res.assignments.find((a) => a.memberId === 45);
    expect(highPrio).toBeDefined();
    expect(highPrio!.role).toBe('main');
  });

  it('within same priority, selection is random — all players get a fair chance', () => {
    // 50 players all at same priority — exactly 40 get main slots, 10 are subs, 0 benched.
    // With a different rng the selected set will differ (randomized tiebreak).
    const regs: Registration[] = [];
    for (let i = 1; i <= 50; i++) {
      regs.push(mkReg(i, `P${String(i).padStart(2, '0')}`, 1000 - i));
    }
    const priorities = new Map<number, number>();
    for (let i = 1; i <= 50; i++) priorities.set(i, 0.5);
    const res1 = suggestRoster({ kind: 'canyon', registrations: regs, priorities, previousRoles: noPrev, rng: () => 0.1 });
    const res2 = suggestRoster({ kind: 'canyon', registrations: regs, priorities, previousRoles: noPrev, rng: () => 0.9 });
    // Counts are always correct regardless of rng
    expect(res1.assignments.filter((a) => a.role === 'main').length).toBe(40);
    expect(res1.assignments.length).toBe(50);
    expect(res1.unassigned.length).toBe(0);
    // Different rng produces different ordering within same-priority group
    const mains1 = res1.assignments.filter((a) => a.role === 'main').map((a) => a.memberId).sort((a, b) => a - b);
    const mains2 = res2.assignments.filter((a) => a.role === 'main').map((a) => a.memberId).sort((a, b) => a - b);
    expect(mains1).not.toEqual(mains2);
  });

  it('missing priority defaults to 1.0', () => {
    // Use teamPreference to force both onto team A so slot ordering is comparable
    const regs = [
      mkReg(1, 'NoPrio', 50, { teamPreference: 'A' }),   // not in map → 1.0
      mkReg(2, 'LowPrio', 50, { teamPreference: 'A' }),  // 0.2
    ];
    const priorities = new Map([[2, 0.2]]);
    const res = suggestRoster({ kind: 'canyon', registrations: regs, priorities, previousRoles: noPrev, rng: () => 0.5 });
    const noPrio = res.assignments.find((a) => a.memberId === 1)!;
    const lowPrio = res.assignments.find((a) => a.memberId === 2)!;
    expect(noPrio.priority).toBe(1.0);
    expect(lowPrio.priority).toBe(0.2);
    // Both on team A; noPrio (1.0) ranks first → lower slot index
    expect(noPrio.slotIndex).toBeLessThan(lowPrio.slotIndex);
  });

  it('resolvedTeamPreference is display-only — any-pref players spill to the other team if preferred side is full', () => {
    // All 41 players hint resolvedTeamPreference='B', but B only fits 30 (20 main + 10 sub).
    // The overflow must go to A, not bench — resolvedTeamPreference must NOT hard-lock.
    const regs: Registration[] = [];
    for (let i = 1; i <= 41; i++) {
      regs.push(mkReg(i, `P${i}`, 1000 - i, { resolvedTeamPreference: 'B' }));
    }
    const res = suggestRoster({ kind: 'canyon', registrations: regs, priorities: new Map(), previousRoles: noPrev });
    expect(res.unassigned.length).toBe(0); // all 41 fit across 60 total slots (30 per team)
    expect(res.assignments.filter((a) => a.team === 'A').length).toBeGreaterThan(0);
  });
});

describe('suggestRoster (Desert)', () => {
  it('splits players by time_slot: 22 -> team A, 13 -> team B', () => {
    const regs = [
      mkReg(1, 'A1', 100, { timeSlot: '22' }),
      mkReg(2, 'A2', 90, { timeSlot: '22' }),
      mkReg(3, 'B1', 80, { timeSlot: '13' }),
      mkReg(4, 'B2', 70, { timeSlot: '13' }),
    ];
    const res = suggestRoster({ kind: 'desert', registrations: regs, priorities: new Map(), previousRoles: noPrev });
    const aIds = res.assignments.filter((a) => a.team === 'A').map((a) => a.memberId).sort();
    const bIds = res.assignments.filter((a) => a.team === 'B').map((a) => a.memberId).sort();
    expect(aIds).toEqual([1, 2]);
    expect(bIds).toEqual([3, 4]);
  });

  it('routes any-slot players to whichever pool has fewer registrants', () => {
    const regs = [
      mkReg(1, 'A1', 100, { timeSlot: '22' }),
      mkReg(2, 'A2', 90, { timeSlot: '22' }),
      mkReg(3, 'A3', 80, { timeSlot: '22' }),
      mkReg(4, 'B1', 70, { timeSlot: '13' }),
      mkReg(5, 'Flex', 60, { timeSlot: 'any' }),
    ];
    const res = suggestRoster({ kind: 'desert', registrations: regs, priorities: new Map(), previousRoles: noPrev });
    const flexAssn = res.assignments.find((a) => a.memberId === 5);
    expect(flexAssn).toBeDefined();
    expect(flexAssn!.team).toBe('B');
  });

  it('uses resolvedTimeSlot to route any-slot players to a specific pool', () => {
    // 3 in pool A (22), 1 in pool B (13), 1 flex with resolvedTimeSlot='22' → must go to A
    const regs = [
      mkReg(1, 'A1', 100, { timeSlot: '22' }),
      mkReg(2, 'A2', 90, { timeSlot: '22' }),
      mkReg(3, 'A3', 80, { timeSlot: '22' }),
      mkReg(4, 'B1', 70, { timeSlot: '13' }),
      mkReg(5, 'Flex', 60, { timeSlot: 'any', resolvedTimeSlot: '22' }),
    ];
    const res = suggestRoster({ kind: 'desert', registrations: regs, priorities: new Map(), previousRoles: noPrev });
    const flexAssn = res.assignments.find((a) => a.memberId === 5);
    expect(flexAssn).toBeDefined();
    expect(flexAssn!.team).toBe('A');
  });

  it('deprioritises Canyon players within equal-priority groups', () => {
    // Pool A: 22 players with equal priority 0.5. IDs 1-11 played Canyon, 12-22 did not.
    const regs: Registration[] = [];
    for (let i = 1; i <= 22; i++) {
      regs.push(mkReg(i, `P${i}`, 1000 - i, { timeSlot: '22' }));
    }
    const priorities = new Map<number, number>();
    for (let i = 1; i <= 22; i++) priorities.set(i, 0.5);
    const canyonPlayedIds = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    const res = suggestRoster({
      kind: 'desert', registrations: regs, priorities, previousRoles: noPrev,
      canyonPlayedIds, rng: () => 0.5,
    });
    const mainIds = res.assignments
      .filter((a) => a.team === 'A' && a.role === 'main')
      .map((a) => a.memberId);
    // All 20 main slots should be filled from the 22 players; the 2 benched should be Canyon players
    expect(mainIds.length).toBe(20);
    const benchedIds = [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22]
      .filter(id => !mainIds.includes(id));
    expect(benchedIds.length).toBe(2);
    // Both benched players must be from the Canyon-played set
    for (const id of benchedIds) {
      expect(canyonPlayedIds.has(id)).toBe(true);
    }
  });

  it('respects priority within each Desert pool', () => {
    const regs = [
      mkReg(1, 'LowPower', 10, { timeSlot: '22' }),
      mkReg(2, 'HighPower', 1000, { timeSlot: '22' }),
    ];
    const priorities = new Map([[1, 1.0], [2, 0.2]]);
    const res = suggestRoster({ kind: 'desert', registrations: regs, priorities, previousRoles: noPrev });
    const a1 = res.assignments.find((a) => a.memberId === 1)!;
    const a2 = res.assignments.find((a) => a.memberId === 2)!;
    expect(a1.team).toBe('A');
    expect(a2.team).toBe('A');
    // priority-1.0 player gets lower slot index (higher priority → picked first)
    expect(a1.slotIndex).toBeLessThan(a2.slotIndex);
  });

  it('assigns strategy roles to all mains per team by power order', () => {
    const regs: Registration[] = [];
    for (let i = 1; i <= 8; i++) {
      regs.push(mkReg(i, `A${i}`, 1000 - i * 10, { timeSlot: '22' }));
    }
    const res = suggestRoster({ kind: 'desert', registrations: regs, priorities: new Map(), previousRoles: noPrev });
    const sorted = res.assignments
      .filter((a) => a.team === 'A')
      .sort((a, b) => b.squadPower - a.squadPower);

    expect(sorted[0].strategyRole).toBe('assassin / silo');
    expect(sorted[1].strategyRole).toBe('assassin / arsenal');
    expect(sorted[2].strategyRole).toBe('hospital 1 / silo');
    expect(sorted[3].strategyRole).toBe('hospital 2 / mercenary');
    expect(sorted[4].strategyRole).toBe('hospital 3 / arsenal');
    expect(sorted[5].strategyRole).toBe('hospital 4 / mercenary');
    expect(sorted[6].strategyRole).toBe('oil 1');
    expect(sorted[7].strategyRole).toBe('oil 2');
  });

  it('assigns Canyon strategy roles to mains per team', () => {
    const regs: Registration[] = [];
    for (let i = 1; i <= 40; i++) {
      regs.push(mkReg(i, `P${i}`, 1000 - i * 10));
    }
    const res = suggestRoster({ kind: 'canyon', registrations: regs, priorities: new Map(), previousRoles: noPrev });
    const teamAMains = res.assignments
      .filter((a) => a.team === 'A' && a.role === 'main')
      .sort((a, b) => b.squadPower - a.squadPower);
    // Top 6 by power get 'power tower / virus lab'
    for (let i = 0; i < 6 && i < teamAMains.length; i++) {
      expect(teamAMains[i].strategyRole).toBe('power tower / virus lab');
    }
    // 7th gets 'sample warehouse 2 / sample warehouse 3'
    if (teamAMains.length > 6) {
      expect(teamAMains[6].strategyRole).toBe('sample warehouse 2 / sample warehouse 3');
    }
  });
});

describe('suggestRoster — assignment shape', () => {
  it('produces unique slot_index per team and assigns main/sub by slot order', () => {
    const regs: Registration[] = [];
    for (let i = 1; i <= 25; i++) {
      regs.push(mkReg(i, `P${String(i).padStart(2, '0')}`, 100 - i));
    }
    const res = suggestRoster({ kind: 'canyon', registrations: regs, priorities: new Map(), previousRoles: noPrev });
    for (const team of ['A', 'B'] as const) {
      const teamAssn = res.assignments.filter((a) => a.team === team);
      const slots = teamAssn.map((a) => a.slotIndex);
      expect(new Set(slots).size).toBe(slots.length); // unique
      for (const a of teamAssn) {
        if (a.slotIndex <= 20) expect(a.role).toBe('main');
        else expect(a.role).toBe('sub');
      }
    }
  });

  it('every assignment has a priority field in 0..1', () => {
    const regs = [
      mkReg(1, 'P1', 100),
      mkReg(2, 'P2', 90),
      mkReg(3, 'P3', 80),
    ];
    const priorities = new Map([[1, 1.0], [2, 0.5], [3, 0.0]]);
    const res = suggestRoster({ kind: 'canyon', registrations: regs, priorities, previousRoles: noPrev });
    for (const a of res.assignments) {
      expect(a.priority).toBeGreaterThanOrEqual(0);
      expect(a.priority).toBeLessThanOrEqual(1);
    }
  });

  it('hard team preference: player requesting team A never goes to B', () => {
    const regs: Registration[] = [];
    for (let i = 1; i <= 31; i++) {
      regs.push(mkReg(i, `A${i}`, 100, { teamPreference: 'A' }));
    }
    for (let i = 32; i <= 40; i++) {
      regs.push(mkReg(i, `B${i}`, 50, { teamPreference: 'B' }));
    }
    const res = suggestRoster({ kind: 'canyon', registrations: regs, priorities: new Map(), previousRoles: noPrev });
    expect(res.unassigned.length).toBe(1);
    const overflowId = res.unassigned[0].memberId;
    expect(overflowId).toBeGreaterThanOrEqual(1);
    expect(overflowId).toBeLessThanOrEqual(31);
    const aPrefOnB = res.assignments.filter(
      (a) => a.team === 'B' && regs.find((r) => r.memberId === a.memberId)?.teamPreference === 'A',
    );
    expect(aPrefOnB).toEqual([]);
  });

  it('any-preference players balance power between teams', () => {
    const regs = [
      mkReg(1, 'Strong', 1000),
      mkReg(2, 'Weak', 100),
    ];
    const res = suggestRoster({ kind: 'canyon', registrations: regs, priorities: new Map(), previousRoles: noPrev });
    const strong = res.assignments.find((a) => a.memberId === 1)!;
    const weak = res.assignments.find((a) => a.memberId === 2)!;
    expect(strong.team).not.toBe(weak.team);
  });
});

describe('suggestRoster — sub→main promotion', () => {
  // Helpers: build a Desert pool of `size` players for a given time slot.
  // IDs start at `startId`, powers at 300+index (deterministic ordering).
  function makeDesertPool(size: number, slot: '22' | '13', startId: number, prio = 0.8) {
    const regs: Registration[] = [];
    const prioMap = new Map<number, number>();
    for (let i = 0; i < size; i++) {
      const id = startId + i;
      regs.push(mkReg(id, `P${id}`, 300 + i, { timeSlot: slot }));
      prioMap.set(id, prio);
    }
    return { regs, prioMap };
  }

  it('promotes a sub-last-time player from sub to main (Desert)', () => {
    // 20 high-priority A players + P21 with low priority → P21 ends up as sub initially
    // P21 was sub last time → should be promoted to main; weakest A main (P1, power 300) demoted
    const a = makeDesertPool(20, '22', 1);
    const p21 = mkReg(21, 'WasSub', 50, { timeSlot: '22' });
    const b = makeDesertPool(21, '13', 100);

    const priorities = new Map([...a.prioMap, ...b.prioMap, [21, 0.2]]);
    const previousRoles = new Map<number, 'main' | 'sub'>([[21, 'sub']]);

    const res = suggestRoster({
      kind: 'desert',
      registrations: [...a.regs, p21, ...b.regs],
      priorities,
      previousRoles,
    });

    const p21Assn = res.assignments.find((x) => x.memberId === 21)!;
    expect(p21Assn).toBeDefined();
    expect(p21Assn.role).toBe('main'); // promoted from sub

    // Weakest main by priority asc → power asc = id=1, power=300 → demoted
    const demoted = res.assignments.find((x) => x.memberId === 1)!;
    expect(demoted.role).toBe('sub');

    // Team A still has exactly 20 mains
    const teamAMains = res.assignments.filter((x) => x.team === 'A' && x.role === 'main');
    expect(teamAMains).toHaveLength(20);
  });

  it('promotes multiple sub-last-time players simultaneously without re-demoting each other (Desert)', () => {
    // Without the fix: promoting P21 makes it a main, then when looking for weakest main for P22,
    // P21 (now main, low priority) is chosen and immediately demoted back → only P22 ends up as main.
    const a = makeDesertPool(20, '22', 1);
    const p21 = mkReg(21, 'WasSub1', 50, { timeSlot: '22' });
    const p22 = mkReg(22, 'WasSub2', 30, { timeSlot: '22' });
    const b = makeDesertPool(22, '13', 100);

    const priorities = new Map([...a.prioMap, ...b.prioMap, [21, 0.2], [22, 0.1]]);
    const previousRoles = new Map<number, 'main' | 'sub'>([[21, 'sub'], [22, 'sub']]);

    const res = suggestRoster({
      kind: 'desert',
      registrations: [...a.regs, p21, p22, ...b.regs],
      priorities,
      previousRoles,
    });

    // Both must be main
    expect(res.assignments.find((x) => x.memberId === 21)?.role).toBe('main');
    expect(res.assignments.find((x) => x.memberId === 22)?.role).toBe('main');

    // 2 weakest mains (id=1 power=300, id=2 power=301) must be sub
    expect(res.assignments.find((x) => x.memberId === 1)?.role).toBe('sub');
    expect(res.assignments.find((x) => x.memberId === 2)?.role).toBe('sub');

    // Team A count stays correct
    expect(res.assignments.filter((x) => x.team === 'A' && x.role === 'main')).toHaveLength(20);
    // Only 2 sub slots were filled initially (22 total A players); after swaps still 2 subs
    expect(res.assignments.filter((x) => x.team === 'A' && x.role === 'sub')).toHaveLength(2);
  });

  it('does not promote a player who was main last time even if currently sub (Desert)', () => {
    const a = makeDesertPool(20, '22', 1);
    const p21 = mkReg(21, 'WasMain', 50, { timeSlot: '22' });
    const b = makeDesertPool(21, '13', 100);

    const priorities = new Map([...a.prioMap, ...b.prioMap, [21, 0.2]]);
    const previousRoles = new Map<number, 'main' | 'sub'>([[21, 'main']]); // was main, not sub

    const res = suggestRoster({
      kind: 'desert',
      registrations: [...a.regs, p21, ...b.regs],
      priorities,
      previousRoles,
    });

    // P21 naturally ends up as sub (low priority) and was main last time → no promotion
    expect(res.assignments.find((x) => x.memberId === 21)?.role).toBe('sub');
  });

  it('does not promote a benched sub-last-time player (Desert)', () => {
    // 30 + 1 extra in pool A: 20 mains + 10 subs filled, P31 benched
    const a = makeDesertPool(30, '22', 1);
    const p31 = mkReg(31, 'BenchedWasSub', 10, { timeSlot: '22' });
    const b = makeDesertPool(21, '13', 100);

    const priorities = new Map([...a.prioMap, ...b.prioMap, [31, 0.2]]);
    const previousRoles = new Map<number, 'main' | 'sub'>([[31, 'sub']]);

    const res = suggestRoster({
      kind: 'desert',
      registrations: [...a.regs, p31, ...b.regs],
      priorities,
      previousRoles,
    });

    // P31 benched — promotion only applies to assigned subs
    expect(res.assignments.find((x) => x.memberId === 31)).toBeUndefined();
    expect(res.unassigned.find((u) => u.memberId === 31)).toBeDefined();
  });
  it('banned IN player is excluded from roster suggestion', () => {
    // Pool of exactly 20 players for team A (22-slot). Adding a banned 21st — they must be excluded.
    const a = makeDesertPool(20, '22', 1);
    const banned = mkReg(999, 'Banned', 9999, { timeSlot: '22', isBanned: true });
    const b = makeDesertPool(20, '13', 100);

    const priorities = new Map([...a.prioMap, ...b.prioMap, [999, 1.0]]);
    const res = suggestRoster({
      kind: 'desert',
      registrations: [...a.regs, banned, ...b.regs],
      priorities,
      previousRoles: new Map(),
    });

    // Banned player must not be in any assignment
    expect(res.assignments.find((x) => x.memberId === 999)).toBeUndefined();
    // Banned player does not appear in unassigned (they are ineligible, not just unplaced)
    expect(res.unassigned.find((u) => u.memberId === 999)).toBeUndefined();
    // All 20 A-team main slots filled by non-banned players
    const teamAMains = res.assignments.filter((x) => x.team === 'A' && x.role === 'main');
    expect(teamAMains).toHaveLength(20);
  });});

// ── sameTeamTime dispatch ────────────────────────────────────────────────────

describe('suggestRoster — sameTeamTime dispatch', () => {
  // Build a pool of N registrants with teamPreference set.
  function makeTeamPrefPool(
    startId: number,
    count: number,
    pref: 'A' | 'B' | 'any',
    basePower = 100,
  ): Registration[] {
    const regs: Registration[] = [];
    for (let i = 0; i < count; i++) {
      regs.push(mkReg(startId + i, `P${startId + i}`, basePower + i, {
        teamPreference: pref,
        timeSlot: null,
      }));
    }
    return regs;
  }

  // Local copy of makeDesertPool (mirrored from the promotion describe)
  function mkDesertPool(size: number, slot: '22' | '13', startId: number) {
    const regs: Registration[] = [];
    const prioMap = new Map<number, number>();
    for (let i = 0; i < size; i++) {
      const id = startId + i;
      regs.push(mkReg(id, `D${id}`, 500 - i, { timeSlot: slot }));
      prioMap.set(id, 0.8);
    }
    return { regs, prioMap };
  }

  it('Canyon + sameTeamTime=false → hard split pools by teamPreference', () => {
    // 20 explicit-A players + 20 explicit-B players; no 'any'.
    // With sameTeamTime=false each team should only contain players from the matching pool.
    const aRegs = makeTeamPrefPool(1, 21, 'A');  // 20 main + 1 bench for A
    const bRegs = makeTeamPrefPool(100, 21, 'B');
    const allRegs = [...aRegs, ...bRegs];
    const res = suggestRoster({
      kind: 'canyon',
      registrations: allRegs,
      priorities: new Map(),
      previousRoles: noPrev,
      sameTeamTime: false,
    });
    // Every A-slot player should come from the A pool (id 1-21)
    const aAssigned = res.assignments.filter((x) => x.team === 'A').map((x) => x.memberId);
    expect(aAssigned.every((id) => id >= 1 && id <= 21)).toBe(true);
    // Every B-slot player should come from the B pool (id 100-120)
    const bAssigned = res.assignments.filter((x) => x.team === 'B').map((x) => x.memberId);
    expect(bAssigned.every((id) => id >= 100 && id <= 120)).toBe(true);
  });

  it('Canyon + sameTeamTime=true (or undefined) → shared pool (existing Canyon behavior)', () => {
    // 30 'any' players — shared pool should balance them between teams.
    const regs = makeTeamPrefPool(1, 42, 'any');
    const res = suggestRoster({
      kind: 'canyon',
      registrations: regs,
      priorities: new Map(),
      previousRoles: noPrev,
      sameTeamTime: true,
    });
    const aCount = res.assignments.filter((x) => x.team === 'A').length;
    const bCount = res.assignments.filter((x) => x.team === 'B').length;
    expect(aCount).toBeGreaterThan(0);
    expect(bCount).toBeGreaterThan(0);
  });

  it('Desert + sameTeamTime=true → shared pool with timeSlot mapping', () => {
    // 22 players with slot '22' (→ hint A) and 22 with slot '13' (→ hint B).
    const aRegs = mkDesertPool(22, '22', 1).regs;
    const bRegs = mkDesertPool(22, '13', 100).regs;
    const res = suggestRoster({
      kind: 'desert',
      registrations: [...aRegs, ...bRegs],
      priorities: new Map(),
      previousRoles: noPrev,
      sameTeamTime: true,
    });
    // Both teams should be populated
    expect(res.assignments.filter((x) => x.team === 'A' && x.role === 'main')).toHaveLength(20);
    expect(res.assignments.filter((x) => x.team === 'B' && x.role === 'main')).toHaveLength(20);
  });

  it('Desert + sameTeamTime=undefined → existing Desert behavior (split by timeSlot)', () => {
    const aRegs = mkDesertPool(21, '22', 1).regs;
    const bRegs = mkDesertPool(21, '13', 100).regs;
    const res = suggestRoster({
      kind: 'desert',
      registrations: [...aRegs, ...bRegs],
      priorities: new Map(),
      previousRoles: noPrev,
      sameTeamTime: undefined,
    });
    expect(res.assignments.filter((x) => x.team === 'A' && x.role === 'main')).toHaveLength(20);
    expect(res.assignments.filter((x) => x.team === 'B' && x.role === 'main')).toHaveLength(20);
  });
});
