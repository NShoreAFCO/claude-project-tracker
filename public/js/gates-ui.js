import { t } from "./i18n.js";
import { api } from "./api.js";
import { h, formDialog, toast } from "./dom.js";
import { isGateLocked, overrideTarget, gateNames, decisionLabel } from "./schedule-ui.js";

/** Opens the milestone decision dialog. */
export async function decisionDialog({ project, milestone }) {
  const decisionMaker = project.decision_maker;
  const intro = h(
    "p.meta",
    decisionMaker
      ? t("decisionRule", {
          name: decisionMaker.name || decisionMaker.text,
        })
      : t("decisionRuleNone"),
  );

  return formDialog({
    title: t("decisionTitle", { name: milestone.title }),
    intro,
    submitLabel: t("recordDecision"),
    fields: [
      {
        name: "decision",
        label: t("fDecision"),
        type: "select",
        value: "go",
        options: [
          ["go", decisionLabel("go")],
          ["go_with_conditions", decisionLabel("go_with_conditions")],
          ["hold", decisionLabel("hold")],
          ["stop", decisionLabel("stop")],
        ],
        required: true,
      },
      {
        name: "note_md",
        label: t("fDecisionNote"),
        type: "textarea",
      },
      {
        name: "evidence",
        label: t("fEvidence"),
        type: "textarea",
      },
      {
        name: "conditions",
        label: t("fConditions"),
        type: "textarea",
        showWhen: {
          field: "decision",
          values: ["go_with_conditions"],
        },
      },
      {
        name: "on_behalf_of_decision_maker",
        label: t("fOnBehalf"),
        type: "checkbox",
      },
    ],
    onSubmit: async (values) => {
      const evidence = (values.evidence || "")
        .split("\n")
        .map((value) => value.trim())
        .filter(Boolean);
      const conditions =
        values.decision === "go_with_conditions"
          ? (values.conditions || "")
              .split("\n")
              .map((value) => value.trim())
              .filter(Boolean)
          : [];

      let result;

      try {
        result = await api.recordDecision(milestone.id, {
          decision: values.decision,
          note_md: values.note_md || null,
          evidence,
          conditions,
          on_behalf_of_decision_maker: values.on_behalf_of_decision_maker,
        });
      } catch (e) {
        if (e && (e.status === 403 || e.status === 400)) {
          throw new Error(e.message);
        }
        throw e;
      }

      toast(t("decisionRecorded"));
      window.dispatchEvent(
        new CustomEvent("tracker:changed", {
          detail: { project_id: project.id },
        }),
      );
      return result;
    },
  });
}

/** Opens the gate override dialog. */
export async function overrideDialog({ wpId, wpTitle, gates, projectId }) {
  const result = await formDialog({
    title: t("overrideTitle"),
    submitLabel: t("overrideSubmit"),
    intro: h("p", t("overrideText", { name: wpTitle, gates })),
    fields: [
      {
        name: "reason",
        label: t("fOverrideReason"),
        type: "textarea",
        required: true,
      },
    ],
    onSubmit: async ({ reason }) => {
      await api.gateOverride(wpId, reason);
      toast(t("overrideDone"));
      window.dispatchEvent(
        new CustomEvent("tracker:changed", {
          detail: { project_id: projectId },
        }),
      );
      return true;
    },
  });

  return result === true;
}

/** Runs a write with schedule-conflict and gate-lock handling. */
export async function guardedWrite(wp, run, projectId) {
  let error;

  try {
    return await run();
  } catch (e) {
    error = e;
  }

  if (error && error.code === "SCHEDULE_CONFLICT") {
    try {
      return await run();
    } catch (e) {
      error = e;
    }
  }

  if (isGateLocked(error)) {
    const target = overrideTarget(error);

    if (target === null) {
      throw error;
    }

    const ok = await overrideDialog({
      wpId: target,
      wpTitle: wp.title,
      gates: gateNames(error),
      projectId,
    });

    if (!ok) {
      return { cancelled: true };
    }

    // the override bumped the version of the locked work package: retry with the current one
    try {
      const fresh = (await api.workpackages(projectId)).find((x) => x.id === wp.id);
      if (fresh) wp.version = fresh.version;
    } catch {
      /* the retry then reports a version conflict if the version really changed */
    }
    return await run();
  }

  throw error;
}

/** Opens the project baseline dialog. */
export function baselineDialog(projectId) {
  return formDialog({
    title: t("setBaseline"),
    narrow: true,
    fields: [
      {
        name: "label",
        label: t("fBaselineLabel"),
        type: "text",
        required: true,
      },
    ],
    onSubmit: async ({ label }) => {
      const result = await api.createBaseline(projectId, label);
      toast(t("baselineSaved"));
      window.dispatchEvent(
        new CustomEvent("tracker:changed", {
          detail: { project_id: projectId },
        }),
      );
      return result;
    },
  });
}
