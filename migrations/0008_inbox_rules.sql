-- Migration 0008 (release 0.7.0): inbox folder rules and an index for the inbox and its badge.
-- Additive only (a new table and a new index), so the previous Worker version keeps working on this schema.

-- Folder rules for unmatched Claude Code hook events: ignore them, or assign them to a project.
CREATE TABLE inbox_rule (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('ignore', 'assign')),
  path TEXT NOT NULL UNIQUE,      -- normalisePath() form: lower case, forward slashes, no trailing slash
  project_id TEXT REFERENCES project(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  CHECK ((kind = 'assign') = (project_id IS NOT NULL))
);
-- The inbox and its badge read unassigned events by action.
CREATE INDEX IF NOT EXISTS event_inbox ON event(action, id) WHERE project_id IS NULL;
