# Install guide

This guide takes you from nothing to a working project tracker that you and your colleagues use from claude.ai, the Claude apps and Claude Code. You do not need to be a developer. Every command is given exactly; copy it, paste it, press Enter.

**Time:** about 60–90 minutes the first time, most of it creating accounts.
**Cost:** the Cloudflare and GitHub free plans are enough for a team (see "Limits" at the end).

> **Working with an AI assistant?** Open Claude Code in the project folder (step 4) and say: *"Help me set up this tracker. Follow docs/ai/SETUP-PLAYBOOK.md."* It will guide you through this document, run the safe commands for you and tell you exactly when you have to click something yourself. Two things it will never do: read your `secrets/` folder, or type secrets for you.

## How it fits together (one minute of background)

- The tracker is a small program (a "Worker") that runs on **Cloudflare**, a hosting company. Its data lives in a Cloudflare database.
- **Cloudflare Access** guards it: only the email addresses you allow can open the dashboard. People sign in with a code that Access emails to them.
- **Claude** connects to the tracker as a "connector" and reads and writes projects for you.
- The code lives on **GitHub** in your own copy of this package. Your settings live in the `instance/` folder of that copy, so updates to the package never overwrite them.
- Secrets (passwords and keys) stay on your computer in a folder called `secrets/`. They are never uploaded to GitHub and never shown on screen.

## Contents

1. Accounts you need
2. Install the tools on your computer
3. Get your own copy of the package
4. Open the folder in a terminal (and in Claude Code)
5. Prepare Cloudflare (two clicks)
6. Create the Cloudflare API token
7. Run the setup
8. Open the dashboard
9. Connect Claude
10. Install the Claude Code session hook (optional, recommended)
11. Connect GitHub repositories (optional)
12. Save your settings in your repository
13. Add or remove people
14. Updates
15. Troubleshooting
16. Back up, rotate secrets, uninstall
17. Limits

---

## 1. Accounts you need

| Account | Why | Where |
|---|---|---|
| GitHub | holds your copy of the code | <https://github.com/signup> |
| Cloudflare | runs the tracker and guards it | <https://dash.cloudflare.com/sign-up> |
| Claude (Pro, Max, Team or Enterprise) | custom connectors need a paid plan | <https://claude.ai> |

Use an email address you can read right now: both sign-ups send a confirmation email.

**You should see:** you can log in to github.com and dash.cloudflare.com.

## 2. Install the tools on your computer

You need four programs. Install them once.

### Windows

Open **PowerShell**: press the Windows key, type `PowerShell`, press Enter. Then paste these lines one at a time:

```powershell
winget install --id OpenJS.NodeJS.LTS -e
winget install --id Git.Git -e
winget install --id GitHub.cli -e
```

Close PowerShell and open it again (new programs are only found in a new window). Then install Claude Code:

```powershell
npm install -g @anthropic-ai/claude-code
```

### macOS

Open **Terminal** (Spotlight: `Terminal`). If you don't have Homebrew yet, install it from <https://brew.sh> (one command on that page). Then:

```bash
brew install node git gh
npm install -g @anthropic-ai/claude-code
```

### Linux

