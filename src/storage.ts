import { normalizeName as normalizeCommanderName, canonicalDisplayName } from './utils/normalizer';

// D1-backed storage for alliance members and rewards
// Member modifications persist across ingestions; rewards are rebuilt from scratch

export interface Member {
  displayName: string;
  normalizedName: string;
  active: boolean;
  aliases: string[];
}

export interface RewardRecord {
  date: string; // ISO date (YYYY-MM-DD)
  driverName: string;
  vipName?: string | null;
  type: 'TRAIN' | 'VIP';
  rawText: string;
  sourceMessageId: string;
  sourceLine: number;
}

export interface LeaderboardMeta {
  id: number;
  slug: string;
  title: string | null;
  weekStart: string | null;
  weekEnd: string | null;
}

export interface LeaderboardRankInfo {
  rank: number;
  commander: string;
}

export interface LeaderboardAverageEntry {
  name: string;
  averageScore: number;
  seenCount: number;
  totalBoards: number;
  primaryScore: number;
  primaryRank: number;
  missingFromOthers: boolean;
}

export interface LeaderboardAverageResult {
  newest: LeaderboardMeta;
  leaderboards: LeaderboardMeta[];
  entries: LeaderboardAverageEntry[];
}

export interface LeaderboardRanksBySlug {
  slug: string;
  title: string | null;
  ranks: Map<string, { commander: string; rank: number; points: number }>;
}

export class DataStore {
  constructor(private db: D1Database) {}

  async getCanonicalNameMap(): Promise<Map<string, string>> {
    const directory = new Map<string, string>();
    const members = await this.db.prepare(
      'SELECT id, display_name, normalized_name FROM members'
    ).all<{ id: number; display_name: string; normalized_name: string }>();

    const memberDisplayById = new Map<number, string>();
    for (const row of members.results) {
      memberDisplayById.set(row.id, row.display_name);
      directory.set(row.normalized_name, row.display_name);
    }

    if (memberDisplayById.size === 0) {
      return directory;
    }

    const aliases = await this.db.prepare(
      'SELECT member_id, alias FROM member_aliases'
    ).all<{ member_id: number; alias: string }>();

    for (const alias of aliases.results) {
      const displayName = memberDisplayById.get(alias.member_id);
      if (!displayName) continue;
      const normalized = this.normalizeForLookup(alias.alias);
      if (!normalized) continue;
      if (!directory.has(normalized)) {
        directory.set(normalized, displayName);
      }
    }

    return directory;
  }

  // Bulk insert rewards (much faster than individual inserts)
  async bulkAddRewards(rewards: Array<Omit<RewardRecord, 'type'> & { type: string }>): Promise<{ added: number; duplicates: number }> {
    if (rewards.length === 0) {
      return { added: 0, duplicates: 0 };
    }

    // D1 has a hard limit around 100 placeholders (?) in a single query
    // With 7 placeholders per row: 14 rows * 7 = 98 (safe)
    const BATCH_SIZE = 14;
    let totalAdded = 0;
    
    for (let i = 0; i < rewards.length; i += BATCH_SIZE) {
      const batch = rewards.slice(i, i + BATCH_SIZE);
      const placeholders = batch.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ');
      const values: any[] = [];
      
      for (const r of batch) {
        values.push(r.date, r.driverName, r.vipName || null, r.type, r.rawText, r.sourceMessageId, r.sourceLine);
      }

      const result = await this.db.prepare(
        `INSERT OR IGNORE INTO rewards (date, driver_name, vip_name, type, raw_text, source_message_id, source_line) 
         VALUES ${placeholders}`
      ).bind(...values).run();

      totalAdded += result.meta.changes || 0;
    }

    const duplicates = rewards.length - totalAdded;
    return { added: totalAdded, duplicates };
  }

  // Bulk ensure members exist (creates if needed)
  async bulkEnsureMembers(names: string[]): Promise<void> {
    if (names.length === 0) return;

    const normalizedMap = new Map<string, { display: string; lookupKeys: Set<string> }>();

    for (const name of names) {
      const simpleNormalized = this.normalize(name);
      if (!simpleNormalized) continue;

      const display = canonicalDisplayName(name);
      const lookupKeys = normalizedMap.get(simpleNormalized)?.lookupKeys ?? new Set<string>();
      lookupKeys.add(simpleNormalized);

      const canonicalNormalized = this.normalizeForLookup(name);
      if (canonicalNormalized.length > 0) {
        lookupKeys.add(canonicalNormalized);
      }

      normalizedMap.set(simpleNormalized, {
        display,
        lookupKeys,
      });
    }

    if (normalizedMap.size === 0) return;

    const SELECT_BATCH = 100;  // 1 param per name for SELECT
    const INSERT_BATCH = 10;   // 2 params per member for INSERT

    const lookupValues = Array.from(
      new Set(
        Array.from(normalizedMap.values()).flatMap(entry => Array.from(entry.lookupKeys))
      )
    );

    const existingNormalized = new Set<string>();

    for (let i = 0; i < lookupValues.length; i += SELECT_BATCH) {
      const batch = lookupValues.slice(i, i + SELECT_BATCH);
      const placeholders = batch.map(() => '?').join(', ');

      const existing = await this.db.prepare(
        `SELECT normalized_name FROM members WHERE normalized_name IN (${placeholders})`
      ).bind(...batch).all<{ normalized_name: string }>();

      existing.results.forEach(r => existingNormalized.add(r.normalized_name));

      const aliases = await this.db.prepare(
        `SELECT LOWER(REPLACE(TRIM(REPLACE(alias, '  ', ' ')), '0', 'o')) as normalized_alias 
         FROM member_aliases 
         WHERE LOWER(REPLACE(TRIM(REPLACE(alias, '  ', ' ')), '0', 'o')) IN (${placeholders})`
      ).bind(...batch).all<{ normalized_alias: string }>();

      aliases.results.forEach(r => existingNormalized.add(r.normalized_alias));
    }

    const skipInsert = new Set<string>();
    for (const [simpleNormalized, entry] of normalizedMap.entries()) {
      for (const key of entry.lookupKeys) {
        if (existingNormalized.has(key)) {
          skipInsert.add(simpleNormalized);
          break;
        }
      }
    }

    const toInsert = Array.from(normalizedMap.entries()).filter(([normalized]) => !skipInsert.has(normalized));
    if (toInsert.length === 0) return;

    for (let i = 0; i < toInsert.length; i += INSERT_BATCH) {
      const batch = toInsert.slice(i, i + INSERT_BATCH);
      const insertPlaceholders = batch.map(() => '(?, ?, 1)').join(', ');
      const insertValues: any[] = [];

      for (const [normalized, entry] of batch) {
        const display = entry.display.length > 0 ? entry.display : canonicalDisplayName(normalized);
        insertValues.push(display, normalized);
      }

      await this.db.prepare(
        `INSERT OR IGNORE INTO members (display_name, normalized_name, active) VALUES ${insertPlaceholders}`
      ).bind(...insertValues).run();
    }
  }

  // Member management
  async addMember(displayName: string): Promise<Member> {
    const existing = await this.findMember(displayName);

    if (existing) {
      if (!existing.active) {
        await this.db.prepare('UPDATE members SET active = 1 WHERE normalized_name = ?')
          .bind(existing.normalizedName).run();
      }
      return {
        ...existing,
        active: true,
      };
    }

    const normalized = this.normalizeForLookup(displayName);

    await this.db.prepare(
      'INSERT INTO members (display_name, normalized_name, active) VALUES (?, ?, 1)'
    ).bind(displayName, normalized).run();

    return {
      displayName,
      normalizedName: normalized,
      active: true,
      aliases: [],
    };
  }

  async findMember(nameOrAlias: string): Promise<Member | undefined> {
    const mapRowToMember = async (row: { id: number; display_name: string; normalized_name: string; active: number }): Promise<Member> => {
      const aliases = await this.getAliases(row.id);
      return {
        displayName: row.display_name,
        normalizedName: row.normalized_name,
        active: Boolean(row.active),
        aliases,
      };
    };

    const canonicalDisplay = canonicalDisplayName(nameOrAlias);
    if (canonicalDisplay.length > 0) {
      const exactDisplay = await this.db.prepare(
        'SELECT id, display_name, normalized_name, active FROM members WHERE TRIM(display_name) = ?'
      ).bind(canonicalDisplay).first<{ id: number; display_name: string; normalized_name: string; active: number }>();

      if (exactDisplay) {
        return mapRowToMember(exactDisplay);
      }
    }

    const normalizedCandidates = Array.from(
      new Set([
        this.normalize(nameOrAlias),
        this.normalizeForLookup(nameOrAlias),
      ].filter(candidate => candidate.length > 0))
    );

    for (const candidate of normalizedCandidates) {
      const direct = await this.db.prepare(
        'SELECT id, display_name, normalized_name, active FROM members WHERE normalized_name = ?'
      ).bind(candidate).first<{ id: number; display_name: string; normalized_name: string; active: number }>();

      if (direct) {
        return mapRowToMember(direct);
      }
    }

    if (canonicalDisplay.length > 0) {
      const displayMatch = await this.db.prepare(
        'SELECT id, display_name, normalized_name, active FROM members WHERE LOWER(TRIM(display_name)) = LOWER(?)'
      ).bind(canonicalDisplay).first<{ id: number; display_name: string; normalized_name: string; active: number }>();

      if (displayMatch) {
        return mapRowToMember(displayMatch);
      }
    }

    const aliasNormalized = this.normalize(nameOrAlias);
    if (aliasNormalized.length > 0) {
      const aliasMatch = await this.db.prepare(
        `SELECT m.id, m.display_name, m.normalized_name, m.active 
         FROM members m 
         JOIN member_aliases a ON m.id = a.member_id 
         WHERE LOWER(REPLACE(TRIM(REPLACE(a.alias, '  ', ' ')), '0', 'o')) = ?`
      ).bind(aliasNormalized).first<{ id: number; display_name: string; normalized_name: string; active: number }>();

      if (aliasMatch) {
        return mapRowToMember(aliasMatch);
      }
    }

    return undefined;
  }

  async removeMember(nameOrAlias: string): Promise<boolean> {
    const member = await this.findMember(nameOrAlias);
    if (!member) return false;

    const memberId = await this.getMemberId(member.normalizedName);
    await this.db.prepare('UPDATE members SET active = 0 WHERE normalized_name = ?')
      .bind(member.normalizedName).run();
    if (memberId) {
      await this.clearPocOpenRows(memberId);
    }
    return true;
  }

  async renameMemberById(memberId: number, newDisplayName: string): Promise<boolean> {
    const trimmed = newDisplayName.trim();
    if (!trimmed) return false;
    const newNormalized = this.normalizeForLookup(trimmed);
    if (!newNormalized) return false;

    // Look up the member being renamed.
    const row = await this.db.prepare(
      'SELECT id, display_name, normalized_name FROM members WHERE id = ?'
    ).bind(memberId).first<{ id: number; display_name: string; normalized_name: string }>();
    if (!row) return false;

    const oldDisplay = row.display_name;
    const oldNormalized = row.normalized_name;
    if (oldNormalized === newNormalized) return false; // no-op

    // Ensure the new name doesn't collide with a *different* member.
    const collision = await this.db.prepare(
      'SELECT id FROM members WHERE normalized_name = ? AND id != ?'
    ).bind(newNormalized, memberId).first<{ id: number }>();
    if (collision) return false;

    // Update display_name and normalized_name.
    await this.db.prepare(
      'UPDATE members SET display_name = ?, normalized_name = ? WHERE id = ?'
    ).bind(trimmed, newNormalized, memberId).run();

    // Add the old display name as an alias (if not already present).
    const oldNorm = this.normalizeForLookup(oldDisplay);
    const existingAlias = await this.db.prepare(
      `SELECT id FROM member_aliases WHERE member_id = ? AND LOWER(REPLACE(TRIM(REPLACE(alias, '  ', ' ')), '0', 'o')) = ?`
    ).bind(memberId, oldNorm).first<{ id: number }>();
    if (!existingAlias) {
      await this.db.prepare(
        'INSERT INTO member_aliases (member_id, alias) VALUES (?, ?)'
      ).bind(memberId, oldDisplay).run();
    }

    // Remove the new name from aliases if it exists as one (it's now the display name).
    await this.db.prepare(
      `DELETE FROM member_aliases WHERE member_id = ? AND LOWER(REPLACE(TRIM(REPLACE(alias, '  ', ' ')), '0', 'o')) = ?`
    ).bind(memberId, newNormalized).run();

    // Record the rename as a journal entry. 'rename' is a no-op for queue
    // positions (replay leaves the queue untouched) but preserves history.
    await this.db.prepare(
      `INSERT INTO train_queue_log (member_id, member_name, action, from_pos, to_pos, comment)
       VALUES (?, ?, 'rename', NULL, NULL, ?)`
    ).bind(memberId, trimmed, `Renamed from "${oldDisplay}"`).run();

    return true;
  }

