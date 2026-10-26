-- Migration 0005 (release R3): risk and nonconformity log, progress transparency, activity data.
-- Additive only (new table, nullable or defaulted columns), so the previous Worker version keeps
-- working on this schema. Holds every R3 column; behaviour arrives with the R3 tasks.

-- Risk and nonconformity log (spec F6): one table, type risk|issue|opportunity|nc. score is derived
-- (probability x impact) and stored so lists can sort and filter on it.
CREATE TABLE risk (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'risk',     -- risk|issue|opportunity|nc
  title TEXT NOT NULL,
  description_md TEXT,
  probability INTEGER NOT NULL,          -- 1..5
  impact INTEGER NOT NULL,               -- 1..5
  score INTEGER NOT NULL,                -- probability * impact (1..25)
  owner_person_id TEXT,
  owner_text TEXT,
  response TEXT,                         -- avoid|reduce|transfer|accept|exploit
  action TEXT,
  due_date TEXT,
  status TEXT NOT NULL DEFAULT 'open',   -- open|monitoring|closed
  workpackage_id TEXT,
  milestone_id TEXT,
  -- nonconformity (type nc) only
  nc_detected_in_wp TEXT,
  nc_cause TEXT,
  nc_correction TEXT,
  nc_corrective_action TEXT,
  nc_effectiveness_check_date TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  deleted_by TEXT
);
CREATE INDEX risk_project ON risk(project_id, status);

-- Progress transparency (spec F7).
ALTER TABLE workpackage ADD COLUMN effort_planned_pd REAL;
ALTER TABLE workpackage ADD COLUMN effort_actual_pd REAL;
ALTER TABLE project ADD COLUMN progress_manual_reason TEXT;

-- Activity data and staleness (spec F8), backfilled from updated_at.
ALTER TABLE project ADD COLUMN last_progress_at TEXT;
ALTER TABLE project ADD COLUMN last_changed_at TEXT;
ALTER TABLE workpackage ADD COLUMN last_progress_at TEXT;
ALTER TABLE workpackage ADD COLUMN last_changed_at TEXT;
UPDATE project SET last_progress_at = updated_at, last_changed_at = updated_at;
UPDATE workpackage SET last_progress_at = updated_at, last_changed_at = updated_at;
