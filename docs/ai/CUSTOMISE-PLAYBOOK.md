# Customise playbook (for the AI assistant)

Goal: apply an organisation's corporate design and wording to this tracker by changing **only** `instance/`. Read `docs/THEMING.md` (token contract and contrast rules) and `docs/CUSTOMISING.md` first.

## Inputs to ask for (once, together)
- Style guide: a PDF, a website URL, or a list of colours, fonts and logo files. If they give a website, read the CSS colours and fonts from it.
- Logo (SVG preferred) and, if available, a square icon for the favicon. Ask the user to put the files into `instance/assets/`.
- App name, language, and texts they want to change (for example "Inbox" → "Unassigned").

## Steps
1. If `instance/` does not exist, copy `instance.example/` to `instance/` (setup does this too).
2. Map brand colours to tokens: the main dark brand colour → `--color-primary`, a darker shade → `--color-primary-strong`, a secondary brand colour → `--color-accent`. Body text near-black, muted text dark grey. Keep `--color-surface` white or very light.
3. Fonts: Google Fonts via `@import` at the top of `theme.css`; other fonts as files in `instance/assets/` with `@font-face`. Fill `--font` and `--font-heading`. Style switches: uppercase headings or buttons only if the style guide uses them.
4. Set `app.name`, `app.logo`, `app.favicon` in `instance/instance.config.json`. Category colours: pick from the brand palette where they stay distinguishable and ≥ 3:1 on the surface.
5. Texts: create `instance/strings.<locale>.json` with only the changed keys (keys from `public/js/locales/en.js`).
6. Run `npm run check`. For every contrast failure, darken (text) or adjust (marks) that token and run again. Never weaken the check.
7. Run `npm test`. Start `npm run dev` with `--var DEV_AUTH_EMAIL:<email> --var ALLOWED_EMAILS:<email>` (see README "Develop") and show the user the dashboard (grid, a project popup, Gantt). Take screenshots if you can.
8. When the user approves: ask, then `npm run deploy`. Commit `instance/`; ask before pushing.

## Never
- Edit `public/app.css`, `public/index.html`, `public/js/` or anything outside `instance/` to rebrand. If the design truly needs a new token, propose it as an upstream change (`docs/UPDATING.md`).
- Turn off checks or set `checks.denylist` to bypass a failing contrast check (that flag only concerns names in core).
