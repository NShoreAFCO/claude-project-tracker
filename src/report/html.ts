import type { ReportModel } from "./build";
import { serverT } from "../i18n/server";
import { escapeHtml, renderMarkdownSafe } from "./md-html";

type T = (key: string, vars?: Record<string, string | number>) => string;

export function workpackagesTable(
  rows: {
    level: number;
    title: string;
    status: string;
    progress: number;
    start_date: string | null;
    end_date: string | null;
    owner: string | null;
    deliverable: string | null;
  }[],
  t: T,
): string {
  const headers = [
    t("report.title"),
    t("report.status"),
    t("report.progress"),
    t("report.start"),
    t("report.due"),
    t("report.owner"),
    t("report.deliverable"),
  ];

  const thead = "<thead><tr>" + headers.map((label) => `<th>${escapeHtml(label)}</th>`).join("") + "</tr></thead>";

  const tbody =
    "<tbody>" +
    rows
      .map((row) => {
        const level = Math.min(5, row.level);

        return (
          "<tr>" +
          `<td class="lvl-${escapeHtml(level)}">${escapeHtml(row.title)}</td>` +
          `<td>${escapeHtml(t("wpstatus." + row.status))}</td>` +
          `<td>${escapeHtml(row.progress)}${escapeHtml("%")}</td>` +
          `<td>${escapeHtml(row.start_date ?? "")}</td>` +
          `<td>${escapeHtml(row.end_date ?? "")}</td>` +
          `<td>${escapeHtml(row.owner ?? "")}</td>` +
          `<td>${escapeHtml(row.deliverable ?? "")}</td>` +
          "</tr>"
        );
      })
      .join("") +
    "</tbody>";

  return `<table class="wp">${thead}${tbody}</table>`;
}

export function risksTable(
  rows: {
    type: string;
    title: string;
    probability: number;
    impact: number;
    score: number;
    status: string;
    owner: string | null;
    action: string | null;
    due_date: string | null;
  }[],
  t: T,
): string {
  const headers = [
    t("report.type"),
    t("report.title"),
    "P",
    "I",
    t("report.score"),
    t("report.status"),
    t("report.owner"),
    t("report.action"),
    t("report.due"),
  ];

  const thead = "<thead><tr>" + headers.map((label) => `<th>${escapeHtml(label)}</th>`).join("") + "</tr></thead>";

  const tbody =
    "<tbody>" +
    rows
      .map(
        (row) =>
          "<tr>" +
          `<td>${escapeHtml(t("risktype." + row.type))}</td>` +
          `<td>${escapeHtml(row.title)}</td>` +
          `<td>${escapeHtml(row.probability)}</td>` +
          `<td>${escapeHtml(row.impact)}</td>` +
          `<td>${escapeHtml(row.score)}</td>` +
          `<td>${escapeHtml(t("riskstatus." + row.status))}</td>` +
          `<td>${escapeHtml(row.owner ?? "")}</td>` +
          `<td>${escapeHtml(row.action ?? "")}</td>` +
          `<td>${escapeHtml(row.due_date ?? "")}</td>` +
          "</tr>",
      )
      .join("") +
    "</tbody>";

  return `<table class="risks">${thead}${tbody}</table>`;
}
export function milestoneCards(
  rows: {
    title: string;
    due_date: string | null;
    reached_at: string | null;
    gate: boolean;
    decision_state: string;
    decisions: {
      decision: string;
      decided_by: string | null;
      decided_at: string;
      note_md: string | null;
    }[];
  }[],
  t: T,
): string {
  return rows
    .map((row) => {
      const heading = escapeHtml(row.title) + (row.gate ? ` (${escapeHtml(t("report.gate"))})` : "");

      const meta: string[] = [];

      if (row.due_date !== null) {
        meta.push(`${escapeHtml(t("report.due"))}: ${escapeHtml(row.due_date)}`);
      }

      if (row.reached_at !== null) {
        meta.push(`${escapeHtml(t("report.reached"))}: ${escapeHtml(row.reached_at.slice(0, 10))}`);
      }

      if (row.gate) {
        meta.push(`${escapeHtml(t("report.decision"))}: ${escapeHtml(t(`decision.${row.decision_state}`))}`);
      }

      const decisions =
        row.decisions.length > 0
          ? `<ul class="decisions">${row.decisions
              .map((decision) => {
                const by = decision.decided_by !== null ? `, ${escapeHtml(decision.decided_by)}` : "";
                const date = escapeHtml(decision.decided_at.slice(0, 10));
                const note = decision.note_md !== null ? `<div>${renderMarkdownSafe(decision.note_md)}</div>` : "";

                return `<li><strong>${escapeHtml(t(`decision.${decision.decision}`))}</strong>${by}, ${date}${note}</li>`;
              })
              .join("")}</ul>`
          : "";

      return `<article class="card"><h3>${heading}</h3><p class="meta">${meta.join(", ")}</p>${decisions}</article>`;
    })
    .join("");
}

