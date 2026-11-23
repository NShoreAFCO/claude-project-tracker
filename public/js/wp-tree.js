// Work package tree rows: tier language (depth 1 = work package, 2 = sub-work package, 3+ = task).
// Pure layout: the caller builds the content parts, the fold state and its callback are passed in.
import { t } from "./i18n.js";
import { h } from "./dom.js";

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
