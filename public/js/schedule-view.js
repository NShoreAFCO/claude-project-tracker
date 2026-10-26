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
    `${t("due")}: ${fmtDate(ms.due_date)}`,
    " · ",
    `${t("requires")}: ${requiresText}`,
    " · ",
    `${t("unlocks")}: ${unlocksText}`,
  ];

  for (const node of scheduleMeta(ms)) {
    if (node.classList.contains("critical")) {
      continue;
    }
    meta.push(" · ", node);
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
    "li.ms",
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
