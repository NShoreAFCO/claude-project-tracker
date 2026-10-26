// Forms for every entity (SPEC §9). Each successful write dispatches "tracker:changed" so open views reload.
import { t } from "./i18n.js";
import { api } from "./api.js";
import { h, formDialog, saveWithConflict, toast, confirmDialog, toastError, deleteText } from "./dom.js";
import { PROJECT_CATEGORIES, WP_CATEGORIES, catLabel } from "./categories.js";
import { closureDialog } from "./closure.js";
import { guardedWrite } from "./gates-ui.js";

export const changed = (project_id) => window.dispatchEvent(new CustomEvent("tracker:changed", { detail: { project_id } }));

const opts = (prefix, values) => values.map((v) => [v, t(`${prefix}.${v}`)]);
const PROJECT_STATUS = ["idea", "active", "on_hold", "done", "abandoned"];
const ORIGINS = ["manual", "claude-web", "claude-code", "mixed"];
const WP_STATUS = ["todo", "doing", "blocked", "waiting", "done", "dropped"];
const BRANCH_STATUS = ["open", "merged", "closed", "abandoned", "stale"];
const BRANCH_KINDS = ["branch", "fork", "worktree"];
const CRITERIA = ["value", "quality", "risk", "effort", "token_efficiency"];

const tagsIn = (s) =>
  s
    ? s
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
    : [];
/** Flatten the WP tree to [[id, "— title"]] options, indented by depth. */
export function wpOptions(tree, excludeId, depth = 0, out = []) {
  for (const w of tree || []) {
    if (w.id === excludeId) continue; // also skips its subtree (no cycles)
    out.push([w.id, `${"— ".repeat(depth)}${w.title}`]);
    wpOptions(w.children, excludeId, depth + 1, out);
  }
  return out;
}
const conflictSummary = (cur) => h("p", `${cur.title ?? ""} · v${cur.version}`);

const CLOSED = ["done", "abandoned"];
const OPEN_WP_STATUS = ["todo", "doing", "blocked", "waiting"];
/** Flat list of all WPs in a tree. */
export function flatWps(tree, out = []) {
  for (const w of tree || []) {
    out.push(w);
    flatWps(w.children, out);
  }
  return out;
}
/** WPs that keep a project from being closed as done (todo, doing, blocked, waiting). */
export const openWps = (tree) => flatWps(tree).filter((w) => OPEN_WP_STATUS.includes(w.status));

/** The logged-in person (for defaults and role checks); null when unknown. */
let mePromise;
export const getMe = () =>
  (mePromise ||= api
    .whoami()
    .then((w) => w.person || null)
    .catch(() => null));
/** [[id, "Name (Company)"]] of all live persons, for pickers. */
export async function personOptions() {
  return (await api.persons()).map((p) => [p.id, p.company ? `${p.name} (${p.company})` : p.name]);
}

