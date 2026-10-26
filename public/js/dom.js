// DOM helpers. Everything is built with createElement/textContent; the only HTML string ever
// assigned is the output of the sanitising markdown renderer (see markdown.js).
import { t, fmtPct } from "./i18n.js";
import { gateNames, issueText } from "./schedule-ui.js";

/** h("div.cls#id", { attrs, on: { click } }, ...children). Strings become text nodes. */
export function h(sel, attrs, ...children) {
  if (attrs === null || typeof attrs !== "object" || attrs instanceof Node || Array.isArray(attrs)) {
    if (attrs !== undefined && attrs !== null) children.unshift(attrs);
    attrs = {};
  }
  const [, tag = "div", rest = ""] = /^([a-z0-9]+)?(.*)$/i.exec(sel);
  const el = document.createElement(tag);
  for (const part of rest.match(/[.#][^.#]+/g) || []) {
    if (part[0] === ".") el.classList.add(part.slice(1));
    else el.id = part.slice(1);
  }
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "on") for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (k === "class") el.className += ` ${v}`;
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k === "style") for (const [p, val] of Object.entries(v)) el.style.setProperty(p, val);
    else if (k in el && k !== "list" && k !== "form" && typeof v !== "string") el[k] = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export const clear = (el, ...children) => {
  el.replaceChildren();
  append(el, children);
  return el;
};

export function statusChip(status, outline = false) {
  return h(`span.chip.st-${status}`, { class: outline || status === "done" ? "outline" : "" }, t(`status.${status}`));
}

const initialsOfText = (s) =>
  String(s || "")
    .trim()
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((w) => [...w][0])
    .slice(0, 2)
    .join("")
    .toUpperCase() || "?";

/** Round initials badge for a person-or-text ref ({person_id,name,initials} | {text} | null); `inherited` greys it. */
export function personBadge(ref, { inherited = false, label = "" } = {}) {
  if (!ref) return null;
  const name = ref.name || ref.text;
  const text = label ? `${label}: ${name}` : name;
  return h(
    "span.initials",
    { class: inherited ? "inherited" : "", title: text, "aria-label": text },
    ref.initials || initialsOfText(ref.text),
  );
}

/** Whole days from a YYYY-MM-DD date until today (UTC); null for no date. */
export function ageDays(ymd, today = new Date()) {
  if (!ymd) return null;
  const [y, m, d] = String(ymd).slice(0, 10).split("-").map(Number);
  return Math.max(
    0,
    Math.floor((Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) - Date.UTC(y, m - 1, d)) / 86400000),
  );
}

export function progressBar(pct, label) {
  const v = Math.max(0, Math.min(100, Number(pct) || 0));
  return h(
    "div.progress-row",
    h(
      "div.bar",
      { role: "progressbar", "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": v, "aria-label": label || t("progress") },
      h("span", { style: { width: `${v}%` } }),
    ),
    h("span.pct", fmtPct(v)),
  );
}

// ---- toast
let toastTimer;
let toastEl;
function hideToast(el) {
  try {
    el.hidePopover();
  } catch {}
  el.hidden = true;
  document.body.append(el);
}
export function toast(msg, error = false, action = null) {
  const el = (toastEl ||= document.getElementById("toast"));
  // an open modal dialog makes everything outside it inert: host the toast inside it so its action stays clickable
  const host = [...document.querySelectorAll("dialog[open]")].pop() || document.body;
  if (el.parentElement !== host) host.append(el);
  el.textContent = msg;
  if (action) el.append(" ", h("button.linkbtn", { type: "button", on: { click: () => (action.onClick(), hideToast(el)) } }, action.label));
  el.classList.toggle("error", error);
  el.hidden = false;
  // popover: the toast sits in the top layer, so it stays visible and clickable above an open dialog
  try {
    if (!el.matches(":popover-open")) el.showPopover();
  } catch {}
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => hideToast(el), action ? 12000 : error ? 6000 : 2500);
}
/**
 * Localised text for a failed call. 409s with a machine-readable `current.code` (PROJECT_CLOSED, PARENT_DELETED,
 * SLUG_TAKEN, TARGET_CLOSED, OPEN_WORKPACKAGES, GATE_LOCKED, SCHEDULE_STRICT, SCHEDULE_CONFLICT, DECISION_MAKER_LOCKED ...) use the errCode.* strings; everything else shows the API message.
 */
