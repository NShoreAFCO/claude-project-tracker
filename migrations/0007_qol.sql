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

-- Backfill actual_start: date of the earliest event that started the WP (status doing or done,
-- progress above 0, or a log_progress event with the WP id).
UPDATE workpackage SET actual_start = (
  SELECT substr(MIN(e.ts), 1, 10) FROM event e
  WHERE e.entity = 'workpackage' AND e.entity_id = workpackage.id
    AND (e.action = 'progress'
      OR CASE WHEN json_valid(e.diff_json) THEN json_extract(e.diff_json, '$.status[1]') END IN ('doing', 'done')
      OR COALESCE(CASE WHEN json_valid(e.diff_json) THEN json_extract(e.diff_json, '$.progress[1]') END, 0) > 0)
);

-- Backfill actual_end: date of the latest event that set status done, for WPs that are done now.
UPDATE workpackage SET actual_end = (
  SELECT substr(MAX(e.ts), 1, 10) FROM event e
  WHERE e.entity = 'workpackage' AND e.entity_id = workpackage.id
    AND CASE WHEN json_valid(e.diff_json) THEN json_extract(e.diff_json, '$.status[1]') END = 'done'
) WHERE status = 'done';