/** Create (existing = null) or edit a project. `workpackages` (tree) lets the status dropdown refuse Done while WPs are open. */
export async function projectForm(existing, { workpackages = [] } = {}) {
  const p = existing || {};
  let persons = [];
  let me = null;
  try {
    [persons, me] = await Promise.all([personOptions(), getMe()]);
  } catch (e) {
    toastError(e);
  }
  const open = existing ? openWps(workpackages) : [];
  const doneBlocked = open.length > 0 && existing.status !== "done";
  const doneTip = doneBlocked ? t("doneBlockedByOpen", { list: open.map((w) => w.title).join(", ") }) : "";
  const statusOptions = (existing ? PROJECT_STATUS : PROJECT_STATUS.filter((s) => !CLOSED.includes(s))).map((s) => [
    s,
    t(`status.${s}`),
    s === "done" && doneBlocked ? { disabled: true, title: doneTip } : undefined,
  ]);
  return formDialog({
    title: existing ? t("formProjectEdit") : t("formProjectNew"),
    narrow: false,
    fields: [
      { name: "title", label: t("fTitle"), required: true, value: p.title },
      ...(existing ? [] : [{ name: "id", label: t("fId"), value: "" }]),
      {
        name: "status",
        label: t("fStatus"),
        type: "select",
        options: statusOptions,
        value: p.status || "active",
        title: doneTip || undefined,
        hint: doneBlocked ? doneTip : undefined,
      },
      {
        name: "owner",
        label: t("fOwner"),
        type: "person",
        options: persons,
        value: existing ? p.owner : me ? { person_id: me.id } : null,
        noneLabel: t("noOwner"),
      },
      { name: "sponsor", label: t("fSponsor"), type: "person", options: persons, value: p.sponsor, noneLabel: t("noOwner") },
      {
        name: "decision_maker",
        label: t("fDecisionMaker"),
        type: "person",
        options: persons,
        value: p.decision_maker,
        noneLabel: t("noOwner"),
      },
      { name: "origin", label: t("fOrigin"), type: "select", options: opts("origin", ORIGINS), value: p.origin || "manual" },
      {
        name: "category",
        label: t("fCategory"),
        type: "select",
        options: [["", t("noCategory")], ...PROJECT_CATEGORIES.map((k) => [k, catLabel("p", k)])],
        value: p.category ?? "",
      },
      { name: "summary", label: t("fSummary"), value: p.summary, full: true },
      { name: "description_md", label: t("fDescription"), type: "textarea", value: p.description_md },
      { name: "repo_url", label: t("fRepoUrl"), type: "url", value: p.repo_url },
      { name: "local_path", label: t("fLocalPath"), value: p.local_path },
      { name: "context_file", label: t("fContextFile"), value: p.context_file },
      { name: "session_id", label: t("fSessionId"), value: p.session_id },
      { name: "start_date", label: t("fStart"), type: "date", value: p.start_date },
      { name: "target_date", label: t("fTarget"), type: "date", value: p.target_date },
      {
        name: "progress_mode",
        label: t("fProgressMode"),
        type: "select",
        options: [
          ["derived", t("fProgressDerived")],
          ["manual", t("fProgressManual")],
        ],
        value: p.progress_mode || "derived",
      },
      {
        name: "progress_manual",
        label: t("fProgressManualValue"),
        type: "number",
        min: 0,
        max: 100,
        step: 1,
        value: p.progress_manual,
        showWhen: { field: "progress_mode", values: ["manual"] },
      },
      {
        name: "progress_manual_reason",
        label: t("fProgressReason"),
        value: p.progress_manual_reason,
        full: true,
        hint: t("fProgressReasonHint"),
        showWhen: { field: "progress_mode", values: ["manual"] },
      },
      { name: "tags", label: t("fTags"), value: (p.tags || []).join(", "), full: true },
    ],
    onSubmit: async (v) => {
      const body = { ...v, tags: tagsIn(v.tags) };
      if (!existing) {
        if (!body.id) delete body.id;
        // an omitted owner defaults to the calling person on the server; null would clear it
        for (const k of ["owner", "sponsor", "decision_maker"]) if (body[k] === null) delete body[k];
        const created = await api.createProject(body);
        toast(t("saved"));
        changed(created.id);
        return created;
      }
      // closing needs the closure record (and possibly moving open WPs): the closure dialog does the save
      if (CLOSED.includes(body.status) && existing.status !== body.status) {
        const { status, ...patch } = body;
        const done = await closureDialog({ project: existing, workpackages, outcome: status, patch });
        return done || undefined;
      }
      const res = await saveWithConflict((ver) => api.updateProject(existing.id, body, ver), existing.version, conflictSummary);
      if (res?.cancelled) return undefined;
      if (!res?.reload) toast(t("saved"));
      changed(existing.id);
      return res;
    },
  });
}

