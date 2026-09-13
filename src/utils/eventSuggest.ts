// Pure functions for event roster suggestion. No D1 / no I/O so it's
// trivially unit-testable. Strength signal is squad_power declared in the
// registration form (NOT leaderboard data).
//
// Selection is priority-based: players are sorted by computed float priority
// (0..1, higher = better) then squad_power DESC. Top slots become mains,
// next subs, the rest land on the bench.
//
// Sub→main promotion: if a player was sub in the previous event of the same
// kind they are promoted to main; the main with the lowest priority in the
// same team gets moved to sub in exchange.

/**
 * Deterministic seeded PRNG (mulberry32).
 * Returns a function that produces uniform floats in [0, 1).
 */
export function seededRng(seed: number): () => number {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Stable 32-bit hash of a string (djb2-style, wraps via |0).
 */
export function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

import type {
  EventKind,
  AssignmentTeam,
  AssignmentRole,
  Registration,
  SquadType,
  TeamPreference,
  TimeSlot,
} from '../eventsStore';

export interface SuggestInput {
  kind: EventKind;
  registrations: Registration[];
  // Float priorities (0..1) keyed by memberId. Missing → 1.0 (no history).
  priorities: Map<number, number>;
  // Role from the most recent locked event of the same kind.
  previousRoles: Map<number, AssignmentRole>;
  // Optional RNG for tiebreaking within equal-priority groups. Defaults to Math.random.
  rng?: () => number;
  // For Desert only: member IDs who played (main/sub) in the locked Canyon event of the
  // same week. Within equal-priority groups they are deprioritised (placed last, still random).
  canyonPlayedIds?: Set<number>;
  /**
   * Whether both teams play at the same time (derived from event.teamAStartsAt vs teamBStartsAt).
   * - true  → use Canyon-style shared-pool algorithm regardless of kind
   * - false → use Desert-style separate-pool algorithm regardless of kind
   * - undefined → dispatch by kind (existing default behaviour)
   */
  sameTeamTime?: boolean;
}

export interface SuggestAssignment {
  memberId: number;
  memberName: string;
  team: AssignmentTeam;
  role: AssignmentRole;
  slotIndex: number;
  squadPower: number;
  squadType: SquadType;
  source: 'auto';
  priority: number; // 0..1
  strategyRole: string | null;
}

export interface SuggestResult {
  assignments: SuggestAssignment[];
  unassigned: { memberId: number; memberName: string; reason: string }[];
  warnings: string[];
}

const MAIN_PER_TEAM = 20;
const SUB_PER_TEAM = 10;
const TEAM_SIZE = MAIN_PER_TEAM + SUB_PER_TEAM; // 30

// Strategy roles assigned to Desert Storm mains in power order (1 = strongest).
export const DS_ROLE_SLOTS: readonly string[] = [
  'assassin / silo',
  'assassin / arsenal',
  'hospital 1 / silo',
  'hospital 2 / mercenary',
  'hospital 3 / arsenal',
  'hospital 4 / mercenary',
  'oil 1',
  'oil 2',
  'science',
  'infos',
  'hospital 1',
  'hospital 2',
  'hospital 3',
  'hospital 4',
  'oil 1',
  'oil 2',
  'hospital 1',
  'hospital 2',
  'hospital 3',
  'hospital 4',
];

export const CANYON_ROLE_SLOTS: readonly string[] = [
  'power tower / virus lab',
  'power tower / virus lab',
  'power tower / virus lab',
  'power tower / virus lab',
  'power tower / virus lab',
  'power tower / virus lab',
  'sample warehouse 2 / sample warehouse 3',
  'defense system 1 / sample warehouse 1',
  'defense system 2 / sample warehouse 4',
  'data center 1 / serum factory 2',
  'data center 2 / serum factory 1',
  'sample warehouse 2 / sample warehouse 3',
  'defense system 1 / sample warehouse 1',
  'defense system 2 / sample warehouse 4',
  'data center 1 / serum factory 2',
  'data center 2 / serum factory 1',
  'defense system 1 / sample warehouse 1',
  'defense system 2 / sample warehouse 4',
  'data center 1 / serum factory 2',
  'data center 2 / serum factory 1',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function eligible(r: Registration): boolean {
  return r.status === 'IN' && r.memberActive && r.squadPower > 0 && !r.isBanned;
}

// Sort by priority DESC, then Canyon-played last (0 = didn't play, 1 = played).
// Within each priority+canyon bucket the pre-shuffle order is random.
function priorityComparator(
  priorities: Map<number, number>,
  a: Registration,
  b: Registration,
  canyonPlayedIds?: Set<number>,
): number {
  const pa = priorities.get(a.memberId) ?? 1.0;
  const pb = priorities.get(b.memberId) ?? 1.0;
  if (pb !== pa) return pb - pa;
  if (canyonPlayedIds) {
    const ca = canyonPlayedIds.has(a.memberId) ? 1 : 0;
    const cb = canyonPlayedIds.has(b.memberId) ? 1 : 0;
    if (ca !== cb) return ca - cb; // non-canyon players sort first
  }
  return 0;
}

// Fisher-Yates in-place shuffle.
function shuffle<T>(arr: T[], rng: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function emptyTypeCount(): Record<SquadType, number> {
  return { tanks: 0, air: 0, missiles: 0 };
}

// Assign a flat ordered list of players to teams A/B, honouring team_preference
// and balancing squad types + total power.
function assignToTeams(
  players: Registration[],
  priorities: Map<number, number>,
  role: AssignmentRole,
  perTeam: number,
  startSlotA: number,
  startSlotB: number,
  typeCount: { A: Record<SquadType, number>; B: Record<SquadType, number> },
): {
  assignments: SuggestAssignment[];
  overflow: Registration[];
} {
  const assignments: SuggestAssignment[] = [];
  const overflow: Registration[] = [];
  let sA = startSlotA;
  let sB = startSlotB;
  const remaining = { A: perTeam, B: perTeam };
  const powerSum = { A: 0, B: 0 };

  function pickTeam(r: Registration): AssignmentTeam | null {
    // Hard team lock only for players who explicitly chose A or B.
    // resolvedTeamPreference is a soft hint for 'any' players — it must not bench
    // them if the preferred side is full; fall through to balance logic instead.
    if (r.teamPreference === 'A') return remaining.A > 0 ? 'A' : null;
    if (r.teamPreference === 'B') return remaining.B > 0 ? 'B' : null;
    if (remaining.A === 0 && remaining.B === 0) return null;
    if (remaining.A === 0) return 'B';
    if (remaining.B === 0) return 'A';
    if (r.squadType !== 'tanks') {
      const a = typeCount.A[r.squadType];
      const b = typeCount.B[r.squadType];
      if (a < b) return 'A';
      if (b < a) return 'B';
    }
    if (powerSum.A !== powerSum.B) return powerSum.A <= powerSum.B ? 'A' : 'B';
    return remaining.A >= remaining.B ? 'A' : 'B';
  }

  for (const r of players) {
    const team = pickTeam(r);
    if (!team) {
      overflow.push(r);
      continue;
    }
    remaining[team] -= 1;
    typeCount[team][r.squadType] += 1;
    powerSum[team] += r.squadPower;
    const slot = team === 'A' ? sA++ : sB++;
    assignments.push({
      memberId: r.memberId,
      memberName: r.memberName,
      team,
      role,
      slotIndex: slot,
      squadPower: r.squadPower,
      squadType: r.squadType,
      source: 'auto',
      priority: priorities.get(r.memberId) ?? 1.0,
      strategyRole: null,
    });
  }
  return { assignments, overflow };
}

// Apply sub→main promotion for a single team's assignments.
// For each player who was sub last time (previousRoles), if they are currently
// assigned as main, keep them (they were promoted). If they are currently sub,
// promote them to main and demote the main with the lowest priority to sub.
function applySubMainPromotion(
  assignments: SuggestAssignment[],
  previousRoles: Map<number, AssignmentRole>,
  priorities: Map<number, number>,
  team: AssignmentTeam,
): SuggestAssignment[] {
  const teamAssn = assignments.filter((a) => a.team === team);
  const otherAssn = assignments.filter((a) => a.team !== team);

  // Find subs who were sub last time → need promotion
  const subsToPromote = teamAssn.filter(
    (a) => a.role === 'sub' && previousRoles.get(a.memberId) === 'sub',
  );

  if (subsToPromote.length > 0) {
    // Pre-sort mains once and exclude the subs-to-promote themselves from demotion
    // candidates. This prevents a promoted player from being immediately re-demoted
    // when there are multiple subs to promote in the same iteration.
    const promoteIds = new Set(subsToPromote.map((a) => a.memberId));
    const mainsSorted = teamAssn
      .filter((a) => a.role === 'main' && !promoteIds.has(a.memberId))
      .sort((a, b) => {
        const pa = priorities.get(a.memberId) ?? 1.0;
        const pb = priorities.get(b.memberId) ?? 1.0;
        if (pa !== pb) return pa - pb; // lowest priority first
        return a.squadPower - b.squadPower; // then weakest first
      });

    for (let i = 0; i < subsToPromote.length && i < mainsSorted.length; i++) {
      const sub = subsToPromote[i];
      const demote = mainsSorted[i];
      // Swap roles and slot indices
      const subSlot = sub.slotIndex;
      const mainSlot = demote.slotIndex;
      sub.role = 'main';
      sub.slotIndex = mainSlot;
      demote.role = 'sub';
      demote.slotIndex = subSlot;
    }
  }

  return [...otherAssn, ...teamAssn];
}

// ---------------------------------------------------------------------------
// Canyon Storm — one global pool across both teams (60 seats).
// ---------------------------------------------------------------------------
function suggestCanyon(input: SuggestInput): SuggestResult {
  const { priorities, previousRoles, rng = Math.random } = input;
  const ins = input.registrations.filter(eligible);
  const warnings: string[] = [];
  if (ins.length < TEAM_SIZE * 2) {
    warnings.push(
      `only ${ins.length} eligible IN registrants; need ${TEAM_SIZE * 2} for full rosters`,
    );
  }

  // Shuffle first so equal-priority players are randomized, then sort by priority DESC.
  const ordered = shuffle(ins.slice(), rng).sort((a, b) => priorityComparator(priorities, a, b));

  const typeCount = { A: emptyTypeCount(), B: emptyTypeCount() };

  // Fill mains (20 per team)
  const mainCandidates = ordered.slice(0, Math.min(MAIN_PER_TEAM * 2, ordered.length));
  const afterMain = ordered.slice(mainCandidates.length);
  const mains = assignToTeams(mainCandidates, priorities, 'main', MAIN_PER_TEAM, 1, 1, typeCount);

  // Fill subs (10 per team)
  const subCandidates = [...mains.overflow, ...afterMain.slice(0, Math.min(SUB_PER_TEAM * 2, afterMain.length))];
  const afterSub = afterMain.slice(Math.max(0, subCandidates.length - mains.overflow.length));
  const subs = assignToTeams(
    subCandidates,
    priorities,
    'sub',
    SUB_PER_TEAM,
    MAIN_PER_TEAM + 1,
    MAIN_PER_TEAM + 1,
    typeCount,
  );

  let allAssignments = [...mains.assignments, ...subs.assignments];

  // Apply sub→main promotion per team
  allAssignments = applySubMainPromotion(allAssignments, previousRoles, priorities, 'A');
  allAssignments = applySubMainPromotion(allAssignments, previousRoles, priorities, 'B');

  // Bench
  const bench = [...subs.overflow, ...afterSub];
  const unassigned = bench.map((r) => ({
    memberId: r.memberId,
    memberName: r.memberName,
    reason: 'no capacity',
  }));

  // Squad type imbalance warning
  for (const t of ['air', 'missiles'] as const) {
    const diff = Math.abs(typeCount.A[t] - typeCount.B[t]);
    if (diff >= 3) {
      warnings.push(`${t} squad imbalance: A=${typeCount.A[t]} B=${typeCount.B[t]}`);
    }
  }

  // Assign strategy roles to mains per team, sorted strongest first.
  for (const team of ['A', 'B'] as const) {
    const teamMains = allAssignments
      .filter((x) => x.team === team && x.role === 'main')
      .sort((x, y) => y.squadPower - x.squadPower || x.memberName.localeCompare(y.memberName));
    for (let i = 0; i < teamMains.length && i < CANYON_ROLE_SLOTS.length; i++) {
      teamMains[i].strategyRole = CANYON_ROLE_SLOTS[i];
    }
  }

  return { assignments: allAssignments, unassigned, warnings };
}

// ---------------------------------------------------------------------------
// Desert Storm — two independent pools by time_slot.
// Time slot '22' → team A, '13' → team B, 'any' → whichever is smaller.
// ---------------------------------------------------------------------------
function suggestDesert(input: SuggestInput): SuggestResult {
  const { priorities, previousRoles, rng = Math.random, canyonPlayedIds } = input;
  const ins = input.registrations.filter(eligible);
  const warnings: string[] = [];

  const poolA: Registration[] = [];
  const poolB: Registration[] = [];
  for (const r of ins) {
    // Use resolvedTimeSlot for 'any' registrations (pre-computed by resolveAnySlots).
    // Fall back to raw timeSlot (explicit '13'/'22') or treat as flex if still null.
    const slot = r.timeSlot === 'any' ? (r.resolvedTimeSlot ?? null) : r.timeSlot;
    if (slot === '22') poolA.push(r);
    else if (slot === '13') poolB.push(r);
    else if (poolA.length <= poolB.length) poolA.push(r);
    else poolB.push(r);
  }

  function runPool(
    pool: Registration[],
    team: AssignmentTeam,
  ): {
    assignments: SuggestAssignment[];
    unassigned: { memberId: number; memberName: string; reason: string }[];
  } {
    if (pool.length < TEAM_SIZE) {
      warnings.push(
        `Desert team ${team}: only ${pool.length} eligible registrants (need ${TEAM_SIZE})`,
      );
    }
    const forced = pool.map((r) => ({ ...r, teamPreference: team } as Registration));
    const ordered = shuffle(forced.slice(), rng).sort((a, b) => priorityComparator(priorities, a, b, canyonPlayedIds));

    const typeCount = { A: emptyTypeCount(), B: emptyTypeCount() };

    const mainCandidates = ordered.slice(0, Math.min(MAIN_PER_TEAM, ordered.length));
    const afterMain = ordered.slice(mainCandidates.length);
    const mains = assignToTeams(mainCandidates, priorities, 'main', MAIN_PER_TEAM, 1, 1, typeCount);

    const subCandidates = [
      ...mains.overflow,
      ...afterMain.slice(0, Math.min(SUB_PER_TEAM, afterMain.length)),
    ];
    const afterSub = afterMain.slice(Math.max(0, subCandidates.length - mains.overflow.length));
    const subs = assignToTeams(
      subCandidates,
      priorities,
      'sub',
      SUB_PER_TEAM,
      MAIN_PER_TEAM + 1,
      MAIN_PER_TEAM + 1,
      typeCount,
    );

    const bench = [...subs.overflow, ...afterSub];
    return {
      assignments: [...mains.assignments, ...subs.assignments],
      unassigned: bench.map((r) => ({
        memberId: r.memberId,
        memberName: r.memberName,
        reason: 'no capacity',
      })),
    };
  }

  const a = runPool(poolA, 'A');
  const b = runPool(poolB, 'B');
  let allAssignments = [...a.assignments, ...b.assignments];

  // Apply sub→main promotion per team
  allAssignments = applySubMainPromotion(allAssignments, previousRoles, priorities, 'A');
  allAssignments = applySubMainPromotion(allAssignments, previousRoles, priorities, 'B');

  // Assign strategy roles to mains per team, sorted strongest first.
  for (const team of ['A', 'B'] as const) {
    const mains = allAssignments
      .filter((x) => x.team === team && x.role === 'main')
      .sort((x, y) => y.squadPower - x.squadPower || x.memberName.localeCompare(y.memberName));
    for (let i = 0; i < mains.length && i < DS_ROLE_SLOTS.length; i++) {
      mains[i].strategyRole = DS_ROLE_SLOTS[i];
    }
  }

  return {
    assignments: allAssignments,
    unassigned: [...a.unassigned, ...b.unassigned],
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Canyon – different start times: hard pool split by teamPreference.
// Players who chose A go to pool A, B to pool B, 'any' balanced by size.
// Each pool is processed independently (like Desert), using Canyon role slots.
// ---------------------------------------------------------------------------
function suggestCanyonDifferentTime(input: SuggestInput): SuggestResult {
  const { priorities, previousRoles, rng = Math.random, canyonPlayedIds } = input;
  const ins = input.registrations.filter(eligible);
  const warnings: string[] = [];

  const poolA: Registration[] = [];
  const poolB: Registration[] = [];
  for (const r of ins) {
    if (r.teamPreference === 'A') poolA.push(r);
    else if (r.teamPreference === 'B') poolB.push(r);
    else if (poolA.length <= poolB.length) poolA.push(r);
    else poolB.push(r);
  }

  function runPool(
    pool: Registration[],
    team: AssignmentTeam,
  ): {
    assignments: SuggestAssignment[];
    unassigned: { memberId: number; memberName: string; reason: string }[];
  } {
    if (pool.length < TEAM_SIZE) {
      warnings.push(
        `Canyon team ${team} (split-time): only ${pool.length} eligible registrants (need ${TEAM_SIZE})`,
      );
    }
    const forced = pool.map((r) => ({ ...r, teamPreference: team } as Registration));
    const ordered = shuffle(forced.slice(), rng).sort((a, b) =>
      priorityComparator(priorities, a, b, canyonPlayedIds),
    );
    const typeCount = { A: emptyTypeCount(), B: emptyTypeCount() };
    const mainCandidates = ordered.slice(0, Math.min(MAIN_PER_TEAM, ordered.length));
    const afterMain = ordered.slice(mainCandidates.length);
    const mains = assignToTeams(mainCandidates, priorities, 'main', MAIN_PER_TEAM, 1, 1, typeCount);
    const subCandidates = [
      ...mains.overflow,
      ...afterMain.slice(0, Math.min(SUB_PER_TEAM, afterMain.length)),
    ];
    const afterSub = afterMain.slice(Math.max(0, subCandidates.length - mains.overflow.length));
    const subs = assignToTeams(
      subCandidates,
      priorities,
      'sub',
      SUB_PER_TEAM,
      MAIN_PER_TEAM + 1,
      MAIN_PER_TEAM + 1,
      typeCount,
    );
    const bench = [...subs.overflow, ...afterSub];
    return {
      assignments: [...mains.assignments, ...subs.assignments],
      unassigned: bench.map((r) => ({
        memberId: r.memberId,
        memberName: r.memberName,
        reason: 'no capacity',
      })),
    };
  }

  const a = runPool(poolA, 'A');
  const b = runPool(poolB, 'B');
  let allAssignments = [...a.assignments, ...b.assignments];

  allAssignments = applySubMainPromotion(allAssignments, previousRoles, priorities, 'A');
  allAssignments = applySubMainPromotion(allAssignments, previousRoles, priorities, 'B');

  // Canyon strategy roles per team, sorted strongest first.
  for (const team of ['A', 'B'] as const) {
    const teamMains = allAssignments
      .filter((x) => x.team === team && x.role === 'main')
      .sort((x, y) => y.squadPower - x.squadPower || x.memberName.localeCompare(y.memberName));
    for (let i = 0; i < teamMains.length && i < CANYON_ROLE_SLOTS.length; i++) {
      teamMains[i].strategyRole = CANYON_ROLE_SLOTS[i];
    }
  }

  return {
    assignments: allAssignments,
    unassigned: [...a.unassigned, ...b.unassigned],
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Desert – same start time for both teams: shared pool, Canyon-style.
// timeSlot is mapped to a soft team-preference hint:
//   '22' → 'A', '13' → 'B', 'any' → 'any'
// Players are then distributed through assignToTeams() like Canyon.
// DS role slots are applied after slot assignment.
// ---------------------------------------------------------------------------
function suggestDesertSameTime(input: SuggestInput): SuggestResult {
  const { priorities, previousRoles, rng = Math.random, canyonPlayedIds } = input;
  const ins = input.registrations.filter(eligible);
  const warnings: string[] = [];

  if (ins.length < TEAM_SIZE * 2) {
    warnings.push(
      `Desert (same time): only ${ins.length} eligible registrants (need ${TEAM_SIZE * 2})`,
    );
  }

  // Map timeSlot → teamPreference hint for shared-pool distribution.
  // Since both teams play at the same time, slot preference has no bearing on
  // which team a player lands on.  Set everyone to 'any' so the balance logic
  // in assignToTeams distributes them evenly, exactly like Canyon shared-pool.
  const mapped: Registration[] = ins.map((r) => ({
    ...r,
    teamPreference: 'any' as TeamPreference,
    resolvedTeamPreference: null,
  }));

  const ordered = shuffle(mapped.slice(), rng).sort((a, b) =>
    priorityComparator(priorities, a, b, canyonPlayedIds),
  );

  const typeCount = { A: emptyTypeCount(), B: emptyTypeCount() };
  const mainCandidates = ordered.slice(0, Math.min(MAIN_PER_TEAM * 2, ordered.length));
  const afterMain = ordered.slice(mainCandidates.length);
  const mains = assignToTeams(
    mainCandidates,
    priorities,
    'main',
    MAIN_PER_TEAM,
    1,
    1,
    typeCount,
  );
  const subCandidates = [
    ...mains.overflow,
    ...afterMain.slice(0, Math.min(SUB_PER_TEAM * 2, afterMain.length)),
  ];
  const afterSub = afterMain.slice(
    Math.max(0, subCandidates.length - mains.overflow.length),
  );
  const subs = assignToTeams(
    subCandidates,
    priorities,
    'sub',
    SUB_PER_TEAM,
    MAIN_PER_TEAM + 1,
    MAIN_PER_TEAM + 1,
    typeCount,
  );
  const bench = [...subs.overflow, ...afterSub];

  let allAssignments = [...mains.assignments, ...subs.assignments];
  allAssignments = applySubMainPromotion(allAssignments, previousRoles, priorities, 'A');
  allAssignments = applySubMainPromotion(allAssignments, previousRoles, priorities, 'B');

  // DS strategy roles per team, sorted strongest first.
  for (const team of ['A', 'B'] as const) {
    const teamMains = allAssignments
      .filter((x) => x.team === team && x.role === 'main')
      .sort((x, y) => y.squadPower - x.squadPower || x.memberName.localeCompare(y.memberName));
    for (let i = 0; i < teamMains.length && i < DS_ROLE_SLOTS.length; i++) {
      teamMains[i].strategyRole = DS_ROLE_SLOTS[i];
    }
  }

  return {
    assignments: allAssignments,
    unassigned: bench.map((r) => ({
      memberId: r.memberId,
      memberName: r.memberName,
      reason: 'no capacity',
    })),
    warnings,
  };
}

export function suggestRoster(input: SuggestInput): SuggestResult {
  const { kind, sameTeamTime } = input;
  if (kind === 'canyon') {
    // Different times → hard pool split by teamPreference (DS-style per pool).
    return sameTeamTime === false ? suggestCanyonDifferentTime(input) : suggestCanyon(input);
  }
  // Desert: same time → shared pool (Canyon-style); different times → current Desert logic.
  return sameTeamTime === true ? suggestDesertSameTime(input) : suggestDesert(input);
}
