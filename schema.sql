-- Cloudflare D1 schema for Last War reward tracking

-- Metadata for tracking ingestion state
CREATE TABLE IF NOT EXISTS metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  display_name TEXT NOT NULL,
  normalized_name TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_members_normalized ON members(normalized_name);
CREATE INDEX IF NOT EXISTS idx_members_active ON members(active);

CREATE TABLE IF NOT EXISTS member_aliases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER NOT NULL,
  alias TEXT NOT NULL,
  FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_aliases_member ON member_aliases(member_id);

CREATE TABLE IF NOT EXISTS rewards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  driver_name TEXT NOT NULL,
  vip_name TEXT,
  type TEXT NOT NULL CHECK(type IN ('TRAIN', 'VIP')),
  raw_text TEXT NOT NULL,
  source_message_id TEXT NOT NULL,
  source_line INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(date, driver_name, vip_name, type)
);

CREATE INDEX IF NOT EXISTS idx_rewards_date ON rewards(date DESC);
CREATE INDEX IF NOT EXISTS idx_rewards_type ON rewards(type);
CREATE INDEX IF NOT EXISTS idx_rewards_driver ON rewards(driver_name);
CREATE INDEX IF NOT EXISTS idx_rewards_vip ON rewards(vip_name);

CREATE TABLE IF NOT EXISTS leaderboards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  week_start TEXT,
  week_end TEXT,
  source TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS leaderboard_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  leaderboard_id INTEGER NOT NULL,
  rank INTEGER NOT NULL,
  commander TEXT NOT NULL,
  normalized_commander TEXT NOT NULL,
  points INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(leaderboard_id, rank),
  FOREIGN KEY (leaderboard_id) REFERENCES leaderboards(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_leaderboard_entries_leaderboard ON leaderboard_entries(leaderboard_id);
CREATE INDEX IF NOT EXISTS idx_leaderboard_entries_commander ON leaderboard_entries(normalized_commander);
CREATE INDEX IF NOT EXISTS idx_leaderboard_entries_points ON leaderboard_entries(points DESC);

-- Train reward queue: one row per member currently in the queue.
-- Lower position = earlier in queue (next up for a train).
-- last_train_date tracks the most recent TRAIN reward date we've already
-- accounted for, so the auto-sync only moves a member to the end of the
-- queue when a NEW train reward appears.
CREATE TABLE IF NOT EXISTS train_queue (
  member_id INTEGER PRIMARY KEY,
  position INTEGER NOT NULL,
  last_train_date TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_train_queue_position ON train_queue(position);

-- Audit log for queue modifications.
-- action: 'manual-move' | 'auto-train' | 'add' | 'remove' | 'rename'
-- from_pos/to_pos: queue positions (1-indexed) before/after the change (nullable for add/remove/rename).
CREATE TABLE IF NOT EXISTS train_queue_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  member_id INTEGER,
  member_name TEXT NOT NULL,
  action TEXT NOT NULL,
  from_pos INTEGER,
  to_pos INTEGER,
  comment TEXT
);
CREATE INDEX IF NOT EXISTS idx_train_queue_log_ts ON train_queue_log(ts DESC);

-- ============================================================================
-- PoC: Events (isolated). All tables prefixed poc_events_* so they can be
-- dropped without affecting production data. See plan in copilot-instructions.
-- ============================================================================

CREATE TABLE IF NOT EXISTS poc_events_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK(kind IN ('canyon', 'desert')),
  week_start TEXT NOT NULL,
  team_a_starts_at TEXT,
  team_b_starts_at TEXT,
  registration_closes_at TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'locked', 'archived')),
  notes TEXT,
  attendance_recorded INTEGER NOT NULL DEFAULT 0 CHECK(attendance_recorded IN (0, 1)),
  roster_posted_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(kind, week_start)
);
-- Migration for existing DBs:
-- ALTER TABLE poc_events_event ADD COLUMN attendance_recorded INTEGER NOT NULL DEFAULT 0 CHECK(attendance_recorded IN (0, 1));
-- ALTER TABLE poc_events_event ADD COLUMN roster_posted_hash TEXT;
CREATE INDEX IF NOT EXISTS idx_poc_events_event_status ON poc_events_event(status);
CREATE INDEX IF NOT EXISTS idx_poc_events_event_week ON poc_events_event(week_start DESC);

CREATE TABLE IF NOT EXISTS poc_events_registration (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL,
  member_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'IN' CHECK(status IN ('IN', 'OUT', 'MAYBE')),
  team_preference TEXT CHECK(team_preference IN ('any', 'A', 'B')),
  time_slot TEXT CHECK(time_slot IN ('13', '22', 'any', 'both')),
  squad_power INTEGER NOT NULL DEFAULT 0,
  squad_type TEXT NOT NULL DEFAULT 'tanks' CHECK(squad_type IN ('tanks', 'air', 'missiles')),
  priority INTEGER CHECK(priority IS NULL OR (priority >= 1 AND priority <= 5)),
  is_banned INTEGER NOT NULL DEFAULT 0 CHECK(is_banned IN (0, 1)),
  is_penalized INTEGER NOT NULL DEFAULT 0 CHECK(is_penalized IN (0, 1)),
  source TEXT NOT NULL DEFAULT 'web' CHECK(source IN ('web', 'admin')),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(event_id, member_id),
  FOREIGN KEY (event_id) REFERENCES poc_events_event(id) ON DELETE CASCADE,
  FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_poc_events_registration_event ON poc_events_registration(event_id);
CREATE INDEX IF NOT EXISTS idx_poc_events_registration_member ON poc_events_registration(member_id);

CREATE TABLE IF NOT EXISTS poc_events_assignment (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL,
  member_id INTEGER NOT NULL,
  team TEXT NOT NULL CHECK(team IN ('A', 'B')),
  role TEXT NOT NULL CHECK(role IN ('main', 'sub')),
  slot_index INTEGER NOT NULL,
  strategy_role TEXT,
  is_locked INTEGER NOT NULL DEFAULT 0,
  member_name_snapshot TEXT,
  source TEXT NOT NULL DEFAULT 'auto' CHECK(source IN ('auto', 'admin')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(event_id, member_id),
  UNIQUE(event_id, team, slot_index),
  FOREIGN KEY (event_id) REFERENCES poc_events_event(id) ON DELETE CASCADE,
  FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_poc_events_assignment_event ON poc_events_assignment(event_id);

CREATE TABLE IF NOT EXISTS poc_events_participation_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  event_id INTEGER NOT NULL,
  member_id INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('played-main', 'played-sub', 'rejected', 'opted-out', 'no-show', 'banned')),
  comment TEXT,
  FOREIGN KEY (event_id) REFERENCES poc_events_event(id) ON DELETE CASCADE,
  FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_poc_events_participation_log_unique ON poc_events_participation_log(event_id, member_id);
CREATE INDEX IF NOT EXISTS idx_poc_events_participation_log_event ON poc_events_participation_log(event_id);
CREATE INDEX IF NOT EXISTS idx_poc_events_participation_log_member ON poc_events_participation_log(member_id);
CREATE INDEX IF NOT EXISTS idx_poc_events_participation_log_ts ON poc_events_participation_log(ts DESC);