/** Create or edit a work package. tree = WP tree of the project (for parent / depends_on choices), milestones for blocked_by references. */
export async function wpForm(projectId, existing, tree, parentId = null, milestones = []) {
  const w = existing || {};
  let persons = [];
  try {
    persons = await personOptions();
  } catch (e) {
    toastError(e);
  }
  const parents = [["", t("fNoParent")], ...wpOptions(tree, existing?.id)];
  const deps = (w.depends_on && (Array.isArray(w.depends_on) ? w.depends_on : safeJson(w.depends_on))) || [];
  return formDialog({
    title: existing ? t("formWpEdit") : t("formWpNew"),
    narrow: false,
    fields: [
      { name: "title", label: t("fTitle"), required: true, value: w.title },
      { name: "status", label: t("fStatus"), type: "select", options: opts("status", WP_STATUS), value: w.status || "todo" },
      { name: "parent_id", label: t("fParent"), type: "select", options: parents, value: w.parent_id ?? parentId ?? "" },
      {
        name: "category",
        label: t("fCategory"),
        type: "select",
        // empty = inherit from the main WP (or "no category" for a main WP)
        options: [["", `${t("noCategory")} / ${t("inheritCategory")}`], ...WP_CATEGORIES.map((k) => [k, catLabel("w", k)])],
        value: w.category ?? "",
      },
      {
        name: "human",
        label: t("fHuman"),
        type: "select",
        options: [
          ["", t("humanDefault")],
          ["1", t("humanYes")],
          ["0", t("humanNo")],
        ],
        value: w.human === 1 ? "1" : w.human === 0 ? "0" : "",
      },
      {
        name: "owner",
        label: t("fOwner"),
        type: "person",
        options: persons,
        value: w.owner,
        noneLabel: t("inheritOwner"),
      },
      {
        name: "priority_stakeholders",
        label: t("fStakeholders"),
        type: "checklist",
        options: persons,
        value: (w.priority_stakeholders || []).map((x) => x.person_id),
      },
      {
        name: "blocked_by",
        label: t("fBlockedBy"),
        type: "blockedby",
        value: w.blocked_by,
        wps: wpOptions(tree, existing?.id),
        milestones: (milestones || []).map((m) => [m.id, m.title]),
      },
      {
        name: "waiting_reason",
        label: t("fWaitingReason"),
        value: w.waiting_reason,
        full: true,
        showWhen: { field: "status", values: ["waiting"] },
      },
      {
        name: "drop_reason",
        label: t("fDropReason"),
        required: true,
        value: w.drop_reason,
        full: true,
        showWhen: { field: "status", values: ["dropped"] },
      },
      { name: "progress", label: t("fProgress"), type: "range", min: 0, max: 100, step: 5, value: w.progress ?? 0 },
      { name: "weight", label: t("fWeight"), type: "number", min: 0, step: 0.5, value: w.weight ?? 1 },
      { name: "effort_planned_pd", label: t("fEffortPlanned"), type: "number", min: 0, step: 0.5, value: w.effort_planned_pd },
      { name: "effort_actual_pd", label: t("fEffortActual"), type: "number", min: 0, step: 0.5, value: w.effort_actual_pd },
      { name: "start_date", label: t("fStart"), type: "date", value: w.start_date },
      { name: "end_date", label: t("fEnd"), type: "date", value: w.end_date },
      { name: "sort", label: t("fSort"), type: "number", step: 1, value: w.sort ?? 0 },
      { name: "depends_on", label: t("fDependsOn"), type: "checklist", options: wpOptions(tree, existing?.id), value: deps },
      { name: "description_md", label: t("fDescription"), type: "textarea", value: w.description_md },
    ],
    onSubmit: async (v) => {
      const body = {
        ...v,
        project_id: projectId,
        depends_on: v.depends_on || [],
        parent_id: v.parent_id || null,
        human: v.human === "1" ? true : v.human === "0" ? false : null,
      };
      if (!existing) {
        const created = await api.createWp(body);
        toast(t("saved"));
        changed(projectId);
        return created;
      }
      const res = await guardedWrite(
        existing,
        () => saveWithConflict((ver) => api.updateWp(existing.id, body, ver), existing.version, conflictSummary),
        projectId,
      );
      if (res?.cancelled) return undefined;
      if (!res?.reload) toast(t("saved"));
      changed(projectId);
      return res;
    },
  });
}

