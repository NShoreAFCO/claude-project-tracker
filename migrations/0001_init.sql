-- Migration 0001: schema from SPEC §4 and §4.1 (verbatim), plus lookup indexes.

CREATE TABLE project (
  id TEXT PRIMARY KEY,                  -- slug
  title TEXT NOT NULL,
  summary TEXT,                         -- one line, card
  description_md TEXT,                  -- popup: WHAT the project is
  status TEXT NOT NULL DEFAULT 'active',-- idea|active|on_hold|done|abandoned
  origin TEXT NOT NULL DEFAULT 'manual',-- claude-web|claude-code|manual|mixed
  repo_url TEXT,                        -- maps webhooks/hooks (https://github.com/...)
  local_path TEXT,                      -- e.g. C:\Users\jane\Documents\Devel\web-app
  context_file TEXT,                    -- local handover doc, e.g. session.md (synced, §10)
  session_id TEXT,                      -- last Claude Code session for `claude --resume`
  start_date TEXT, target_date TEXT,
  progress_mode TEXT NOT NULL DEFAULT 'derived', -- derived|manual
  progress_manual REAL,
  tags TEXT,                            -- JSON array
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE workpackage (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES workpackage(id) ON DELETE CASCADE,  -- sub-projects / sub-WPs
  title TEXT NOT NULL, description_md TEXT,
  status TEXT NOT NULL DEFAULT 'todo',  -- todo|doing|blocked|waiting|done|dropped
  blocked_by TEXT,
  progress REAL NOT NULL DEFAULT 0, weight REAL NOT NULL DEFAULT 1,
  start_date TEXT, end_date TEXT, depends_on TEXT, -- JSON array
  sort INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE branch (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  workpackage_id TEXT REFERENCES workpackage(id) ON DELETE SET NULL,
  repo TEXT NOT NULL, name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'branch',  -- branch|fork|worktree
  base TEXT, status TEXT NOT NULL DEFAULT 'open', -- open|merged|closed|abandoned|stale
  pr_number INTEGER, pr_url TEXT, last_commit TEXT, last_activity TEXT, note TEXT,
  UNIQUE(repo, name)
);
CREATE TABLE score (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  criterion TEXT NOT NULL, value REAL NOT NULL, note TEXT,
  recorded_at TEXT NOT NULL, actor TEXT NOT NULL
);
CREATE TABLE token_cost (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  workpackage_id TEXT, recorded_at TEXT NOT NULL,
  claude_tokens INTEGER, copilot_prompts INTEGER, note TEXT, actor TEXT NOT NULL
);
CREATE TABLE event (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, actor TEXT NOT NULL,
  project_id TEXT, entity TEXT NOT NULL, entity_id TEXT,
  action TEXT NOT NULL, summary TEXT, diff_json TEXT
);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE context_doc (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  owner_kind TEXT NOT NULL,             -- project|workpackage|branch
  owner_id TEXT NOT NULL,               -- = project.id / workpackage.id / branch.id
  title TEXT NOT NULL,
  slug TEXT NOT NULL,                   -- unique per owner; used for files and audit paths
  source TEXT NOT NULL,                 -- upload|paste|claude|sync
  filename TEXT,                        -- original name for uploads / synced files
  content_md TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,    -- pinned docs go first in bundles
  sort INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  created_by TEXT NOT NULL, updated_by TEXT NOT NULL,
  UNIQUE(owner_kind, owner_id, slug)
);
CREATE TABLE context_revision (          -- full previous content on each change
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id TEXT NOT NULL REFERENCES context_doc(id) ON DELETE CASCADE,
  version INTEGER NOT NULL, content_md TEXT NOT NULL,
  changed_at TEXT NOT NULL, changed_by TEXT NOT NULL
);
CREATE INDEX ctx_owner ON context_doc(owner_kind, owner_id);

-- Lookup indexes (not in the brief; no behavioural change)
CREATE INDEX wp_project ON workpackage(project_id);
CREATE INDEX wp_parent ON workpackage(parent_id);
CREATE INDEX branch_project ON branch(project_id);
CREATE INDEX score_project ON score(project_id, recorded_at);
CREATE INDEX event_project ON event(project_id, id);
CREATE INDEX ctx_project ON context_doc(project_id);
CREATE INDEX ctxrev_doc ON context_revision(doc_id, version);
