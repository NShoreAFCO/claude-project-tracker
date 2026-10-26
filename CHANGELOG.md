# Changelog

## R3

### Added

- Risk and nonconformity log: `type` `risk | issue | opportunity | nc`, probability and impact (1–5), derived score 1–25, owner, response, action, status; `nc_*` fields for type `nc` only (400 otherwise; changing the type away from `nc` clears them). MCP `upsert_risk` and `list_risks`, REST `/api/risks`. Risks go to the trash with their project. The context bundle has an "Open risks" section.
- Derived `risk` score: while open risks exist (not closed, not opportunities) it is round((highest score − 1) / 24 × 10) and marked `derived`; the manual score is the fallback. Cards add `risk_summary` {open, max_score, high_without_action}; scores of 15 or more without an action are a portfolio warning.
- Progress transparency: `progress_basis` {mode, done, total, weighted_percent, reason} on projects. Manual progress needs `progress_manual_reason` when switching to manual or changing the value. Work package `effort_planned_pd` and `effort_actual_pd` (person-days); `log_progress` takes `effort_pd`, which adds to the actual effort.
- Activity: `last_progress_at` and `last_changed_at` on projects and work packages, and a derived `stale` flag (active project, last progress more than `stale_days` UTC calendar days ago; `policy.stale_days`, overridable per project type).
- MCP tools: `upsert_risk`, `list_risks` (27 tools in total).

### Breaking

- The card field `last_activity` now means the last progress (`last_progress_at`), not the latest event.
- A project with open risks shows a derived `risk` score; the manual score applies again once none are open.

### Migration

- `0005_r3_risk_progress_activity.sql`, additive only; the previous Worker version keeps running on it. Existing rows are backfilled from `updated_at`. Run `npm run db:migrate:remote`, then deploy.
- Legacy manual-progress projects without a reason stay editable; a reason is asked for at the next change of the manual value.

## R2

### Added

- Schedule validation: write results carry `warnings` for `DEP_START_BEFORE_PRED_END`, `START_BEFORE_GATE`, `CHILD_OUTSIDE_PARENT`, `MILESTONE_BEFORE_REQUIRED_END` and `DEP_UNKNOWN` (unknown or legacy free-text `depends_on`). Equal dates are no conflict. New `depends_on` ids must be work packages of the project, and cycles are refused (400). Per-project `schedule_strict` (policy `schedule_strict_default`): a write that adds an issue fails with 409 `SCHEDULE_STRICT`; existing issues never block unrelated edits; racing schedule writes get 409 `SCHEDULE_CONFLICT`.
- Baselines: `create_baseline` (MCP) and `POST /api/projects/:id/baselines`. Project detail adds `baseline`, `baseline_start`, `baseline_end`, `slip_days` and `critical` (longest calendar-day path over `depends_on` and milestone requires/unlocks; none when the plan has a cycle).
- Gates: milestone `gate`, decisions `go | go_with_conditions | hold | stop` via `record_gate_decision` and `POST /api/milestones/:id/decisions`. The decider is always the calling person (service tokens are refused); a named decision maker decides alone (admins on their behalf, with a note), a free-text one needs a note. `go` and `go_with_conditions` take a baseline, each condition becomes a work package, `stop` puts the project on hold with a pending closure decision.
- Gate lock: work packages an undecided gate unlocks (and their sub-WPs) cannot be started, progressed or finished (409 `GATE_LOCKED`). A person overrides with a reason (`POST /api/workpackages/:id/gate-override`); agents never can.
- Dashboard: Gantt schedule issues, baseline bars and slip, critical path, gate decision dialog and override dialog.
- MCP tools: `create_baseline`, `record_gate_decision` (25 tools in total). `update_project` takes `schedule_strict`.

### Changed

- `log_progress` no longer auto-starts a gate-locked work package.
- Agents cannot clear a gate flag, drop work packages from an undecided gate, delete the gate, move a locked work package, or change the project's decision maker while a gate is undecided (409 `DECISION_MAKER_LOCKED` for the last).

### Breaking

- Gate decisions need a project decision maker (409 `DECISION_MAKER_MISSING`); once a gate exists the decision maker can be changed but not cleared (409 `DECISION_MAKER_REQUIRED`).
- Writes with unknown `depends_on` ids and dependency cycles are refused (400). Stored legacy values are kept and reported as `DEP_UNKNOWN`.

### Migration

- `0004_r2_schedule_gates.sql`, additive only; the previous Worker version keeps running on it. Run `npm run db:migrate:remote`, then deploy.
- Schedule issues are computed lazily: rows hold NULL until a project is first read (project detail or context bundle) after the deploy, which stores them.
- Optional: set `policy.schedule_strict_default` and `policy.gates.require_decision` in `instance/instance.config.json`.

## R1

### Added

- People: `person` records for users and stakeholders; every write records the human behind it (`person_id`, `on_behalf_of` for the Claude Code hook). Owner, sponsor and decision maker on projects; owner and priority stakeholders on work packages. Dashboard: People view and owner initials on cards.
- `policy` block in `instance.config.json` (admins, default role, locales, stale days, retention days, gates, report, score scales). Setup asks for the admin email(s).
- Status rules: `done` and `abandoned` need a closure note, `done` also needs lessons learned, and only `done` requires that no work package is open; `dropped` needs a reason; `blocked_by` references (`wp:`, `ms:`, `ext:`) with `blocked_since`; `waiting_reason`; auto-start of `todo` work packages on first progress; `stalled_blocked` and `closure_due` flags. Dashboard: closure dialog, Blocked and Waiting chips.
- `move_workpackages` (MCP and REST): moves open work packages to a follow-up project.
- Soft delete with a Trash view: restore, and admin purge after `policy.retention_days`. `GET /api/delete-preview` for confirmation texts.
- Context document status (`draft`, `released`, `obsolete`); bundles leave out obsolete documents unless asked.
- MCP tools: `list_persons`, `upsert_person`, `move_workpackages`, `restore_entity`, `set_context_meta` (23 tools in total).

### Changed

- `delete_entity` and `delete_context` move items to the trash instead of removing them; `delete_entity` also accepts kinds `context_doc` and `person`.
- An MCP login whose email is no longer allowed is refused (403) at once, not when the grant expires.
- New context documents are `released` by default.
- Create/update project results carry `warnings`. Without owner and status, `create_project` makes an `idea` with a warning; an explicit `active` without owner fails.

### Breaking

- `wp_counts` on project cards and `list_projects` now has `open` (todo only), `in_progress`, `waiting_blocked`, `done` (`started` repeats `in_progress` for now). Code that read `open` as "not done" must change.
- Closed (`done`/`abandoned`) projects refuse new open work packages (409 `PROJECT_CLOSED`); reopen the project first.
- `npm run setup:check` fails until `policy.admins` is set.

### Migration

- `0003_r1_people_status_trash.sql`, additive only (new tables and columns); the previous Worker version keeps running on it. Run `npm run db:migrate:remote`, then deploy.
- Maintainers: add `policy.admins` (an allowed email) to `instance/instance.config.json`, or rerun `npm run setup`. The admin role is given at a person's first sign-in only; for people who already signed in, an admin changes the role in the People view.
- Known limitation: a purged person's name disappears from older history.
