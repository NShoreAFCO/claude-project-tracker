-- Migration 0004 (release R2): schedule validation, baselines, gate decisions.
-- Additive only (new tables, nullable or defaulted columns), so the previous Worker version keeps
-- working on this schema. Holds every R2 column; behaviour arrives with the R2 tasks.

-- Schedule validation (spec F4): stored issues per entity (JSON array of ScheduleIssue, NULL = none
-- computed yet, "[]" = computed, none) and the project's strict flag (NULL = policy
-- schedule_strict_default). schedule_rev is bumped by every schedule-affecting write inside its batch
-- (guarded), so concurrent writes cannot store stale issues or bypass strict mode.
ALTER TABLE workpackage ADD COLUMN schedule_issues TEXT;
ALTER TABLE milestone ADD COLUMN schedule_issues TEXT;
ALTER TABLE project ADD COLUMN schedule_strict INTEGER;
ALTER TABLE project ADD COLUMN schedule_rev INTEGER NOT NULL DEFAULT 0;

-- Baselines (spec F4): a labelled snapshot of WP and milestone dates.
CREATE TABLE baseline (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  decision_id TEXT,                     -- set when a gate decision created it
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,             -- technical actor
  person_id TEXT                        -- the human behind it, when known
);
CREATE INDEX baseline_project ON baseline(project_id, created_at);

CREATE TABLE baseline_item (
  baseline_id TEXT NOT NULL REFERENCES baseline(id) ON DELETE CASCADE,
  entity TEXT NOT NULL,                 -- workpackage|milestone
  entity_id TEXT NOT NULL,
  start_date TEXT,                      -- WP start (NULL for milestones)
  end_date TEXT,                        -- WP end, milestone due date
  PRIMARY KEY (baseline_id, entity, entity_id)
);
CREATE INDEX baseline_item_entity ON baseline_item(entity, entity_id);

-- Gate decisions (spec F5).
ALTER TABLE milestone ADD COLUMN gate INTEGER NOT NULL DEFAULT 0;

CREATE TABLE decision (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  milestone_id TEXT NOT NULL REFERENCES milestone(id) ON DELETE CASCADE,
  decision TEXT NOT NULL,               -- go|go_with_conditions|hold|stop
  decided_by TEXT NOT NULL,             -- person id (never an agent)
  decided_at TEXT NOT NULL,
  decision_note_md TEXT,
  evidence TEXT,                        -- JSON array of context doc ids or URLs
  conditions TEXT,                      -- JSON array of {title, workpackage_id}: the WPs created for the conditions (go_with_conditions)
  on_behalf INTEGER NOT NULL DEFAULT 0, -- 1 = an admin recorded it for the named decision maker
  actor TEXT NOT NULL,                  -- technical actor of the write
  baseline_id TEXT,                     -- baseline created by a go / go_with_conditions decision
  created_at TEXT NOT NULL
);
CREATE INDEX decision_milestone ON decision(milestone_id, decided_at);
CREATE INDEX decision_project ON decision(project_id);

-- Gate lock override by a person in the dashboard.
ALTER TABLE workpackage ADD COLUMN gate_override_by TEXT;
ALTER TABLE workpackage ADD COLUMN gate_override_at TEXT;
ALTER TABLE workpackage ADD COLUMN gate_override_reason TEXT;

-- A stop decision puts the project on hold until it is closed or reactivated.
ALTER TABLE project ADD COLUMN closure_decision_pending INTEGER NOT NULL DEFAULT 0;