export function ncCards(
  rows: {
    title: string;
    status: string;
    description_md: string | null;
    cause: string | null;
    correction: string | null;
    corrective_action: string | null;
    effectiveness_check_date: string | null;
  }[],
  t: T,
): string {
  return rows
    .map((row) => {
      const description = row.description_md !== null ? renderMarkdownSafe(row.description_md) : "";

      const entries: string[] = [];

      if (row.cause !== null) {
        entries.push(`<dt>${escapeHtml(t("report.cause"))}</dt><dd>${escapeHtml(row.cause)}</dd>`);
      }

      if (row.correction !== null) {
        entries.push(`<dt>${escapeHtml(t("report.correction"))}</dt><dd>${escapeHtml(row.correction)}</dd>`);
      }

      if (row.corrective_action !== null) {
        entries.push(`<dt>${escapeHtml(t("report.correctiveAction"))}</dt><dd>${escapeHtml(row.corrective_action)}</dd>`);
      }

      if (row.effectiveness_check_date !== null) {
        entries.push(`<dt>${escapeHtml(t("report.effectiveness"))}</dt><dd>${escapeHtml(row.effectiveness_check_date)}</dd>`);
      }

      return `<article class="card"><h3>${escapeHtml(row.title)}</h3>${description}<dl>${entries.join("")}</dl></article>`;
    })
    .join("");
}

const mdSection = (title: string, md: string | null): string =>
  md && md.trim() ? `<section><h2>${escapeHtml(title)}</h2>${renderMarkdownSafe(md)}</section>` : "";
const section = (title: string, body: string): string => (body ? `<section><h2>${escapeHtml(title)}</h2>${body}</section>` : "");

/** Complete HTML5 report. Everything is escaped; Markdown fields go through renderMarkdownSafe only. */
export function renderHtml(m: ReportModel, opts: { stylesheet?: boolean } = {}): string {
  const t: T = (k, v) => serverT(m.locale, k, v);
  const p = m.project;
  const facts: Array<[string, string | null]> = [
    [t("report.status"), t(`status.${p.status}`)],
    [t("report.progress"), `${p.progress}%`],
    [t("report.start"), p.start_date],
    [t("report.target"), p.target_date],
    [t("report.owner"), p.owner],
    [t("report.sponsor"), p.sponsor],
    [t("report.decisionMaker"), p.decision_maker],
    [t("report.generated"), m.generated],
  ];
  const dl = facts
    .filter(([, v]) => v)
    .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v!)}</dd>`)
    .join("");
  const head = `<header class="report-head"><h1>${escapeHtml(p.title)}</h1><dl class="facts">${dl}</dl>${
    p.summary ? `<p>${escapeHtml(p.summary)}</p>` : ""
  }</header>`;
  const body = [
    mdSection(t("report.objectives"), m.objectives_md),
    mdSection(t("report.scopeIn"), m.scope_in_md),
    mdSection(t("report.scopeOut"), m.scope_out_md),
    mdSection(t("report.successCriteria"), m.success_criteria_md),
    section(t("report.workpackages"), m.workpackages.length ? workpackagesTable(m.workpackages, t) : ""),
    section(t("report.milestones"), milestoneCards(m.milestones, t)),
    section(t("report.risks"), m.risks.length ? risksTable(m.risks, t) : ""),
    section(t("report.deviations"), ncCards(m.ncs, t)),
    mdSection(t("report.closureNote"), m.closure_note_md),
    mdSection(t("report.lessonsLearned"), m.lessons_learned_md),
  ].join("");
  const link = opts.stylesheet === false ? "" : `<link rel="stylesheet" href="/api/report/print.css">`;
  return `<!doctype html>
<html lang="${escapeHtml(m.locale)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(p.title)}</title>
${link}
</head>
<body><main class="report">${head}${body}</main></body>
</html>
`;
}