export function errorText(e) {
  if (e?.isAuth) return t("errorAuth");
  const cur = e?.body?.current;
  if (e?.isConflict && cur?.code) {
    const key = `errCode.${cur.code}`;
    const msg = t(key, {
      list: cur.gates
        ? gateNames(e)
        : cur.issues
          ? cur.issues.map((i) => issueText(i)).join(" ")
          : (cur.open_workpackages || []).map((w) => w.title).join(", "),
      fields: (cur.missing || []).join(", "),
      date: cur.purgeable_at ? String(cur.purgeable_at).slice(0, 10) : "",
    });
    if (msg !== key) return msg;
  }
  return t("errorGeneric", { msg: e?.message || String(e) });
}
export const toastError = (e) => toast(errorText(e), true);

/** Confirm text for a delete; `children` is the delete preview's {workpackages, milestones, context_docs}. */
export function deleteText(kind, name, children) {
  const c = children || {};
  const part = (key) => (c[key] ? t(`deleteKids.${key}${c[key] === 1 ? "_one" : ""}`, { n: c[key] }) : null);
  const parts = [part("workpackages"), part("milestones"), part("context_docs"), part("risks")].filter(Boolean);
  const kids = parts.length ? t("deleteWith", { items: parts.join(", ") }) : "";
  return t("confirmDeleteTrash", { kind: t(`entityKind.${kind}`), name, kids });
}

/** "..." row menu: items = [{ label, onClick, danger }]. Closes on outside click, Escape and after a choice. */
export function menuButton(label, items) {
  const list = h("ul.menu-list", { role: "menu", hidden: true });
  const btn = h(
    "button.btn.small.ghost.menu-btn",
    {
      type: "button",
      "aria-haspopup": "menu",
      "aria-expanded": "false",
      "aria-label": label,
      title: label,
      on: { click: () => (list.hidden ? open() : close()) },
    },
    "⋯",
  );
  const wrap = h("span.menu", btn, list);
  const onDoc = (ev) => {
    if (!wrap.contains(ev.target)) close();
  };
  const onKey = (ev) => {
    if (ev.key === "Escape" && !list.hidden) {
      ev.stopPropagation();
      close();
      btn.focus();
    }
  };
  function open() {
    list.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    document.addEventListener("click", onDoc, true);
    document.addEventListener("keydown", onKey, true);
  }
  function close() {
    list.hidden = true;
    btn.setAttribute("aria-expanded", "false");
    document.removeEventListener("click", onDoc, true);
    document.removeEventListener("keydown", onKey, true);
  }
  for (const it of items)
    list.append(
      h(
        "li",
        { role: "none" },
        h(
          `button.menu-item${it.danger ? ".danger" : ""}`,
          { type: "button", role: "menuitem", on: { click: () => (close(), it.onClick()) } },
          it.label,
        ),
      ),
    );
  return wrap;
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast(t("copied"));
  } catch {
    toast(t("copyFailed"), true);
  }
}

// ---- dialogs
/** Open a <dialog>. Returns { dialog, body, foot, head, close }. onClose runs once when it closes. */
export function openModal({ title, narrow = false, onClose, headExtra } = {}) {
  const titleId = `dlg-${Math.random().toString(36).slice(2)}`;
  const body = h("div.modal-body");
  const foot = h("div.modal-foot");
  const closeBtn = h("button.close", { type: "button", "aria-label": t("close"), on: { click: () => dialog.close() } }, "×");
  const heading = h("h2", { id: titleId }, title || "");
  const head = h("div.modal-head", heading, closeBtn, headExtra || null);
  const dialog = h("dialog", { class: narrow ? "narrow" : "", "aria-labelledby": titleId }, head, body, foot);
  dialog.addEventListener("close", () => {
    dialog.remove();
    onClose?.(dialog.returnValue);
  });
  document.body.append(dialog);
  dialog.showModal();
  return { dialog, body, foot, head, heading, close: (v) => dialog.close(v) };
}