  async mergeMembers(targetName: string, duplicateName: string, pocSource: 'target' | 'duplicate' = 'target'): Promise<boolean> {
    const target = await this.findMember(targetName);
    const duplicate = await this.findMember(duplicateName);

    if (!target || !duplicate || target.normalizedName === duplicate.normalizedName) {
      return false;
    }

    const targetId = await this.getMemberId(target.normalizedName);
    const duplicateId = await this.getMemberId(duplicate.normalizedName);

    if (!targetId || !duplicateId) return false;

    return this.runMergeBatch({
      targetId,
      duplicateId,
      targetDisplay: target.displayName,
      duplicateDisplay: duplicate.displayName,
      targetAliases: target.aliases,
      duplicateAliases: duplicate.aliases,
      pocSource,
    });
  }

  // Runs the merge as a single D1 transactional batch. All reads happen
  // upfront; the writes go through `db.batch([...])` so a failure (e.g. an
  // FK violation) rolls back every statement — including the train_queue_log
  // entries — preventing the partial-state cascade that produced 'merge-remove
  // logged but member never deleted, then re-spawned by the next sync'.
  private async runMergeBatch(input: {
    targetId: number;
    duplicateId: number;
    targetDisplay: string;
    duplicateDisplay: string;
    targetAliases: string[];
    duplicateAliases: string[];
    pocSource?: 'target' | 'duplicate';
    // When true the target is renamed to the duplicate's display_name (maintenance
    // rename-merge). Old target display_name becomes an alias instead of the
    // duplicate display_name. Rewards history is left as-is (alias lookup matches).
    updateTargetDisplayName?: boolean;
  }): Promise<boolean> {
    const { targetId, duplicateId, targetDisplay, duplicateDisplay } = input;
    const isRename = input.updateTargetDisplayName === true;

    // ── Reads: collect everything we need before opening the batch ──
    const aliasesToAdd: string[] = [];
    if (isRename) {
      // Old target name becomes an alias; duplicate name becomes the new display_name.
      if (!input.targetAliases.includes(targetDisplay)) {
        aliasesToAdd.push(targetDisplay);
      }
      for (const alias of input.duplicateAliases) {
        if (!input.targetAliases.includes(alias) && alias !== targetDisplay) {
          aliasesToAdd.push(alias);
        }
      }
    } else {
      if (!input.targetAliases.includes(duplicateDisplay)) {
        aliasesToAdd.push(duplicateDisplay);
      }
      for (const alias of input.duplicateAliases) {
        if (!input.targetAliases.includes(alias) && alias !== duplicateDisplay) {
          aliasesToAdd.push(alias);
        }
      }
    }

    const targetQueueRow = await this.db.prepare(
      'SELECT position, last_train_date FROM train_queue WHERE member_id = ?'
    ).bind(targetId).first<{ position: number; last_train_date: string | null }>();
    const duplicateQueueRow = await this.db.prepare(
      'SELECT position, last_train_date FROM train_queue WHERE member_id = ?'
    ).bind(duplicateId).first<{ position: number; last_train_date: string | null }>();

    const allQueueRows = await this.db.prepare(
      'SELECT member_id, position FROM train_queue ORDER BY position ASC'
    ).all<{ member_id: number; position: number }>();

    // ── Build the statement list for the batch ──
    const stmts: D1PreparedStatement[] = [];

    if (aliasesToAdd.length > 0) {
      const placeholders = aliasesToAdd.map(() => '(?, ?)').join(', ');
      const values: (number | string)[] = [];
      for (const alias of aliasesToAdd) {
        values.push(targetId, alias);
      }
      stmts.push(
        this.db.prepare(
          `INSERT OR IGNORE INTO member_aliases (member_id, alias) VALUES ${placeholders}`
        ).bind(...values),
      );
    }

    if (!isRename) {
      // Rewards: rename driver/vip references onto the canonical name.
      // When renaming (updateTargetDisplayName), old rewards are left as-is;
      // the old display_name becomes an alias so reward lookups still match.
      stmts.push(
        this.db.prepare('UPDATE rewards SET driver_name = ? WHERE driver_name = ?')
          .bind(targetDisplay, duplicateDisplay),
        this.db.prepare('UPDATE rewards SET vip_name = ? WHERE vip_name = ?')
          .bind(targetDisplay, duplicateDisplay),
      );
    }

    // Train-queue updates + log entries. Same logic as before, but emitted as
    // queued statements based on the snapshot we already read.
    if (duplicateQueueRow) {
      if (targetQueueRow) {
        // Both in queue: target keeps the better slot, duplicate is removed,
        // remaining positions renumber to close the gap.
        const keepPosition = Math.min(targetQueueRow.position, duplicateQueueRow.position);
        const olderDate = (a: string | null, b: string | null): string | null => {
          if (a && b) return a < b ? a : b;
          return a || b;
        };
        const keepLastTrain = olderDate(targetQueueRow.last_train_date, duplicateQueueRow.last_train_date);
        const targetOldPosition = targetQueueRow.position;

        stmts.push(
          this.db.prepare('DELETE FROM train_queue WHERE member_id = ?').bind(duplicateId),
          this.db.prepare(
            `INSERT INTO train_queue_log (member_id, member_name, action, from_pos, to_pos, comment)
             VALUES (?, ?, 'merge-remove', ?, NULL, ?)`
          ).bind(duplicateId, duplicateDisplay, duplicateQueueRow.position, `Merged into ${targetDisplay}`),
          this.db.prepare(
            `UPDATE train_queue SET position = ?, last_train_date = ?, updated_at = datetime('now') WHERE member_id = ?`
          ).bind(keepPosition, keepLastTrain, targetId),
        );
        if (targetOldPosition !== keepPosition) {
          // After splicing the duplicate out, target's effective position
          // shifts up by one if the duplicate sat above it.
          const fromPosForReplay = duplicateQueueRow.position < targetOldPosition
            ? targetOldPosition - 1
            : targetOldPosition;
          stmts.push(
            this.db.prepare(
              `INSERT INTO train_queue_log (member_id, member_name, action, from_pos, to_pos, comment)
               VALUES (?, ?, 'merge-move', ?, ?, ?)`
            ).bind(targetId, targetDisplay, fromPosForReplay, keepPosition, `Inherited queue slot from ${duplicateDisplay} (merge)`),
          );
        }

        // Renumber so positions stay contiguous 1..N. We compute the post-state
        // from the pre-batch snapshot since reads inside a batch aren't possible.
        const postSnapshot = allQueueRows.results
          .filter(r => r.member_id !== duplicateId)
          .map(r => ({
            member_id: r.member_id,
            position: r.member_id === targetId ? keepPosition : r.position,
          }))
          .sort((a, b) => a.position - b.position);
        for (let i = 0; i < postSnapshot.length; i++) {
          const newPos = i + 1;
          if (postSnapshot[i].position !== newPos) {
            stmts.push(
              this.db.prepare(
                `UPDATE train_queue SET position = ?, updated_at = datetime('now') WHERE member_id = ?`
              ).bind(newPos, postSnapshot[i].member_id),
            );
          }
        }
      } else {
        // Only duplicate in queue: transfer slot to target. Logged as
        // merge-remove + add at the same position so the replay reproduces it.
        const pos = duplicateQueueRow.position;
        stmts.push(
          this.db.prepare(
            `UPDATE train_queue SET member_id = ?, updated_at = datetime('now') WHERE member_id = ?`
          ).bind(targetId, duplicateId),
          this.db.prepare(
            `INSERT INTO train_queue_log (member_id, member_name, action, from_pos, to_pos, comment)
             VALUES (?, ?, 'merge-remove', ?, NULL, ?)`
          ).bind(duplicateId, duplicateDisplay, pos, `Merged into ${targetDisplay}`),
          this.db.prepare(
            `INSERT INTO train_queue_log (member_id, member_name, action, from_pos, to_pos, comment)
             VALUES (?, ?, 'add', NULL, ?, ?)`
          ).bind(targetId, targetDisplay, pos, `Queue slot inherited from ${duplicateDisplay} (merge)`),
        );
      }
    }

    // PoC tables: reassign so the FK delete on `members` doesn't fire RESTRICT.
    stmts.push(...this.absorbPocRowsStatements(duplicateId, targetId, input.pocSource ?? 'target'));

    // Member aliases on the duplicate: explicit cleanup (no cascade).
    stmts.push(
      this.db.prepare('DELETE FROM member_aliases WHERE member_id = ?').bind(duplicateId),
    );

    // Finally remove the duplicate member.
    stmts.push(
      this.db.prepare('DELETE FROM members WHERE id = ?').bind(duplicateId),
    );

    if (isRename) {
      // Rename the target member to the duplicate's display_name (the new game name).
      const newNorm = this.normalizeForLookup(duplicateDisplay);
      if (newNorm) {
        stmts.push(
          this.db.prepare(
            'UPDATE members SET display_name = ?, normalized_name = ? WHERE id = ?'
          ).bind(duplicateDisplay, newNorm, targetId),
          this.db.prepare(
            `INSERT INTO train_queue_log (member_id, member_name, action, from_pos, to_pos, comment)
             VALUES (?, ?, 'rename', NULL, NULL, ?)`
          ).bind(targetId, duplicateDisplay, `Renamed from "${targetDisplay}" (maintenance merge)`),
        );
      }
    }

    await this.db.batch(stmts);
    return true;
  }

  // When the leaderboard maintenance dialog merges an existing active member into
  // a leaderboard ghost (player renamed in-game or OCR variant), the direction
  // must be reversed: the EXISTING member is kept as the target (preserving its
  // queue position and history) and the ghost is deleted as the duplicate.
  // The existing member is also renamed to the ghost's display_name.
  async maintenanceMerge(existingMemberId: number, leaderboardNorm: string): Promise<boolean> {
    const existing = await this.db.prepare(
      'SELECT id, display_name, normalized_name FROM members WHERE id = ?'
    ).bind(existingMemberId).first<{ id: number; display_name: string; normalized_name: string }>();
    if (!existing) return false;
    if (existing.normalized_name === leaderboardNorm) return false;

    const ghost = await this.db.prepare(
      'SELECT id, display_name FROM members WHERE normalized_name = ? LIMIT 1'
    ).bind(leaderboardNorm).first<{ id: number; display_name: string }>();
    if (!ghost || ghost.id === existing.id) return false;

    const existingAliasRows = await this.db.prepare(
      'SELECT alias FROM member_aliases WHERE member_id = ?'
    ).bind(existing.id).all<{ alias: string }>();
    const ghostAliasRows = await this.db.prepare(
      'SELECT alias FROM member_aliases WHERE member_id = ?'
    ).bind(ghost.id).all<{ alias: string }>();

    return this.runMergeBatch({
      targetId: existing.id,
      duplicateId: ghost.id,
      targetDisplay: existing.display_name,
      duplicateDisplay: ghost.display_name,
      targetAliases: existingAliasRows.results.map(r => r.alias),
      duplicateAliases: ghostAliasRows.results.map(r => r.alias),
      pocSource: 'target',
      updateTargetDisplayName: true,
    });
  }

  // Statements that reassign the duplicate member's rows in the poc_events_*
  // tables onto the target member, ahead of deleting the duplicate from
  // `members`. For tables with UNIQUE(event_id, member_id), the conflicting
  // row from the losing side is deleted first so the UPDATE can proceed.
  //
  // pocSource controls which side wins on conflict for registration/assignment:
  //   'target'    — target's existing registration beats the duplicate's (default).
  //   'duplicate' — duplicate's registration beats the target's (account transfer).
  //
  // For participation_log the target's existing record always wins regardless
  // of pocSource (historical event outcomes should not be overwritten).
  //
  // Returned as a list of prepared statements so they can be appended to the
  // single transactional batch the merge runs in.
  private absorbPocRowsStatements(duplicateId: number, targetId: number, pocSource: 'target' | 'duplicate' = 'target'): D1PreparedStatement[] {
    // For registration/assignment: decide which side to delete on conflict.
    const [regDeleteId, regKeepId] = pocSource === 'duplicate'
      ? [targetId, duplicateId]   // duplicate's row wins: delete target's conflicting rows
      : [duplicateId, targetId];  // target's row wins: delete duplicate's conflicting rows
    return [
      this.db.prepare(
        `DELETE FROM poc_events_registration
         WHERE member_id = ?
           AND event_id IN (SELECT event_id FROM poc_events_registration WHERE member_id = ?)`
      ).bind(regDeleteId, regKeepId),
      this.db.prepare('UPDATE poc_events_registration SET member_id = ? WHERE member_id = ?')
        .bind(targetId, duplicateId),
      this.db.prepare(
        `DELETE FROM poc_events_assignment
         WHERE member_id = ?
           AND event_id IN (SELECT event_id FROM poc_events_assignment WHERE member_id = ?)`
      ).bind(regDeleteId, regKeepId),
      this.db.prepare('UPDATE poc_events_assignment SET member_id = ? WHERE member_id = ?')
        .bind(targetId, duplicateId),
      // Participation log has UNIQUE(event_id, member_id). Target's historical
      // record always wins; delete the duplicate's conflicting rows first.
      this.db.prepare(
        `DELETE FROM poc_events_participation_log
         WHERE member_id = ?
           AND event_id IN (SELECT event_id FROM poc_events_participation_log WHERE member_id = ?)`
      ).bind(duplicateId, targetId),
      this.db.prepare('UPDATE poc_events_participation_log SET member_id = ? WHERE member_id = ?')
        .bind(targetId, duplicateId),
    ];
  }

