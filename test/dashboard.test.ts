import { beforeAll, describe, expect, it } from "vitest";
// Plain ES modules from the dashboard; both are DOM-free.
// @ts-expect-error untyped JS module
import { renderMarkdown } from "../public/js/markdown.js";
// @ts-expect-error untyped JS module
import { lineDiff } from "../public/js/diff.js";
import { call, installTestKeys, userJwt } from "./helpers";

const md = renderMarkdown as (s: string) => string;
const tagsOf = (html: string) => [...html.matchAll(/<([a-z0-9]+)[\s>]/gi)].map((m) => m[1].toLowerCase());
const ALLOWED_TAGS = new Set([
  "p",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "strong",
  "em",
  "code",
  "pre",
  "a",
  "ul",
  "ol",
  "li",
  "blockquote",
  "hr",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
]);

describe("markdown renderer (sanitising)", () => {
  const vectors = [
    "<script>alert(1)</script>",
    "<img src=x onerror=alert(1)>",
    '<a href="javascript:alert(1)">x</a>',
    "[x](javascript:alert(1))",
    "[x](JaVaScRiPt:alert(1))",
    "[x](data:text/html;base64,PHNjcmlwdD4=)",
    "[x](vbscript:msgbox)",
    '![a](https://e.com/i.png" onerror="alert(1))',
    '[a"b](https://e.com/"onmouseover="alert(1))',
    "<svg onload=alert(1)>",
    "<iframe src=//evil>",
    "`<b>` **<i>x</i>** _<u>y</u>_",
    "| a | <script> |\n|---|---|\n| <img src=x> | b |",
    "> <style>body{}</style>",
    "```\n</code></pre><script>x</script>\n```",
    'https://e.com/?q="><script>',
  ];

  it.each(vectors)("emits only allow-listed tags and no event handlers: %s", (v) => {
    const html = md(v);
    for (const tag of tagsOf(html)) expect(ALLOWED_TAGS.has(tag), `tag <${tag}> in ${html}`).toBe(true);
    // attributes only appear on generated anchors
    for (const m of html.matchAll(/<([a-z0-9]+)(\s[^>]*)?>/gi)) {
      if (!m[2]) continue;
      expect(m[1]).toBe("a");
      expect(m[2]).toMatch(/^ href="(https?:\/\/|mailto:|#)[^"]*" target="_blank" rel="noopener noreferrer"$/i);
    }
    expect(html).not.toMatch(/href="\s*(javascript|vbscript|data):/i);
  });

  it("renders the supported subset", () => {
    const html = md(
      "# T\n\n- a\n  - b\n\n1. one\n\n> q\n\n---\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```\nx < y\n```\n\n**b** *i* `c` [l](https://e.com/a?x=1&y=2) https://e.com/p.",
    );
    expect(html).toContain("<h2>T</h2>");
    expect(html).toContain("<ul><li>a<ul><li>b</li></ul></li></ul>");
    expect(html).toContain("<ol><li>one</li></ol>");
    expect(html).toContain("<blockquote><p>q</p></blockquote>");
    expect(html).toContain("<hr>");
    expect(html).toContain("<th>A</th>");
    expect(html).toContain("<pre><code>x &lt; y</code></pre>");
    expect(html).toContain("<strong>b</strong> <em>i</em> <code>c</code>");
    expect(html).toContain('href="https://e.com/a?x=1&amp;y=2"');
    expect(html).toContain('href="https://e.com/p"');
  });
});

describe("line diff", () => {
  const diff = lineDiff as (a: string, b: string) => Array<{ op: string; line: string }>;
  it("marks added, removed and unchanged lines", () => {
    expect(diff("a\nb\nc", "a\nB\nc\nd")).toEqual([
      { op: "same", line: "a" },
      { op: "del", line: "b" },
      { op: "add", line: "B" },
      { op: "same", line: "c" },
      { op: "add", line: "d" },
    ]);
  });
  it("handles empty sides", () => {
    expect(diff("", "x").map((d) => d.op)).toEqual(["del", "add"]);
    expect(diff("x", "x")).toEqual([{ op: "same", line: "x" }]);
  });
});

describe("dashboard assets", () => {
  beforeAll(installTestKeys);
  it("serves index.html with a CSP to a logged-in user", async () => {
    const res = await call("/", { jwt: await userJwt() });
    expect(res.status).toBe(200);
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).toContain("font-src 'self' https://fonts.gstatic.com"); // theme fonts in instance/assets
    expect(await res.text()).toContain('<script type="module" src="/js/app.js"></script>');
  });
  it("never serves assets without a valid Access JWT", async () => {
    expect((await call("/")).status).toBe(401);
    expect((await call("/js/app.js")).status).toBe(401);
  });
});

describe("dashboard categories (instance config)", () => {
  it("lists come from the instance and unknown keys render neutrally", async () => {
    // @ts-expect-error untyped JS module
    const c = await import("../public/js/categories.js");
    // @ts-expect-error untyped JS module
    const cfg = (await import("../public/instance/config.js")).default;
    expect(c.PROJECT_CATEGORIES).toEqual(cfg.categories.project.map((x: { key: string }) => x.key));
    // @ts-expect-error untyped JS module
    const { LOCALE } = await import("../public/js/i18n.js");
    expect(c.catLabel("p", "process-optimisation")).toBe(LOCALE === "de" ? "Prozessoptimierung" : "Process optimisation");
    expect(c.catLabel("p", "retired-key")).toBe("retired-key");
    expect(c.catVar("p", "retired-key")).toBe("var(--cat-none)");
    expect(c.catVar("w", "coding")).toBe("var(--cat-w-coding)");
    expect(c.knownCategory("p", "retired-key")).toBeNull();
    expect(c.knownCategory("p", "research")).toBe("research");
  });
});

describe("locales", () => {
  const keyPaths = (o: Record<string, unknown>, p = ""): string[] =>
    Object.entries(o).flatMap(([k, v]) => (v && typeof v === "object" ? keyPaths(v as Record<string, unknown>, `${p}${k}.`) : [`${p}${k}`]));
  it("locales have identical key sets", async () => {
    // @ts-expect-error untyped JS module
    const en = (await import("../public/js/locales/en.js")).default;
    // @ts-expect-error untyped JS module
    const de = (await import("../public/js/locales/de.js")).default;
    expect(keyPaths(en).sort()).toEqual(keyPaths(de).sort());
  });
  it("no German in en locale", async () => {
    // @ts-expect-error untyped JS module
    const en = (await import("../public/js/locales/en.js")).default;
    expect(JSON.stringify(en)).not.toMatch(/[äöüßÄÖÜ]|„/);
  });
  it("default locale is English and instance overrides apply", async () => {
    // @ts-expect-error untyped JS module
    const { LOCALE, t, mergeStrings } = await import("../public/js/i18n.js");
    expect(LOCALE).toBe("en");
    expect(t("navProjects")).toBe("Projects");
    expect(mergeStrings({ a: "x", n: { b: "y", c: "z" } }, { n: { b: "Y" } })).toEqual({ a: "x", n: { b: "Y", c: "z" } });
  });
});
