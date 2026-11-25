// Inbox: unmatched hook/webhook events with "assign to project" (SPEC §9), plus triage:
// dismiss/restore (single and bulk) and folder rules for hook events.
import { t, fmtDateTime } from "./i18n.js";
import { can } from "./access.js";
import { api } from "./api.js";
import { h, clear, toast, toastError, openModal, confirmDialog } from "./dom.js";
import { changed } from "./forms.js";

const LIST_LIMIT = 500; // the server maximum
const IDS_PER_CALL = 200; // the server maximum per dismiss/restore call
const MAX_FOLDERS = 6; // the event's folder and up to 5 parents

/** The flattened "after" fields of an event diff ({ hook: [null, { cwd, … }] } → { cwd, … }), or {}. */
function diffFields(e) {
  if (!e.diff_json) return {};
  try {
    const d = JSON.parse(e.diff_json);
    return Object.assign({}, ...Object.values(d).map((v) => (Array.isArray(v) && v[1] && typeof v[1] === "object" ? v[1] : {})));
  } catch {
    return {};
  }
}

/** Human-readable details from the event diff (repo, branch, cwd …), shown as plain text. */
function details(e) {
  if (!e.diff_json) return null;
  try {
    JSON.parse(e.diff_json);
  } catch {
    return h("div.meta.inbox-meta", e.diff_json.slice(0, 300));
  }
  const pairs = Object.entries(diffFields(e))
    .filter(([, v]) => v !== null && v !== "" && typeof v !== "object")
    .slice(0, 8)
    .map(([k, v]) => h("span", `${k}: `, h("b", String(v).slice(0, 200))));
  return pairs.length ? h("div.meta.inbox-meta", pairs) : null;
}

const slashes = (p) => String(p).replace(/\\/g, "/").replace(/\/+$/, "");

/** Working folder of a hook event (forward slashes), or null for any other event. */
export function eventCwd(e) {
  if (e.entity !== "hook") return null;
  const cwd = diffFields(e).cwd;
  return typeof cwd === "string" && cwd.trim() ? slashes(cwd.trim()) : null;
}

/** The folder and its parents, deepest first, at most MAX_FOLDERS; never a bare drive or the root. */
export function folderChoices(cwd) {
  const out = [];
  let p = slashes(cwd);
  while (p && out.length < MAX_FOLDERS) {
    if (p === "" || /^[a-z]:$/i.test(p) || p === "/" || p === "//") break;
    out.push(p);
    const i = p.lastIndexOf("/");
    if (i <= 0) break;
    p = p.slice(0, i);
  }
  return out;
}

/** Number of loaded events whose folder is `folder` or below it. */
export function countUnder(events, folder) {
  const f = folder.toLowerCase();
  return events.filter((e) => {
    const c = eventCwd(e)?.toLowerCase();
    return c && (c === f || c.startsWith(`${f}/`));
  }).length;
}

const chunk = (ids) => {
  const out = [];
  for (let i = 0; i < ids.length; i += IDS_PER_CALL) out.push(ids.slice(i, i + IDS_PER_CALL));
  return out;
};

/** Current tab from the hash query (#/inbox?state=dismissed). */
function currentState() {
  const q = (globalThis.location?.hash || "").split("?")[1] || "";
  return new URLSearchParams(q).get("state") === "dismissed" ? "dismissed" : "open";
}

function showTab(state) {
  location.hash = state === "dismissed" ? "#/inbox?state=dismissed" : "#/inbox";
}

