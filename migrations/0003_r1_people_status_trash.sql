-- Migration 0003 (release R1): persons, owners, status rules, soft delete, document control.
-- Additive only (new tables, nullable or defaulted columns), so the previous Worker version keeps
-- working on this schema. Holds every R1 column; behaviour arrives with the R1 tasks.

-- Persons and identity (spec §4.1). Users are persons whose email is on the allow-list.
CREATE TABLE person (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  display_name TEXT,                    -- optional short form; initials come from it or name
  company TEXT,
  email TEXT,                           -- lower-cased; unique when set
  phone TEXT,
  contact_note TEXT,
  internal INTEGER NOT NULL DEFAULT 0,  -- 1 = own organisation
  function TEXT,                        -- descriptive job role, not a permission
  comment TEXT,
  access_role TEXT,                     -- viewer|editor|decider|admin; NULL = not a user (stakeholder)
  locale TEXT,                          -- UI preference; NULL = instance default
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  deleted_at TEXT, deleted_by TEXT
);
CREATE UNIQUE INDEX person_email ON person(lower(email)) WHERE email IS NOT NULL;

-- Events keep the technical actor and gain the human behind it.
ALTER TABLE event ADD COLUMN person_id TEXT;

-- Project: owner, sponsor, decision maker (person id or free text), closure, soft delete.
ALTER TABLE project ADD COLUMN owner_person_id TEXT;
ALTER TABLE project ADD COLUMN owner_text TEXT;
ALTER TABLE project ADD COLUMN sponsor_person_id TEXT;
ALTER TABLE project ADD COLUMN sponsor_text TEXT;
ALTER TABLE project ADD COLUMN decision_maker_person_id TEXT;
ALTER TABLE project ADD COLUMN decision_maker_text TEXT;
ALTER TABLE project ADD COLUMN closure_note_md TEXT;
ALTER TABLE project ADD COLUMN lessons_learned_md TEXT;
ALTER TABLE project ADD COLUMN deleted_at TEXT;
ALTER TABLE project ADD COLUMN deleted_by TEXT;

-- Work package: owner, drop / block / wait details, soft delete.
ALTER TABLE workpackage ADD COLUMN owner_person_id TEXT;
ALTER TABLE workpackage ADD COLUMN owner_text TEXT;
ALTER TABLE workpackage ADD COLUMN drop_reason TEXT;
ALTER TABLE workpackage ADD COLUMN blocked_since TEXT;   -- YYYY-MM-DD
ALTER TABLE workpackage ADD COLUMN waiting_reason TEXT;
ALTER TABLE workpackage ADD COLUMN deleted_at TEXT;
ALTER TABLE workpackage ADD COLUMN deleted_by TEXT;

-- Priority stakeholders of a work package (0..n persons).
CREATE TABLE wp_stakeholder (
  workpackage_id TEXT NOT NULL REFERENCES workpackage(id) ON DELETE CASCADE,
  person_id TEXT NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  PRIMARY KEY (workpackage_id, person_id)
);
CREATE INDEX wps_person ON wp_stakeholder(person_id);

-- Links between projects (follow-up projects after closure: follows / followed_by).
CREATE TABLE project_link (
  from_project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  to_project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (from_project_id, to_project_id, kind)
);
CREATE INDEX plink_to ON project_link(to_project_id);

-- Soft delete for milestones; soft delete and release status for context documents.
ALTER TABLE milestone ADD COLUMN deleted_at TEXT;
ALTER TABLE milestone ADD COLUMN deleted_by TEXT;
ALTER TABLE context_doc ADD COLUMN deleted_at TEXT;
ALTER TABLE context_doc ADD COLUMN deleted_by TEXT;
ALTER TABLE context_doc ADD COLUMN status TEXT NOT NULL DEFAULT 'released'; -- draft|released|obsolete; existing docs count as released
ALTER TABLE context_doc ADD COLUMN released_by TEXT;
ALTER TABLE context_doc ADD COLUMN released_at TEXT;
