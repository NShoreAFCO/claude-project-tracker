import type { ReportModel } from "./build";
import { serverT } from "../i18n/server";

export function renderMarkdown(m: ReportModel): string {
  const t = (k: string, v?: Record<string, string | number>) => serverT(m.locale, k, v);
  const out: string[] = [];

  const cell = (value: unknown): string =>
    String(value ?? "")
      .replace(/\|/g, "\\|")
      .replace(/\r?\n/g, " ");

  const date = (value: string): string => value.split("T")[0];

  const section = (key: string, content: string): void => {
    out.push(`## ${t(key)}`, content);
  };

  out.push(`# ${m.project.title}`);

  const facts: string[] = [
    `- ${t("report.status")}: ${t(`status.${m.project.status}`)}`,
    `- ${t("report.progress")}: ${m.project.progress}%`,
  ];

  if (m.project.start_date) {
    facts.push(`- ${t("report.start")}: ${date(m.project.start_date)}`);
  }
  if (m.project.target_date) {
    facts.push(`- ${t("report.target")}: ${date(m.project.target_date)}`);
  }
  if (m.project.owner) {
    facts.push(`- ${t("report.owner")}: ${m.project.owner}`);
  }
  if (m.project.sponsor) {
    facts.push(`- ${t("report.sponsor")}: ${m.project.sponsor}`);
  }
  if (m.project.decision_maker) {
    facts.push(`- ${t("report.decisionMaker")}: ${m.project.decision_maker}`);
  }
  if (m.generated) {
    facts.push(`- ${t("report.generated")}: ${date(m.generated)}`);
  }

  out.push(facts.join("\n"));

  if (m.project.summary) {
    out.push(m.project.summary);
  }

  if (m.objectives_md) {
    section("report.objectives", m.objectives_md);
  }

  if (m.scope_in_md) {
    section("report.scopeIn", m.scope_in_md);
  }

  if (m.scope_out_md) {
    section("report.scopeOut", m.scope_out_md);
  }

  if (m.success_criteria_md) {
    section("report.successCriteria", m.success_criteria_md);
  }

  if (m.workpackages.length) {
    const rows = [
      [
        t("report.title"),
        t("report.status"),
        t("report.progress"),
        t("report.start"),
        t("report.end"),
        t("report.owner"),
        t("report.deliverable"),
      ],
      ["---", "---", "---", "---", "---", "---", "---"],
      ...m.workpackages.map((wp) => [
        `${"\u00a0\u00a0".repeat(wp.level)}${wp.title}`,
        t(`wpstatus.${wp.status}`),
        `${wp.progress}%`,
        wp.start_date ? date(wp.start_date) : "",
        wp.end_date ? date(wp.end_date) : "",
        wp.owner ?? "",
        wp.deliverable ?? "",
      ]),
    ];

    const table = rows.map((row) => `| ${row.map(cell).join(" | ")} |`).join("\n");

    section("report.workpackages", table);
  }

  if (m.milestones.length) {
    const milestones = m.milestones.map((milestone) => {
      const lines: string[] = [`### ${milestone.title}${milestone.gate ? ` (${t("report.gate")})` : ""}`];

      if (milestone.due_date) {
        lines.push(`- ${t("report.due")}: ${date(milestone.due_date)}`);
      }
      if (milestone.reached_at) {
        lines.push(`- ${t("report.reached")}: ${date(milestone.reached_at)}`);
      }
      if (milestone.gate) {
        lines.push(`- ${t("report.decision")}: ${t(`decision.${milestone.decision_state}`)}`);
      }

      for (const decision of milestone.decisions) {
        let item = `- ${t(`decision.${decision.decision}`)}`;
        if (decision.decided_by) {
          item += `, ${decision.decided_by}`;
        }
        item += `, ${date(decision.decided_at)}`;
        if (decision.note_md) {
          item += `, ${decision.note_md}`;
        }
        lines.push(item);
      }

      return lines.join("\n");
    });

    section("report.milestones", milestones.join("\n\n"));
  }

  if (m.risks.length) {
    const rows = [
      [
        t("report.type"),
        t("report.title"),
        "P",
        "I",
        t("report.score"),
        t("report.status"),
        t("report.owner"),
        t("report.action"),
        t("report.due"),
      ],
      ["---", "---", "---", "---", "---", "---", "---", "---", "---"],
      ...m.risks.map((risk) => [
        t(`risktype.${risk.type}`),
        risk.title,
        risk.probability,
        risk.impact,
        risk.score,
        t(`riskstatus.${risk.status}`),
        risk.owner ?? "",
        risk.action ?? "",
        risk.due_date ? date(risk.due_date) : "",
      ]),
    ];

    const table = rows.map((row) => `| ${row.map(cell).join(" | ")} |`).join("\n");

    section("report.risks", table);
  }

  if (m.ncs.length) {
    const deviations = m.ncs.map((nc) => {
      const lines: string[] = [`### ${nc.title}`];

      if (nc.description_md) {
        lines.push(nc.description_md);
      }
      if (nc.cause) {
        lines.push(`- ${t("report.cause")}: ${nc.cause}`);
      }
      if (nc.correction) {
        lines.push(`- ${t("report.correction")}: ${nc.correction}`);
      }
      if (nc.corrective_action) {
        lines.push(`- ${t("report.correctiveAction")}: ${nc.corrective_action}`);
      }
      if (nc.effectiveness_check_date) {
        lines.push(`- ${t("report.effectiveness")}: ${date(nc.effectiveness_check_date)}`);
      }

      return lines.join("\n");
    });

    section("report.deviations", deviations.join("\n\n"));
  }

  if (m.closure_note_md) {
    section("report.closureNote", m.closure_note_md);
  }

  if (m.lessons_learned_md) {
    section("report.lessonsLearned", m.lessons_learned_md);
  }

  return `${out.join("\n\n").replace(/\n+$/, "")}\n`;
}
