# Changelog

## v0.3.0 - usability release

Read "Breaking" and "Upgrade from v0.2.0" before you deploy. Details: `docs/SPEC.md` section 25.

### Added

- Migration 0007 (additive): work package `code`, `actual_start`, `actual_end`; project `local_host`; person `dashboard_prefs`.
- Work package codes (max 12 characters), shown before the title everywhere.
- Actual dates, set automatically on first start, progress or `log_progress`, and on done; settable explicitly.
- Project `local_host`: the session hook sends the host name; hidden from viewers.
- The hook also syncs `HANDOFF.md` (slug `handoff`, pinned) next to `session.md`; the old `context_file` still works.
- Gate lists: milestone reads carry `reached`, `requires_status`, `unlocks_status`; the decision dialog shows them with a warning for a gate not yet reached; bundle "Gates" lines show `reached: yes|no`.
- Project cards carry `current_gate`.
- My-dashboard API (`/api/persons/me/dashboard`, `human_only` and `project_id` on `mine`, `/api/workpackages/open`, `/api/gates/open`) and the `#/my` view with saved views.
- UI shell: home link, left sidebar with categories, logout link (hidden on localhost), drawer below 900 px.
- Grid: completed filter (hide / only / all), tag filter with AND, filters kept in `localStorage`, redesigned cards.
- Theme tokens `--underlay-wp`, `--underlay-milestone`, `--underlay-gate` (7:1 contrast checked).
- Project page: Gantt link, host in the scope line, milestones and gates inside the work package tree, larger chevrons, branches folded.
- Gantt: planned, actual, progress and overdue bars; milestones (`M<n>`) and gates (`G<n>`) on work package rows; codes in labels.
- MCP usage guide: server instructions, `docs/ai/PROJECT-STRUCTURE.md`, tool description hints.

### Changed

- Version 0.3.0 (package and MCP server).
- Milestone dependency arrows are gone from the Gantt chart.

### Breaking

- **Gate lock.** A work package stays locked until its gate is reached (all `requires` work packages done or dropped) and has a go or go_with_conditions decision. A decision recorded before the gate is reached no longer unlocks early. Gates without any non-dropped `requires` work package never reach; their work packages stay locked until an override. `policy.gates.require_decision=false` is unchanged. Check the live data for gates with a go decision that are not yet reached before you deploy.
- New theme tokens: `npm run check` fails until `instance/theme.css` defines the three `--underlay-*` tokens.

### Upgrade from v0.2.0

1. Back up first: `npm run backup`.
2. Before deploying, list gates with a go decision whose `requires` work packages are not all done or dropped; they will lock their work packages.
3. Apply migration 0007: `npm run db:migrate:remote` (additive).
4. Add `--underlay-wp`, `--underlay-milestone` and `--underlay-gate` to `instance/theme.css` (values in `instance.example/theme.css`, rules in `docs/THEMING.md`).
5. Re-run `npm run hook:install` on every machine that uses the session hook (host and `HANDOFF.md`).
6. Reconnect MCP clients (new instructions and descriptions).
7. Run `npm test` and `npm run check`, then deploy.

## v0.2.0 — 2026-10-26

v0.2.0 bundles the conformity releases R1 to R5 below plus the fixes from the final review. Read "Breaking" and "Upgrade from v0.1.0" before you deploy.

### Fixed / changed in the final review

- Creating or reopening a work package is atomic against a concurrent close of the project: if the project was closed in between, nothing is written and the answer is 409 `PROJECT_CLOSED` (404 when the project is in the trash).
- Admin bootstrap: a login whose email is in `policy.admins` becomes admin when no live (not deleted) admin exists, and a `person` update event records it. While an admin exists, a deliberate demotion stays.
- `get_context_bundle` has a "Gates" section: undecided gate milestones and gate-locked work packages (left out when there is nothing to list).
- Restoring an open work package (or a sub-work-package restored with it) into a `done` or `abandoned` project gives 409 `PROJECT_CLOSED`.
- Risk links into a work package or milestone in the trash read as empty (REST, MCP, reports) and come back when the item is restored. A risk with such a link stays editable.
- Work packages created by a `go_with_conditions` decision are linked to the gate milestone with the role `requires`, so a later `hold` does not lock them.
- Overdue checks (portfolio and project views) and the `verified_at` date check use the UTC date.
- The gate decision event carries `note_md`, `evidence`, `conditions` and `on_behalf`.
- Restore from the trash is an admin action, no longer an editor action (see Breaking). The R5 section below is corrected accordingly.
- The MCP server reports version 0.2.0.