  // Clears a member's open PoC registrations and assignments. Called when a
  // member is removed/deactivated so they stop showing up in upcoming events.
  // Locked assignments and participation log are kept as historical record.
  private async clearPocOpenRows(memberId: number): Promise<void> {
    await this.db.prepare('DELETE FROM poc_events_registration WHERE member_id = ?')
      .bind(memberId).run();
    await this.db.prepare('DELETE FROM poc_events_assignment WHERE member_id = ? AND is_locked = 0')
      .bind(memberId).run();
  }

  // Reward management
  async addReward(record: RewardRecord): Promise<boolean> {
    try {
      await this.db.prepare(
        `INSERT INTO rewards (date, driver_name, vip_name, type, raw_text, source_message_id, source_line)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        record.date,
        record.driverName,
        record.vipName ?? null,
        record.type,
        record.rawText,
        record.sourceMessageId,
        record.sourceLine
      ).run();
      
      // Auto-add members if they don't exist
      await this.addMember(record.driverName);
      if (record.vipName) {
        await this.addMember(record.vipName);
      }
      
      return true;
    } catch (err: any) {
      // UNIQUE constraint violation means duplicate
      if (err.message?.includes('UNIQUE')) {
        return false;
      }
      throw err;
    }
  }

  async clearRewards(): Promise<void> {
    await this.db.prepare('DELETE FROM rewards').run();
  }

  // Store last ingestion timestamp
  async setLastIngestionTime(timestamp: string): Promise<void> {
    await this.db.prepare(`
      INSERT OR REPLACE INTO metadata (key, value) 
      VALUES ('last_ingestion_timestamp', ?)
    `).bind(timestamp).run();
  }

  // Get last ingestion timestamp
  async getLastIngestionTime(): Promise<string | null> {
    const result = await this.db.prepare(
      'SELECT value FROM metadata WHERE key = ?'
    ).bind('last_ingestion_timestamp').first<{ value: string }>();
    
    return result?.value ?? null;
  }

  // Remove members that have no rewards (cleanup orphaned/incorrectly parsed members)
  async cleanupUnusedMembers(): Promise<number> {
    const result = await this.db.prepare(`
      DELETE FROM members 
      WHERE id NOT IN (
        SELECT DISTINCT m.id 
        FROM members m
        JOIN rewards r ON (
          LOWER(REPLACE(TRIM(REPLACE(r.driver_name, '  ', ' ')), '0', 'o')) = m.normalized_name
          OR LOWER(REPLACE(TRIM(REPLACE(r.vip_name, '  ', ' ')), '0', 'o')) = m.normalized_name
        )
      )
      AND active = 0
    `).run();
    
    return result.meta.changes || 0;
  }

  async getRewards(): Promise<RewardRecord[]> {
    const results = await this.db.prepare(
      'SELECT date, driver_name, vip_name, type, raw_text, source_message_id, source_line FROM rewards ORDER BY date DESC'
    ).all<{
      date: string;
      driver_name: string;
      vip_name: string | null;
      type: string;
      raw_text: string;
      source_message_id: string;
      source_line: number;
    }>();

    return results.results.map(r => ({
      date: r.date,
      driverName: r.driver_name,
      vipName: r.vip_name ?? undefined,
      type: r.type as 'TRAIN' | 'VIP',
      rawText: r.raw_text,
      sourceMessageId: r.source_message_id,
      sourceLine: r.source_line,
    }));
  }

  async getLatestRewardDate(): Promise<string | null> {
    const result = await this.db.prepare('SELECT MAX(date) AS latest FROM rewards')
      .first<{ latest: string | null }>();
    return result?.latest ?? null;
  }

  async getRewardedMembers(daysBack: number, type?: 'train' | 'vip'): Promise<{ name: string; count: number; lastDate: string }[]> {
    const referenceDate = await this.getReferenceDate();
    // Subtract (daysBack - 1) to get exactly N days inclusive, counting from last reward date
    const cutoffDate = this.getDateDaysAgo(daysBack - 1, referenceDate);
    
    let query = `
      SELECT 
        CASE 
          WHEN type = 'TRAIN' THEN driver_name
          WHEN type = 'VIP' THEN vip_name
        END as name,
        COUNT(*) as count,
        MAX(date) as last_date
      FROM rewards
      WHERE date >= ?
    `;
    
    const params: any[] = [cutoffDate];
    
    if (type === 'train') {
      query += ` AND type = 'TRAIN'`;
    } else if (type === 'vip') {
      query += ` AND type = 'VIP' AND vip_name IS NOT NULL`;
    } else {
      query += ` AND ((type = 'TRAIN') OR (type = 'VIP' AND vip_name IS NOT NULL))`;
    }
    
    query += ` GROUP BY name ORDER BY last_date DESC, count DESC, name ASC`;
    
    const results = await this.db.prepare(query).bind(...params).all<{
      name: string;
      count: number;
      last_date: string;
    }>();
    
    return results.results.map(r => ({
      name: r.name,
      count: r.count,
      lastDate: r.last_date,
    }));
  }

  async getWaitingMembers(limit: number, type?: 'train' | 'vip'): Promise<{ name: string; daysSinceReward: number | null }[]> {
    const referenceDate = await this.getReferenceDate();

    const memberRows = await this.db.prepare(
      'SELECT id, display_name FROM members WHERE active = 1'
    ).all<{ id: number; display_name: string }>();

    if (memberRows.results.length === 0) {
      return [];
    }

    const members = memberRows.results.map(row => {
      const asciiNormalized = normalizeCommanderName(row.display_name);
      const fallbackNormalized = this.normalize(row.display_name);
      const normalized = asciiNormalized || fallbackNormalized;
      return {
        id: row.id,
        displayName: row.display_name,
        normalized,
        fallbackNormalized,
      };
    });

    const memberById = new Map<number, typeof members[number]>(
      members.map(member => [member.id, member])
    );

    const aliasRows = await this.db.prepare(
      'SELECT member_id, alias FROM member_aliases'
    ).all<{ member_id: number; alias: string }>();

    const aliasTargets = new Map<string, string>();
    for (const alias of aliasRows.results) {
      const member = memberById.get(alias.member_id);
      if (!member) continue;
      const normalizedAlias = normalizeCommanderName(alias.alias) || this.normalize(alias.alias);
      if (!normalizedAlias) continue;
      aliasTargets.set(normalizedAlias, member.normalized);
    }

    for (const member of members) {
      if (member.fallbackNormalized && member.fallbackNormalized !== member.normalized) {
        aliasTargets.set(member.fallbackNormalized, member.normalized);
      }
    }

    const lastRewardByNormalized = new Map<string, string>();
    const recordReward = (name: string | null | undefined, date: string) => {
      if (!name) return;
      const normalized = normalizeCommanderName(name) || this.normalize(name);
      if (!normalized) return;
      const existing = lastRewardByNormalized.get(normalized);
      if (!existing || date > existing) {
        lastRewardByNormalized.set(normalized, date);
      }
    };

    const recordAggregatedRewards = (
      rows: { name: string | null; last_date: string | null }[],
    ) => {
      for (const row of rows) {
        if (!row.name || !row.last_date) continue;
        recordReward(row.name, row.last_date);
      }
    };

    if (type === 'train') {
      const driverRows = await this.db.prepare(
        `SELECT driver_name AS name, MAX(date) AS last_date
         FROM rewards
         WHERE type = 'TRAIN' AND driver_name IS NOT NULL AND TRIM(driver_name) <> ''
         GROUP BY driver_name`
      ).all<{ name: string | null; last_date: string | null }>();
      recordAggregatedRewards(driverRows.results);
    } else if (type === 'vip') {
      const vipRows = await this.db.prepare(
        `SELECT vip_name AS name, MAX(date) AS last_date
         FROM rewards
         WHERE type = 'VIP' AND vip_name IS NOT NULL AND TRIM(vip_name) <> ''
         GROUP BY vip_name`
      ).all<{ name: string | null; last_date: string | null }>();
      recordAggregatedRewards(vipRows.results);
    } else {
      const driverRows = await this.db.prepare(
        `SELECT driver_name AS name, MAX(date) AS last_date
         FROM rewards
         WHERE (type = 'TRAIN' OR type = 'VIP')
           AND driver_name IS NOT NULL AND TRIM(driver_name) <> ''
         GROUP BY driver_name`
      ).all<{ name: string | null; last_date: string | null }>();
      recordAggregatedRewards(driverRows.results);

      const vipRows = await this.db.prepare(
        `SELECT vip_name AS name, MAX(date) AS last_date
         FROM rewards
         WHERE type = 'VIP' AND vip_name IS NOT NULL AND TRIM(vip_name) <> ''
         GROUP BY vip_name`
      ).all<{ name: string | null; last_date: string | null }>();
      recordAggregatedRewards(vipRows.results);
    }

    if (aliasTargets.size > 0) {
      let updated = true;
      while (updated) {
        updated = false;
        for (const [aliasNormalized, targetNormalized] of aliasTargets.entries()) {
          if (aliasNormalized === targetNormalized) continue;
          const aliasDate = lastRewardByNormalized.get(aliasNormalized);
          if (!aliasDate) continue;
          const existing = lastRewardByNormalized.get(targetNormalized);
          if (!existing || aliasDate > existing) {
            lastRewardByNormalized.set(targetNormalized, aliasDate);
            updated = true;
          }
        }
      }
    }

    const waitingList = members.map(member => {
      const lastDate = lastRewardByNormalized.get(member.normalized);
      const daysSinceReward = lastDate
        ? this.daysBetween(this.parseDate(lastDate), referenceDate)
        : null;
      return {
        name: member.displayName,
        daysSinceReward,
      };
    });

    waitingList.sort((a, b) => {
      if (a.daysSinceReward === null && b.daysSinceReward === null) return 0;
      if (a.daysSinceReward === null) return -1;
      if (b.daysSinceReward === null) return 1;
      return b.daysSinceReward - a.daysSinceReward;
    });

    return waitingList.slice(0, limit);
  }

  // Returns every active member together with their most recent TRAIN reward,
  // most recent VIP reward, and combined "last any" reward date plus days
  // waiting (computed from today / now). Used by the web dashboard.
  async getActiveMembersWithLastReward(): Promise<Array<{
    id: number;
    name: string;
    lastTrainDate: string | null;
    lastVipDate: string | null;
    lastAnyDate: string | null;
    daysSinceTrain: number | null;
    daysSinceVip: number | null;
    daysSinceAny: number | null;
  }>> {
    // Days waiting is always counted from "today" so the dashboard reflects
    // real wall-clock waiting time, not a stale snapshot anchored on the most
    // recent recorded reward.
    const today = new Date();
    const referenceDate = new Date(Date.UTC(
      today.getUTCFullYear(),
      today.getUTCMonth(),
      today.getUTCDate(),
    ));

    const memberRows = await this.db.prepare(
      'SELECT id, display_name FROM members WHERE active = 1'
    ).all<{ id: number; display_name: string }>();

    if (memberRows.results.length === 0) {
      return [];
    }

    const members = memberRows.results.map(row => {
      const asciiNormalized = normalizeCommanderName(row.display_name);
      const fallbackNormalized = this.normalize(row.display_name);
      const normalized = asciiNormalized || fallbackNormalized;
      return {
        id: row.id,
        displayName: row.display_name,
        normalized,
        fallbackNormalized,
      };
    });

    const memberById = new Map<number, typeof members[number]>(
      members.map(member => [member.id, member])
    );

    const aliasRows = await this.db.prepare(
      'SELECT member_id, alias FROM member_aliases'
    ).all<{ member_id: number; alias: string }>();

    const aliasTargets = new Map<string, string>();
    for (const alias of aliasRows.results) {
      const member = memberById.get(alias.member_id);
      if (!member) continue;
      const normalizedAlias = normalizeCommanderName(alias.alias) || this.normalize(alias.alias);
      if (!normalizedAlias) continue;
      aliasTargets.set(normalizedAlias, member.normalized);
    }

    for (const member of members) {
      if (member.fallbackNormalized && member.fallbackNormalized !== member.normalized) {
        aliasTargets.set(member.fallbackNormalized, member.normalized);
      }
    }

    const trainByNormalized = new Map<string, string>();
    const vipByNormalized = new Map<string, string>();

    const recordInto = (target: Map<string, string>, name: string | null | undefined, date: string) => {
      if (!name) return;
      const normalized = normalizeCommanderName(name) || this.normalize(name);
      if (!normalized) return;
      const existing = target.get(normalized);
      if (!existing || date > existing) {
        target.set(normalized, date);
      }
    };

    const driverRows = await this.db.prepare(
      `SELECT driver_name AS name, MAX(date) AS last_date
       FROM rewards
       WHERE type = 'TRAIN' AND driver_name IS NOT NULL AND TRIM(driver_name) <> ''
       GROUP BY driver_name`
    ).all<{ name: string | null; last_date: string | null }>();
    for (const row of driverRows.results) {
      if (row.name && row.last_date) recordInto(trainByNormalized, row.name, row.last_date);
    }

    const vipRows = await this.db.prepare(
      `SELECT vip_name AS name, MAX(date) AS last_date
       FROM rewards
       WHERE type = 'VIP' AND vip_name IS NOT NULL AND TRIM(vip_name) <> ''
       GROUP BY vip_name`
    ).all<{ name: string | null; last_date: string | null }>();
    for (const row of vipRows.results) {
      if (row.name && row.last_date) recordInto(vipByNormalized, row.name, row.last_date);
    }

    // Propagate alias-keyed dates onto their canonical normalized key.
    const propagate = (target: Map<string, string>) => {
      if (aliasTargets.size === 0) return;
      let updated = true;
      while (updated) {
        updated = false;
        for (const [aliasNormalized, canonicalNormalized] of aliasTargets.entries()) {
          if (aliasNormalized === canonicalNormalized) continue;
          const aliasDate = target.get(aliasNormalized);
          if (!aliasDate) continue;
          const existing = target.get(canonicalNormalized);
          if (!existing || aliasDate > existing) {
            target.set(canonicalNormalized, aliasDate);
            updated = true;
          }
        }
      }
    };
    propagate(trainByNormalized);
    propagate(vipByNormalized);

    const result = members.map(member => {
      const lastTrainDate = trainByNormalized.get(member.normalized) ?? null;
      const lastVipDate = vipByNormalized.get(member.normalized) ?? null;
      const lastAnyDate =
        lastTrainDate && lastVipDate
          ? (lastTrainDate > lastVipDate ? lastTrainDate : lastVipDate)
          : (lastTrainDate ?? lastVipDate);
      const daysSinceTrain = lastTrainDate
        ? this.daysBetween(this.parseDate(lastTrainDate), referenceDate)
        : null;
      const daysSinceVip = lastVipDate
        ? this.daysBetween(this.parseDate(lastVipDate), referenceDate)
        : null;
      const daysSinceAny = lastAnyDate
        ? this.daysBetween(this.parseDate(lastAnyDate), referenceDate)
        : null;
      return {
        id: member.id,
        name: member.displayName,
        lastTrainDate,
        lastVipDate,
        lastAnyDate,
        daysSinceTrain,
        daysSinceVip,
        daysSinceAny,
      };
    });

    result.sort((a, b) => {
      // Members who never received any reward first, then longest-waiting.
      if (a.daysSinceAny === null && b.daysSinceAny === null) return a.name.localeCompare(b.name);
      if (a.daysSinceAny === null) return -1;
      if (b.daysSinceAny === null) return 1;
      if (a.daysSinceAny !== b.daysSinceAny) return b.daysSinceAny - a.daysSinceAny;
      return a.name.localeCompare(b.name);
    });

    return result;
  }

  async listLeaderboards(): Promise<LeaderboardMeta[]> {
    const rows = await this.db.prepare(
      `SELECT id, slug, title, week_start, week_end
       FROM leaderboards
       ORDER BY COALESCE(week_end, substr(created_at, 1, 10)) DESC, id DESC`
    ).all<{ id: number; slug: string; title: string | null; week_start: string | null; week_end: string | null }>();
    return rows.results.map(r => ({
      id: r.id,
      slug: r.slug,
      title: r.title ?? null,
      weekStart: r.week_start ?? null,
      weekEnd: r.week_end ?? null,
    }));
  }

  async getLeaderboardBySlug(slug: string): Promise<{ leaderboard: LeaderboardMeta; entries: { rank: number; commander: string; points: number }[] } | null> {
    const metaRow = await this.db.prepare(
      `SELECT id, slug, title, week_start, week_end
       FROM leaderboards
       WHERE slug = ?
       LIMIT 1`
    ).bind(slug).first<{ id: number; slug: string; title: string | null; week_start: string | null; week_end: string | null }>();
    if (!metaRow) return null;
    const entryRows = await this.db.prepare(
      `SELECT rank, commander, points
       FROM leaderboard_entries
       WHERE leaderboard_id = ?
       ORDER BY rank ASC`
    ).bind(metaRow.id).all<{ rank: number; commander: string; points: number }>();
    return {
      leaderboard: {
        id: metaRow.id,
        slug: metaRow.slug,
        title: metaRow.title ?? null,
        weekStart: metaRow.week_start ?? null,
        weekEnd: metaRow.week_end ?? null,
      },
      entries: entryRows.results.map(r => ({ rank: r.rank, commander: r.commander, points: r.points })),
    };
  }

  async uploadLeaderboard(input: {
    slug: string;
    title: string;
    weekStart?: string | null;
    weekEnd?: string | null;
    source?: string | null;
    pointsMultiplier?: number;
    entries: { rank: number; commander: string; points: number }[];
  }): Promise<{
    leaderboardId: number;
    slug: string;
    inserted: number;
    commanders: { normalized: string; commander: string }[];
    missingActiveMembers: { id: number; displayName: string; normalizedName: string }[];
  }> {
    const slug = input.slug.trim();
    if (!slug) throw new Error('slug is required');
    const title = input.title.trim() || slug;
    const weekStart = input.weekStart?.trim() || null;
    const weekEnd = input.weekEnd?.trim() || null;
    const source = input.source?.trim() || null;
    const multiplier = input.pointsMultiplier && input.pointsMultiplier > 0 ? Math.floor(input.pointsMultiplier) : 1;

    // Normalize entries.
    const normalizedEntries = input.entries.map(e => ({
      rank: e.rank,
      commander: canonicalDisplayName(e.commander) || e.commander,
      normalized: normalizeCommanderName(e.commander),
      points: e.points * multiplier,
    })).filter(e => e.normalized.length > 0);

    if (normalizedEntries.length === 0) {
      throw new Error('No valid entries to upload.');
    }

    // Validate ranks (allow but report; we just upsert).
    // Upsert leaderboard row.
    const existing = await this.db.prepare('SELECT id FROM leaderboards WHERE slug = ? LIMIT 1')
      .bind(slug).first<{ id: number }>();
    let leaderboardId: number;
    if (existing) {
      leaderboardId = existing.id;
      await this.db.prepare(
        'UPDATE leaderboards SET title = ?, week_start = ?, week_end = ?, source = ? WHERE id = ?'
      ).bind(title, weekStart, weekEnd, source, leaderboardId).run();
    } else {
      const inserted = await this.db.prepare(
        'INSERT INTO leaderboards (slug, title, week_start, week_end, source) VALUES (?, ?, ?, ?, ?) RETURNING id'
      ).bind(slug, title, weekStart, weekEnd, source).first<{ id: number }>();
      if (!inserted) throw new Error('Failed to insert leaderboard.');
      leaderboardId = inserted.id;
    }

    // Replace entries.
    await this.db.prepare('DELETE FROM leaderboard_entries WHERE leaderboard_id = ?')
      .bind(leaderboardId).run();
    // Batch insert in chunks to stay below D1's bound-parameter limit (100 per statement).
    // 5 columns per row → max 20 rows per batch.
    const CHUNK = 20;
    for (let i = 0; i < normalizedEntries.length; i += CHUNK) {
      const chunk = normalizedEntries.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => '(?, ?, ?, ?, ?)').join(', ');
      const values: (string | number)[] = [];
      for (const e of chunk) {
        values.push(leaderboardId, e.rank, e.commander, e.normalized, e.points);
      }
      await this.db.prepare(
        `INSERT INTO leaderboard_entries (leaderboard_id, rank, commander, normalized_commander, points) VALUES ${placeholders}`
      ).bind(...values).run();
    }

    // Ensure members for each commander (insert active if new; reactivate + update display if exists).
    const byNormalized = new Map<string, string>();
    for (const e of normalizedEntries) {
      if (!byNormalized.has(e.normalized)) byNormalized.set(e.normalized, e.commander);
    }

    // Pre-load all members and build a lookup map keyed by BOTH the stored
    // normalized_name AND the full-normalized display_name. This ensures that
    // legacy members whose normalized_name was written by the simple normalizer
    // (which keeps spaces and doesn't strip diacritics, e.g. "rick m") are still
    // matched when the leaderboard entry normalizes to a different key ("rickm").
    const allMemberRows = await this.db.prepare(
      'SELECT id, display_name, normalized_name, active FROM members'
    ).all<{ id: number; display_name: string; normalized_name: string; active: number }>();
    const memberMap = new Map<string, { id: number; display_name: string; normalized_name: string; active: number }>();
    for (const m of allMemberRows.results) {
      if (!memberMap.has(m.normalized_name)) memberMap.set(m.normalized_name, m);
      // Secondary key: full-normalizer applied to display_name catches legacy rows.
      const fullKey = this.normalizeForLookup(m.display_name);
      if (fullKey && !memberMap.has(fullKey)) memberMap.set(fullKey, m);
    }

    // Pre-load alias index so a leaderboard name that happens to be a known
    // alias of another member doesn't spawn a ghost. Aliases are normalized
    // with the same `normalizeCommanderName` used for entries above so the
    // keys match. Falls back to `this.normalize` to mirror findMember.
    const aliasIndexRows = await this.db.prepare(
      'SELECT member_id, alias FROM member_aliases'
    ).all<{ member_id: number; alias: string }>();
    const aliasIndex = new Map<string, number>();
    for (const row of aliasIndexRows.results) {
      const normalized = normalizeCommanderName(row.alias) || this.normalize(row.alias);
      if (!normalized) continue;
      if (!aliasIndex.has(normalized)) aliasIndex.set(normalized, row.member_id);
      // Also index by full-normalized alias display text for consistency.
      const fullKey = this.normalizeForLookup(row.alias);
      if (fullKey && !aliasIndex.has(fullKey)) aliasIndex.set(fullKey, row.member_id);
    }

    // Track which existing member each leaderboard row resolved to. Used
    // below to compute "missing active members" — if a member is reachable
    // via alias from a leaderboard row, they are NOT missing.
    const resolvedMemberIds = new Set<number>();

    for (const [normalized, commander] of byNormalized.entries()) {
      // Look up by full-normalized key. The memberMap also covers legacy members
      // whose normalized_name was stored with the simple normalizer, via their
      // full-normalized display_name as a secondary key.
      const row = memberMap.get(normalized) ?? null;
      if (row) {
        const updates: string[] = [];
        const params: (string | number)[] = [];
        if (row.display_name !== commander) { updates.push('display_name = ?'); params.push(commander); }
        if (Number(row.active) !== 1) { updates.push('active = 1'); }
        // Heal normalized_name if it was stored with the simple normalizer.
        if (row.normalized_name !== normalized) { updates.push('normalized_name = ?'); params.push(normalized); }
        if (updates.length > 0) {
          params.push(row.id);
          await this.db.prepare(`UPDATE members SET ${updates.join(', ')} WHERE id = ?`)
            .bind(...params).run();
        }
        resolvedMemberIds.add(row.id);
        continue;
      }

      // No direct member match — check whether this name is a known alias of
      // some existing member. If so, don't insert a ghost; just reactivate
      // the canonical member. We deliberately do NOT update their
      // display_name from the leaderboard text, because the alias entry is
      // proof that this spelling is already linked to the canonical name.
      const aliasMemberId = aliasIndex.get(normalized);
      if (aliasMemberId) {
        await this.db.prepare(
          'UPDATE members SET active = 1 WHERE id = ? AND active = 0'
        ).bind(aliasMemberId).run();
        resolvedMemberIds.add(aliasMemberId);
        continue;
      }

      const inserted = await this.db.prepare(
        'INSERT INTO members (display_name, normalized_name, active) VALUES (?, ?, 1) RETURNING id'
      ).bind(commander, normalized).first<{ id: number }>();
      if (inserted) {
        resolvedMemberIds.add(inserted.id);
      }
    }

    // Find active members missing from leaderboard. Members reachable via
    // alias from any leaderboard row count as "present" — otherwise the
    // merge UI would still flag them as candidates for removal even after
    // the alias was set.
    const activeRows = await this.db.prepare(
      'SELECT id, display_name, normalized_name FROM members WHERE active = 1 ORDER BY display_name COLLATE NOCASE'
    ).all<{ id: number; display_name: string; normalized_name: string }>();
    const missingActiveMembers = activeRows.results
      .filter(r => !resolvedMemberIds.has(r.id))
      .map(r => ({ id: r.id, displayName: r.display_name, normalizedName: r.normalized_name }));

    return {
      leaderboardId,
      slug,
      inserted: normalizedEntries.length,
      commanders: Array.from(byNormalized.entries()).map(([normalized, commander]) => ({ normalized, commander })),
      missingActiveMembers,
    };
  }

  async deleteLeaderboardBySlug(slug: string): Promise<boolean> {
    const row = await this.db.prepare('SELECT id FROM leaderboards WHERE slug = ? LIMIT 1')
      .bind(slug).first<{ id: number }>();
    if (!row) return false;
    await this.db.prepare('DELETE FROM leaderboard_entries WHERE leaderboard_id = ?')
      .bind(row.id).run();
    await this.db.prepare('DELETE FROM leaderboards WHERE id = ?').bind(row.id).run();
    return true;
  }

  async deactivateMemberById(id: number): Promise<boolean> {
    const res = await this.db.prepare('UPDATE members SET active = 0 WHERE id = ?').bind(id).run();
    const changed = (res.meta?.changes ?? 0) > 0;
    if (changed) {
      await this.clearPocOpenRows(id);
    }
    return changed;
  }

  // ---------------- Train queue ----------------

  // Reconcile the queue with current state: add new active members at end,
  // remove inactive members, and move members whose latest train reward is
  // newer than what we've already recorded (auto-rotation after a train).
  // Idempotent: safe to call on every queue read.
  async syncTrainQueue(): Promise<void> {
    const activeMembers = await this.db.prepare(
      'SELECT id, display_name FROM members WHERE active = 1'
    ).all<{ id: number; display_name: string }>();
    const activeById = new Map<number, string>();
    for (const row of activeMembers.results) activeById.set(row.id, row.display_name);

    const queueRows = await this.db.prepare(
      'SELECT member_id, position, last_train_date FROM train_queue ORDER BY position ASC'
    ).all<{ member_id: number; position: number; last_train_date: string | null }>();
    const inQueue = new Map<number, { position: number; lastTrainDate: string | null }>();
    for (const r of queueRows.results) {
      inQueue.set(r.member_id, { position: r.position, lastTrainDate: r.last_train_date });
    }

    // Compute latest train date per active member id (via display name match).
    const driverRows = await this.db.prepare(
      `SELECT driver_name AS name, MAX(date) AS last_date
       FROM rewards
       WHERE type = 'TRAIN' AND driver_name IS NOT NULL AND TRIM(driver_name) <> ''
       GROUP BY driver_name`
    ).all<{ name: string; last_date: string }>();
    // Build a normalized → date map and resolve aliases.
    const trainByNormalized = new Map<string, string>();
    for (const row of driverRows.results) {
      const normalized = normalizeCommanderName(row.name) || this.normalize(row.name);
      if (!normalized) continue;
      const existing = trainByNormalized.get(normalized);
      if (!existing || row.last_date > existing) trainByNormalized.set(normalized, row.last_date);
    }
    const aliasRows = await this.db.prepare(
      'SELECT member_id, alias FROM member_aliases'
    ).all<{ member_id: number; alias: string }>();
    const aliasToMember = new Map<string, number>();
    for (const row of aliasRows.results) {
      const normalized = normalizeCommanderName(row.alias) || this.normalize(row.alias);
      if (!normalized) continue;
      aliasToMember.set(normalized, row.member_id);
    }
    const memberNormalized = new Map<number, string>();
    for (const row of activeMembers.results) {
      const normalized = normalizeCommanderName(row.display_name) || this.normalize(row.display_name);
      memberNormalized.set(row.id, normalized);
    }
    const latestTrainByMemberId = new Map<number, string>();
    for (const [memberId, normalized] of memberNormalized.entries()) {
      const direct = trainByNormalized.get(normalized);
      if (direct) latestTrainByMemberId.set(memberId, direct);
    }
    for (const [aliasNormalized, memberId] of aliasToMember.entries()) {
      const date = trainByNormalized.get(aliasNormalized);
      if (!date) continue;
      const existing = latestTrainByMemberId.get(memberId);
      if (!existing || date > existing) latestTrainByMemberId.set(memberId, date);
    }

    // Remove members no longer active. Process one at a time: for each removal
    // we re-read the live position, delete, log that exact position, then
    // renumber the remaining queue 1..N. This guarantees each log entry's
    // from_pos reflects the queue state at the moment of that specific removal
    // (matters when multiple members were inactivated together, e.g. via a
    // merge — without sequential renumbering the second removal would log a
    // stale position).
    const toRemove: number[] = [];
    for (const memberId of inQueue.keys()) {
      if (!activeById.has(memberId)) toRemove.push(memberId);
    }
    if (toRemove.length > 0) {
      const placeholders = toRemove.map(() => '?').join(',');
      const nameRows = await this.db.prepare(
        `SELECT id, display_name FROM members WHERE id IN (${placeholders})`
      ).bind(...toRemove).all<{ id: number; display_name: string }>();
      const nameById = new Map<number, string>();
      for (const row of nameRows.results) nameById.set(row.id, row.display_name);

      // Sort by current position ascending so the log order is deterministic
      // (lowest position removed first).
      toRemove.sort((a, b) => (inQueue.get(a)?.position ?? 0) - (inQueue.get(b)?.position ?? 0));

      for (const memberId of toRemove) {
        const displayName = nameById.get(memberId) ?? `member#${memberId}`;
        // Re-read the live position — earlier removals in this loop have
        // already renumbered the queue.
        const liveRow = await this.db.prepare(
          'SELECT position FROM train_queue WHERE member_id = ?'
        ).bind(memberId).first<{ position: number }>();
        const livePos = liveRow?.position ?? null;

        await this.db.prepare('DELETE FROM train_queue WHERE member_id = ?').bind(memberId).run();
        await this.db.prepare(
          `INSERT INTO train_queue_log (member_id, member_name, action, from_pos, to_pos, comment)
           VALUES (?, ?, 'remove', ?, NULL, ?)`
        ).bind(memberId, displayName, livePos, 'Removed from queue (member inactive)').run();
        inQueue.delete(memberId);

        // Renumber immediately so the next iteration (and the in-memory
        // inQueue map used later in this function) sees accurate positions.
        const remaining = await this.db.prepare(
          'SELECT member_id, position FROM train_queue ORDER BY position ASC'
        ).all<{ member_id: number; position: number }>();
        for (let i = 0; i < remaining.results.length; i++) {
          const newPos = i + 1;
          if (remaining.results[i].position !== newPos) {
            await this.db.prepare(
              `UPDATE train_queue SET position = ?, updated_at = datetime('now') WHERE member_id = ?`
            ).bind(newPos, remaining.results[i].member_id).run();
            const tracked = inQueue.get(remaining.results[i].member_id);
            if (tracked) tracked.position = newPos;
          }
        }
      }
    }

    // Find next available position for appends.
    let maxPos = 0;
    for (const entry of inQueue.values()) {
      if (entry.position > maxPos) maxPos = entry.position;
    }

    // Add active members not in the queue, in alphabetical order for deterministic seeding.
    const newcomers = Array.from(activeById.entries())
      .filter(([id]) => !inQueue.has(id))
      .sort(([, a], [, b]) => a.localeCompare(b));
    for (const [memberId, displayName] of newcomers) {
      maxPos += 1;
      const latestTrain = latestTrainByMemberId.get(memberId) ?? null;
      await this.db.prepare(
        `INSERT INTO train_queue (member_id, position, last_train_date, updated_at)
         VALUES (?, ?, ?, datetime('now'))`
      ).bind(memberId, maxPos, latestTrain).run();
      inQueue.set(memberId, { position: maxPos, lastTrainDate: latestTrain });
      await this.db.prepare(
        `INSERT INTO train_queue_log (member_id, member_name, action, from_pos, to_pos, comment)
         VALUES (?, ?, 'add', NULL, ?, NULL)`
      ).bind(memberId, displayName, maxPos).run();
    }

    // Auto-rotate members whose train reward date moved forward.
    const toMoveToEnd: Array<{ memberId: number; displayName: string; oldPos: number; newDate: string }> = [];
    for (const [memberId, entry] of inQueue.entries()) {
      const latest = latestTrainByMemberId.get(memberId);
      if (!latest) continue;
      if (entry.lastTrainDate && latest <= entry.lastTrainDate) continue;
      toMoveToEnd.push({
        memberId,
        displayName: activeById.get(memberId) ?? `#${memberId}`,
        oldPos: entry.position,
        newDate: latest,
      });
    }
    // Process in chronological order of the new reward so the most recently
    // rewarded member ends up last in the queue. Ties broken by oldPos for
    // deterministic behavior.
    toMoveToEnd.sort((a, b) => {
      if (a.newDate !== b.newDate) return a.newDate < b.newDate ? -1 : 1;
      return a.oldPos - b.oldPos;
    });
    for (const move of toMoveToEnd) {
      // Claim the update atomically before writing the log row.
      // If two concurrent syncTrainQueue calls race, only the first will see
      // changes=1; the second sees changes=0 and skips — preventing duplicate
      // log entries.
      const claim = await this.db.prepare(
        'UPDATE train_queue SET last_train_date = ? WHERE member_id = ? AND (last_train_date IS NULL OR last_train_date < ?)'
      ).bind(move.newDate, move.memberId, move.newDate).run();
      if (!claim.meta.changes) continue;

      // Move to end atomically using db.batch() (a single SQLite transaction).
      //
      // Root cause of past bug: applyQueueMove did a non-atomic SELECT + N×UPDATE
      // + INSERT. Two concurrent requests claiming different members would both
      // read the same stale snapshot, then interleave their renumber UPDATEs,
      // leaving position gaps and logging wrong from_pos values.
      //
      // Fix: wrap the three logical steps in one batch transaction so SQLite
      // serialises concurrent callers — the second batch always sees the first
      // batch's committed positions, producing correct from_pos.
      //
      // s0: rank of this member among active members (1-based) BEFORE the move.
      // s1: single CTE UPDATE that renumbers all active-member positions atomically,
      //     placing this member last (ORDER BY CASE … THEN 1 ELSE 0 END, position).
      // s2: total active-member count AFTER the move = toPos (always queue length).
      const [fromResult, , totalResult] = await this.db.batch([
        this.db.prepare(
          `SELECT COUNT(*) AS rank
           FROM train_queue q JOIN members m ON m.id = q.member_id
           WHERE m.active = 1
             AND q.position < (SELECT position FROM train_queue WHERE member_id = ?)`
        ).bind(move.memberId),
        this.db.prepare(
          `WITH ranked AS (
             SELECT member_id,
                    ROW_NUMBER() OVER (
                      ORDER BY CASE WHEN member_id = ? THEN 1 ELSE 0 END, position ASC
                    ) AS new_pos
             FROM train_queue q JOIN members m ON m.id = q.member_id WHERE m.active = 1
           )
           UPDATE train_queue
           SET position = (SELECT new_pos FROM ranked WHERE ranked.member_id = train_queue.member_id),
               updated_at = datetime('now')
           WHERE member_id IN (SELECT member_id FROM ranked)`
        ).bind(move.memberId),
        this.db.prepare(
          `SELECT COUNT(*) AS total
           FROM train_queue q JOIN members m ON m.id = q.member_id WHERE m.active = 1`
        ),
      ]);

      const fromPos = (fromResult.results[0] as { rank: number }).rank + 1;
      const toPos = (totalResult.results[0] as { total: number }).total;
      await this.db.prepare(
        `INSERT INTO train_queue_log (member_id, member_name, action, from_pos, to_pos, comment)
         VALUES (?, ?, 'auto-train', ?, ?, ?)`
      ).bind(move.memberId, move.displayName, fromPos, toPos, `Train reward on ${move.newDate}`).run();
    }
  }

