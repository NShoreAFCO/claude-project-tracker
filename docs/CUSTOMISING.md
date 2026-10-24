# Customising your instance

Everything that makes a deployment yours lives in the `instance/` folder. Core files (`src/`, `public/`, `migrations/`, `test/`, `scripts/`, `docs/`) stay identical to the package, which is what keeps updates painless (`docs/UPDATING.md`).

```
instance/
  instance.config.json   name, language, categories, deploy settings (no secrets)
  theme.css              design tokens (docs/THEMING.md)
  assets/                logo, favicon, fonts
  strings.en.json        optional: change single texts of the English interface
  strings.de.json        optional: the same for German
  seed.json              demo data loaded into an empty database by setup
```

`npm run setup` creates `instance/` from `instance.example/` the first time. Commit `instance/` to your repository: it contains no secrets. Secrets live in `secrets/`, which is never committed.

After any change: `npm run check`, then `npm run deploy` (it rebuilds the generated files first).

## instance.config.json

| Field | Meaning |
|---|---|
| `app.name` | shown in the header, the browser tab and the sign-in consent page |
| `app.locale` | `en` or `de` |
| `app.logo`, `app.favicon` | paths inside `instance/` |
| `categories.project`, `categories.workpackage` | project and work types (README: "Choosing your project and work-package types") |
| `deploy.*` | written by setup: Cloudflare ids, address, allowed emails, audit repository. Edit `allowedEmails` by hand if you like, then run setup again. |
| `upstream` | `false` in your instance; only the package's own repository uses `true` |
| `checks.denylist` | `false` in your instance (the package uses it to keep itself brand-free) |

## Texts

To change single texts without touching core, create `instance/strings.en.json` (or `.de.json`) with only the keys you want to change. The keys are in `public/js/locales/en.js`. Nested keys are nested objects:

```json
{
  "appTitle": "Acme Projects",
  "navInbox": "Unassigned",
  "status": { "on_hold": "Paused" }
}
```

A new language means a new locale file in core: contribute it upstream (`docs/UPDATING.md`) so everyone gets it.

## Demo data

`instance/seed.json` is loaded once, by setup, into an empty database. Change it to start with your own example project, or make it `{ "projects": [] }` to start empty. It is never loaded again once the database has projects.

## Your own repository or a fork

| | Own repository from the template | Fork |
|---|---|---|
| Create | `gh repo create <name> --private --template <package-repo> --clone` | `gh repo fork <package-repo> --clone` |
| Visibility | private, independent | follows the package's visibility rules |
| Updates | add the package as `upstream` once (`docs/UPDATING.md`) | `upstream` is set automatically |
| Contributing back | via a fork or a patch | pull request directly |

Both work the same way otherwise. Use the template for a company deployment; use a fork if you mainly want to improve the package itself.
