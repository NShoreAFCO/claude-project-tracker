// Work package tree rows: tier language (depth 1 = work package, 2 = sub-work package, 3+ = task).
// Pure layout: the caller builds the content parts, the fold state and its callback are passed in.
import { t, fmtDate } from "./i18n.js";
import { h, menuButton } from "./dom.js";
import { milestoneView, decisionLabel } from "./schedule-ui.js";
import { issueBadge, scheduleMeta } from "./schedule-view.js";
import { lateness, lateChip } from "./lateness.js";
import { compareCode } from "./order.js";

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
export function wpRow({ depth, fold, id = null, code, title, badges = [], status, dates, owner, progress, below = [] }) {
  const tier = tierOf(depth);
  return h(
    `div.wp.tw-row.tier-${tier}`,
    { id, dataset: { tier: String(tier) } },
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

/**
 * True when a work package can be marked done: not done or dropped yet, and its progress is 100 % (a leaf by its own
 * progress, a parent by its effective progress from the sub-work packages). The permission check is the caller's.
 */
export function canMarkDone(w) {
  if (isDoneWp(w)) return false;
  const leaf = !w.children?.length;
  return Number(leaf ? w.progress : w.effective_progress) >= 100;
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
 * primary (optional): { label, onClick } shown first as the filled button; Edit then becomes secondary.
 * gate wraps the result (role check); it returns null for a reader.
 */
export function rowActions({ edit, primary = null, items = [], menuLabel, gate = (x) => x }) {
  const menuItems = items.filter(Boolean);
  const box = h(
    "div.actions.row-actions",
    primary ? h("button.btn.small", { type: "button", on: { click: primary.onClick } }, primary.label) : null,
    h(
      primary ? "button.btn.small.secondary" : "button.btn.small",
      { type: "button", on: { click: edit.onClick } },
      edit.label,
    ),
    menuItems.length ? menuButton(menuLabel, menuItems) : null,
  );
  return gate(box);
}

/**
 * Slim gate or milestone row inside the tree: icon, code, title, state, due date with its overdue chip, schedule
 * issues, baseline / slip / critical mark, last gate decision, requires, unlocks, one action.
 */
export function slimMilestoneRow(ms, { today, titleOf, requiresText, unlocksText, actions = null, id = null }) {
  const { state, gate, decision } = milestoneView(ms, today);
  const stateLabel = state === "done" ? t("reached") : state === "overdue" ? t("overdue") : t("msOpen");
  const last = gate && ms.decisions?.length ? ms.decisions[ms.decisions.length - 1] : null;
  const lastText = last
    ? t("decisionBy", {
        decision: decisionLabel(last.decision),
        name: last.decided_by?.name ?? "",
        date: fmtDate((last.decided_at ?? "").slice(0, 10)),
      })
    : null;
  return h(
    "li.tw-ms.ms." + (gate ? "underlay-gate" : "underlay-milestone"),
    { id, dataset: { kind: gate ? "gate" : "milestone" } },
    h("span.ms-diamond." + state, { "aria-hidden": "true", class: gate ? "gate" : "" }),
    h("span.tw-ms-code", ms.code || (gate ? t("gateMark") : "")),
    // title column: the text parts, then the actions under the title, like the work package rows
    h(
      "div.tw-ms-main",
      h("strong.tw-ms-title", ms.title),
      h("span.ms-state." + state, stateLabel),
      gate ? h("span.badge.decision.decision-" + decision, decisionLabel(decision)) : null,
      h("span.tw-ms-due", `${t("due")}: ${fmtDate(ms.due_date)}`, " ", lateChip(lateness(ms.due_date, state === "done" ? "reached" : "open"))),
      issueBadge(ms, titleOf),
      ...scheduleMeta(ms),
      lastText ? h("span.tw-ms-last.meta", lastText) : null,
      h("span.tw-ms-req", t("requires"), ": ", requiresText),
      h("span.tw-ms-unl", t("unlocks"), ": ", unlocksText),
    ),
    actions ? h("div.tw-ms-below", actions) : null,
  );
}
// /dialog layout

// dependency links
const idList = (raw) => {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== "string" || !raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

/** Items in code order; an item without a code goes last, by title. */
export function sortRefs(items) {
  return [...items].sort((a, b) => compareCode(a.code, b.code) || String(a.title).localeCompare(String(b.title)));
}

/**
 * Dependencies of one work package: { dependsOn: [wp], neededBy: [{ kind, item }] } in code order.
 * neededBy holds the work packages whose depends_on hold it and the milestones whose requires hold it.
 */
export function wpDependencies(w, allWps, milestones = []) {
  const byId = new Map(allWps.map((x) => [x.id, x]));
  const dependsOn = sortRefs(idList(w.depends_on).map((id) => byId.get(id)).filter(Boolean)).map((item) => ({ kind: "wp", item }));
  const needed = [
    ...allWps.filter((x) => idList(x.depends_on).includes(w.id)).map((item) => ({ kind: "wp", item })),
    ...milestones.filter((ms) => (ms.requires || []).includes(w.id)).map((item) => ({ kind: "ms", item })),
  ];
  const neededBy = needed.sort((a, b) => compareCode(a.item.code, b.item.code) || String(a.item.title).localeCompare(String(b.item.title)));
  return { dependsOn, neededBy };
}

/** DOM id of a work package row or milestone row, the target of a dependency link. */
export const depTargetId = (kind, id) => `dep-${kind}-${id}`;

/** One link to a work package or milestone: its code (title in the title attribute), or the title without a code. */
export function depLink(kind, item, onJump) {
  return h(
    "button.linkbtn.dep-link",
    {
      type: "button",
      title: item.code ? item.title : null,
      on: { click: () => onJump(kind, item.id) },
    },
    item.code || item.title,
  );
}

/** blocked_by is wp:<id>, ms:<id>, ext:<text> or free text: wp: and ms: give a link, everything else stays text. */
export function blockedRef(raw, allWps, milestones, onJump) {
  const m = /^(wp|ms|ext):([\s\S]*)$/.exec(String(raw).trim());
  if (!m) return raw;
  const ref = m[2].trim();
  if (m[1] === "ext") return ref;
  const hit = (m[1] === "wp" ? allWps : milestones).find((x) => x.id === ref);
  return hit ? depLink(m[1], hit, onJump) : ref;
}

/** "Depends on: WP1, WP2" as a muted line; null when there are no references. */
export function depLine(cls, label, refs, onJump) {
  if (!refs.length) return null;
  return h(
    `div.meta.dep-line.${cls}`,
    label,
    ": ",
    refs.flatMap((r, i) => [i ? ", " : null, depLink(r.kind, r.item, onJump)]),
  );
}

/** Ids from the top-level work package down to the work package itself (empty when it is not in the tree). */
export function pathTo(tree, id, trail = []) {
  for (const w of tree || []) {
    const here = [...trail, w.id];
    if (w.id === id) return here;
    const hit = pathTo(w.children, id, here);
    if (hit.length) return hit;
  }
  return [];
}

/**
 * Makes a work package visible by changing the fold state: unfolds all its ancestors, opens the done group when its
 * top-level work package is finished, and turns the issues-only filter off when `shown` (a Set or null) hides it.
 */
export function revealFold(tree, id, fold, shown = null) {
  const path = pathTo(tree, id);
  if (!path.length) return;
  for (const a of path.slice(0, -1)) fold.open.add(a);
  const top = tree.find((w) => w.id === path[0]);
  if (top && isDoneWp(top)) fold.doneOpen = true;
  if (fold.issuesOnly && shown && !shown.has(id)) fold.issuesOnly = false;
}

/** Scrolls the target into view, moves focus to it and highlights it for 2 s (`dep-target`). */
export function revealTarget(el, { reduceMotion = false, timer = setTimeout } = {}) {
  if (!el) return;
  if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
  el.scrollIntoView?.({ block: "center", behavior: reduceMotion ? "auto" : "smooth" });
  el.focus?.({ preventScroll: true });
  el.classList.add("dep-target");
  timer(() => el.classList.toggle("dep-target", false), 2000);
}
// /dependency links
