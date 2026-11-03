# Structuring a tracked project

## Purpose

This guide defines how AI agents and humans should structure a project in the tracker.
It provides a consistent hierarchy for work packages, tasks, milestones, gates, schedules, and handoffs.
Use the smallest structure that clearly describes the work.
Do not create extra work packages merely to make the hierarchy look complete.

## Standard project hierarchy

Every project contains the following top-level work packages:

- WP1: Project management
- WP2: Research
- WP3 to WP5: Content work packages, using only as many as the project needs

WP1 and WP2 always exist.
They are always unlocked.
No gate may be placed in front of WP1 or WP2.

WP1 contains the work needed to direct and control the project.
Typical subjects include planning, goals, reporting, communication, controlling, and administration.
These subjects may be represented by sub-WPs when the project needs that detail.

WP2 contains research and evidence-gathering work.
Typical subjects include literature, requirements discovery, technical investigation, and validation.
Research may continue while gated content work is waiting.

Most projects need two or three content work packages.
Use WP3 and WP4 when two content areas are sufficient.
Add WP5 only when the project has a distinct third content area.
Do not create unused placeholder content work packages.

Each content WP has this internal order:

1. `x.1` Planning
2. `x.2` Review
3. `x.3`, `x.4`, and later sub-WPs for project-specific objectives

For example, WP3 may contain:

- WP3.1 Planning
- WP3.2 Review
- WP3.3 First objective
- WP3.4 Second objective

Planning defines the intended work, dependencies, evidence, and completion conditions.
Review collects the checks needed for that content area.
Objective sub-WPs contain the work that produces the project result.
Add only the objective sub-WPs that are necessary.

## Codes and parent levels

Always fill the `code` field when creating or updating a work package or task.
The maximum length of `code` is 12 characters.

Use these code forms:

- Top-level work package: `WP1`, `WP2`, `WP3`
- Sub-WP: `WP3.1`, `WP3.2`, `WP3.3`
- Task: `T01`, `T02`, `T03`

Keep the hierarchy represented by `parent_id` consistent with `code`.

A top-level code such as `WP3` has no work-package parent.
A sub-WP code such as `WP3.2` has the corresponding top-level WP as its `parent_id`.
A task code has the sub-WP that contains it as its `parent_id`.

Do not place `WP3.2` under WP4.
Do not place a task directly under a top-level content WP.
Do not encode a hierarchy in `code` that differs from the hierarchy represented by `parent_id`.

Tasks are numbered continuously across the whole project.
Start with `T01` and continue through `T02`, `T03`, and so on.
Do not restart task numbering for a new work package.
Do not use separate task sequences for different content areas.

A task always sits under a sub-WP.
Several tasks may share the same sub-WP.
Use an additional sub-WP only when it represents a meaningful planning, review, or objective grouping.

## Creating the project structure

Create the complete content structure when the project is created.
This includes:

- The required WP1 and WP2
- Every content WP currently expected
- Planning and Review sub-WPs for each content WP
- Known objective sub-WPs
- Known tasks
- Milestones
- Gates
- Gate relationships

Use `create_project` for the project.
Use `upsert_workpackage` for work packages, sub-WPs, and tasks.
Use `upsert_milestone` for milestones and gates.

Do not postpone creation of the content WPs, milestones, or gates until execution reaches them.
Creating the planned structure together makes dependencies and locks visible from the beginning.
The structure may still be updated when the project scope genuinely changes.

## Gates

A gate is a milestone with `gate=true`.
Its `requires` field lists the WPs that must be completed before the gate is reached.
Its `unlocks` field lists the WPs controlled by the gate.

A gate remains closed until both conditions are satisfied:

1. Every WP in `requires` is done.
2. A person records a go decision.

Use `record_gate_decision` only to record the person's decision.
An agent may prepare evidence and report readiness, but the decision belongs to a person.

A decision recorded before every required WP is done does not by itself open the gate.
The gate stays closed until all WPs in `requires` are done.
A reached gate without a go decision also remains closed.

A WP listed in `unlocks` is behind that gate.
A WP behind a closed gate cannot be started.
Do not work around a gate by moving, duplicating, or renumbering the locked WP.

WP1 and WP2 must not appear in a gate's `unlocks`.
They remain available throughout the project.

A gate should unlock the smallest useful set of WPs.
List every controlled WP explicitly in `unlocks`.
Place dependencies between WPs in `depends_on`; do not treat a gate as a replacement for ordinary dependencies.

## Milestones

A milestone represents a checkable project result or point in time.
Its `requires` field lists the WPs that must be done for the milestone to be reached.
A normal milestone does not use `gate=true` and does not unlock work.

Give each milestone a due date that is on or after the end of every WP in `requires`.
Create milestones together with the initial project structure.
Use milestone titles that identify an observable result.

## Dependencies and dates

Use `depends_on` to record predecessor WPs.
Values in `depends_on` refer to WPs in the same project.

When an AI assigns dates, every dependent WP starts after all WPs in its `depends_on` have ended.
A WP unlocked by a gate starts after the gate due date.
If both rules apply, use the later permitted start date.

These scheduling rules apply unless the user expressly overrides them.
An express override may intentionally create a scheduling conflict.
Record or report the override so that the conflict is visible.

