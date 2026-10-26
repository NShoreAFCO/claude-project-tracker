# Theming: apply your corporate design

The dashboard's look comes entirely from three places in your `instance/` folder:

| File | Holds |
|---|---|
| `instance/theme.css` | design tokens: colours, fonts, corner radius, a few style switches |
| `instance/assets/` | logo and favicon (any web format: SVG, PNG, WebP) |
| `instance/instance.config.json` | `app.name`, `app.logo`, `app.favicon`, and the category colours |

The core stylesheet `public/app.css` contains **no colour values at all**; it only uses the tokens below. Never edit `public/app.css` or other core files to rebrand: your changes would conflict with every update. `npm run check` enforces this.

After a change: `npm run check` (contrast and completeness), look at it locally (`npm run dev`, see README "Develop"), then `npm run deploy`.

## Token reference

Every token must be defined in `instance/theme.css`. A token may refer to another one (`var(--color-primary)`), but colour tokens must end in a `#rrggbb` value so the contrast check can measure them.

### Brand

| Token | Used for | Rule |
|---|---|---|
| `--color-primary` | filled buttons, table headers, category bars in the grid, active navigation underline, header rule | `--color-on-primary` on it ≥ 7:1 |
| `--color-primary-strong` | button hover, badges, ghost-button text | text on surface and tint ≥ 7:1; `--color-on-primary` on it ≥ 7:1 |
| `--color-on-primary` | text on primary, primary-strong, danger and dark toasts | see above |
| `--color-accent` | secondary-button border, keyboard focus ring, open milestones | – |
| `--color-accent-strong` | secondary-button hover border | – |

### Surfaces and text

| Token | Used for | Rule |
|---|---|---|
| `--color-surface` | page and card background | – |
| `--color-tint` | zebra rows, callouts, hover, inherited context blocks | text tokens on it ≥ 7:1 |
| `--color-border` | lines and outlines | – |
| `--color-text` | body text | ≥ 7:1 on surface and tint |
| `--color-text-strong` | headings, strong text, toasts' background | ≥ 7:1 on surface and tint |
| `--color-text-muted` | secondary text (dates, counts) | ≥ 7:1 on surface |
| `--color-link` | links | ≥ 7:1 on surface |
| `--color-danger` | delete buttons, error messages | ≥ 7:1 on surface; `--color-on-primary` on it ≥ 7:1 |

### Status marks

Coloured stripes and outlines on status chips. Marks, never text: each ≥ 3:1 against `--color-surface`.

`--status-active`, `--status-doing`, `--status-idea` (also waiting, to do, open), `--status-hold` (also blocked, stale, overdue milestones), `--status-done` (also merged), `--status-dropped` (also abandoned, closed, "no category").

Card chips for the status rules: `--status-blocked` (the red "Blocked" chip of a project with a blocked top-level work package) and `--status-waiting` (the amber "Waiting" chip). The chip text stays `--color-text-strong`; the tokens only colour the bar and outline, so they are marks like the others (≥ 3:1 on `--color-surface`). Existing instance themes must add both tokens (`npm run check` reports them as missing).

### Risk marks

Fills for the risk heat map, the score chips and the risk type chips: `--risk-low`, `--risk-medium`, `--risk-high`, `--risk-critical` (score bands 1–4, 5–9, 10–14, 15–25) and `--risk-nc` (nonconformity) and `--risk-opportunity`. Text sits on these fills, so `--color-text-strong` on each must reach ≥ 7:1 (light to mid tones). Existing instance themes must add all six tokens (`npm run check` reports them as missing).

### Type and shape

| Token | Example | Notes |
|---|---|---|
| `--font` | `"Inter", system-ui, sans-serif` | body text |
| `--font-heading` | `var(--font)` | page title |
| `--font-size-base` | `16px` | keep ≥ 16px |
| `--weight-heading` | `650` | page title weight |
| `--heading-transform` | `none` or `uppercase` | page title |
| `--button-transform` | `none` or `uppercase` | buttons, tabs, navigation, category headings |
| `--button-letter-spacing` | `0` or `0.05em` | pairs well with uppercase |
| `--radius` | `6px` | corners of buttons, cards, inputs |
| `--header-rule` | `3px solid var(--color-primary)` | line under the header |

### Category colours

Category colours live with the categories in `instance.config.json` (`categories.*[].color`), not in `theme.css`. They are marks (dots, stripes, Gantt bars): each ≥ 3:1 against `--color-surface`.

## Web fonts

`theme.css` may start with an `@import` of a font stylesheet from Google Fonts (the dashboard's security policy allows `fonts.googleapis.com` and `fonts.gstatic.com`). For fonts hosted elsewhere, put the font files into `instance/assets/` and declare them with `@font-face` and `url("assets/<file>")`.

## Worked example: "Example Corp"

Example Corp's style guide says: navy `#14213d`, signal orange `#e4572e` as accent, light grey backgrounds, font *Source Sans 3*, square corners, uppercase buttons.

```css
@import url("https://fonts.googleapis.com/css2?family=Source+Sans+3:wght@400;600;700&display=swap");
:root {
  --color-primary: #14213d;
  --color-primary-strong: #0b1326;
  --color-on-primary: #ffffff;
  --color-accent: #e4572e;          /* focus ring and secondary buttons: a mark, not text */
  --color-accent-strong: #b8401c;
  --color-surface: #ffffff;
  --color-tint: #f1f3f6;
  --color-border: #cfd5de;
  --color-text: #1f2633;
  --color-text-strong: #0b1326;
  --color-text-muted: #47505e;
  --color-link: #14213d;
  --color-danger: #8a1c1c;
  --status-active: #14213d;
  --status-doing: #2e7d6b;
  --status-idea: #e4572e;
  --status-hold: #6b4f8a;
  --status-done: #14213d;
  --status-dropped: #6f7a84;
  --status-blocked: #a4262c;
  --status-waiting: #b45f06;
  --risk-low: #a8dbb5;
  --risk-medium: #f2dc8c;
  --risk-high: #f5a96b;
  --risk-critical: #ef8f8f;
  --risk-nc: #c7b6e8;
  --risk-opportunity: #9cd0ec;
  --font: "Source Sans 3", system-ui, sans-serif;
  --font-heading: var(--font);
  --font-size-base: 16px;
  --weight-heading: 700;
  --heading-transform: uppercase;
  --button-transform: uppercase;
  --button-letter-spacing: 0.05em;
  --radius: 0;
  --header-rule: 4px solid var(--color-accent);
}
```

Then put `example-corp-logo.svg` into `instance/assets/`, set `"logo": "assets/example-corp-logo.svg"` (and the favicon) in `instance.config.json`, run `npm run check`.

If the check reports a contrast failure, for example `color-text-muted on color-surface 5.10:1 < 7:1`, darken that colour until it passes. Brand colours that are too light for text can still be used for marks (`--color-accent`, status and category colours).

## Let your AI do it

Give Claude Code your style guide (PDF, website or a list of colours and fonts) and say: *"Apply our corporate design. Follow docs/ai/CUSTOMISE-PLAYBOOK.md."*
