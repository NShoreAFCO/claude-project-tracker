// Inbox: unmatched hook/webhook events with "assign to project" (SPEC §9).
import { t, fmtDateTime } from "./i18n.js";
import { api } from "./api.js";
import { h, clear, toast, toastError } from "./dom.js";
import { changed } from "./forms.js";

/** Human-readable details from the event diff (repo, branch, cwd …), shown as plain text. */
function details(e) {
  if (!e.diff_json) return null;
  let d;
  try {
    d = JSON.parse(e.diff_json);
  } catch {
    return h("div.meta", e.diff_json.slice(0, 300));
  }
  // unmatched events store { hook | github: [null, { …fields }] }; flatten the "after" side of each entry
  const flat = Object.assign({}, ...Object.values(d).map((v) => (Array.isArray(v) && v[1] && typeof v[1] === "object" ? v[1] : {})));
  const pairs = Object.entries(flat)
    .filter(([, v]) => v !== null && v !== "" && typeof v !== "object")
    .slice(0, 8)
    .map(([k, v]) => h("span", `${k}: `, h("b", String(v).slice(0, 200))));
  return pairs.length ? h("div.meta", pairs) : null;
}

export async function renderInbox(main, state) {
  clear(main, h("h2", t("inboxTitle")), h("p", t("loading")));
  let events;
  try {
    events = await api.inbox();
  } catch (e) {
    toastError(e);
    return;
  }
  const rows = events.map((e) => {
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
    return h(
      "tr",
      h("td", fmtDateTime(e.ts)),
      h("td", e.actor),
      h("td", h("strong", e.summary || `${e.entity} ${e.action}`), details(e)),
      h("td", h("div", { style: { display: "flex", gap: "0.4rem", "flex-wrap": "wrap" } }, h("div", { style: { "min-width": "160px", flex: 1 } }, sel), btn)),
    );
  });
  clear(
    main,
    h("h2", t("inboxTitle")),
    h("p.meta", t("inboxHint")),
    events.length
      ? h("div.table-wrap", h("table", h("thead", h("tr", [t("colWhen"), t("colBy"), t("description"), ""].map((x) => h("th", x)))), h("tbody", rows)))
      : h("p.empty", t("inboxEmpty")),
  );
}