Write results may carry schedule warnings.
Warnings can identify a WP starting before a predecessor ends, a WP starting before its unlocking gate is due, or a milestone due before a required WP ends.
Fix each warning when possible.
If the requested plan intentionally keeps the conflict, report the warning to the user.
Do not silently ignore schedule warnings.

After structural or scheduling changes, use `get_context_bundle` when current project context is needed.
Use `log_progress` for substantive progress.
Use `append_context` to preserve relevant session information.

## Project handoff

Keep exactly one `HANDOFF.md` in each project folder.
The agent keeps this file current as the project changes.
The session hook syncs `HANDOFF.md` to the project as a pinned document.

`HANDOFF.md` should contain:

- Done: completed work and confirmed results
- Open points: unresolved questions, blockers, decisions, and risks
- Next step: the next concrete action and any prerequisite for starting it

Keep the handoff concise enough to read at the start of a session.
Update it after substantive progress, a changed decision, a new blocker, or a changed next step.
Do not use multiple competing handoff files for one project.
The handoff complements the tracked structure; it does not replace statuses, dependencies, milestones, or gates.

## Worked example: a small command-line tool

The following example uses one content WP because the project has one content area.
WP1 and WP2 remain always unlocked.
All tasks are placed under sub-WPs and use one continuous sequence.

| Code | Title | Start | End | `depends_on` | Status |
|---|---|---|---|---|---|
| WP1 | Project management | 2026-02-02 | 2026-02-20 | — | doing |
| WP1.1 | Project coordination | 2026-02-02 | 2026-02-20 | — | doing |
| T01 | Maintain plan and handoff | 2026-02-02 | 2026-02-20 | — | doing |
| WP2 | Research | 2026-02-02 | 2026-02-05 | — | done |
| WP2.1 | Requirements research | 2026-02-02 | 2026-02-05 | — | done |
| T02 | Confirm command and output requirements | 2026-02-02 | 2026-02-03 | — | done |
| T03 | Evaluate packaging options | 2026-02-04 | 2026-02-05 | T02 | done |
| WP3 | Command-line tool | 2026-02-02 | 2026-02-18 | — | doing |
| WP3.1 | Planning | 2026-02-02 | 2026-02-06 | — | done |
| T04 | Define interfaces and acceptance checks | 2026-02-02 | 2026-02-06 | — | done |
| G1 | Go for implementation | 2026-02-09 | 2026-02-09 | WP2, WP3.1 | open |
| WP3.3 | Core implementation | 2026-02-10 | 2026-02-13 | WP3.1 | todo |
| T05 | Implement command processing | 2026-02-10 | 2026-02-13 | WP3.1 | todo |
| WP3.4 | Packaging | 2026-02-16 | 2026-02-17 | WP3.3 | todo |
| T06 | Build and verify the package | 2026-02-16 | 2026-02-17 | WP3.3 | todo |
| WP3.2 | Review | 2026-02-18 | 2026-02-18 | WP3.3, WP3.4 | todo |
| M1 | First release | 2026-02-18 | 2026-02-18 | WP3.4 | open |

G1 has `gate=true`.
G1 has `requires` set to WP2 and WP3.1.
G1 has `unlocks` set to WP3.3 and WP3.4.
M1 has `requires` set to WP3.4.

The dependency logic is checkable as follows:

- T03 starts on 2026-02-04, after T02 ends on 2026-02-03.
- G1 is due on 2026-02-09, after WP2 ends on 2026-02-05 and WP3.1 ends on 2026-02-06.
- WP3.3 starts on 2026-02-10, after WP3.1 ends and after the G1 due date.
- WP3.4 starts on 2026-02-16, after WP3.3 ends on 2026-02-13 and after the G1 due date.
- WP3.2 starts on 2026-02-18, after WP3.3 and WP3.4 have ended.
- M1 is due on 2026-02-18, after WP3.4 ends on 2026-02-17.
- WP1 and WP2 have no unlocking gate and can be worked on throughout their planned dates.
- WP3.3 and WP3.4 still cannot start unless G1 has reached its requirements and a person has recorded a go decision.

## Agent checklist

Before finishing project creation, verify that:

- [ ] WP1 Project management exists and is unlocked.
- [ ] WP2 Research exists and is unlocked.
- [ ] Only the necessary content WPs from WP3 to WP5 exist.
- [ ] Every content WP has Planning and Review sub-WPs.
- [ ] Objective sub-WPs describe the actual project outcomes.
- [ ] Every work package and task has a valid `code` of at most 12 characters.
- [ ] Every `parent_id` matches the level implied by `code`.
- [ ] Tasks use one continuous `T01` to `Tnn` sequence.
- [ ] Every task is under a sub-WP.
- [ ] Content WPs, milestones, and gates were created together with the project.
- [ ] Every gate has correct `requires`, `unlocks`, and `gate=true`.
- [ ] No gate unlocks WP1 or WP2.
- [ ] Dates respect `depends_on` and gate due dates unless expressly overridden.
- [ ] Schedule warnings were fixed or reported.
- [ ] One current `HANDOFF.md` records done work, open points, and the next step.
