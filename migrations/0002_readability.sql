-- Migration 0002 (WP11): categories, human-work flag, milestones. Additive only, so the
-- previous Worker version keeps working on this schema.

ALTER TABLE project ADD COLUMN category TEXT;        -- research|digital|product|regulatory|media
ALTER TABLE workpackage ADD COLUMN category TEXT;    -- coding|pm|research|experimental|data|docs; NULL = inherit
ALTER TABLE workpackage ADD COLUMN human INTEGER;     -- 1|0; NULL = default from category

CREATE TABLE milestone (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  workpackage_id TEXT REFERENCES workpackage(id) ON DELETE SET NULL, -- optional owner WP
  title TEXT NOT NULL, description_md TEXT,
  due_date TEXT,                 -- YYYY-MM-DD, optional
  reached_at TEXT,               -- first time it was reached; never cleared
  sort INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE milestone_link (
  milestone_id TEXT NOT NULL REFERENCES milestone(id) ON DELETE CASCADE,
  workpackage_id TEXT NOT NULL REFERENCES workpackage(id) ON DELETE CASCADE,
  role TEXT NOT NULL,            -- requires | unlocks
  PRIMARY KEY (milestone_id, workpackage_id, role)
);
CREATE INDEX ms_project ON milestone(project_id);
CREATE INDEX msl_wp ON milestone_link(workpackage_id);