Install Node.js 20 or newer, git and the GitHub CLI with your package manager (`gh` instructions: <https://cli.github.com>), then `npm install -g @anthropic-ai/claude-code`.

### Check

```powershell
node --version
git --version
gh --version
claude --version
```

**You should see:** four version numbers. Node must be `v20` or higher.
**If not:** close the window, open a new one and try again. If a command is still "not recognized", reinstall that tool.

### Log the GitHub CLI in

```powershell
gh auth login
```

Answer: `GitHub.com` → `HTTPS` → `Yes` (authenticate Git) → `Login with a web browser`. Copy the code shown, press Enter, paste the code in the browser and approve.

**You should see:** `✓ Logged in as <your-name>`.

## 3. Get your own copy of the package

You will work in your **own** repository, so you can commit your settings and still receive updates.

The package is published at `NShoreAFCO/claude-project-tracker`. If someone gave you a copy from a different address, use theirs in the commands below. Then choose one of these:

**A. Your own repository from the template (recommended):**

```powershell
cd $HOME\Documents
gh repo create my-project-tracker --private --template NShoreAFCO/claude-project-tracker --clone
cd my-project-tracker
```

Your repository stays private. Replace `my-project-tracker` with any name you like.

**B. A fork** (choose this if you want to send improvements back easily): `gh repo fork NShoreAFCO/claude-project-tracker --clone`, then `cd claude-project-tracker`. A fork of a public repository is public too, so don't commit anything private to it. Your secrets stay in the ignored `secrets/` folder either way.

**You should see:** a new folder with files such as `README.md`, `package.json` and `instance.example`.

Now install the package's helpers (this takes a minute):

```powershell
npm install
```

**You should see:** `added … packages`. Warnings are normal; errors are not (see Troubleshooting).

## 4. Open the folder in a terminal (and in Claude Code)

Every command from here on runs **inside this folder**. If you open a new window later, first go back into it, for example `cd $HOME\Documents\my-project-tracker`.

If you want Claude Code's help, start it in the same folder:

```powershell
claude
```

Claude reads `CLAUDE.md` and knows how to help. Keep a **second** terminal window open in the same folder for the commands that ask for secrets (step 7).

## 5. Prepare Cloudflare (two clicks)

Two things in Cloudflare must exist before the setup can run. Both are one-time choices that only you can make.

1. **Your workers.dev address.** Log in to <https://dash.cloudflare.com>, open **Workers & Pages** in the left menu. If Cloudflare asks you to choose a subdomain, pick a short name (for example your organisation's name). Your tracker will live at `https://<tracker-name>.<that-subdomain>.workers.dev`.
2. **Zero Trust (Cloudflare Access).** In the left menu open **Zero Trust**. Choose a **team name** (for example `myorg`; it becomes `myorg.cloudflareaccess.com`) and the **Free** plan. Cloudflare may ask for payment details even for the free plan; nothing is charged on the free plan.

**You should see:** the Zero Trust overview page, and under Workers & Pages your `….workers.dev` subdomain.

## 6. Create the Cloudflare API token

The setup needs permission to create things in your Cloudflare account. You give it that permission with an **API token**. Think of it as a key that only opens the doors listed below.

1. Open <https://dash.cloudflare.com/profile/api-tokens>.
2. Click **Create Token**, then at the bottom **Create Custom Token** → **Get started**.
3. **Token name:** `project-tracker-setup`.
4. **Permissions.** Add one row per line below (first box **Account**, then the permission, then **Edit** or **Read**). Use **+ Add more** for each new row:

   | | Permission | Access |
   |---|---|---|
   | Account | Workers Scripts | Edit |
   | Account | D1 | Edit |
   | Account | Workers KV Storage | Edit |
   | Account | Access: Apps and Policies | Edit |
   | Account | Access: Service Tokens | Edit |
   | Account | Access: Organizations, Identity Providers, and Groups | Edit |
   | Account | Account Settings | Read |

5. **Account Resources:** `Include` → your account.
6. **TTL** (optional): set an end date if your organisation requires one. You only need the token for setup and later updates.
7. Click **Continue to summary** → **Create Token**.
8. Cloudflare shows the token **once**. Click **Copy**. Do not paste it into a chat, an email or a document. You paste it into the setup in the next step, where it is hidden.

**If you lose it:** create a new token the same way; the setup asks again if the saved one stops working (delete `secrets/instance.secrets.json` first to be asked).

## 7. Run the setup

This is the main step. One command creates everything in Cloudflare, stores the secrets, deploys the tracker and checks that it is protected.

Run it **yourself**, in a normal terminal window in the project folder. Don't run it through an AI assistant: you will paste the API token, and only your own terminal hides it properly.

```powershell
npm run setup
```

The setup asks a few questions. Press Enter to accept the value in `[brackets]`.

| Question | What to answer |
|---|---|
| Name shown in the dashboard header | e.g. `Acme Project Tracker` |
| Dashboard language | `en` (English) or `de` (German) |
| Email addresses allowed | everyone who may use the tracker, comma-separated, e.g. `jane@example.com, joe@example.com`. You can change this later. |
| Admin email(s) | who administers the tracker (manages people's roles, later also the trash). Enter keeps the offered address (the first allowed one). Each admin must also be an allowed address. Everyone else starts as an editor. |
| Short name for the tracker | becomes part of the web address, e.g. `project-tracker` → `https://project-tracker.<subdomain>.workers.dev` |
| Switch off any project types / work types | Enter keeps all. Type keys such as `sales-customer, other` to hide types you don't use (README: "Choosing your project and work-package types"). |
| Cloudflare API token | paste the token from step 6. Only `*` appear. Press Enter. |
| Optional audit log | `n` unless you want an hourly backup of all tracker data to a private GitHub repository (see below). |

Then it works through about twenty steps and prints a line for each:

```
  ✓ Database (D1) — project-tracker-db created
  ✓ Access application: whole tracker — created
  ...
  ✓ Check the access protection — all 4 checks passed
```

At the end it prints the dashboard address and the next steps.

**If a step shows ✗:** read the message under it. It says what to do (for example "open Workers & Pages once"). Fix that, then run `npm run setup` again. Finished steps are reused, so nothing is created twice.

**Audit log (optional).** If you answer `y`, the setup creates a private GitHub repository and opens GitHub's token page. Create a **fine-grained token**: Repository access → *Only select repositories* → the audit repository; Permissions → *Contents: Read and write*; expiry 1 year. Copy it and paste it into the setup when asked. Every hour the tracker then commits a snapshot of all projects, context documents and events to that repository.

**What the setup created** (all named after your short name, e.g. `project-tracker`):

- the Worker `project-tracker` and its database `project-tracker-db`
- the login store `project-tracker-oauth`
- three Access applications: `project-tracker` (the whole site, for people), `project-tracker-machine-paths` (the endpoints Claude and GitHub call; they check their own tokens) and `project-tracker-mcp-login` (the sign-in Claude uses)
- three Access policies and the service token `project-tracker-hook`

Secrets are in `secrets/instance.secrets.json` on your computer, and the settings are in `instance/instance.config.json`.

## 8. Open the dashboard

Open the address the setup printed, e.g. `https://project-tracker.<subdomain>.workers.dev`.

1. Cloudflare shows a sign-in page. Enter one of the allowed email addresses.
2. Check that mailbox for a code from Cloudflare, enter it.
3. You see the dashboard with one demo project, "Example: website relaunch".

**If no code arrives:** check spam. Codes are only sent to allowed addresses. The page looks the same for other addresses, but no code is sent (on purpose). Check the spelling in `instance/instance.config.json` → `deploy.allowedEmails`, then see "Add or remove people".

You can delete the demo project from its row menu (⋯ → Delete) whenever you like. Deleted items go to the Trash view, where an admin can restore them.

Your own entry appears in the **People** view after your first sign-in, with the admin role if you named yourself as admin in the setup. Admins give other people a role there (viewer, editor, decider, admin); someone who signs in for the first time gets the default role (`editor`). Stakeholders without a login can be added there too.

What each role may do: a **viewer** reads (and edits only their own language, name and phone); an **editor** also writes projects, work packages and the rest; a **decider** also closes and reopens projects, records gate decisions and verifies sign-offs; an **admin** also changes roles and email addresses, deletes users, and restores from and purges the Trash. Claude (through the connector) acts with your role, but never decides gates, manages roles or purges. The admin role is given from the setup list at first sign-in; someone on the list who signed in earlier becomes admin only while the tracker has no admin. Later changes are made in the People view. A role change applies on the person's next request.

## 9. Connect Claude

### claude.ai, Claude Desktop and the Claude mobile app

1. In claude.ai open **Settings → Connectors → Add custom connector**.
2. Name: `Project tracker`. URL: your dashboard address followed by `/mcp`, e.g. `https://project-tracker.<subdomain>.workers.dev/mcp`.
3. Click **Connect**. A window opens: approve "Allow access?", then sign in with your email code as in step 8.
4. Desktop and mobile apps use the same account and pick the connector up automatically.

Each person connects their own Claude account the same way.

**Try it:** in a new chat ask *"List my tracker projects."* Claude should name the demo project.

**Tell Claude how to use it.** In a claude.ai **Project**, add this to the project instructions (copy from `docs/ai/claude-ai-project-instructions.md`):

> Before working on a tracked project, call tracker `get_context_bundle` for it. At the end of substantive work, call `log_progress` and `append_context` (slug `handover`) with what was done, decisions and open points.

### Claude Code

In any terminal:

```powershell
claude mcp add --transport http tracker https://project-tracker.<subdomain>.workers.dev/mcp --scope user
```

Then start `claude`, type `/mcp`, choose `tracker` → **Authenticate**, and sign in in the browser.

If `claude mcp list` already shows a server named `tracker` (for example from another organisation's tracker), pick a different name for this one, such as `tracker-<org>`, in the command above and in `/mcp`. Give the claude.ai connector a distinct name the same way.

## 10. Install the Claude Code session hook (optional, recommended)

The hook tells the tracker each time a Claude Code session ends: which folder, branch and last commit, plus the folder's `session.md` handover notes. The tracker files this under the matching project, or in the **Inbox** if it can't match the folder.

```powershell
npm run hook:install
```

It copies the hook to your Claude Code folder, adds it to Claude Code's settings (after a backup), stores the tracker address and the hook's service token as your user environment variables, and sends one test message.

The hook also sends the name of your computer (so the dashboard can show where a project's folder lives) and, if the folder has one, its `HANDOFF.md`, which appears as a pinned **HANDOFF** document on the project. Files over 256 KB are skipped. If you update the tracker, run `npm run hook:install` again so your copy of the hook is replaced by the new version.

**You should see:** `✓` lines and a successful test.
Then **restart Claude Code**, and on Windows open a new terminal window, so the new settings are picked up.

To link a project to a folder, set the project's **Local path** (or its **Repository URL**) in the dashboard.

## 11. Connect GitHub repositories (optional)

With a webhook, GitHub tells the tracker about new branches, pushes and pull requests, so they appear on the project automatically. Do this per repository. Set the repository's URL on the tracker project first.

The webhook needs the secret the setup generated. This command reads it from `secrets/` and passes it to GitHub without showing it. Replace the two placeholders (keep the quotes):

```powershell
node scripts/add-webhook.mjs "<owner>/<repository>"
```

**You should see:** `✓ webhook added`. On GitHub, repository → Settings → Webhooks shows a green tick after the first delivery.

## 12. Save your settings in your repository

The setup wrote your settings to `instance/`. Commit them, so they are safe and shared with anyone who maintains the tracker (they contain no secrets). Without them, a fresh copy cannot redeploy to the same Cloudflare resources.

This step does not depend on steps 8–11; the hook installer only reads `instance/`. It comes last because if a check fails, you usually rerun `npm run setup`, and that rewrites `instance/`. Commit again after every rerun.

```powershell
git add instance
git commit -m "Instance settings"
git push
```

## 13. Add or remove people

1. Edit `instance/instance.config.json` → `deploy` → `allowedEmails` (a list in quotes, comma-separated).
2. Run `npm run setup` again and press Enter through the questions; the new list is shown as the default. It updates the Access policy and redeploys.
3. Commit the change (step 12).

People you remove can no longer sign in, and their Claude connections stop working as soon as the new list is deployed. Their entry in the tracker's people list stays, so history still shows who did what. To lock out a person at once, an admin can also delete them in the People view; they are refused with "person deactivated" until an admin restores them from the Trash.

Clearing a person's role in the People view does not lock them out (the default role is applied again at their next sign-in). To revoke access, remove the email as above or delete the person.

## 14. Updates

When the package receives improvements, follow `docs/UPDATING.md`. In short: fetch the update, merge it, `npm install`, `npm test`, `npm run db:migrate:remote`, `npm run deploy`. Your `instance/` folder is never touched by updates.

## 15. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `npm run setup` says it is interactive | It was started without a terminal (e.g. by an AI tool). Run it yourself in a terminal window. |
| ✗ "has no workers.dev address yet" | Step 5.1: open Workers & Pages once and choose a subdomain. |
| ✗ "Zero Trust is not set up" | Step 5.2: open Zero Trust, choose a team name and the Free plan. |
| ✗ "Cloudflare refused … (403)" | The API token lacks a permission or is for another account. Compare with the table in step 6, or create a new token. To enter a new token: delete `secrets/instance.secrets.json` (other values are recreated) or ask your AI assistant for the safe way. |
| ✗ "can see several accounts" | Limit the token to one account (step 6.5). |
| ✗ at "Check the access protection" | Access settings take a minute or two to apply. Wait, then run `npm run setup:check`. |
| Sign-in code never arrives | Not an allowed address (on purpose no error is shown), or in spam. See step 13. |
| claude.ai connector shows an error after "Connect" | Remove the connector and add it again. Make sure the URL ends with `/mcp`. |
| Claude says the tracker tools failed with an auth error | Disconnect and reconnect the connector (claude.ai) or `/mcp` → re-authenticate (Claude Code). |
| Hook test shows 302 or 401 | The service token was rejected. Run `npm run setup` again (it checks the token and the policy), then `npm run hook:install`. |
| "Someone else changed it" (409) in the dashboard | Two people edited the same thing. The dialog shows the newer version; reload and redo your change. |
| `npm install` fails | Node is older than 20 (`node --version`), or a company proxy blocks downloads. |
| Anything else | `npm run setup:check` shows what is missing. Ask your AI assistant with the output of that command (it contains no secrets). |

## 16. Back up, rotate secrets, uninstall

**Back up the database** (all projects and context documents in one file):

```powershell
npm run backup
```

**You should see:** `Backup written to backups/<database>-<date>.sql`. The `backups/` folder is never committed. Keep the file private, it contains everything in the tracker. To restore into an empty database: `node scripts/wrangler-env.mjs d1 execute <database> --remote --file backups/<file>.sql`.

**Rotate secrets** (for example if a computer with the `secrets/` folder was lost):

```powershell
npm run secrets:rotate
```

This replaces the encryption key and the webhook secret. Then add each GitHub webhook again (step 11) and reconnect Claude. To replace the hook's service token, delete it in Cloudflare Zero Trust → Access → Service credentials, run `npm run setup` and then `npm run hook:install` again. Also create a new API token (step 6) and delete the old one.

**Revoke all Claude connections:** in Cloudflare open Storage & Databases → KV → the `…-oauth` namespace and delete all entries. Everyone signs in again on next use.

**Uninstall:**

```powershell
npm run teardown
```

It lists everything it will delete and asks you to type `delete <name>` to confirm. It only deletes what the setup created for this instance. Afterwards remove the connector in claude.ai, `claude mcp remove tracker` in Claude Code, and the `SessionEnd` entry in `~/.claude/settings.json`.

## 17. Limits

The Cloudflare free plan allows 100,000 Worker requests per day, a 5 GB D1 database and up to 50 Zero Trust users. That is far more than a team's tracker needs. Current limits: <https://developers.cloudflare.com/workers/platform/pricing/> and <https://www.cloudflare.com/plans/zero-trust-services/>.

### PDF reports

Project reports can be downloaded as PDF. The PDF is rendered by Cloudflare Browser Rendering through a binding (`BROWSER`) that setup puts into the generated `wrangler.jsonc`; no extra token or step is needed. On the free plan Browser Rendering allows 10 browser minutes a day and one PDF every 10 seconds: beyond that the PDF button answers "try again later" (503), while the Markdown and HTML reports keep working. Limits: <https://developers.cloudflare.com/browser-rendering/limits/>. The first PDF render has not been checked against a live account yet, so open one report as PDF after your first deploy.

To switch PDF off, set `"report": { "pdf": false }` in `policy` in `instance/instance.config.json`, run `npm run build:instance` and `npm run deploy`. The binding is then left out and the PDF route answers 503.
