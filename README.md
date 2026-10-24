# Project tracker for Claude

One Cloudflare Worker that tracks projects you work on with Claude, across claude.ai, the Claude apps and Claude Code.

- **Dashboard** (`/`): projects, work packages, milestones, branches, scorecards, token cost, Gantt chart, inbox, and a context repository per project, work package and branch.
- **Remote MCP server** (`/mcp`): 17 tools plus `tracker://context/{doc_id}` resources, for claude.ai connectors and Claude Code.
- **REST API** (`/api/*`): used by the dashboard and the Claude Code SessionEnd hook.
- **GitHub webhook** (`/webhooks/github`): branches, pushes, pull requests and forks (HMAC-checked).
- **Audit log (optional)**: an hourly commit of a snapshot, the context documents and the event log to a GitHub repository of your choice.

Every human-facing path sits behind Cloudflare Access. The machine paths (`/mcp`, `/oauth/*`, `/.well-known/*`, `/webhooks/github`) authenticate on their own.

## Your instance

Everything that makes a deployment yours lives in one folder, `instance/`: name, language, categories, theme, logo, demo data and deploy settings. The package ships `instance.example/`; setup creates `instance/` from it. Core code never needs editing to rebrand.

## Choosing your project and work-package types

Every project gets one **project type**, and every work package gets one **work type** (sub-packages inherit their parent's type unless they set their own). The types colour the dashboard cards, group the project grid and colour the Gantt bars. Claude also sees the list when it creates projects and work packages.

The package ships a generic catalogue, so you only switch off what your organisation does not need.

**Project types** (`categories.project`):

| Key | Label |
|---|---|
| `research` | Research |
| `product-development` | Product development |
| `product-launch` | Product launch |
| `product-optimisation` | Product optimisation |
| `process-development` | Process development |
| `process-implementation` | Process implementation |
| `process-optimisation` | Process optimisation |
| `digital-it` | Digital & IT |
| `quality-regulatory` | Quality, regulatory & compliance |
| `marketing-communication` | Marketing & communication |
| `sales-customer` | Sales & customer projects |
| `training-knowledge` | Training & knowledge |
| `organisation-change` | Organisation & change |
| `other` | Other |

**Work types** (`categories.workpackage`). "Off the computer" types are marked as human work by default: Claude logs the progress you report, and sets them to done only when you say so.

| Key | Label | Off the computer by default |
|---|---|---|
| `pm` | Planning & decisions | yes |
| `research` | Research | |
| `design` | Design & concept | |
| `coding` | Coding | |
| `data` | Data analysis | |
| `experimental` | Hands-on & lab work | yes |
| `testing` | Testing & validation | |
| `procurement` | Procurement & suppliers | yes |
| `regulatory` | Regulatory & approvals | |
| `docs` | Reports & documentation | |
| `communication` | Communication & media | |
| `training` | Training & handover | yes |
| `rollout` | Rollout & operations | |
| `review` | Review & sign-off | yes |

### How to choose

1. Open `instance/instance.config.json`. If you have no `instance/` folder yet, copy `instance.example/` to `instance/` first; setup does this for you.
2. In `categories.project` and `categories.workpackage`, add `"enabled": false` to every type you do not want:

   ```json
   { "key": "sales-customer", "enabled": false, "color": "#96612d", "label": { "en": "Sales & customer projects", "de": "Vertrieb & Kundenprojekte" } }
   ```

3. Optional changes you can make in the same place:
   - Rename a type: change its `label` (`en`, and `de` if you use German).
   - Change its colour: `color`, as `#rrggbb`. `npm run check` makes sure it stays readable (at least 3:1 against the page background).
   - Change the default human flag of a work type: `human`.
   - Add a type of your own: a new entry with a unique lower-case `key`.
   - The order of the entries is the order in menus and in the grid.
4. Run `npm run check`, then `npm run deploy`. Both rebuild the generated files from your config.

Rules worth knowing:
- **Keep keys stable.** The key is what is stored in the database; the label is only what people see. Rename labels freely, but don't rename keys of types that are in use.
- **Switching a type off is safe.** Projects and work packages that already use it keep their value. The dashboard shows them under "No category" and displays the raw key, and nobody can pick the type for new items. Switch it back on and everything returns to normal.
- Each list must keep at least one enabled type; the build stops with a clear message otherwise.
- There is no admin screen for this yet. For now the types are chosen in the config file, which keeps them versioned with the rest of your instance.

## Guides

- Install: `docs/INSTALL.md` *(written in a later step)*
- Customise and theme: `docs/CUSTOMISING.md`, `docs/THEMING.md` *(later step)*
- Updates from upstream: `docs/UPDATING.md` *(later step)*
- Technical specification: [`docs/SPEC.md`](docs/SPEC.md); verified API versions: [`docs/VERIFIED.md`](docs/VERIFIED.md)

## Develop

```powershell
npm install
npm test                 # builds the instance files, then vitest (Workers runtime) and the script tests
npm run typecheck
npm run check            # repo checks: secrets, theme contract, identity
npx wrangler d1 migrations apply tracker-db --local
npm run db:seed:local
npx wrangler dev --var DEV_AUTH_EMAIL:you@example.com --var ALLOWED_EMAILS:you@example.com
```

`DEV_AUTH_EMAIL` stands in for the Access login, and only for requests to `localhost` / `127.0.0.1`.
