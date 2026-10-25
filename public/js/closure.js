// Closure dialog (spec F3): closure note, lessons learned and, if work packages are still open, moving them
// to a new or an existing follow-up project. Order: create target (if new) -> move -> close.
import { t } from "./i18n.js";
import { api } from "./api.js";
import { h, openModal, toast, saveWithConflict, errorText } from "./dom.js";
import { openWps, changed } from "./forms.js";

const CLOSED = ["done", "abandoned"];

/**
 * project: the stored project (id, title, version); workpackages: its WP tree; outcome: done | abandoned;
 * patch: further project fields to save together with the closure (from the edit form).
 * Resolves the updated project, or null when cancelled or reloaded.
 */
export async function closureDialog({ project, workpackages = [], outcome = "done", patch = {} }) {
  let targets = [];
  try {
    targets = (await api.projects()).filter((p) => p.id !== project.id && !CLOSED.includes(p.status));
  } catch {
    targets = [];
  }
  let open = openWps(workpackages);
  return new Promise((resolve) => {
    let result = null;
    let createdTarget = null; // a follow-up project created by an earlier attempt of this dialog
    const m = openModal({ title: t("closureTitle", { name: project.title }), narrow: false, onClose: () => resolve(result) });

    const outcomeSel = h(
      "select",
      { id: "cl-outcome" },
      CLOSED.map((s) => h("option", { value: s }, t(`status.${s}`))),
    );
    outcomeSel.value = outcome;
    const note = h("textarea", { id: "cl-note", rows: 5 });
    const lessons = h("textarea", { id: "cl-lessons", rows: 5 });
    const err = h("div.callout.conflict", { role: "alert", hidden: true });
    const fail = (msg) => {
      err.textContent = msg;
      err.hidden = false;
    };

    // move section (only while WPs are open)
    const radio = (value, checked) => h("input", { type: "radio", name: "cl-move", value, checked });
    const rNone = radio("none", true);
    const rNew = radio("new", false);
    const rExisting = radio("existing", false);
    const newTitle = h("input", {
      type: "text",
      "aria-label": t("closureNewTitle"),
      value: t("closureFollowUpDefault", { name: project.title }),
    });
    const existingSel = h(
      "select",
      { "aria-label": t("closureExisting") },
      targets.map((p) => h("option", { value: p.id }, p.title)),
    );
    const mode = () => [rNone, rNew, rExisting].find((r) => r.checked).value;
    const syncMove = () => {
      newTitle.disabled = mode() !== "new";
      existingSel.disabled = mode() !== "existing";
    };
    for (const r of [rNone, rNew, rExisting]) r.addEventListener("change", syncMove);
    syncMove();
    const moveBlock = () =>
      open.length
        ? h(
            "fieldset.checklist",
            h("legend", t("closureMoveLegend", { n: open.length })),
            h("p.meta", open.map((w) => w.title).join(", ")),
            h("label.check", rNone, t("closureMoveNone")),
            h("label.check", rNew, t("closureMoveNew"), newTitle),
            targets.length ? h("label.check", rExisting, t("closureMoveExisting"), existingSel) : null,
          )
        : null;

    const form = h(
      "form",
      { novalidate: true },
      h("div.field", h("label", { for: "cl-outcome" }, t("closureOutcome")), outcomeSel),
      h("div.field", h("label", { for: "cl-note" }, t("fClosureNote")), note),
      h("div.field", h("label", { for: "cl-lessons" }, t("fLessons")), h("p.meta", t("lessonsHint")), lessons),
      moveBlock(),
      err,
    );
    const submit = h("button.btn", { type: "submit" }, t("closureSubmit"));
    form.id = `cl-form-${Math.random().toString(36).slice(2)}`;
    submit.setAttribute("form", form.id);
    m.body.append(form);
    m.foot.append(h("button.btn.ghost", { type: "button", on: { click: () => m.close() } }, t("cancel")), submit);
    note.focus();

    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      err.hidden = true;
      const out = outcomeSel.value;
      if (!note.value.trim()) return fail(t("required", { field: t("fClosureNote") }));
      if (out === "done" && !lessons.value.trim()) return fail(t("required", { field: t("fLessons") }));
      const how = open.length ? mode() : "none";
      if (out === "done" && how === "none" && open.length) return fail(t("closureNeedsMove", { n: open.length }));
      if (how === "new" && !newTitle.value.trim()) return fail(t("required", { field: t("closureNewTitle") }));
      if (how === "existing" && !existingSel.value) return fail(t("required", { field: t("closureExisting") }));
      submit.disabled = true;
      try {
        if (how !== "none") {
          let toId = existingSel.value;
          if (how === "new") {
            createdTarget ||= (await api.createProject({ title: newTitle.value.trim() })).id;
            toId = createdTarget;
          }
          await api.moveWorkpackages(
            project.id,
            toId,
            open.map((w) => w.id),
          );
          open = []; // moved: a retry after a failed close must not move again
          changed(project.id);
        }
        const res = await saveWithConflict(
          (ver) =>
            api.updateProject(
              project.id,
              { ...patch, status: out, closure_note_md: note.value.trim(), lessons_learned_md: lessons.value.trim() || undefined },
              ver,
            ),
          project.version,
        );
        if (res?.cancelled) return;
        if (!res?.reload) {
          toast(t("closureDone"));
          result = res;
        }
        changed(project.id);
        m.close();
      } catch (e) {
        fail(errorText(e));
      } finally {
        submit.disabled = false;
      }
    });
  });
}
