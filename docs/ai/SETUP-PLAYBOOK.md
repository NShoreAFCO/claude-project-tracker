# Setup playbook (for the AI assistant)

You are helping someone, possibly with little technical background, set up this tracker. `docs/INSTALL.md` is the human guide; this playbook tells you how to drive it efficiently. Keep your messages short: one step at a time, the exact thing to click or type, what they should see.

## Hard rules
- Never read, list or search `secrets/`, `.dev.vars` or `backups/`. Never ask for a token, password or secret in the chat. If the user pastes one anyway, tell them to revoke it and create a new one (INSTALL §6 for the Cloudflare token).
- Never run `npm run setup`, `npm run teardown`, `npm run secrets:rotate` or `npm run hook:install` yourself. They ask for secrets or change the user's machine. Give the user the command to run in **their own terminal window**.
- Ask before `npm run deploy`, `npm run db:migrate:remote`, `git push`.

## 0. Find out where they are (one command)

Run `npm run setup:check` (it prints names and pass/fail only, never secrets) and `git remote -v`. Then jump to the first section whose condition is not met:

| Condition | Section |
|---|---|
| `node`, `git`, `gh` missing or `gh auth status` fails | 1 |
| no `node_modules/` | 2 |
| "instance/instance.config.json exists" fails, or deploy/secret lines fail | 3 |
| access checks fail | 4 |
| everything ok | 5 |

## 1. Tools
Run `node --version; git --version; gh --version; gh auth status`. For anything missing, give the INSTALL §2 commands for their OS (ask which OS only if you cannot tell from the shell). `gh auth login` is interactive: the user runs it.

## 2. Package
`npm install` (you may run it). If it fails with network errors, ask whether a company proxy is in use.

## 3. Cloudflare and setup
Say, in this order, waiting for "done" each time:
1. INSTALL §5.1, workers.dev subdomain: "Open dash.cloudflare.com → Workers & Pages. If it asks for a subdomain, choose a short name."
2. INSTALL §5.2, Zero Trust: "Open Zero Trust in the left menu, choose a team name and the Free plan."
3. INSTALL §6, API token: give the permission table exactly as in INSTALL. Remind them to copy the token and **not** paste it into the chat.
4. "In a separate terminal window, in this folder, run: `npm run setup`." Explain the questions briefly (INSTALL §7 table). Suggest: allowed emails = everyone who should use it; language; types to switch off (show the README tables if they want to choose).
5. When they report back, run `npm run setup:check`. If a step failed, the setup printed a plain fix. Ask them to paste **only the ✗ line and the line below it** (these never contain secrets) and explain the fix from INSTALL §15.

The Claude Code `!` prefix does not work for setup: it gives the script no interactive terminal, so setup refuses to ask for the token (`docs/VERIFIED.md`). Always a separate terminal window.

## 4. Access checks failing
Access changes take one to two minutes. Wait, then run `npm run setup:check` again. If "Dashboard redirects…" still fails, the Access application for the whole site is missing: ask them to rerun `npm run setup`. If "MCP endpoint demands a token" returns 302, the machine-paths application is missing: same fix.

## 5. After setup (do these with the user)
1. Dashboard: open the printed URL, sign in with an allowed email (code by email). INSTALL §8.
2. claude.ai connector: INSTALL §9 (URL ends with `/mcp`). Then suggest the project instruction from `docs/ai/claude-ai-project-instructions.md`.
3. Claude Code: you may run `claude mcp add --transport http tracker <url>/mcp --scope user` **after asking**; then the user runs `/mcp` → authenticate.
4. Session hook: user runs `npm run hook:install`, then restarts Claude Code.
5. Webhooks, per repository: you may run `node scripts/add-webhook.mjs "<owner>/<repo>"` after asking; it passes the secret via stdin and prints no secret.
6. Commit the instance: `git add instance && git commit -m "Instance settings"`; ask before `git push`. This does not depend on steps 1–5 (the hook installer only reads `instance/`); it comes last only because a failed check usually means a setup rerun, which rewrites `instance/`. Commit again after every rerun. Never commit `instance/` in the upstream template repository.

## Stop and ask a human when
- Cloudflare shows errors not listed in INSTALL §15, or payment questions beyond choosing the Free plan.
- The user's organisation already has a Zero Trust team with existing policies (setup adds its own apps and policies by name, but someone responsible for that account should agree).
- Anything would require editing core files (`src/`, `public/`, `migrations/`, `scripts/`).