### Breaking (all of v0.2.0)

From R1:

- `wp_counts` on project cards and `list_projects` is now `{open, in_progress, waiting_blocked, done}`. `open` counts leaf work packages with status `todo` only; `in_progress` is `doing`; `waiting_blocked` is `waiting` plus `blocked`; parent work packages and `dropped` are not counted. The old `started` alias is removed. Code that read `open` as "not done" must change.
- Closed (`done`/`abandoned`) projects refuse new open work packages (409 `PROJECT_CLOSED`); reopen the project first.
- `npm run setup:check` fails until `policy.admins` is set.

From R2:

- Gate decisions need a project decision maker (409 `DECISION_MAKER_MISSING`); once a gate exists the decision maker can be changed but not cleared (409 `DECISION_MAKER_REQUIRED`).
- Writes with unknown `depends_on` ids and dependency cycles are refused (400). Stored legacy values are kept and reported as `DEP_UNKNOWN`.

From R3:

- The card field `last_activity` means the last progress (`last_progress_at`), not the latest event.
- A project with open risks shows a derived `risk` score; the manual score applies again once none are open.

From R5:

- Viewers lose write access everywhere (403).
- Reopening a closed project needs a decider.
- Viewers no longer see `local_path`, `session_id` or `repo_url`.

New in the final review:

- Restore from the trash is admin-only: REST, MCP `restore_entity` and the dashboard. Service tokens never restore; the MCP login of an admin may. Editors, deciders, viewers and MCP logins of non-admins get 403, and the dashboard shows the Restore button to admins only.

### Also in this release

Earlier sections did not list these.

- Error codes `PARENT_DELETED` (restore while the parent is in the trash), `SLUG_TAKEN` (restore of a context document whose slug was reused) and `TARGET_CLOSED` (moving work packages into a closed project), all 409.
- A context document deleted on its own gives up its slug (renamed `<slug>~deleted-<time>`), so a new document can take it.
- The agent view of persons (service tokens and MCP) leaves out phone, contact note and deletion data; the audit export shows contact data changes only as `[changed]`.
- Changing a person's access role or a user's email, and deleting a user's person, are admin-only; agents never do them.

### Known limitations (planned for v0.2.x)

- The audit export has no snapshot tables for decisions, risks and baselines; decisions are in the events.
- Editing a risk in the dashboard while its linked work package or milestone is in the trash clears that link.
- The context bundle lists undecided gates even when `policy.gates.require_decision` is false.
- The `PROJECT_CLOSED` check on restore runs just before the write, not inside it.
- The role-bootstrap event is recorded with channel `dashboard` even when the trigger is an MCP login.

### Upgrade from v0.1.0

1. Back up first: `npm run backup`.
2. Apply the migrations 0003 to 0006: `npm run db:migrate:remote`. They are additive; the previous Worker version keeps running on them.
3. Review the new `policy` keys in `instance/instance.config.json` (defaults in `instance.example/`): `admins`, `default_role`, `locales`, `stale_days`, `schedule_strict_default`, `target_date_required_categories`, `gates.require_decision`, `retention_days`, `hide_empty_categories`, `report.paper`, `report.pdf`, `score_scales`.
4. Make sure `policy.admins` holds at least one email.
5. Assign the `decider` role in the People view to everyone who should close projects, decide gates or verify sign-offs.
6. Reconnect MCP clients: the tool list changed (28 tools).
7. Run `npm test` and `npm run check`, then deploy.

## R5

### Added

