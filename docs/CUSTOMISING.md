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
| `policy.*` | rules for this deployment, see the next table. Every field is optional; missing fields use the defaults shown. |
| `deploy.*` | written by setup: Cloudflare ids, address, allowed emails, audit repository. Edit `allowedEmails` by hand if you like, then run setup again. |
| `upstream` | `false` in your instance; only the package's own repository uses `true` |
| `checks.denylist` | `false` in your instance (the package uses it to keep itself brand-free) |

### policy

| Field | Default | Meaning |
|---|---|---|
| `admins` | the admin email(s) you gave in setup | these people get the `admin` role when they first sign in; later only while the tracker has no admin (otherwise an admin changes roles in the People view) |
| `default_role` | `editor` | role of everyone else on first sign-in: `viewer` (read only), `editor`, `decider` (also closes projects, decides gates, verifies sign-offs) or `admin` (also roles, restore and purge) |
| `locales` | `app.locale` first, then the other language | languages people may choose in the dashboard; a project's report `language` must be one of them. The OAuth sign-in pages use the instance default language |
| `stale_days` | `14` | days without activity before a project counts as stale; a project type may set its own `stale_days` |
| `schedule_strict_default` | `false` | default for a project's strict schedule mode (schedule warnings become errors) |
| `target_date_required_categories` | `research`, `product-development`, `product-launch`, `quality-regulatory` (those that exist) | project types that need a target date before they can become active (400 otherwise; a new project without status then starts as `idea`) |
| `gates.require_decision` | `true` | gate milestones need a recorded decision |
| `retention_days` | `30` | deleted items can be purged by an admin after this many days (never automatically) |
| `hide_empty_categories` | `collapse` | `hide` or `collapse` empty type groups on the dashboard |
| `report.paper`, `report.pdf` | `a4`, `true` | paper size (`a4` or `letter`) and PDF of project reports; `false` leaves the Browser Rendering binding out of the deployment and the PDF route answers 503 |
| `score_scales` | short texts for `value`, `quality`, `risk`, `effort`, `token_efficiency` | per criterion: what `0`, `5` and `10` mean, one text per language (`en`, `de`) |

`npm run build:instance` and `npm run setup:check` report a field with a wrong value by name.

## Texts

To change single texts without touching core, create `instance/strings.en.json` (or `.de.json`) with only the keys you want to change. The keys are in `public/js/locales/en.js`. Nested keys are nested objects:

```json
{
  "appTitle": "Acme Projects",
  "navInbox": "Unassigned",
  "status": { "on_hold": "Paused" }
}
```

Texts that the server writes itself, such as project reports, are overridden the same way. Use the key with dots as nested objects, for example `{ "report": { "status": "State" } }`. The keys are in `src/i18n/server.ts`; a key without an override falls back to the built-in text.

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
