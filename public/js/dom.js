// DOM helpers. Everything is built with createElement/textContent; the only HTML string ever
// assigned is the output of the sanitising markdown renderer (see markdown.js).
import { t, fmtPct } from "./i18n.js";

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
export function toast(msg, error = false) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.toggle("error", error);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), error ? 6000 : 2500);
}
export const toastError = (e) => toast(e?.isAuth ? t("errorAuth") : t("errorGeneric", { msg: e?.message || String(e) }), true);

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
    for (const f of fields) {
      const id = `f-${f.name}-${Math.random().toString(36).slice(2, 7)}`;
      let input;
      if (f.type === "checklist") {
        const selected = new Set(f.value || []);
        input = h(
          "fieldset.checklist",
          { id },
          h("legend", f.label),
          (f.options || []).map(([v, l]) => h("label.check", h("input", { type: "checkbox", value: v, checked: selected.has(v) }), l)),
        );
        inputs[f.name] = input;
        grid.append(h("div.field", { style: { "grid-column": "1 / -1" } }, input));
        continue;
      }
      if (f.type === "textarea") input = h("textarea", { id, name: f.name, rows: f.rows || 8 });
      else if (f.type === "select")
        input = h(
          "select",
          { id, name: f.name },
          (f.options || []).map(([v, l]) => h("option", { value: v }, l)),
        );
      else
        input = h("input", { id, name: f.name, type: f.type || "text", min: f.min, max: f.max, step: f.step, placeholder: f.placeholder });
      if (f.type === "checkbox") input.checked = !!f.value;
      else input.value = f.value ?? "";
      if (f.required) input.required = true;
      inputs[f.name] = input;
      const wrap =
        f.type === "checkbox"
          ? h("div.field", { style: f.full ? { "grid-column": "1 / -1" } : undefined }, h("label.check", { for: id }, input, f.label))
          : h(
              "div.field",
              { style: f.full || f.type === "textarea" ? { "grid-column": "1 / -1" } : undefined },
              h("label", { for: id }, f.label),
              input,
            );
      if (f.type === "range") {
        const out = h("output", { for: id }, fmtPct(input.value));
        input.addEventListener("input", () => (out.textContent = fmtPct(input.value)));
        wrap.append(out);
      }
      grid.append(wrap);
    }
    form.append(grid, err);
    const submit = h("button.btn", { type: "submit" }, submitLabel);
    m.foot.append(h("button.btn.ghost", { type: "button", on: { click: () => m.close() } }, t("cancel")), submit);
    submit.setAttribute("form", (form.id = `form-${Math.random().toString(36).slice(2)}`));
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const values = {};
      for (const f of fields) {
        const el = inputs[f.name];
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
        err.textContent = e?.isAuth ? t("errorAuth") : t("errorGeneric", { msg: e?.message || String(e) });
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
    if (!e?.isConflict) throw e;
    const current = e.body?.current;
    const choice = await conflictDialog(current, describe);
    if (choice === "overwrite" && current?.version !== undefined) return save(current.version);
    if (choice === "reload") return { reload: true };
    return { cancelled: true };
  }
}
