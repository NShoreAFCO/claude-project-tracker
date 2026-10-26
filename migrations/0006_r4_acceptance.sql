-- Migration 0006 (release R4): objectives, scope, acceptance criteria and verification (spec F2).
-- Additive only (nullable or defaulted columns), so the previous Worker version keeps working on
-- this schema: its INSERTs name their columns, and new WPs it writes get verification 'none'.

-- Project: objectives and scope (Markdown), report language (NULL = instance default locale).
ALTER TABLE project ADD COLUMN objectives_md TEXT;
ALTER TABLE project ADD COLUMN scope_in_md TEXT;
ALTER TABLE project ADD COLUMN scope_out_md TEXT;
ALTER TABLE project ADD COLUMN success_criteria_md TEXT;
ALTER TABLE project ADD COLUMN language TEXT;

-- Work package: deliverable, acceptance criteria and how completion is verified.
ALTER TABLE workpackage ADD COLUMN deliverable TEXT;
ALTER TABLE workpackage ADD COLUMN acceptance_criteria_md TEXT;
ALTER TABLE workpackage ADD COLUMN verification TEXT NOT NULL DEFAULT 'none'; -- review|test|demo|sign_off|none
ALTER TABLE workpackage ADD COLUMN verified_by TEXT;                           -- person id (never an agent)
ALTER TABLE workpackage ADD COLUMN verified_at TEXT;
