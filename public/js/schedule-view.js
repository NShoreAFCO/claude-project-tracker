import { t, fmtDate } from "./i18n.js";
import { h } from "./dom.js";
import { parseIssues, issueText, milestoneView, decisionLabel, slipText } from "./schedule-ui.js";

/** Builds the schedule issue list for an entity. */
export function issueList(entity, titleOf) {
  const issues = parseIssues(entity.schedule_issues);

  if (!issues.length) {
    return null;
  }

  return h(
    "ul.issues",
    { role: "list" },
    issues.map((issue) => h("li.issue", h("span.issue-mark", { "aria-hidden": "true" }, "⚠"), " ", issueText(issue, titleOf))),
  );
}

/** Builds schedule metadata nodes for an entity. */
export function scheduleMeta(entity) {
  const nodes = [];

  if (entity.baseline_end != null) {
    // milestones have only a baseline due date (no start)
    nodes.push(
      h(
        "span",
        entity.baseline_start
          ? t("baselineRange", { start: fmtDate(entity.baseline_start), end: fmtDate(entity.baseline_end) })
          : t("baselineDue", { date: fmtDate(entity.baseline_end) }),
      ),
    );
  }

  const slip = slipText(entity.slip_days);
  if (slip !== null) {
    nodes.push(h("span.slip", { class: entity.slip_days > 0 ? "late" : "" }, slip));
  }

  if (entity.critical) {
    nodes.push(h("span.badge.critical", t("criticalMark")));
  }

  return nodes;
}

/** Builds an issue-count badge for an entity. */
export function issueBadge(entity, titleOf) {
  const issues = parseIssues(entity.schedule_issues);

  if (!issues.length) {
    return null;
  }

  const texts = issues.map((issue) => issueText(issue, titleOf));

  return h(
    "span.badge.issue",
    {
      title: texts.join("\n"),
      "aria-label": texts.join(". "),
    },
    "⚠ ",
    String(issues.length),
  );
}

/** Builds a milestone list item. */
export function milestoneItem(ms, { today, titleOf, requiresText, unlocksText, actions = [], decide }) {
  const { state, gate, decision } = milestoneView(ms, today);
  const stateLabel = state === "done" ? t("reached") : state === "overdue" ? t("overdue") : t("msOpen");

  const meta = [
    h("span", `${t("due")}: ${fmtDate(ms.due_date)}`),
    h("span", `${t("requires")}: ${requiresText}`),
    h("span", `${t("unlocks")}: ${unlocksText}`),
  ];

  for (const node of scheduleMeta(ms)) {
    if (node.classList.contains("critical")) {
      continue;
    }
    meta.push(node);
  }

  let lastDecision = null;
  if (gate && ms.decisions?.length) {
    const last = ms.decisions[ms.decisions.length - 1];
    lastDecision = h(
      "div.meta.last-decision",
      t("decisionBy", {
        decision: decisionLabel(last.decision),
        name: last.decided_by?.name ?? "",
        date: fmtDate(last.decided_at.slice(0, 10)),
      }),
    );
  }

  const actionNodes = [];
  if (gate && typeof decide === "function") {
    actionNodes.push(h("button.btn.small.secondary", { type: "button", on: { click: decide } }, t("recordDecision")));
  }
  actionNodes.push(...actions);

  return h(
    "li.ms." + (gate ? "underlay-gate" : "underlay-milestone"),
    h("span.ms-diamond." + state, { "aria-hidden": "true", class: gate ? "gate" : "" }),
    h("strong", ms.title),
    h("span.ms-state." + state, stateLabel),
    gate ? h("span.badge.gate", t("gateMark")) : null,
    gate ? h("span.badge.decision.decision-" + decision, decisionLabel(decision)) : null,
    ms.critical ? h("span.badge.critical", t("criticalMark")) : null,
    h("div.meta", meta),
    lastDecision,
    issueList(ms, titleOf),
    h("div.actions", actionNodes),
  );
}

/**
 * Places milestone and gate rows in a work package tree (running context, D13).
 * `tree` is the list of top-level WPs as shown (children nested); `isOpen(wp)` tells whether a parent is unfolded.
 * Returns { before: Map<wpId, ms[]>, after: Map<wpId, ms[]>, tail: ms[] }: gate rows go before the first WP they
 * unlock, milestone rows after the last of their `requires` WPs (a WP inside a folded parent counts as the outermost
 * folded parent), else after the attached WP, else at the end. Links to WPs that are not shown are ignored.
 */
export function placeMilestones(tree, milestones, isOpen = () => true) {
  const order = new Map(); // displayed node id -> position
  const rep = new Map(); // any shown WP id -> displayed node id
  const walk = (list, shownAs) => {
    for (const w of list) {
      const node = shownAs ?? w.id;
      if (!shownAs) order.set(w.id, order.size);
      rep.set(w.id, node);
      if (w.children?.length) walk(w.children, shownAs ?? (isOpen(w) ? null : w.id));
    }
  };
  walk(tree, null);

  const before = new Map();
  const after = new Map();
  const tail = [];
  const add = (map, key, ms) => map.set(key, [...(map.get(key) ?? []), ms]);
  const pick = (ids, last) => {
    const nodes = [...new Set((ids ?? []).map((id) => rep.get(id)).filter((x) => x !== undefined))];
    if (!nodes.length) return null;
    return nodes.reduce((a, b) => ((order.get(b) > order.get(a)) === last ? b : a));
  };
  for (const ms of milestones) {
    const first = ms.gate ? pick(ms.unlocks, false) : null;
    if (first !== null) {
      add(before, first, ms);
      continue;
    }
    const last = pick(ms.requires, true) ?? (ms.workpackage_id ? (rep.get(ms.workpackage_id) ?? null) : null);
    if (last !== null) add(after, last, ms);
    else tail.push(ms);
  }
  return { before, after, tail };
}
