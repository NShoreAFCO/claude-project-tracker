// Trash view (spec F10): deleted items with restore; purge (admins, after the retention period).
import { t, fmtDateTime } from "./i18n.js";
import { api } from "./api.js";
import { h, clear, toast, toastError, confirmDialog } from "./dom.js";
import { changed } from "./forms.js";

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
      h("td", t(`entityKind.${it.kind}`)),
      h("td", h("strong", it.title), it.project_id && it.kind !== "project" ? h("div.meta", it.project_id) : null),
      h("td", fmtDateTime(it.deleted_at), h("div.meta", it.deleted_by)),
      h("td.num", it.children ? t("trashChildren", { n: it.children }) : t("none")),
      h(
        "td",
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
            "table",
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