export function confirmDialog(text, { okLabel = t("yes"), danger = false } = {}) {
  return new Promise((resolve) => {
    let result = false;
    const m = openModal({ title: t("confirmTitle"), narrow: true, onClose: () => resolve(result) });
    m.body.append(h("p", text));
    m.foot.append(
      h("button.btn.ghost", { type: "button", on: { click: () => m.close() } }, t("cancel")),
      h(`button.btn${danger ? ".danger" : ""}`, { type: "button", on: { click: () => ((result = true), m.close()) } }, okLabel),
    );
  });
}

/**
 * 409 dialog. Resolves "reload" or "overwrite" (or null on cancel). `current` is the server's record.
 * `describe(current)` may return a node shown under "Aktueller Stand".
 */
export function conflictDialog(current, describe) {
  return new Promise((resolve) => {
    let result = null;
    const m = openModal({ title: t("conflictTitle"), narrow: true, onClose: () => resolve(result) });
    m.body.append(h("div.callout.conflict", t("conflictText", { v: current?.version ?? "?" })));
    if (describe && current) m.body.append(h("h3", t("conflictCurrent")), describe(current));
    m.foot.append(
      h("button.btn.ghost", { type: "button", on: { click: () => m.close() } }, t("cancel")),
      h("button.btn.secondary", { type: "button", on: { click: () => ((result = "overwrite"), m.close()) } }, t("conflictOverwrite")),
      h("button.btn", { type: "button", on: { click: () => ((result = "reload"), m.close()) } }, t("conflictReload")),
    );
  });
}

/**
 * Generic form dialog.
 * fields: [{ name, label, type: text|textarea|select|number|date|checkbox|range|url, value, options: [[value,label]], required, min, max, step, full }]
 * onSubmit(values) may throw; the dialog stays open and shows the error. Resolves the onSubmit result, or null if cancelled.
 */