/** Create (existing = null) or edit a milestone. tree = WP tree of the project. */
export function milestoneForm(projectId, existing, tree) {
  const m = existing || {};
  const all = wpOptions(tree);
  const mains = (tree || []).map((w) => [w.id, w.title]);
  return formDialog({
    title: t(existing ? "milestone" : "addMilestone"),
    narrow: false,
    fields: [
      { name: "title", label: t("fTitle"), required: true, value: m.title },
      { name: "due_date", label: t("due"), type: "date", value: m.due_date },
      { name: "workpackage_id", label: t("fOwnerWp"), type: "select", options: [["", t("none")], ...mains], value: m.workpackage_id ?? "" },
      { name: "sort", label: t("fSort"), type: "number", step: 1, value: m.sort ?? 0 },
      { name: "gate", label: t("fGate"), type: "checkbox", value: !!m.gate },
      { name: "requires", label: t("requires"), type: "checklist", options: all, value: m.requires },
      { name: "unlocks", label: t("unlocks"), type: "checklist", options: all, value: m.unlocks },
      { name: "description_md", label: t("fDescription"), type: "textarea", rows: 4, value: m.description_md },
    ],
    onSubmit: async (v) => {
      const body = { ...v, project_id: projectId };
      if (!existing) {
        const created = await api.createMilestone(body);
        toast(t("saved"));
        changed(projectId);
        return created;
      }
      const res = await saveWithConflict((ver) => api.updateMilestone(existing.id, body, ver), existing.version, conflictSummary);
      if (res?.cancelled) return undefined;
      if (!res?.reload) toast(t("saved"));
      changed(projectId);
      return res;
    },
  });
}

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return [];
  }
}

/** Inline progress slider save (leaf WPs). Conflict → dialog. */
export async function saveWpProgress(projectId, wp, progress) {
  try {
    const res = await guardedWrite(
      wp,
      () => saveWithConflict((ver) => api.updateWp(wp.id, { project_id: projectId, progress }, ver), wp.version, conflictSummary),
      projectId,
    );
    if (!res?.cancelled && !res?.reload) toast(t("progressSaved"));
  } catch (e) {
    toastError(e);
  }
  changed(projectId);
}

/** "Adjust progress" of a leaf work package: the slider is read-only in the row, changes go through this dialog. */
export function adjustProgressDialog(projectId, wp) {
  return formDialog({
    title: t("adjustProgressTitle", { name: wp.title }),
    narrow: true,
    intro: h("p.meta", t("adjustProgressHint")),
    fields: [{ name: "progress", label: t("fProgress"), type: "range", min: 0, max: 100, step: 5, value: wp.progress ?? 0 }],
    onSubmit: async (v) => {
      const res = await guardedWrite(
        wp,
        () =>
          saveWithConflict((ver) => api.updateWp(wp.id, { project_id: projectId, progress: v.progress }, ver), wp.version, conflictSummary),
        projectId,
      );
      if (res?.cancelled) return undefined;
      if (!res?.reload) toast(t("progressSaved"));
      changed(projectId);
      return res || { ok: true };
    },
  });
}

/** Project-level progress: derived from the work packages, or set by hand with a reason (spec F7). */
export function adjustProjectProgressForm(project) {
  return formDialog({
    title: t("adjustProgressTitle", { name: project.title }),
    narrow: true,
    intro: h("p.meta", t("adjustProjectProgressHint")),
    fields: [
      {
        name: "progress_mode",
        label: t("fProgressMode"),
        type: "select",
        options: [
          ["derived", t("fProgressDerived")],
          ["manual", t("fProgressManual")],
        ],
        value: project.progress_mode || "derived",
      },
      {
        name: "progress_manual",
        label: t("fProgressManualValue"),
        type: "number",
        min: 0,
        max: 100,
        step: 1,
        value: project.progress_manual,
        showWhen: { field: "progress_mode", values: ["manual"] },
      },
      {
        name: "progress_manual_reason",
        label: t("fProgressReason"),
        value: project.progress_manual_reason,
        full: true,
        required: true,
        hint: t("fProgressReasonHint"),
        showWhen: { field: "progress_mode", values: ["manual"] },
      },
    ],
    onSubmit: async (v) => {
      const res = await saveWithConflict((ver) => api.updateProject(project.id, v, ver), project.version, conflictSummary);
      if (res?.cancelled) return undefined;
      if (!res?.reload) toast(t("saved"));
      changed(project.id);
      return res || { ok: true };
    },
  });
}

