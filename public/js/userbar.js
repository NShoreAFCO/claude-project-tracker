import { t, LOCALE, AVAILABLE, setLocale, rememberLocale } from "./i18n.js";
import { api } from "./api.js";
import { h, clear, toastError } from "./dom.js";
import { getMe, role, loadMe, POLICY } from "./access.js";

export function renderUserBar(el, onLocaleChange) {
  const offered = POLICY.locales.filter((code) => AVAILABLE.includes(code));
  const person = getMe();
  const accessRole = role();
  const children = [];

  if (person) {
    children.push(h("span.who", person.display_name || person.name));

    if (accessRole !== null) {
      children.push(
        h(
          "span.badge.role-badge",
          {
            class: "role-" + accessRole,
            title: t("roleBadgeTitle"),
          },
          t("accessRole." + accessRole),
        ),
      );
    }
  }

  if (offered.length > 1) {
    const options = offered.map((code) =>
      h(
        "option",
        {
          value: code,
          selected: code === LOCALE,
        },
        t("localeName." + code),
      ),
    );

    children.push(
      h(
        "select.lang-switch",
        {
          "aria-label": t("languageLabel"),
          on: {
            change: async (event) => {
              const code = event.target.value;

              if (!setLocale(code)) {
                return;
              }

              rememberLocale(code);

              const currentPerson = getMe();

              if (currentPerson) {
                try {
                  await api.updateMe({ locale: code }, currentPerson.version);
                  await loadMe();
                } catch (e) {
                  toastError(e);
                }
              }

              onLocaleChange();
            },
          },
        },
        ...options,
      ),
    );
  }

  clear(el, ...children);
}
