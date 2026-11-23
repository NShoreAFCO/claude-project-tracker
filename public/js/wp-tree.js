// Work package tree rows: tier language (depth 1 = work package, 2 = sub-work package, 3+ = task).
// Pure layout: the caller builds the content parts, the fold state and its callback are passed in.
import { t } from "./i18n.js";
import { h, menuButton } from "./dom.js";
import { fmtDate } from "./i18n.js";
import { milestoneView, decisionLabel } from "./schedule-ui.js";

/** Tier of a row by depth: 1 for the top level, 2 for its children, 3 for everything deeper. */
export function tierOf(depth) {
  return depth <= 1 ? 1 : depth === 2 ? 2 : 3;
}

/** Column header strip above the tree (hidden in a narrow dialog by CSS). */
export function treeHead() {
  return h(
    "div.tw-head",
    { "aria-hidden": "true" },
    h("span.tw-h-code", t("twColCode")),
    h("span.tw-h-ttl", t("twColTitle")),
    h("span.tw-h-st", t("colStatus")),
    h("span.tw-h-dt", t("twColDates")),
    h("span.tw-h-own", t("twColOwner")),
    h("span.tw-h-pct", t("progress")),
  );
}

/**
 * One tree row. parts: { code, title, badges, status, dates, owner, progress, below }
 * fold: { leaf, open, label, onToggle }. A top-level row carries the block border on its li, see `wpItem`.
 */
export function wpRow({ depth, fold, code, title, badges = [], status, dates, owner, progress, below = [] }) {
  const tier = tierOf(depth);
  return h(
    `div.wp.tw-row.tier-${tier}`,
    { dataset: { tier: String(tier) } },
    !fold.leaf
      ? h(
          "button.chev.tw-fold",
          {
            type: "button",
            "aria-expanded": String(!!fold.open),
            "aria-label": fold.label,
            on: { click: fold.onToggle },
          },
          h("span.fold-glyph", { "aria-hidden": "true" }, fold.open ? "▾" : "▸"),
        )
      : h("span.tw-nofold", { "aria-hidden": "true" }),
    h("span.tw-code.wp-code", code || ""),
    h("div.tw-ttl", h("strong.tw-name", title), ...badges),
    h("span.tw-st", status),
    h("span.tw-dt", dates),
    h("span.tw-own", owner),
    h("div.tw-pct", progress),
    below.length ? h("div.tw-below", ...below) : null,
  );
}

/** List item for a row; top-level ones are one bordered block, deeper ones sit inside it. */
export function wpItem(depth, row, children) {
  return h(`li.tw-item${depth <= 1 ? ".tw-block" : ""}`, row, children);
}

// dialog layout

/** True for a top-level work package that is finished (done or dropped). */
export function isDoneWp(w) {
  return w.status === "done" || w.status === "dropped";
}

/** Splits top-level work packages into open and done ones, keeping the code order of each. */
export function splitDone(list) {
  return { open: list.filter((w) => !isDoneWp(w)), done: list.filter(isDoneWp) };
}

/** One fold line "n done · Show" with the done blocks after it while it is open. Returns a list of items. */
export function doneFold({ count, open, onToggle, rows = [] }) {
  if (!count) return [];
  return [
    h(
      "li.tw-donefold",
      h(
        "button.linkbtn.tw-donefold-btn",
        { type: "button", "aria-expanded": String(!!open), on: { click: onToggle } },
        t("doneCount", { n: count }),
        " · ",
        t(open ? "doneHide" : "doneShow"),
      ),
    ),
    ...(open ? rows : []),
  ];
}

/**
 * One action per row: the primary button stays visible, everything else goes into a menu.
 * edit: { label, onClick }; items: [{ label, onClick, danger }] (falsy entries are skipped).
 * gate wraps the result (role check); it returns null for a reader.
 */
export function rowActions({ edit, items = [], menuLabel, gate = (x) => x }) {
  const menuItems = items.filter(Boolean);
  const box = h(
    "div.actions.row-actions",
    h("button.btn.small", { type: "button", on: { click: edit.onClick } }, edit.label),
    menuItems.length ? menuButton(menuLabel, menuItems) : null,
  );
  return gate(box);
}

/** Slim gate or milestone row inside the tree: icon, code, title, state, due date, requires, unlocks, one action. */
export function slimMilestoneRow(ms, { today, requiresText, unlocksText, actions = null }) {
  const { state, gate, decision } = milestoneView(ms, today);
  const stateLabel = state === "done" ? t("reached") : state === "overdue" ? t("overdue") : t("msOpen");
  return h(
    "li.tw-ms.ms." + (gate ? "underlay-gate" : "underlay-milestone"),
    { dataset: { kind: gate ? "gate" : "milestone" } },
    h("span.ms-diamond." + state, { "aria-hidden": "true", class: gate ? "gate" : "" }),
    h("span.tw-ms-code", ms.code || (gate ? t("gateMark") : "")),
    h("strong.tw-ms-title", ms.title),
    h("span.ms-state." + state, stateLabel),
    gate ? h("span.badge.decision.decision-" + decision, decisionLabel(decision)) : null,
    h("span.tw-ms-due", `${t("due")}: ${fmtDate(ms.due_date)}`),
    h("span.tw-ms-req", `${t("requires")}: ${requiresText}`),
    h("span.tw-ms-unl", `${t("unlocks")}: ${unlocksText}`),
    actions,
  );
}
// /dialog layout