- Dashboard by role: one client helper (`public/js/access.js`, mirrors the server's minimum roles) hides or disables write, close, decide, sign_off and purge controls; the header shows your name, role and a language switch (`policy.locales`, saved to your profile, applied without a reload). Empty project categories hide or collapse per `policy.hide_empty_categories`; active projects without a target date in a `policy.target_date_required_categories` category get an amber hint. The public instance config now carries `policy.locales`, `hide_empty_categories` and `target_date_required_categories`.
- Role enforcement: every REST route and MCP tool maps to one action (`read | write | decide | close | verify_sign_off | manage_roles | purge | restore`) with a minimum role (viewer < editor < decider < admin); an unmapped route or tool answers 403. Service tokens act as editor and never decide, close, verify a `sign_off`, manage roles, purge or restore, even with `on_behalf_of`. MCP logins act with the person's role but never manage roles or purge. Roles are read on every request. The full matrix is in `docs/SPEC.md` section 24.
- Closing a project (`done`, `abandoned`) and reopening it need a decider. Recording, changing or lowering a `sign_off` verification needs a decider; `review`, `test` and `demo` verification need a person. Restore from the trash and purge are admin actions (restore was an editor action before v0.2.0). Viewers may edit only their own language, display name and phone (`PATCH /api/persons/me`). The Claude Code hook checks the user's role.
- Hygiene: a project in a `policy.target_date_required_categories` category needs a target date to become `active` (400); `create_project` without status then gives `idea` plus a warning. Project `language` is checked against `policy.locales`.
- The OAuth consent and error pages use the instance default language and the instance string overrides.
- Setup, backup and deploy scripts fall back to wrangler's own login (`wrangler login`) with the account from the instance config when no saved token file exists.

### Changed

- Viewers no longer see `local_path`, `session_id` or `repo_url` (REST and MCP); branch `repo` and `pr_url` stay visible.
- `GET /api/whoami` accepts GET only.

### Breaking

- Viewers lose write access everywhere (403).
- Reopening a closed project needs a decider.
- Viewers no longer see the internal fields above.

### Migration

- None. Update, run `npm test` and `npm run check`, then deploy. Review the People view before deploying: everyone who should close projects or verify sign-offs needs the `decider` role, and the default role is still `editor`.

## R4

### Added

- Acceptance: project `objectives_md`, `scope_in_md`, `scope_out_md`, `success_criteria_md` and `language`; work package `deliverable`, `acceptance_criteria_md`, `verification` (`none | review | test | demo | sign_off`), `verified_by` and `verified_at`.
- Verification: completing a work package with a verification method (status `done`, or `log_progress` reaching 100) needs a person as verifier. Dashboard users and MCP logins verify as themselves, service tokens need `on_behalf_of`; otherwise 409 `VERIFICATION_REQUIRED`. Agents may name only their own person, cannot change another person's verification (403) and can raise but never lower the method (403). Reopening clears the verification.
- Portfolio overview: `GET /api/portfolio/summary` (`by_status`, overdue milestones, gates awaiting decision, blocked, stale, missing target date, missing owner, schedule issues, open high risks, each with count and project ids), `GET /api/workpackages/upcoming` and `GET /api/workpackages/mine`.
- Reports: `GET /api/projects/:id/report?format=md|html|pdf` in the project's language (else the instance default), names only, no contact data. PDF is rendered by the Cloudflare Browser Rendering binding `BROWSER`; `policy.report.pdf: false` leaves the binding out, and the PDF route then answers 503. `policy.report.paper` (`a4` | `letter`) sets the paper size.
- Server-side texts (reports) can be overridden per language in `instance/strings.<locale>.json`.
- MCP tool: `get_portfolio_summary`, read-only (28 tools in total). `create_project`, `update_project` and `upsert_workpackage` take the new fields.

### Changed

- `log_progress` reaching 100 on a work package with a verification method records the verifier like a status change to done.

### Migration

- `0006_r4_acceptance.sql`, additive only; the previous Worker version keeps running on it, but until the new Worker is deployed it can set work packages done without a verifier. Run `npm run db:migrate:remote`, then deploy straight away.
- PDF reports: no setup step, the binding is part of the generated `wrangler.jsonc`. On the Workers Free plan Browser Rendering allows 10 minutes a day and one PDF every 10 seconds (503 with `Retry-After` beyond that). The real PDF render is not verified yet: open one report as PDF after the first deploy. To switch PDF off, set `policy.report.pdf` to `false` and deploy.

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

- `wp_counts` on project cards and `list_projects` now has `open` (todo only), `in_progress`, `waiting_blocked`, `done` (the old `started` alias is removed). Code that read `open` as "not done" must change.
- Closed (`done`/`abandoned`) projects refuse new open work packages (409 `PROJECT_CLOSED`); reopen the project first.
- `npm run setup:check` fails until `policy.admins` is set.

### Migration

- `0003_r1_people_status_trash.sql`, additive only (new tables and columns); the previous Worker version keeps running on it. Run `npm run db:migrate:remote`, then deploy.
- Maintainers: add `policy.admins` (an allowed email) to `instance/instance.config.json`, or rerun `npm run setup`. The admin role is given at a person's first sign-in only; for people who already signed in, an admin changes the role in the People view.
- Known limitation: a purged person's name disappears from older history.