  // Internal: move member to target position (1-indexed, clamped) and renumber.
  // Writes one log row for the move.
  private async applyQueueMove(
    memberId: number,
    requestedPosition: number,
    action: 'manual-move' | 'auto-train',
    comment: string | null,
    displayNameOverride?: string,
  ): Promise<{ fromPos: number; toPos: number; displayName: string }> {
    const rows = await this.db.prepare(
      `SELECT q.member_id, q.position, m.display_name
       FROM train_queue q JOIN members m ON m.id = q.member_id
       WHERE m.active = 1
       ORDER BY q.position ASC`
    ).all<{ member_id: number; position: number; display_name: string }>();
    const ordered = rows.results.slice();
    const currentIdx = ordered.findIndex(r => r.member_id === memberId);
    if (currentIdx < 0) {
      throw new Error('member is not in the queue');
    }
    const displayName = displayNameOverride ?? ordered[currentIdx].display_name;
    const fromPos = ordered[currentIdx].position;
    const [moved] = ordered.splice(currentIdx, 1);
    const targetIdx = Math.max(0, Math.min(ordered.length, requestedPosition - 1));
    ordered.splice(targetIdx, 0, moved);
    // Renumber 1..N.
    for (let i = 0; i < ordered.length; i++) {
      const newPos = i + 1;
      if (ordered[i].position !== newPos) {
        await this.db.prepare(
          `UPDATE train_queue SET position = ?, updated_at = datetime('now') WHERE member_id = ?`
        ).bind(newPos, ordered[i].member_id).run();
      }
    }
    const toPos = targetIdx + 1;
    await this.db.prepare(
      `INSERT INTO train_queue_log (member_id, member_name, action, from_pos, to_pos, comment)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(memberId, displayName, action, fromPos, toPos, comment).run();
    return { fromPos, toPos, displayName };
  }

  async moveQueueMember(memberId: number, position: number, comment: string): Promise<{ fromPos: number; toPos: number; displayName: string }> {
    const trimmed = comment.trim();
    if (!trimmed) throw new Error('comment is required');
    if (!Number.isInteger(position) || position < 1) {
      throw new Error('position must be a positive integer');
    }
    return await this.applyQueueMove(memberId, position, 'manual-move', trimmed);
  }

  // Shift each of the selected members by `spots` positions in the given
  // direction. Selected players keep their relative order; positions clamp
  // to [1, N]. Each individual move is logged with the shared comment.
  async bulkMoveQueueMembers(
    memberIds: number[],
    direction: 'up' | 'down',
    spots: number,
    comment: string,
  ): Promise<Array<{ memberId: number; displayName: string; fromPos: number; toPos: number }>> {
    const trimmed = comment.trim();
    if (!trimmed) throw new Error('comment is required');
    if (!Number.isInteger(spots) || spots < 1) {
      throw new Error('spots must be a positive integer');
    }
    if (direction !== 'up' && direction !== 'down') {
      throw new Error('direction must be "up" or "down"');
    }
    const ids = Array.from(new Set(memberIds.filter(n => Number.isInteger(n) && n > 0)));
    if (ids.length === 0) throw new Error('no members selected');

    // Snapshot current queue order.
    const rows = await this.db.prepare(
      `SELECT q.member_id, q.position, m.display_name
       FROM train_queue q JOIN members m ON m.id = q.member_id
       WHERE m.active = 1
       ORDER BY q.position ASC`
    ).all<{ member_id: number; position: number; display_name: string }>();
    const ordered = rows.results.slice();
    const indexOf = new Map<number, number>();
    ordered.forEach((r, i) => indexOf.set(r.member_id, i));

    const missing = ids.filter(id => !indexOf.has(id));
    if (missing.length > 0) {
      throw new Error('members not in queue: ' + missing.join(', '));
    }

    // Process selected members so that earlier-moved players don't push
    // later-moved players back: ascending position for "up", descending for "down".
    const selectedOrdered = ids
      .map(id => ({ id, idx: indexOf.get(id)! }))
      .sort((a, b) => direction === 'up' ? a.idx - b.idx : b.idx - a.idx);

    const results: Array<{ memberId: number; displayName: string; fromPos: number; toPos: number }> = [];
    const moves: Array<{ memberId: number; displayName: string; fromPos: number; toPos: number }> = [];

    // Work on a mutable copy of the ordering.
    const list = ordered.slice();
    // Track how many selected members are already "locked" against the
    // direction of travel (at the tail for "down", at the head for "up").
    // Without this, when two members at the end are both shifted down, the
    // last one clamps to its own position (no-op) but the second-to-last
    // still sees an unclamped target and ends up swapping with it.
    let lockedAtBoundary = 0;
    for (const sel of selectedOrdered) {
      const currentIdx = list.findIndex(r => r.member_id === sel.id);
      if (currentIdx < 0) continue;
      const fromPos = currentIdx + 1;
      const boundary = direction === 'down'
        ? list.length - 1 - lockedAtBoundary
        : 0 + lockedAtBoundary;
      const targetIdxRaw = direction === 'up' ? currentIdx - spots : currentIdx + spots;
      const targetIdx = direction === 'down'
        ? Math.min(boundary, Math.max(0, targetIdxRaw))
        : Math.max(boundary, Math.min(list.length - 1, targetIdxRaw));
      if (targetIdx === currentIdx) {
        // Pinned against the boundary; extend the lock so the next selected
        // member (one position closer to the middle) clamps to the slot
        // before this one.
        if (direction === 'down' && currentIdx === list.length - 1 - lockedAtBoundary) {
          lockedAtBoundary++;
        } else if (direction === 'up' && currentIdx === lockedAtBoundary) {
          lockedAtBoundary++;
        }
        continue;
      }
      const [moved] = list.splice(currentIdx, 1);
      list.splice(targetIdx, 0, moved);
      const toPos = targetIdx + 1;
      moves.push({ memberId: moved.member_id, displayName: moved.display_name, fromPos, toPos });
      // If the move landed exactly at the boundary, extend the lock so the
      // next selected member can't push it further.
      if (direction === 'down' && targetIdx === list.length - 1 - lockedAtBoundary) {
        lockedAtBoundary++;
      } else if (direction === 'up' && targetIdx === lockedAtBoundary) {
        lockedAtBoundary++;
      }
    }

    if (moves.length === 0) {
      return [];
    }

    // Renumber positions for everything that changed.
    for (let i = 0; i < list.length; i++) {
      const newPos = i + 1;
      if (ordered[i].member_id !== list[i].member_id || ordered[i].position !== newPos) {
        await this.db.prepare(
          `UPDATE train_queue SET position = ?, updated_at = datetime('now') WHERE member_id = ?`
        ).bind(newPos, list[i].member_id).run();
      }
    }

    // Log each move.
    for (const m of moves) {
      await this.db.prepare(
        `INSERT INTO train_queue_log (member_id, member_name, action, from_pos, to_pos, comment)
         VALUES (?, ?, 'manual-move', ?, ?, ?)`
      ).bind(m.memberId, m.displayName, m.fromPos, m.toPos, trimmed).run();
      results.push(m);
    }

    return results;
  }

  // Move all selected members to the end of the queue, preserving their
  // current relative order among themselves. Each move is logged.
  async moveQueueMembersToEnd(
    memberIds: number[],
    comment: string,
  ): Promise<Array<{ memberId: number; displayName: string; fromPos: number; toPos: number }>> {
    const trimmed = comment.trim();
    if (!trimmed) throw new Error('comment is required');
    const ids = Array.from(new Set(memberIds.filter(n => Number.isInteger(n) && n > 0)));
    if (ids.length === 0) throw new Error('no members selected');

    const rows = await this.db.prepare(
      `SELECT q.member_id, q.position, m.display_name
       FROM train_queue q JOIN members m ON m.id = q.member_id
       WHERE m.active = 1
       ORDER BY q.position ASC`
    ).all<{ member_id: number; position: number; display_name: string }>();
    const ordered = rows.results.slice();
    const idSet = new Set(ids);
    const missing = ids.filter(id => !ordered.some(r => r.member_id === id));
    if (missing.length > 0) {
      throw new Error('members not in queue: ' + missing.join(', '));
    }

    const oldPosById = new Map<number, number>();
    ordered.forEach((r, i) => oldPosById.set(r.member_id, i + 1));

    const selectedRows = ordered.filter(r => idSet.has(r.member_id));
    const remaining = ordered.filter(r => !idSet.has(r.member_id));
    const newOrder = [...remaining, ...selectedRows];

    for (let i = 0; i < newOrder.length; i++) {
      const newPos = i + 1;
      const row = newOrder[i];
      const oldPos = oldPosById.get(row.member_id);
      if (oldPos !== newPos) {
        await this.db.prepare(
          `UPDATE train_queue SET position = ?, updated_at = datetime('now') WHERE member_id = ?`
        ).bind(newPos, row.member_id).run();
      }
    }

    const moves: Array<{ memberId: number; displayName: string; fromPos: number; toPos: number }> = [];
    for (const row of selectedRows) {
      const fromPos = oldPosById.get(row.member_id)!;
      const toPos = newOrder.findIndex(r => r.member_id === row.member_id) + 1;
      await this.db.prepare(
        `INSERT INTO train_queue_log (member_id, member_name, action, from_pos, to_pos, comment)
         VALUES (?, ?, 'manual-move', ?, ?, ?)`
      ).bind(row.member_id, row.display_name, fromPos, toPos, trimmed).run();
      moves.push({ memberId: row.member_id, displayName: row.display_name, fromPos, toPos });
    }
    return moves;
  }

  async getTrainQueue(): Promise<Array<{
    memberId: number;
    position: number;
    name: string;
    lastTrainDate: string | null;
    daysSinceTrain: number | null;
  }>> {
    const today = new Date();
    const referenceDate = new Date(Date.UTC(
      today.getUTCFullYear(),
      today.getUTCMonth(),
      today.getUTCDate(),
    ));
    const rows = await this.db.prepare(
      `SELECT q.member_id, q.position, q.last_train_date, m.display_name
       FROM train_queue q JOIN members m ON m.id = q.member_id
       WHERE m.active = 1
       ORDER BY q.position ASC`
    ).all<{ member_id: number; position: number; last_train_date: string | null; display_name: string }>();
    return rows.results.map((r, i) => ({
      memberId: r.member_id,
      position: i + 1,
      name: r.display_name,
      lastTrainDate: r.last_train_date ?? null,
      daysSinceTrain: r.last_train_date
        ? this.daysBetween(this.parseDate(r.last_train_date), referenceDate)
        : null,
    }));
  }

  async getTrainQueueLog(limit = 200): Promise<Array<{
    id: number;
    ts: string;
    memberName: string;
    action: string;
    fromPos: number | null;
    toPos: number | null;
    comment: string | null;
  }>> {
    const safeLimit = Math.max(1, Math.min(1000, Math.floor(limit)));
    const rows = await this.db.prepare(
      `SELECT id, ts, member_name, action, from_pos, to_pos, comment
       FROM train_queue_log
       ORDER BY ts DESC, id DESC
       LIMIT ?`
    ).bind(safeLimit).all<{ id: number; ts: string; member_name: string; action: string; from_pos: number | null; to_pos: number | null; comment: string | null }>();
    return rows.results.map(r => ({
      id: r.id,
      ts: r.ts,
      memberName: r.member_name,
      action: r.action,
      fromPos: r.from_pos,
      toPos: r.to_pos,
      comment: r.comment,
    }));
  }

  // ---------------- /Train queue ----------------

  async mergeMemberById(duplicateId: number, targetNormalized: string, pocSource: 'target' | 'duplicate' = 'target'): Promise<boolean> {
    const duplicate = await this.db.prepare(
      'SELECT id, display_name, normalized_name FROM members WHERE id = ?'
    ).bind(duplicateId).first<{ id: number; display_name: string; normalized_name: string }>();
    if (!duplicate) return false;
    if (duplicate.normalized_name === targetNormalized) return false;

    const target = await this.db.prepare(
      'SELECT id, display_name FROM members WHERE normalized_name = ? LIMIT 1'
    ).bind(targetNormalized).first<{ id: number; display_name: string }>();
    if (!target) return false;

    const targetAliasRows = await this.db.prepare(
      'SELECT alias FROM member_aliases WHERE member_id = ?'
    ).bind(target.id).all<{ alias: string }>();
    const duplicateAliasRows = await this.db.prepare(
      'SELECT alias FROM member_aliases WHERE member_id = ?'
    ).bind(duplicate.id).all<{ alias: string }>();

    return this.runMergeBatch({
      targetId: target.id,
      duplicateId: duplicate.id,
      targetDisplay: target.display_name,
      duplicateDisplay: duplicate.display_name,
      targetAliases: targetAliasRows.results.map(r => r.alias),
      duplicateAliases: duplicateAliasRows.results.map(r => r.alias),
      pocSource,
    });
  }

  async getLatestLeaderboardRanks(names: string[]): Promise<{ leaderboard: LeaderboardMeta | null; ranks: Map<string, LeaderboardRankInfo> }> {
    const normalizedTargets = Array.from(new Set(
      names
        .map(name => this.normalizeLeaderboardName(name))
        .filter((value): value is string => Boolean(value))
    ));

    const leaderboardRows = await this.db.prepare(
      `SELECT id, slug, title, week_start, week_end, created_at
       FROM leaderboards
       ORDER BY COALESCE(week_end, substr(created_at, 1, 10)) DESC, id DESC
       LIMIT 1`
    ).all<{ id: number; slug: string; title: string | null; week_start: string | null; week_end: string | null }>();

    if (leaderboardRows.results.length === 0) {
      return { leaderboard: null, ranks: new Map() };
    }

    const latestRow = leaderboardRows.results[0];
    const leaderboard: LeaderboardMeta = {
      id: latestRow.id,
      slug: latestRow.slug,
      title: latestRow.title ?? null,
      weekStart: latestRow.week_start ?? null,
      weekEnd: latestRow.week_end ?? null,
    };

    if (normalizedTargets.length === 0) {
      return { leaderboard, ranks: new Map() };
    }

    const ranks = new Map<string, LeaderboardRankInfo>();
    const CHUNK_SIZE = 25;

    // Only search the latest leaderboard - do not fall back to older ones
    for (let i = 0; i < normalizedTargets.length; i += CHUNK_SIZE) {
      const chunk = normalizedTargets.slice(i, i + CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(', ');
      const query = `
        SELECT normalized_commander, commander, rank
        FROM leaderboard_entries
        WHERE leaderboard_id = ? AND normalized_commander IN (${placeholders})
      `;

      const rows = await this.db.prepare(query)
        .bind(latestRow.id, ...chunk)
        .all<{ normalized_commander: string; commander: string; rank: number }>();

      for (const entry of rows.results) {
        ranks.set(entry.normalized_commander, { rank: entry.rank, commander: entry.commander });
      }
    }

    return { leaderboard, ranks };
  }

  async getLeaderboardAverages(boardCount: number, excludedSlugs: string[] = []): Promise<LeaderboardAverageResult | null> {
    const requested = Math.max(1, boardCount);
    const exclusionSet = new Set(excludedSlugs);
    const fetchLimit = Math.max(requested * 3, requested + exclusionSet.size);
    const leaderboardRows = await this.db.prepare(
      `SELECT id, slug, title, week_start, week_end, created_at
       FROM leaderboards
       ORDER BY COALESCE(week_end, substr(created_at, 1, 10)) DESC, id DESC
       LIMIT ?`
    ).bind(fetchLimit).all<{ id: number; slug: string; title: string | null; week_start: string | null; week_end: string | null }>();

    const filteredRows = leaderboardRows.results.filter(row => !exclusionSet.has(row.slug));
    if (filteredRows.length === 0) {
      return null;
    }

    const selectedRows = filteredRows.slice(0, requested);

    const leaderboards: LeaderboardMeta[] = selectedRows.map((row) => ({
      id: row.id,
      slug: row.slug,
      title: row.title ?? null,
      weekStart: row.week_start ?? null,
      weekEnd: row.week_end ?? null,
    }));

    const newest = leaderboards[0];
    const leaderboardIds: number[] = leaderboards.map((l) => l.id);
    const canonicalMap = await this.getCanonicalNameMap();

    const placeholders = leaderboardIds.map(() => '?').join(', ');
    const entryRows = await this.db.prepare(
      `SELECT leaderboard_id, rank, commander, normalized_commander, points
       FROM leaderboard_entries
       WHERE leaderboard_id IN (${placeholders})`
    ).bind(...leaderboardIds).all<{ leaderboard_id: number; rank: number; commander: string; normalized_commander: string; points: number }>();

    // Build reverse alias map: normalized alias → canonical normalized name
    const aliasToCanonical = new Map<string, string>();
    const members = await this.db.prepare(
      'SELECT id, normalized_name FROM members'
    ).all<{ id: number; normalized_name: string }>();
    const memberNormalizedById = new Map<number, string>();
    for (const m of members.results) {
      memberNormalizedById.set(m.id, m.normalized_name);
      aliasToCanonical.set(m.normalized_name, m.normalized_name);
    }
    const aliases = await this.db.prepare(
      'SELECT member_id, alias FROM member_aliases'
    ).all<{ member_id: number; alias: string }>();
    for (const a of aliases.results) {
      const memberNorm = memberNormalizedById.get(a.member_id);
      if (!memberNorm) continue;
      const aliasNorm = this.normalizeLeaderboardName(a.alias);
      if (aliasNorm && !aliasToCanonical.has(aliasNorm)) {
        aliasToCanonical.set(aliasNorm, memberNorm);
      }
    }

    const resolveCanonicalNormalized = (normalized: string): string => {
      return aliasToCanonical.get(normalized) ?? normalized;
    };

    const entriesByLeaderboard = new Map<number, Map<string, { rank: number; commander: string; points: number }>>();
    for (const row of entryRows.results) {
      let boardMap = entriesByLeaderboard.get(row.leaderboard_id);
      if (!boardMap) {
        boardMap = new Map<string, { rank: number; commander: string; points: number }>();
        entriesByLeaderboard.set(row.leaderboard_id, boardMap);
      }
      const canonicalNormalized = resolveCanonicalNormalized(row.normalized_commander);
      const canonicalName = canonicalMap.get(canonicalNormalized) ?? canonicalMap.get(row.normalized_commander) ?? row.commander;
      // Use canonical normalized as key so aliases merge
      if (!boardMap.has(canonicalNormalized)) {
        boardMap.set(canonicalNormalized, { rank: row.rank, commander: canonicalName, points: row.points });
      }
    }

    const totalBoards = leaderboards.length;
    const entries: LeaderboardAverageEntry[] = [];
    const seenCanonical = new Set<string>();

    // Collect every canonical player that appears in any selected leaderboard,
    // not just the newest one — this allows surfacing strong players who missed
    // the most recent board.
    const canonicalOrder: string[] = [];
    for (const row of entryRows.results) {
      const canonicalNormalized = resolveCanonicalNormalized(row.normalized_commander);
      if (!seenCanonical.has(canonicalNormalized)) {
        seenCanonical.add(canonicalNormalized);
        canonicalOrder.push(canonicalNormalized);
      }
    }

    const newestBoardMap = entriesByLeaderboard.get(newest.id);

    for (const canonicalNormalized of canonicalOrder) {
      const scores: number[] = [];
      let missingFromOthers = false;
      let fallbackCommander: string | undefined;

      for (const board of leaderboards) {
        const boardMap = entriesByLeaderboard.get(board.id);
        const match = boardMap?.get(canonicalNormalized);
        if (match) {
          scores.push(match.points);
          if (!fallbackCommander) {
            fallbackCommander = match.commander;
          }
        } else if (board.id !== newest.id) {
          missingFromOthers = true;
        }
      }

      if (scores.length === 0) {
        continue;
      }

      const averageScore = scores.reduce((sum, value) => sum + value, 0) / scores.length;
      const canonicalName = canonicalMap.get(canonicalNormalized) ?? fallbackCommander ?? canonicalNormalized;

      const primaryMatch = newestBoardMap?.get(canonicalNormalized);
      const primaryScore = primaryMatch?.points ?? 0;
      // Players missing from the newest board sort after present players when
      // tie-breaking on primaryRank (lower-is-better), so use a large sentinel.
      const primaryRank = primaryMatch?.rank ?? Number.MAX_SAFE_INTEGER;

      entries.push({
        name: canonicalName,
        averageScore,
        seenCount: scores.length,
        totalBoards,
        primaryScore,
        primaryRank,
        missingFromOthers: missingFromOthers || !primaryMatch,
      });
    }

    return {
      newest,
      leaderboards,
      entries,
    };
  }

  async getLeaderboardRanksBySlug(slugs: string[], names: string[]): Promise<LeaderboardRanksBySlug[]> {
    if (slugs.length === 0 || names.length === 0) {
      return [];
    }

    const uniqueSlugs = Array.from(new Set(slugs.map(slug => slug.trim()).filter(Boolean)));
    if (uniqueSlugs.length === 0) {
      return [];
    }

    const normalizedTargets = Array.from(new Set(
      names
        .map(name => this.normalizeLeaderboardName(name))
        .filter((value): value is string => Boolean(value))
    ));

    if (normalizedTargets.length === 0) {
      return [];
    }

    // Build reverse alias map: canonical normalized → all known normalized variants (including aliases)
    const members = await this.db.prepare(
      'SELECT id, normalized_name FROM members'
    ).all<{ id: number; normalized_name: string }>();
    const memberNormalizedById = new Map<number, string>();
    const canonicalToAliases = new Map<string, Set<string>>();
    for (const m of members.results) {
      memberNormalizedById.set(m.id, m.normalized_name);
      if (!canonicalToAliases.has(m.normalized_name)) {
        canonicalToAliases.set(m.normalized_name, new Set([m.normalized_name]));
      }
    }
    const aliases = await this.db.prepare(
      'SELECT member_id, alias FROM member_aliases'
    ).all<{ member_id: number; alias: string }>();
    for (const a of aliases.results) {
      const memberNorm = memberNormalizedById.get(a.member_id);
      if (!memberNorm) continue;
      const aliasNorm = this.normalizeLeaderboardName(a.alias);
      if (aliasNorm) {
        const variants = canonicalToAliases.get(memberNorm);
        if (variants) {
          variants.add(aliasNorm);
        }
      }
    }

    // Expand normalized targets to include all alias variants
    const expandedTargets = new Set<string>();
    const targetToCanonical = new Map<string, string>();
    for (const target of normalizedTargets) {
      // Check if target is a canonical name
      if (canonicalToAliases.has(target)) {
        for (const variant of canonicalToAliases.get(target)!) {
          expandedTargets.add(variant);
          targetToCanonical.set(variant, target);
        }
      } else {
        // Check if target is an alias pointing to a canonical
        for (const [canonical, variants] of canonicalToAliases.entries()) {
          if (variants.has(target)) {
            for (const variant of variants) {
              expandedTargets.add(variant);
              targetToCanonical.set(variant, canonical);
            }
            break;
          }
        }
        // If not found in aliases, just use target as-is
        if (!expandedTargets.has(target)) {
          expandedTargets.add(target);
          targetToCanonical.set(target, target);
        }
      }
    }

    const allTargets = Array.from(expandedTargets);

    const slugPlaceholders = uniqueSlugs.map(() => '?').join(', ');
    const leaderboardRows = await this.db.prepare(
      `SELECT id, slug, title, week_start, week_end
       FROM leaderboards
       WHERE slug IN (${slugPlaceholders})`
    ).bind(...uniqueSlugs).all<{ id: number; slug: string; title: string | null; week_start: string | null; week_end: string | null }>();

    if (leaderboardRows.results.length === 0) {
      return [];
    }

    const canonicalMap = await this.getCanonicalNameMap();
    const results: LeaderboardRanksBySlug[] = [];
    const CHUNK_SIZE = 25;

    for (const row of leaderboardRows.results) {
      const ranks = new Map<string, { commander: string; rank: number; points: number }>();

      for (let i = 0; i < allTargets.length; i += CHUNK_SIZE) {
        const chunk = allTargets.slice(i, i + CHUNK_SIZE);
        const placeholders = chunk.map(() => '?').join(', ');
        const entries = await this.db.prepare(
          `SELECT normalized_commander, commander, rank, points
           FROM leaderboard_entries
           WHERE leaderboard_id = ? AND normalized_commander IN (${placeholders})`
        ).bind(row.id, ...chunk).all<{ normalized_commander: string; commander: string; rank: number; points: number }>();

        for (const entry of entries.results) {
          // Map back to canonical normalized name for consistent lookup
          const canonical = targetToCanonical.get(entry.normalized_commander) ?? entry.normalized_commander;
          // Only set if not already found (prefer first match)
          if (!ranks.has(canonical)) {
            const displayName = canonicalMap.get(canonical) ?? canonicalMap.get(entry.normalized_commander) ?? entry.commander;
            ranks.set(canonical, {
              commander: displayName,
              rank: entry.rank,
              points: entry.points,
            });
          }
        }
      }

      results.push({
        slug: row.slug,
        title: row.title ?? null,
        ranks,
      });
    }

    const slugOrder = new Map(uniqueSlugs.map((slug, index) => [slug, index] as const));
    results.sort((a, b) => {
      const aIndex = slugOrder.get(a.slug) ?? Number.MAX_SAFE_INTEGER;
      const bIndex = slugOrder.get(b.slug) ?? Number.MAX_SAFE_INTEGER;
      return aIndex - bIndex;
    });

    return results;
  }

  private normalize(name: string): string {
    return name
      .trim()
      .toLowerCase()
      .replace(/0/g, 'o')
      .replace(/\s+/g, ' ');
  }

  private normalizeLeaderboardName(name: string): string | null {
    const normalized = normalizeCommanderName(name);
    return normalized.length > 0 ? normalized : null;
  }

  private normalizeForLookup(name: string): string {
    const normalized = normalizeCommanderName(name);
    return normalized.length > 0 ? normalized : this.normalize(name);
  }

  private async getAliases(memberId: number): Promise<string[]> {
    const results = await this.db.prepare('SELECT alias FROM member_aliases WHERE member_id = ?')
      .bind(memberId).all<{ alias: string }>();
    return results.results.map(r => r.alias);
  }

  private async getMemberId(normalizedName: string): Promise<number | null> {
    const result = await this.db.prepare('SELECT id FROM members WHERE normalized_name = ?')
      .bind(normalizedName).first<{ id: number }>();
    return result?.id ?? null;
  }

  private parseDate(date: string): Date {
    return new Date(`${date}T00:00:00Z`);
  }

  private getDateDaysAgo(days: number, reference: Date): string {
    const date = new Date(reference.getTime());
    date.setUTCDate(date.getUTCDate() - days);
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  private async getReferenceDate(): Promise<Date> {
    const result = await this.db.prepare('SELECT MAX(date) as latest FROM rewards')
      .first<{ latest: string | null }>();
    
    if (!result?.latest) {
      return new Date();
    }
    
    return this.parseDate(result.latest);
  }

  private daysBetween(date1: Date, date2: Date): number {
    const diff = date2.getTime() - date1.getTime();
    return Math.floor(diff / (1000 * 60 * 60 * 24));
  }

  async getStats() {
    const result = await this.db.prepare(
      `SELECT
        (SELECT COUNT(*) FROM members) as total_members,
        (SELECT COUNT(*) FROM members WHERE active = 1) as active_members,
        (SELECT COUNT(*) FROM rewards) as total_rewards`
    ).first<{ total_members: number; active_members: number; total_rewards: number }>();

    return {
      totalMembers: result?.total_members ?? 0,
      activeMembers: result?.active_members ?? 0,
      totalRewards: result?.total_rewards ?? 0,
    };
  }

  // ---------------- Leaderboard score reviews ----------------

  async ensureScoreReview(slug: string, leaderboardId: number): Promise<{
    slug: string;
    leaderboardId: number;
    penaltiesStatus: string;
    bansStatus: string;
  }> {
    await this.db.prepare(
      `INSERT OR IGNORE INTO leaderboard_score_reviews (slug, leaderboard_id) VALUES (?, ?)`
    ).bind(slug, leaderboardId).run();
    const row = await this.db.prepare(
      'SELECT slug, leaderboard_id, penalties_status, bans_status FROM leaderboard_score_reviews WHERE slug = ?'
    ).bind(slug).first<{ slug: string; leaderboard_id: number; penalties_status: string; bans_status: string }>();
    if (!row) throw new Error('failed to create score review');
    return { slug: row.slug, leaderboardId: row.leaderboard_id, penaltiesStatus: row.penalties_status, bansStatus: row.bans_status };
  }

  async getScoreReview(slug: string): Promise<{
    slug: string;
    leaderboardId: number;
    penaltiesStatus: string;
    bansStatus: string;
    configJson: string | null;
    resultJson: string | null;
  } | null> {
    const row = await this.db.prepare(
      `SELECT slug, leaderboard_id, penalties_status, bans_status, config_json, result_json
       FROM leaderboard_score_reviews WHERE slug = ? LIMIT 1`
    ).bind(slug).first<{ slug: string; leaderboard_id: number; penalties_status: string; bans_status: string; config_json: string | null; result_json: string | null }>();
    if (!row) return null;
    return {
      slug: row.slug,
      leaderboardId: row.leaderboard_id,
      penaltiesStatus: row.penalties_status,
      bansStatus: row.bans_status,
      configJson: row.config_json ?? null,
      resultJson: row.result_json ?? null,
    };
  }

  async listPendingScoreReviews(): Promise<Array<{
    slug: string;
    leaderboardId: number;
    title: string | null;
    penaltiesStatus: string;
    bansStatus: string;
    createdAt: string;
  }>> {
    const rows = await this.db.prepare(
      `SELECT r.slug, r.leaderboard_id, l.title, r.penalties_status, r.bans_status, r.created_at
       FROM leaderboard_score_reviews r
       JOIN leaderboards l ON l.id = r.leaderboard_id
       WHERE r.penalties_status = 'pending' OR r.bans_status = 'pending'
       ORDER BY r.created_at DESC, r.slug ASC`
    ).all<{ slug: string; leaderboard_id: number; title: string | null; penalties_status: string; bans_status: string; created_at: string }>();
    return rows.results.map((r) => ({
      slug: r.slug,
      leaderboardId: r.leaderboard_id,
      title: r.title ?? null,
      penaltiesStatus: r.penalties_status,
      bansStatus: r.bans_status,
      createdAt: r.created_at,
    }));
  }

  async setScoreReviewStatus(
    slug: string,
    field: 'penalties_status' | 'bans_status',
    status: 'pending' | 'done' | 'skipped',
    extra?: { configJson?: string; resultJson?: string },
  ): Promise<void> {
    const sets = [`${field} = ?`, `updated_at = datetime('now')`];
    const vals: (string | null)[] = [status];
    if (extra?.configJson !== undefined) {
      sets.push('config_json = ?');
      vals.push(extra.configJson);
    }
    if (extra?.resultJson !== undefined) {
      sets.push('result_json = ?');
      vals.push(extra.resultJson);
    }
    vals.push(slug);
    await this.db.prepare(
      `UPDATE leaderboard_score_reviews SET ${sets.join(', ')} WHERE slug = ?`
    ).bind(...vals).run();
  }

  /** Leaderboard entries joined to member ids (via direct or alias match). */
  async getScoreReviewEntries(leaderboardId: number): Promise<Array<{
    rank: number;
    commander: string;
    normalized: string;
    points: number;
    memberId: number | null;
    memberName: string | null;
  }>> {
    const entryRows = await this.db.prepare(
      `SELECT rank, commander, normalized_commander, points
       FROM leaderboard_entries WHERE leaderboard_id = ? ORDER BY rank ASC`
    ).bind(leaderboardId).all<{ rank: number; commander: string; normalized_commander: string; points: number }>();
    if (entryRows.results.length === 0) return [];
    const memberRows = await this.db.prepare(
      'SELECT id, display_name, normalized_name FROM members'
    ).all<{ id: number; display_name: string; normalized_name: string }>();
    const byNorm = new Map<string, { id: number; display_name: string }>();
    for (const m of memberRows.results) {
      if (!byNorm.has(m.normalized_name)) byNorm.set(m.normalized_name, { id: m.id, display_name: m.display_name });
    }
    const aliasRows = await this.db.prepare(
      'SELECT member_id, alias FROM member_aliases'
    ).all<{ member_id: number; alias: string }>();
    const memberById = new Map(memberRows.results.map((m) => [m.id, m] as const));
    for (const a of aliasRows.results) {
      const member = memberById.get(a.member_id);
      if (!member) continue;
      const norm = normalizeCommanderName(a.alias) || this.normalize(a.alias);
      if (norm && !byNorm.has(norm)) byNorm.set(norm, { id: a.member_id, display_name: member.display_name });
    }
    return entryRows.results.map((e) => {
      const hit = byNorm.get(e.normalized_commander) ?? null;
      return {
        rank: e.rank,
        commander: e.commander,
        normalized: e.normalized_commander,
        points: e.points,
        memberId: hit ? hit.id : null,
        memberName: hit ? hit.display_name : null,
      };
    });
  }

  async hasScorePenalties(leaderboardId: number): Promise<boolean> {
    const row = await this.db.prepare(
      'SELECT COUNT(*) AS n FROM leaderboard_score_penalties WHERE leaderboard_id = ?'
    ).bind(leaderboardId).first<{ n: number }>();
    return (row?.n ?? 0) > 0;
  }

  async saveScorePenalties(
    leaderboardId: number,
    rows: Array<{
      memberId: number | null;
      normalized: string;
      commander: string;
      points: number;
      rawPenalty: number;
      appliedPenalty: number;
      capped: boolean;
      reason: 'below-min' | 'above-max';
    }>,
  ): Promise<number> {
    if (rows.length === 0) return 0;
    if (await this.hasScorePenalties(leaderboardId)) {
      throw new Error('penalties already applied for this leaderboard');
    }
    const CHUNK = 10;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
      const values: (string | number | null)[] = [];
      for (const r of chunk) {
        values.push(
          leaderboardId, r.memberId, r.normalized, r.commander, r.points,
          r.rawPenalty, r.appliedPenalty, r.capped ? 1 : 0, r.reason,
        );
      }
      // 9 columns per row.
      const ph9 = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
      void placeholders;
      await this.db.prepare(
        `INSERT INTO leaderboard_score_penalties
           (leaderboard_id, member_id, normalized_commander, commander, points, raw_penalty, applied_penalty, capped, reason)
         VALUES ${ph9}`
      ).bind(...values).run();
    }
    return rows.length;
  }

  /**
   * Consecutive capped-max streaks ending at the current leaderboard.
   * `previewCapped` carries the current board's capped hits (normalized +
   * memberId); the preview itself counts as streak position 1.
   */
  async getCappedStreaks(
    currentLeaderboardId: number,
    previewCapped: Array<{ normalized: string; memberId: number | null }>,
  ): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    if (previewCapped.length === 0) return result;
    const boardRows = await this.db.prepare(
      `SELECT id FROM leaderboards
       ORDER BY COALESCE(week_end, substr(created_at, 1, 10)) DESC, id DESC`
    ).all<{ id: number }>();
    const ordered = boardRows.results.map((r) => r.id);
    const currentIdx = ordered.indexOf(currentLeaderboardId);
    const olderBoards = currentIdx >= 0 ? ordered.slice(currentIdx + 1) : [];
    // All historic capped rows for the candidate norms/members in one query.
    const norms = Array.from(new Set(previewCapped.map((c) => c.normalized)));
    const memberIds = Array.from(new Set(previewCapped.map((c) => c.memberId).filter((v): v is number => typeof v === 'number' && v > 0)));
    const hitByBoard = new Map<number, Set<string>>();
    const recordHit = (h: { leaderboard_id: number; normalized_commander: string; member_id: number | null }) => {
      let set = hitByBoard.get(h.leaderboard_id);
      if (!set) {
        set = new Set<string>();
        hitByBoard.set(h.leaderboard_id, set);
      }
      set.add(h.normalized_commander);
      if (h.member_id !== null) set.add(`id:${h.member_id}`);
    };
    // D1 allows only ~100 bound variables per statement: a long-lived alliance
    // easily has 70+ leaderboards, and a wide board can yield dozens of capped
    // candidates, so a single IN(...) query blows up with
    // "D1_ERROR: too many SQL variables". Chunk every IN list so each query
    // stays under ~80 bindings.
    const chunk = <T>(arr: T[], size: number): T[][] => {
      const out: T[][] = [];
      for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
      return out;
    };
    if (olderBoards.length > 0 && (norms.length > 0 || memberIds.length > 0)) {
      const normChunks = norms.length > 0 ? chunk(norms, 30) : [[] as string[]];
      const idChunks = memberIds.length > 0 ? chunk(memberIds, 30) : [[] as number[]];
      for (const boards of chunk(olderBoards, 20)) {
        const boardPh = boards.map(() => '?').join(',');
        for (const ns of normChunks) {
          for (const ms of idChunks) {
            const conds: string[] = [];
            const vals: (string | number)[] = [];
            if (ns.length > 0) {
              conds.push(`normalized_commander IN (${ns.map(() => '?').join(',')})`);
              vals.push(...ns);
            }
            if (ms.length > 0) {
              conds.push(`member_id IN (${ms.map(() => '?').join(',')})`);
              vals.push(...ms);
            }
            if (conds.length === 0) continue;
            const hist = await this.db.prepare(
              `SELECT leaderboard_id, normalized_commander, member_id
               FROM leaderboard_score_penalties
               WHERE capped = 1 AND leaderboard_id IN (${boardPh}) AND (${conds.join(' OR ')})`
            ).bind(...boards, ...vals).all<{ leaderboard_id: number; normalized_commander: string; member_id: number | null }>();
            for (const h of hist.results) recordHit(h);
          }
        }
      }
    }
    for (const c of previewCapped) {
      let streak = 1;
      for (const boardId of olderBoards) {
        const set = hitByBoard.get(boardId);
        const hit = !!set && (set.has(c.normalized) || (c.memberId !== null && set.has(`id:${c.memberId}`)));
        if (hit) streak += 1;
        else break;
      }
      result.set(c.normalized, streak);
    }
    return result;
  }
}
