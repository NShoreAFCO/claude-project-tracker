// Forms for every entity (SPEC §9). Each successful write dispatches "tracker:changed" so open views reload.
import { t } from "./i18n.js";
import { api } from "./api.js";
import { h, formDialog, saveWithConflict, toast, confirmDialog, toastError } from "./dom.js";
import { PROJECT_CATEGORIES, WP_CATEGORIES, catLabel } from "./categories.js";

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

/** Create (existing = null) or edit a project. */
export function projectForm(existing) {
  const p = existing || {};
  return formDialog({
    title: existing ? t("formProjectEdit") : t("formProjectNew"),
    narrow: false,
    fields: [
      { name: "title", label: t("fTitle"), required: true, value: p.title },
      ...(existing ? [] : [{ name: "id", label: t("fId"), value: "" }]),
      { name: "status", label: t("fStatus"), type: "select", options: opts("status", PROJECT_STATUS), value: p.status || "active" },
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
      { name: "progress_manual", label: t("fProgressManualValue"), type: "number", min: 0, max: 100, step: 1, value: p.progress_manual },
      { name: "tags", label: t("fTags"), value: (p.tags || []).join(", "), full: true },
    ],
    onSubmit: async (v) => {
      const body = { ...v, tags: tagsIn(v.tags) };
      if (!existing) {
        if (!body.id) delete body.id;
        const created = await api.createProject(body);
        toast(t("saved"));
        changed(created.id);
        return created;
      }
      const res = await saveWithConflict((ver) => api.updateProject(existing.id, body, ver), existing.version, conflictSummary);
      if (res?.cancelled) return undefined;
      if (!res?.reload) toast(t("saved"));
      changed(existing.id);
      return res;
    },
  });
}

/** Create or edit a work package. tree = WP tree of the project (for parent / depends_on choices). */
export function wpForm(projectId, existing, tree, parentId = null) {
  const w = existing || {};
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
      { name: "blocked_by", label: t("fBlockedBy"), value: w.blocked_by },
      { name: "progress", label: t("fProgress"), type: "range", min: 0, max: 100, step: 5, value: w.progress ?? 0 },
      { name: "weight", label: t("fWeight"), type: "number", min: 0, step: 0.5, value: w.weight ?? 1 },
      { name: "start_date", label: t("fStart"), type: "date", value: w.start_date },
      { name: "end_date", label: t("fEnd"), type: "date", value: w.end_date },
      { name: "sort", label: t("fSort"), type: "number", step: 1, value: w.sort ?? 0 },
      { name: "depends_on", label: `${t("fDependsOn")} (ID, Komma)`, value: deps.join(", ") },
      { name: "description_md", label: t("fDescription"), type: "textarea", value: w.description_md },
    ],
    onSubmit: async (v) => {
      const body = {
        ...v,
        project_id: projectId,
        depends_on: tagsIn(v.depends_on),
        parent_id: v.parent_id || null,
        human: v.human === "1" ? true : v.human === "0" ? false : null,
      };
      if (!existing) {
        const created = await api.createWp(body);
        toast(t("saved"));
        changed(projectId);
        return created;
      }
      const res = await saveWithConflict((ver) => api.updateWp(existing.id, body, ver), existing.version, conflictSummary);
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
    const res = await saveWithConflict((ver) => api.updateWp(wp.id, { project_id: projectId, progress }, ver), wp.version, conflictSummary);
    if (!res?.cancelled && !res?.reload) toast(t("progressSaved"));
  } catch (e) {
    toastError(e);
  }
  changed(projectId);
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

/** Append a full scorecard (all default criteria, 0–10). */
export function scoresForm(projectId, current) {
  const cur = Object.fromEntries((current || []).map((s) => [s.criterion, s]));
  return formDialog({
    title: t("formScores"),
    fields: CRITERIA.flatMap((c) => [
      { name: c, label: t(`criteria.${c}`), type: "number", min: 0, max: 10, step: 0.5, value: cur[c]?.value },
      { name: `${c}__note`, label: `${t(`criteria.${c}`)} – ${t("fNote")}`, value: cur[c]?.note },
    ]),
    onSubmit: async (v) => {
      const scores = CRITERIA.filter((c) => v[c] !== null).map((c) => ({ criterion: c, value: v[c], note: v[`${c}__note`] }));
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
      const res = await api.logProgress({ ...v, project_id: projectId, workpackage_id: v.workpackage_id || null });
      toast(t("saved"));
      changed(projectId);
      return res;
    },
  });
}

/** Confirm, then delete. kind: project | workpackage | branch. */
export async function deleteEntity(kind, id, name, projectId) {
  const text = kind === "project" ? t("confirmDeleteProject", { name }) : t("confirmDelete", { name });
  if (!(await confirmDialog(text, { okLabel: t("delete"), danger: true }))) return false;
  try {
    if (kind === "project") await api.deleteProject(id);
    else if (kind === "workpackage") await api.deleteWp(id);
    else if (kind === "milestone") await api.deleteMilestone(id);
    else await api.deleteBranch(id);
    toast(t("deleted"));
    changed(projectId);
    return true;
  } catch (e) {
    toastError(e);
    return false;
  }
}