/**
 * "Mark complete" for a work package at 100 %: sets Done. With a verification other than none it asks who verified
 * (default: you); the server records verified_by. Full verification handling follows with R4.4.
 */
export async function markCompleteDialog(projectId, wp) {
  const needsVerifier = wp.verification && wp.verification !== "none";
  let persons = [];
  let me = null;
  if (needsVerifier) {
    try {
      [persons, me] = await Promise.all([personOptions(), getMe()]);
    } catch (e) {
      toastError(e);
    }
  }
  return formDialog({
    title: t("markCompleteTitle", { name: wp.title }),
    narrow: true,
    submitLabel: t("markComplete"),
    intro: h("p.meta", needsVerifier ? t("markCompleteVerify", { how: t(`verification.${wp.verification}`) }) : t("markCompleteHint")),
    fields: needsVerifier
      ? [
          {
            name: "verified_by",
            label: t("fVerifiedBy"),
            type: "select",
            required: true,
            options: persons,
            value: me?.id ?? wp.verified_by ?? "",
          },
        ]
      : [],
    onSubmit: async (v) => {
      const body = { project_id: projectId, status: "done", progress: 100, ...(needsVerifier ? { verified_by: v.verified_by } : {}) };
      const res = await guardedWrite(
        wp,
        () => saveWithConflict((ver) => api.updateWp(wp.id, body, ver), wp.version, conflictSummary),
        projectId,
      );
      if (res?.cancelled) return undefined;
      if (!res?.reload) toast(t("saved"));
      changed(projectId);
      return res || { ok: true };
    },
  });
}

/** Link (upsert by repo + name) a branch, fork or worktree. */
export function branchForm(projectId, existing, tree) {
  const b = existing || {};
  return formDialog({
    title: t("formBranch"),
    narrow: false,
    fields: [
      { name: "repo", label: t("fRepo"), required: true, value: b.repo },
      { name: "name", label: t("fName"), required: true, value: b.name },
      { name: "kind", label: t("fKind"), type: "select", options: opts("kind", BRANCH_KINDS), value: b.kind || "branch" },
      { name: "status", label: t("fStatus"), type: "select", options: opts("status", BRANCH_STATUS), value: b.status || "open" },
      { name: "base", label: t("fBase"), value: b.base },
      {
        name: "workpackage_id",
        label: t("fWorkpackage"),
        type: "select",
        options: [["", t("fNoParent")], ...wpOptions(tree)],
        value: b.workpackage_id ?? "",
      },
      { name: "pr_number", label: t("fPrNumber"), type: "number", min: 1, step: 1, value: b.pr_number },
      { name: "pr_url", label: t("fPrUrl"), type: "url", value: b.pr_url },
      { name: "note", label: t("fNote"), value: b.note, full: true },
    ],
    onSubmit: async (v) => {
      const body = { ...v, project_id: projectId, workpackage_id: v.workpackage_id || null };
      for (const k of ["pr_number", "pr_url", "base", "note"]) if (body[k] === null) delete body[k];
      const res = await api.linkBranch(body);
      toast(t("saved"));
      changed(projectId);
      return res;
    },
  });
}

