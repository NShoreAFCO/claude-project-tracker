-- Migration 0007 (release 0.3.0): WP code, actual dates, project host, dashboard preferences.
-- Additive only (nullable columns), so the previous Worker version keeps working on this schema.

-- Work package: short code shown before the title, and the actual start and end (YYYY-MM-DD, UTC).
ALTER TABLE workpackage ADD COLUMN code TEXT;
ALTER TABLE workpackage ADD COLUMN actual_start TEXT;
ALTER TABLE workpackage ADD COLUMN actual_end TEXT;

-- Project: host name of the machine that holds local_path (sent by the hook).
ALTER TABLE project ADD COLUMN local_host TEXT;

-- Person: personal dashboard layout (JSON, own record only).
ALTER TABLE person ADD COLUMN dashboard_prefs TEXT;

-- Backfill actual_end: date of the latest event that set status done, for WPs that are done now.
UPDATE workpackage SET actual_end = (
  SELECT substr(MAX(e.ts), 1, 10) FROM event e
  WHERE e.entity = 'workpackage' AND e.entity_id = workpackage.id
    AND CASE WHEN json_valid(e.diff_json) THEN json_extract(e.diff_json, '$.status[1]') END = 'done'
) WHERE status = 'done';

-- Backfill actual_start for WPs that have started (status not todo or dropped), in fallback order. Each
-- step only fills what is still empty, so the steps are idempotent and a log before a gate opened wins.
-- Notes (action 'note') never count as start. A todo WP gets no start: old progress events do not count for it.
-- Step 1 (also for dropped WPs, D21 h: only a current todo is excluded): earliest event that started the WP (status doing or done, progress above 0, or a log_progress event).
UPDATE workpackage SET actual_start = (
  SELECT substr(MIN(e.ts), 1, 10) FROM event e
  WHERE e.entity = 'workpackage' AND e.entity_id = workpackage.id AND e.action <> 'note'
    AND (e.action = 'progress'
      OR CASE WHEN json_valid(e.diff_json) THEN json_extract(e.diff_json, '$.status[1]') END IN ('doing', 'done')
      OR COALESCE(CASE WHEN json_valid(e.diff_json) THEN json_extract(e.diff_json, '$.progress[1]') END, 0) > 0)
) WHERE actual_start IS NULL AND status <> 'todo';

-- Step 2: opening of a gate that unlocks the WP. A gate opens only if its latest decision (by decided_at, then
-- created_at, id) is go or go_with_conditions; a go superseded by a later hold or stop opens nothing. The opening
-- date is the later of reached_at and that go decision's date; the earliest such date over the WP's gates.
UPDATE workpackage SET actual_start = (
  SELECT MIN(CASE WHEN substr(d.decided_at, 1, 10) > substr(m.reached_at, 1, 10) THEN substr(d.decided_at, 1, 10) ELSE substr(m.reached_at, 1, 10) END)
  FROM milestone_link l
  JOIN milestone m ON m.id = l.milestone_id AND m.gate = 1 AND m.deleted_at IS NULL AND m.reached_at IS NOT NULL
  JOIN decision d ON d.id = (SELECT d2.id FROM decision d2 WHERE d2.milestone_id = m.id
                             ORDER BY d2.decided_at DESC, d2.created_at DESC, d2.id DESC LIMIT 1)
    AND d.decision IN ('go', 'go_with_conditions')
  WHERE l.workpackage_id = workpackage.id AND l.role = 'unlocks'
) WHERE actual_start IS NULL AND status IN ('doing', 'blocked', 'waiting', 'done');

-- Step 3: the nearest ancestor that has an actual_start from steps 1-2 (or its own actual_start). An ancestor
-- without one would itself fall back to its own ancestor or the project start, so walking up the chain in one
-- statement gives the same value for every row whatever the row order (no dependence on which parent was
-- updated first). No ancestor with a start: the row stays empty and gets the project start in step 4.
UPDATE workpackage SET actual_start = (
  WITH RECURSIVE anc(id, parent_id, actual_start, depth) AS (
    SELECT p.id, p.parent_id, p.actual_start, 1 FROM workpackage p WHERE p.id = workpackage.parent_id
    UNION ALL
    SELECT g.id, g.parent_id, g.actual_start, a.depth + 1 FROM workpackage g JOIN anc a ON g.id = a.parent_id WHERE a.depth < 50
  )
  SELECT actual_start FROM anc WHERE actual_start IS NOT NULL ORDER BY depth LIMIT 1
) WHERE actual_start IS NULL AND parent_id IS NOT NULL AND status IN ('doing', 'blocked', 'waiting', 'done');

-- Step 4: the project start date.
UPDATE workpackage SET actual_start = (
  SELECT substr(pr.start_date, 1, 10) FROM project pr WHERE pr.id = workpackage.project_id
) WHERE actual_start IS NULL AND status IN ('doing', 'blocked', 'waiting', 'done');

-- Step 5: the project's created_at.
UPDATE workpackage SET actual_start = (
  SELECT substr(pr.created_at, 1, 10) FROM project pr WHERE pr.id = workpackage.project_id
) WHERE actual_start IS NULL AND status IN ('doing', 'blocked', 'waiting', 'done');

-- Clamp, last and once, after the whole chain: the start is never later than the end.
UPDATE workpackage SET actual_start = actual_end WHERE actual_end IS NOT NULL AND actual_start > actual_end;
