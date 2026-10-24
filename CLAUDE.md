# Project tracker — instructions for Claude Code

## What this is
A Cloudflare Worker (dashboard, remote MCP server, REST API, GitHub webhook, optional audit export) plus Node setup scripts. Spec: `docs/SPEC.md`. Verified API versions and Cloudflare calls: `docs/VERIFIED.md`.

## Map
- `src/` Worker · `public/` dashboard (plain ES modules) · `migrations/` D1 schema · `test/` vitest (Workers runtime)
- `scripts/` setup, checks, hook installer, webhook, backup (`scripts/test/` = node:test)
- `instance.example/` default identity · `instance/` this deployment's identity (name, locale, categories, theme, logo, seed, deploy settings)
- Generated, never edit: `wrangler.jsonc`, `src/generated/`, `public/instance/`, `seed/seed.sql`

## Guiding a user
- Setting up: follow `docs/ai/SETUP-PLAYBOOK.md`. Corporate design: `docs/ai/CUSTOMISE-PLAYBOOK.md`. Human guide: `docs/INSTALL.md`.
- Start every setup conversation with `npm run setup:check`; it reports state without secrets.

## Rules
- Never read, list, search or print anything in `secrets/`, `.dev.vars` or `backups/`. Never ask the user to paste a secret into the chat.
- Never run `npm run setup`, `npm run teardown`, `npm run secrets:rotate` or `npm run hook:install` yourself: they are interactive or change the user's machine. Tell the user the exact command to run in their own terminal.
- You may run: `npm install`, `npm test`, `npm run typecheck`, `npm run check`, `npm run setup:check`, `npm run build:instance`, `npm run dev`.
- Ask before `npm run deploy`, `npm run db:migrate:remote`, `git push`, or deleting anything.
- Rebranding changes `instance/` only, never core files. Core fixes go upstream (`docs/UPDATING.md`).
- Verify with scripts (`npm test`, `npm run check`) before any browser check.