/** Append a full scorecard (all default criteria, 0–10). The risk score is derived while open risks exist. */
export function scoresForm(projectId, current) {
  const cur = Object.fromEntries((current || []).map((s) => [s.criterion, s]));
  const derived = (c) => !!cur[c]?.derived;
  return formDialog({
    title: t("formScores"),
    intro: h("p.meta", t("scoreScaleHelp")),
    fields: CRITERIA.flatMap((c) => [
      {
        name: c,
        label: t(`criteria.${c}`),
        type: "number",
        min: 0,
        max: 10,
        step: 0.5,
        value: cur[c]?.value,
        disabled: derived(c),
        hint: derived(c) ? t("scoreDerivedHint") : t(`scoreScale.${c}`),
      },
      { name: `${c}__note`, label: `${t(`criteria.${c}`)} – ${t("fNote")}`, value: derived(c) ? null : cur[c]?.note, disabled: derived(c) },
    ]),
    onSubmit: async (v) => {
      const scores = CRITERIA.filter((c) => !derived(c) && v[c] !== null).map((c) => ({
        criterion: c,
        value: v[c],
        note: v[`${c}__note`],
      }));
      if (!scores.length) return null;
      const res = await api.setScores(projectId, scores);
      toast(t("saved"));
      changed(projectId);
      return res;
    },
  });
}

export function tokenCostForm(projectId, tree) {
  return formDialog({
    title: t("formTokenCost"),
    fields: [
      { name: "claude_tokens", label: t("fClaudeTokens"), type: "number", min: 0, step: 1000 },
      { name: "copilot_prompts", label: t("fCopilotPrompts"), type: "number", min: 0, step: 1 },
      { name: "workpackage_id", label: t("fWorkpackage"), type: "select", options: [["", t("fNoParent")], ...wpOptions(tree)] },
      { name: "note", label: t("fNote"), full: true },
    ],
    onSubmit: async (v) => {
      const res = await api.logTokenCost({ ...v, project_id: projectId, workpackage_id: v.workpackage_id || null });
      toast(t("saved"));
      changed(projectId);
      return res;
    },
  });
}

export function logProgressForm(projectId, tree) {
  return formDialog({
    title: t("formLogProgress"),
    fields: [
      { name: "summary", label: t("fSummaryText"), type: "textarea", required: true, rows: 5 },
      { name: "workpackage_id", label: t("fWorkpackage"), type: "select", options: [["", t("fNoParent")], ...wpOptions(tree)] },
      { name: "progress", label: `${t("fProgress")} (${t("fWorkpackage")})`, type: "number", min: 0, max: 100, step: 5 },
    ],
    onSubmit: async (v) => {
      const wp = flatWps(tree).find((w) => w.id === v.workpackage_id) || { id: v.workpackage_id, title: v.workpackage_id };
      const res = await guardedWrite(
        wp,
        () => api.logProgress({ ...v, project_id: projectId, workpackage_id: v.workpackage_id || null }),
        projectId,
      );
      if (res?.cancelled) return undefined;
      toast(t("saved"));
      changed(projectId);
      return res;
    },
  });
}

const DELETE_CALL = {
  project: (id) => api.deleteProject(id),
  workpackage: (id) => api.deleteWp(id),
  milestone: (id) => api.deleteMilestone(id),
  branch: (id) => api.deleteBranch(id),
  context_doc: (id) => api.contextDelete(id),
  person: (id) => api.deletePerson(id),
  risk: (id) => api.deleteRisk(id),
};

/**
 * Ask what the delete would take along, confirm naming the children, then delete.
 * kind: project | workpackage | milestone | branch | context_doc | person | risk. Everything but a branch moves to the trash.
 */
export async function deleteEntity(kind, id, name, projectId) {
  let children = null;
  if (kind !== "branch") {
    try {
      children = (await api.deletePreview(kind, id)).children;
    } catch {
      children = null; // the delete itself reports a missing item
    }
  }
  const text = kind === "branch" ? t("confirmDelete", { name }) : deleteText(kind, name, children);
  if (!(await confirmDialog(text, { okLabel: t("delete"), danger: true }))) return false;
  try {
    await DELETE_CALL[kind](id);
    toast(kind === "branch" ? t("deleted") : t("movedToTrash"));
    changed(projectId);
    return true;
  } catch (e) {
    toastError(e);
    return false;
  }
}
