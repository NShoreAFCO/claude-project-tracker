# Changelog

## R1

### Added

- People: `person` records for users and stakeholders; every write records the human behind it (`person_id`, `on_behalf_of` for the Claude Code hook). Owner, sponsor and decision maker on projects; owner and priority stakeholders on work packages. Dashboard: People view and owner initials on cards.
- `policy` block in `instance.config.json` (admins, default role, locales, stale days, retention days, gates, report, score scales). Setup asks for the admin email(s).
- Status rules: closing a project needs a closure note (and lessons learned for `done`) and no open work packages; `dropped` needs a reason; `blocked_by` references (`wp:`, `ms:`, `ext:`) with `blocked_since`; `waiting_reason`; auto-start of `todo` work packages on first progress; `stalled_blocked` and `closure_due` flags. Dashboard: closure dialog, Blocked and Waiting chips.
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
