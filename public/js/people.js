// People view (spec 4.1): list, add and edit persons. Editors manage stakeholders; only admins change access
// roles or the email of a user.
import { t } from "./i18n.js";
import { api } from "./api.js";
import { h, clear, formDialog, saveWithConflict, toast, menuButton, personBadge } from "./dom.js";
import { changed, deleteEntity } from "./forms.js";

const ROLES = ["viewer", "editor", "decider", "admin"];

/** Create (existing = null) or edit a person. canAdmin: may set access role and a user's email. */
export function personForm(existing, canAdmin) {
  const p = existing || {};
  const isUser = !!existing && existing.access_role !== null;
  const fields = [
    { name: "name", label: t("fPersonName"), required: true, value: p.name },
    { name: "display_name", label: t("fDisplayName"), value: p.display_name },
    { name: "company", label: t("fCompany"), value: p.company },
    { name: "function", label: t("fFunction"), value: p.function },
    { name: "internal", label: t("fInternal"), type: "checkbox", value: !!p.internal },
    // a user's email is their login: only admins change it
    { name: "email", label: t("fEmail"), type: "email", value: p.email, disabled: isUser && !canAdmin },
    { name: "phone", label: t("fPhone"), value: p.phone },
    { name: "contact_note", label: t("fContactNote"), type: "textarea", rows: 3, value: p.contact_note },
    { name: "comment", label: t("fComment"), type: "textarea", rows: 3, value: p.comment },
  ];
  if (canAdmin)
    fields.push({
      name: "access_role",
      label: t("fAccessRole"),
      type: "select",
      options: [["", t("noAccessRole")], ...ROLES.map((r) => [r, t(`accessRole.${r}`)])],
      value: p.access_role ?? "",
    });
  return formDialog({
    title: existing ? t("formPersonEdit") : t("formPersonNew"),
    narrow: false,
    fields,
    onSubmit: async (v) => {
      const body = { ...v };
      if (!existing) {
        for (const k of Object.keys(body)) if (body[k] === null) delete body[k];
        const created = await api.createPerson(body);
        toast(t("saved"));
        changed(null);
        return created;
      }
      const res = await saveWithConflict(
        (ver) => api.updatePerson(existing.id, body, ver),
        existing.version,
        (cur) => h("p", `${cur.name} · v${cur.version}`),
      );
      if (res?.cancelled) return undefined;
      if (!res?.reload) toast(t("saved"));
      changed(null);
      return res;
    },
  });
}

/** Own profile: display name, phone, UI language (PATCH /api/persons/me). */
function profileForm(me) {
  return formDialog({
    title: t("formProfile"),
    fields: [
      { name: "display_name", label: t("fDisplayName"), value: me.display_name },
      { name: "phone", label: t("fPhone"), value: me.phone },
      {
        name: "locale",
        label: t("fLocale"),
        type: "select",
        options: [
          ["", t("localeDefault")],
          ["en", "English"],
          ["de", "Deutsch"],
        ],
        value: me.locale ?? "",
      },
    ],
    onSubmit: async (v) => {
      const res = await saveWithConflict(
        (ver) => api.updateMe(v, ver),
        me.version,
        (cur) => h("p", `${cur.name} · v${cur.version}`),
      );
      if (res?.cancelled) return undefined;
      toast(t("saved"));
      changed(null);
      return res;
    },
  });
}

/** Same rule as the server's chip initials. */
function initialsOf(p) {
  const dn = (p.display_name || "").trim();
  if (/^\p{L}{1,3}$/u.test(dn)) return dn.toUpperCase();
  const words = (dn || p.name || "")
    .trim()
    .split(/[\s-]+/)
    .filter(Boolean);
  if (!words.length) return "?";
  return ([...words[0]][0] + (words.length > 1 ? [...words[words.length - 1]][0] : "")).toUpperCase();
}

export async function renderPeople(main) {
  clear(main, h("h2", t("peopleTitle")), h("p", t("loading")));
  const [persons, me] = await Promise.all([
    api.persons(),
    api
      .whoami()
      .then((w) => w.person || null)
      .catch(() => null),
  ]);
  const canAdmin = me?.access_role === "admin";

  const rows = persons.map((p) =>
    h(
      "tr",
      h(
        "td.p-name",
        personBadge({ name: p.name, initials: initialsOf(p) }),
        " ",
        h("strong", p.name),
        p.display_name ? h("div.meta", p.display_name) : null,
        // phones show a stacked card: function and company on a second line
        [p.function, p.company].some(Boolean) ? h("div.meta.p-sub", [p.function, p.company].filter(Boolean).join(" · ")) : null,
      ),
      h("td.p-company", p.company || t("none")),
      h("td.p-function", p.function || t("none")),
      h("td", { dataset: { label: t("colType") } }, p.internal ? t("internal") : t("external")),
      h(
        `td${p.email || p.phone ? "" : ".empty"}`,
        { dataset: { label: t("colContact") } },
        p.email || (p.phone ? "" : t("none")),
        p.phone ? h("div.meta", p.phone) : null,
      ),
      h(
        `td${p.access_role ? "" : ".empty"}`,
        { dataset: { label: t("fAccessRole") } },
        p.access_role ? t(`accessRole.${p.access_role}`) : t("none"),
      ),
      h(
        "td.row-actions",
        h(
          "div.actions",
          h("button.btn.small.ghost", { type: "button", on: { click: () => personForm(p, canAdmin) } }, t("edit")),
          menuButton(t("moreActions"), [{ label: t("delete"), danger: true, onClick: () => deleteEntity("person", p.id, p.name, null) }]),
        ),
      ),
    ),
  );

  clear(
    main,
    h(
      "div.toolbar",
      h("h2", t("peopleTitle")),
      h("span.spacer"),
      me ? h("button.btn.secondary", { type: "button", on: { click: () => profileForm(me) } }, t("myProfile")) : null,
      h("button.btn", { type: "button", on: { click: () => personForm(null, canAdmin) } }, `+ ${t("newPerson")}`),
    ),
    h("p.meta", t("peopleHint")),
    persons.length
      ? h(
          "div.table-wrap",
          h(
            "table.stack",
            h(
              "thead",
              h(
                "tr",
                [t("colName"), t("fCompany"), t("fFunction"), t("colType"), t("colContact"), t("fAccessRole"), ""].map((x) => h("th", x)),
              ),
            ),
            h("tbody", rows),
          ),
        )
      : h("p.empty", t("noPeople")),
  );
}