export function formDialog({ title, fields, onSubmit, submitLabel = t("save"), narrow = true, intro }) {
  return new Promise((resolve) => {
    let result = null;
    const m = openModal({ title, narrow, onClose: () => resolve(result) });
    const form = h("form", { novalidate: true });
    const inputs = {};
    const err = h("div.callout.conflict", { role: "alert", hidden: true });
    if (intro) form.append(intro);
    const grid = h("div.grid2");
    const wraps = {};
    for (const f of fields) {
      const id = `f-${f.name}-${Math.random().toString(36).slice(2, 7)}`;
      let input;
      if (f.type === "person" || f.type === "blockedby") {
        const c = f.type === "person" ? personField(f, id) : blockedByField(f, id);
        inputs[f.name] = c;
        wraps[f.name] = c.wrap;
        grid.append(c.wrap);
        continue;
      }
      if (f.type === "checklist") {
        const selected = new Set(f.value || []);
        input = h(
          "fieldset.checklist",
          { id },
          h("legend", f.label),
          (f.options || []).map(([v, l]) => h("label.check", h("input", { type: "checkbox", value: v, checked: selected.has(v) }), l)),
        );
        inputs[f.name] = input;
        wraps[f.name] = h("div.field", { style: { "grid-column": "1 / -1" } }, input);
        grid.append(wraps[f.name]);
        continue;
      }
      if (f.type === "textarea") input = h("textarea", { id, name: f.name, rows: f.rows || 8 });
      else if (f.type === "select")
        input = h(
          "select",
          { id, name: f.name, title: f.title, "aria-describedby": f.hint ? `${id}-hint` : null },
          (f.options || []).map(([v, l, opt]) => h("option", { value: v, disabled: !!opt?.disabled, title: opt?.title }, l)),
        );
      else
        input = h("input", { id, name: f.name, type: f.type || "text", min: f.min, max: f.max, step: f.step, placeholder: f.placeholder });
      if (f.type === "checkbox") input.checked = !!f.value;
      else input.value = f.value ?? "";
      if (f.required) input.required = true;
      if (f.disabled) input.disabled = true;
      inputs[f.name] = input;
      const wrap =
        f.type === "checkbox"
          ? h("div.field", { style: f.full ? { "grid-column": "1 / -1" } : undefined }, h("label.check", { for: id }, input, f.label))
          : h(
              "div.field",
              { style: f.full || f.type === "textarea" ? { "grid-column": "1 / -1" } : undefined },
              h("label", { for: id }, f.label),
              input,
              f.hint ? h("p.meta.hint", { id: `${id}-hint` }, f.hint) : null,
            );
      wraps[f.name] = wrap;
      if (f.type === "range") {
        const out = h("output", { for: id }, fmtPct(input.value));
        input.addEventListener("input", () => (out.textContent = fmtPct(input.value)));
        wrap.append(out);
      }
      grid.append(wrap);
    }
    form.append(grid, err);
    // fields with showWhen: { field, values } are only shown (and submitted) while that other field has one of the values
    const valueOf = (name) => (inputs[name]?.get ? inputs[name].get() : inputs[name]?.value);
    const visible = (f) => !f.showWhen || f.showWhen.values.includes(valueOf(f.showWhen.field));
    const syncShown = () => {
      for (const f of fields) if (f.showWhen && wraps[f.name]) wraps[f.name].hidden = !visible(f);
    };
    for (const f of fields) if (f.showWhen) inputs[f.showWhen.field]?.addEventListener?.("change", syncShown);
    // fields with dependsOn: { field, update(sourceValue, targetInput) } follow another field live
    for (const f of fields) {
      if (f.dependsOn) {
        const syncDependency = () => {
          const sourceInput = inputs[f.dependsOn.field];
          const targetInput = inputs[f.name];
          if (sourceInput && targetInput) {
            f.dependsOn.update(sourceInput.value, targetInput);
          }
        };
        syncDependency();
        inputs[f.dependsOn.field]?.addEventListener?.("change", syncDependency);
      }
    }
    syncShown();
    const submit = h("button.btn", { type: "submit" }, submitLabel);
    m.foot.append(h("button.btn.ghost", { type: "button", on: { click: () => m.close() } }, t("cancel")), submit);
    submit.setAttribute("form", (form.id = `form-${Math.random().toString(36).slice(2)}`));
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const values = {};
      for (const f of fields) {
        const el = inputs[f.name];
        if (!visible(f)) continue;
        if (el.get) {
          values[f.name] = el.get();
          continue;
        }
        if (f.type === "checklist") {
          values[f.name] = [...el.querySelectorAll("input:checked")].map((x) => x.value);
          continue;
        }
        let v = f.type === "checkbox" ? el.checked : el.value;
        if (typeof v === "string") v = v.trim();
        if (f.required && (v === "" || v === null)) {
          err.textContent = t("required", { field: f.label });
          err.hidden = false;
          el.focus();
          return;
        }
        if ((f.type === "number" || f.type === "range") && v !== "") v = Number(v);
        values[f.name] = v === "" ? null : v;
      }
      submit.disabled = true;
      try {
        result = await onSubmit(values);
        if (result !== undefined) m.close();
        else result = null;
      } catch (e) {
        err.textContent = errorText(e);
        err.hidden = false;
      } finally {
        submit.disabled = false;
      }
    });
    m.body.append(form);
    form.querySelector("input,textarea,select")?.focus();
  });
}

