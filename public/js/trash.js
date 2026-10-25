// Trash view (spec F10): deleted items with restore; purge (admins, after the retention period).
import { t, fmtDateTime } from "./i18n.js";
import { api } from "./api.js";
import { h, clear, toast, toastError, confirmDialog } from "./dom.js";
import { changed } from "./forms.js";

const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);

async function restore(item) {
  try {
    await api.restoreTrash(item.kind, item.id);
    toast(t("restored"));
    changed(item.project_id);
  } catch (e) {
    toastError(e); // PARENT_DELETED, SLUG_TAKEN ... as localised text
  }
}

async function purge(item) {
  if (!(await confirmDialog(t("confirmPurge", { name: item.title }), { okLabel: t("purge"), danger: true }))) return;
  try {
    await api.purgeTrash(item.kind, item.id);
    toast(t("purged"));
    changed(item.project_id);
  } catch (e) {
    toastError(e); // RETENTION says when the item may be purged
  }
}

export async function renderTrash(main) {
  clear(main, h("h2", t("trashTitle")), h("p", t("loading")));
  const [items, who] = await Promise.all([api.trash(), api.whoami().catch(() => null)]);
  const isAdmin = who?.person?.access_role === "admin";
  const rows = items.map((it) =>
    h(
      "tr",
      h("td.kind", { dataset: { label: t("colKind") } }, capital(t(`entityKind.${it.kind}`))),
      h("td.p-name", h("strong", it.title), it.project_id && it.kind !== "project" ? h("div.meta", it.project_id) : null),
      h("td", { dataset: { label: t("colDeleted") } }, fmtDateTime(it.deleted_at), h("div.meta", it.deleted_by)),
      h(
        `td.num${it.children ? "" : ".empty"}`,
        { dataset: { label: t("colChildren") } },
        it.children ? t("trashChildren", { n: it.children }) : t("none"),
      ),
      h(
        "td.row-actions",
        h(
          "div.actions",
          h("button.btn.small.secondary", { type: "button", on: { click: () => restore(it) } }, t("restore")),
          isAdmin ? h("button.btn.small.danger", { type: "button", on: { click: () => purge(it) } }, t("purge")) : null,
        ),
      ),
    ),
  );
  clear(
    main,
    h("h2", t("trashTitle")),
    h("p.meta", t("trashHint")),
    items.length
      ? h(
          "div.table-wrap",
          h(
            "table.stack",
            h(
              "thead",
              h(
                "tr",
                [t("colKind"), t("fTitle"), t("colDeleted"), t("colChildren"), ""].map((x) => h("th", x)),
              ),
            ),
            h("tbody", rows),
          ),
        )
      : h("p.empty", t("trashEmpty")),
  );
}
