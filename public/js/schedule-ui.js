import { t } from "./i18n.js";

/** Parse schedule issues from JSON text or an array. */
export function parseIssues(raw) {
  if (Array.isArray(raw)) {
    return raw;
  }

  if (typeof raw !== "string") {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Return localized text for a schedule issue. */
export function issueText(issue, titleOf) {
  const key = `issue.${issue.code}`;
  const text = t(key, {
    other: titleOf?.(issue.related_id) ?? issue.related_id,
  });

  return text === key ? issue.message : text;
}

/** Collect and de-duplicate schedule issues from schedule detail data. */
export function collectIssues(detail) {
  const issues = [];
  const seen = new Set();

  const addIssues = (raw) => {
    for (const issue of parseIssues(raw)) {
      const key = `${issue.code}|${issue.entity}|${issue.entity_id}|${issue.related_id}`;

      if (!seen.has(key)) {
        seen.add(key);
        issues.push(issue);
      }
    }
  };

  const walkWorkpackages = (workpackages) => {
    if (!Array.isArray(workpackages)) {
      return;
    }

    for (const workpackage of workpackages) {
      addIssues(workpackage?.schedule_issues);
      walkWorkpackages(workpackage?.children);
    }
  };

  walkWorkpackages(detail?.workpackages);

  if (Array.isArray(detail?.milestones)) {
    for (const milestone of detail.milestones) {
      addIssues(milestone?.schedule_issues);
    }
  }

  return issues;
}

/** Group schedule issues by entity ID. */
export function issuesByEntity(issues) {
  const grouped = new Map();

  for (const issue of issues) {
    const existing = grouped.get(issue.entity_id);

    if (existing) {
      existing.push(issue);
    } else {
      grouped.set(issue.entity_id, [issue]);
    }
  }

  return grouped;
}

/** Derive the display state of a milestone. */
export function milestoneView(m, today) {
  let state = "open";

  if (m.done) {
    state = "done";
  } else if (m.due_date !== null && m.due_date < today) {
    state = "overdue";
  }

  return {
    state,
    gate: !!m.gate,
    decision: m.gate ? m.decision_state || "none" : "none",
  };
}

/** Return the localized label for a decision state. */
export function decisionLabel(decision) {
  return t(`decisionState.${decision}`);
}

/** Return localized schedule-slip text. */
export function slipText(days) {
  if (days === null || days === undefined) {
    return null;
  }

  if (days === 0) {
    return t("slipNone");
  }

  if (days > 0) {
    return t("slipLate", { n: days });
  }

  return t("slipEarly", { n: -days });
}

/** Return quoted gate titles from an API error. */
export function gateNames(err) {
  const gates = err?.body?.current?.gates;

  if (!Array.isArray(gates) || gates.length === 0) {
    return "";
  }

  return gates.map((gate) => t("quoted", { s: gate.title })).join(", ");
}

/** Extract the work package ID from a gate override endpoint. */
export function overrideTarget(err) {
  const endpoint = err?.body?.current?.override_endpoint;

  if (typeof endpoint !== "string") {
    return null;
  }

  const match = /^POST \/api\/workpackages\/([^/]+)\/gate-override$/.exec(endpoint);
  return match ? match[1] : null;
}

/** Return whether an API error represents a locked gate. */
export function isGateLocked(err) {
  return err?.status === 409 && err?.body?.current?.code === "GATE_LOCKED";
}