/** Run a versioned save; on 409 show the conflict dialog, and retry with the server's version on "overwrite". */
export async function saveWithConflict(save, expectedVersion, describe) {
  try {
    return await save(expectedVersion);
  } catch (e) {
    // 409s with a machine-readable code are refused transitions (PROJECT_CLOSED ...), not version conflicts
    if (!e?.isConflict || e.code) throw e;
    const current = e.body?.current;
    const choice = await conflictDialog(current, describe);
    if (choice === "overwrite" && current?.version !== undefined) return save(current.version);
    if (choice === "reload") return { reload: true };
    return { cancelled: true };
  }
}

// ---- custom form fields (used by formDialog)

/** Person picker: pick a person, or "other" and type free text. get() returns a person id, a text, or null. */
function personField(f, id) {
  const OTHER = "__other";
  const persons = f.options || [];
  const sel = h(
    "select",
    { id, name: f.name },
    h("option", { value: "" }, f.noneLabel || t("none")),
    persons.map(([v, l]) => h("option", { value: v }, l)),
    h("option", { value: OTHER }, t("personOther")),
  );
  const text = h("input", { type: "text", "aria-label": `${f.label}: ${t("personOther")}`, maxlength: "200", hidden: true });
  const cur = f.value;
  if (cur?.person_id && persons.some(([v]) => v === cur.person_id)) sel.value = cur.person_id;
  else if (cur?.text) {
    sel.value = OTHER;
    text.value = cur.text;
    text.hidden = false;
  }
  sel.addEventListener("change", () => {
    text.hidden = sel.value !== OTHER;
    if (!text.hidden) text.focus();
  });
  const wrap = h("div.field", h("label", { for: id }, f.label), sel, text);
  return { wrap, addEventListener: () => {}, get: () => (sel.value === OTHER ? text.value.trim() || null : sel.value || null) };
}

/** blocked_by builder: reference a WP or milestone, an external blocker, or free text. get() returns "wp:<id>", "ms:<id>", "ext:<text>", text or null. */
function blockedByField(f, id) {
  const m = /^(wp|ms|ext):([\s\S]*)$/.exec(String(f.value || "").trim());
  const kind0 = f.value ? (m ? m[1] : "text") : "";
  const kind = h(
    "select",
    { id, name: f.name },
    [
      ["", t("blockedNone")],
      ["wp", t("blockedKindWp")],
      ["ms", t("blockedKindMs")],
      ["ext", t("blockedKindExt")],
      ["text", t("blockedKindText")],
    ].map(([v, l]) => h("option", { value: v }, l)),
  );
  const wpSel = h(
    "select",
    { "aria-label": t("blockedKindWp") },
    (f.wps || []).map(([v, l]) => h("option", { value: v }, l)),
  );
  const msSel = h(
    "select",
    { "aria-label": t("blockedKindMs") },
    (f.milestones || []).map(([v, l]) => h("option", { value: v }, l)),
  );
  const txt = h("input", { type: "text", "aria-label": t("fBlockedBy") });
  kind.value = kind0;
  const ref = m ? m[2].trim() : String(f.value || "");
  if (kind0 === "wp") wpSel.value = ref;
  if (kind0 === "ms") msSel.value = ref;
  if (kind0 === "ext" || kind0 === "text") txt.value = ref;
  const sync = () => {
    wpSel.hidden = kind.value !== "wp";
    msSel.hidden = kind.value !== "ms";
    txt.hidden = kind.value !== "ext" && kind.value !== "text";
  };
  kind.addEventListener("change", sync);
  sync();
  const wrap = h(
    "div.field",
    { style: { "grid-column": "1 / -1" } },
    h("label", { for: id }, f.label),
    h("div.blockedby", kind, wpSel, msSel, txt),
  );
  return {
    wrap,
    addEventListener: () => {},
    get() {
      if (kind.value === "wp") return wpSel.value ? `wp:${wpSel.value}` : null;
      if (kind.value === "ms") return msSel.value ? `ms:${msSel.value}` : null;
      const v = txt.value.trim();
      if (!v) return null;
      return kind.value === "ext" ? `ext:${v}` : v;
    },
  };
}