/** The rule dialog for one hook event: folder, kind, project, "also apply to existing". */
function ruleDialog(e, events, capped, projects) {
  const folders = folderChoices(eventCwd(e));
  const uid = Math.random().toString(36).slice(2, 7);
  const m = openModal({ title: t("inboxRuleTitle"), narrow: true });
  const folderSel = h(
    "select",
    { id: `rule-folder-${uid}`, name: "folder" },
    folders.map((f) => h("option", { value: f }, f)),
  );
  const kindIgnore = h("input", { type: "radio", name: `rule-kind-${uid}`, value: "ignore", checked: true });
  const kindAssign = h("input", { type: "radio", name: `rule-kind-${uid}`, value: "assign" });
  const projectSel = h(
    "select",
    { id: `rule-project-${uid}`, name: "project", hidden: true },
    h("option", { value: "" }, t("inboxChoose")),
    projects.map((p) => h("option", { value: p.id }, p.title)),
  );
  const projectWrap = h("div.field", { hidden: true }, h("label", { for: `rule-project-${uid}` }, t("inboxRuleProject")), projectSel);
  const apply = h("input", { type: "checkbox", name: "apply", checked: true });
  const applyText = h("span");
  const err = h("div.callout.conflict", { role: "alert", hidden: true });
  const sync = () => {
    const n = countUnder(events, folderSel.value || folders[0]);
    applyText.textContent = t(capped ? "inboxRuleApplyAtLeast" : "inboxRuleApply", { n });
    projectWrap.hidden = !kindAssign.checked;
  };
  folderSel.addEventListener("change", sync);
  kindIgnore.addEventListener("change", sync);
  kindAssign.addEventListener("change", sync);
  sync();
  m.body.append(
    h("div.field", h("label", { for: `rule-folder-${uid}` }, t("inboxRuleFolder")), folderSel),
    h(
      "fieldset.rule-kind",
      h("legend", t("inboxRuleKind")),
      h("label.check", kindIgnore, t("inboxRuleIgnore")),
      h("label.check", kindAssign, t("inboxRuleAssign")),
    ),
    projectWrap,
    h("label.check", apply, applyText),
    err,
  );
  const save = h("button.btn", { type: "button" }, t("save"));
  save.addEventListener("click", async () => {
    const kind = kindAssign.checked ? "assign" : "ignore";
    if (kind === "assign" && !projectSel.value) {
      err.textContent = t("required", { field: t("inboxRuleProject") });
      err.hidden = false;
      return projectSel.focus();
    }
    save.disabled = true;
    try {
      const body = { kind, path: folderSel.value || folders[0], apply_existing: !!apply.checked };
      if (kind === "assign") body.project_id = projectSel.value;
      const res = await api.createInboxRule(body);
      toast(t(res?.more ? "inboxRuleSavedMore" : "inboxRuleSaved", { n: res?.applied ?? 0 }));
      m.close();
      changed();
    } catch (x) {
      err.textContent = x?.message || String(x);
      err.hidden = false;
      save.disabled = false;
    }
  });
  m.foot.append(h("button.btn.ghost", { type: "button", on: { click: () => m.close() } }, t("cancel")), save);
  folderSel.focus();
}

function rulesSection(rules) {
  if (!rules) return h("section.inbox-rules", h("h3", t("inboxRulesTitle")), h("p.meta", { role: "alert" }, t("inboxRulesError")));
  const rows = rules.map((r) => {
    const del = h("button.btn.small.danger", { type: "button" }, t("inboxRuleDelete"));
    del.addEventListener("click", async () => {
      if (!(await confirmDialog(t("inboxRuleDeleteConfirm", { path: r.path }), { okLabel: t("inboxRuleDelete"), danger: true }))) return;
      try {
        await api.deleteInboxRule(r.id);
        toast(t("inboxRuleDeleted"));
        changed();
      } catch (err) {
        toastError(err);
      }
    });
    return h(
      "tr",
      h("td", t(r.kind === "assign" ? "inboxRuleKindAssign" : "inboxRuleKindIgnore")),
      h("td", h("code", r.path)),
      h("td", r.kind === "assign" ? r.project_title || r.project_id || "" : ""),
      h("td.inbox-when", fmtDateTime(r.created_at)),
      h("td.inbox-act", del),
    );
  });
  return h(
    "section.inbox-rules",
    h("h3", t("inboxRulesTitle")),
    rules.length
      ? h(
          "div.table-wrap",
          h(
            "table.inbox-table",
            h("thead", h("tr", [t("inboxRuleColKind"), t("inboxRuleColFolder"), t("inboxRuleColProject"), t("inboxRuleColCreated")].map((x) => h("th", x)), h("th.inbox-act", t("colActions")))),
            h("tbody", rows),
          ),
        )
      : h("p.meta", t("inboxRulesEmpty")),
  );
}

export async function renderInbox(main, state) {
  clear(main, h("h2", t("inboxTitle")), h("p", t("loading")));
  const tab = currentState();
  const editor = can("write");
  let events;
  let openCount;
  let rules = [];
  try {
    [events, openCount, rules] = await Promise.all([
      api.inbox({ state: tab, limit: LIST_LIMIT }),
      api.inboxCount(),
      editor ? api.inboxRules().catch(() => null) : [],
    ]);
  } catch (e) {
    toastError(e);
    return;
  }
  const capped = events.length >= LIST_LIMIT;
  const selected = new Set();

  // ---- selection bar and select-all
  const all = h("input", { type: "checkbox", "aria-label": t("inboxSelectAll") });
  const bulkBtn = h("button.btn.small", { type: "button" });
  const countText = h("span.meta", { "aria-hidden": "true" });
  // Always rendered (outside the hidden bar), so the first selection is announced.
  const status = h("span.sr-only", { role: "status" });
  const bar = h("div.inbox-bar", { hidden: true }, countText, bulkBtn);
  const boxes = [];
  const syncSelection = () => {
    const n = selected.size;
    all.checked = n > 0 && n === events.length;
    all.indeterminate = n > 0 && n < events.length;
    bar.hidden = n === 0;
    countText.textContent = t("inboxSelectedCount", { n });
    status.textContent = n ? countText.textContent : "";
    bulkBtn.textContent = t(tab === "open" ? "inboxDismissSelected" : "inboxRestoreSelected", { n });
  };
  all.addEventListener("change", () => {
    selected.clear();
    if (all.checked) for (const e of events) selected.add(e.id);
    for (const b of boxes) b.checked = all.checked;
    syncSelection();
  });
  const run = async (ids, button) => {
    if (!ids.length) return;
    button.disabled = true;
    try {
      let n = 0;
      for (const part of chunk(ids)) {
        const res = await (tab === "open" ? api.dismissInbox(part) : api.restoreInbox(part));
        n += (tab === "open" ? res?.dismissed : res?.restored) ?? 0;
      }
      toast(t(tab === "open" ? "inboxDismissedDone" : "inboxRestoredDone", { n }));
      changed();
    } catch (err) {
      toastError(err);
      button.disabled = false;
    }
  };
  bulkBtn.addEventListener("click", () => run([...selected], bulkBtn));

  // ---- rows
  const rows = events.map((e) => {
    const cwd = eventCwd(e);
    let cells = null;
    if (editor) {
      const rowBtn = h("button.btn.small.secondary", { type: "button" }, t(tab === "open" ? "inboxDismiss" : "inboxRestore"));
      rowBtn.addEventListener("click", () => run([e.id], rowBtn));
      const parts = [];
      if (tab === "open") {
        const sel = h(
          "select",
          { "aria-label": t("inboxChoose") },
          h("option", { value: "" }, t("inboxChoose")),
          state.projects.map((p) => h("option", { value: p.id }, p.title)),
        );
        const btn = h("button.btn.small", { type: "button" }, t("inboxAssign"));
        btn.addEventListener("click", async () => {
          if (!sel.value) return sel.focus();
          btn.disabled = true;
          try {
            await api.assignInbox(e.id, sel.value);
            toast(t("inboxAssigned"));
            changed(sel.value);
          } catch (err) {
            toastError(err);
            btn.disabled = false;
          }
        });
        parts.push(h("div", { style: { "min-width": "160px", flex: 1 } }, sel), btn);
      } else if (e.action === "ignored") {
        parts.push(h("span.meta.inbox-ignored", t("inboxIgnoredByRule")));
      }
      parts.push(rowBtn);
      if (tab === "open" && cwd) {
        const ruleBtn = h("button.btn.small.ghost", { type: "button" }, t("inboxRuleBtn"));
        ruleBtn.addEventListener("click", () => ruleDialog(e, events, capped, state.projects));
        parts.push(ruleBtn);
      }
      cells = h("div.inbox-actions", parts);
    } else if (e.action === "ignored") {
      cells = h("span.meta.inbox-ignored", t("inboxIgnoredByRule"));
    }
    const box = editor
      ? h("input", { type: "checkbox", "aria-label": t("inboxSelectRow", { what: e.summary || e.entity }), value: String(e.id) })
      : null;
    if (box) {
      boxes.push(box);
      box.addEventListener("change", () => {
        if (box.checked) selected.add(e.id);
        else selected.delete(e.id);
        syncSelection();
      });
    }
    return h(
      "tr",
      editor ? h("td.sel", box) : null,
      h("td.inbox-when", fmtDateTime(e.ts)),
      h("td.inbox-by", e.actor),
      h("td.inbox-desc", h("strong", e.summary || `${e.entity} ${e.action}`), details(e)),
      h("td.inbox-act", cells),
    );
  });

  const tabBtn = (id, label) => {
    const b = h("button", { type: "button", role: "tab", "aria-selected": tab === id ? "true" : "false" }, label);
    b.addEventListener("click", () => tab !== id && showTab(id));
    return b;
  };
  const tabs = h(
    "div.tabs.inbox-tabs",
    { role: "tablist", "aria-label": t("inboxTabs") },
    tabBtn("open", t("inboxTabOpen", { n: openCount?.open ?? 0 })),
    tabBtn("dismissed", t("inboxTabDismissed")),
  );
  syncSelection();
  clear(
    main,
    h("h2", t("inboxTitle")),
    h("p.meta", t("inboxHint")),
    tabs,
    editor ? status : null,
    editor ? bar : null,
    capped ? h("p.meta", t("inboxCapped", { n: LIST_LIMIT })) : null,
    events.length
      ? h(
          "div.table-wrap",
          h(
            "table.inbox-table",
            h(
              "thead",
              h("tr", [editor ? h("th.sel", all) : null, ...[t("colWhen"), t("colBy"), t("description")].map((x) => h("th", x)), h("th.inbox-act", t("colActions"))]),
            ),
            h("tbody", rows),
          ),
        )
      : h("p.empty", t(tab === "open" ? "inboxEmpty" : "inboxEmptyDismissed")),
    editor ? rulesSection(rules) : null,
  );
}
