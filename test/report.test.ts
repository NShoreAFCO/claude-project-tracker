// F9 (release R4.3): project report as Markdown, HTML and server-side PDF.
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { buildReport } from "../src/report/build";
import { call, installTestKeys, testCaller, userJwt, serviceJwt } from "./helpers";
import { createProject, updateProject } from "../src/data/projects";
import { upsertWorkpackage } from "../src/data/workpackages";
import { upsertMilestone } from "../src/data/milestones";
import { upsertRisk } from "../src/data/risks";
import { recordGateDecision } from "../src/data/gates";
import { ensureUserPerson, upsertPerson } from "../src/data/persons";
import { serverT, reportLocale, STRINGS } from "../src/i18n/server";
import { POLICY } from "../src/policy";
import type { BrowserBinding } from "../src/types";

const db = env.DB;
const SYS = testCaller();
let n = 0;

const PHONE = "+49 170 5550199";
const NOTE = "call after 5pm, ask for Zed";
const MAIL = "secret.person@example.com";

let ownerId: Promise<{ id: string }> | undefined;
const ownerPerson = () => (ownerId ??= upsertPerson(db, { name: "Olga Owner", email: MAIL, phone: PHONE, contact_note: NOTE }, SYS));

/** A project with objectives, a gated milestone with a decision, a risk, an nc and lessons learned. */
async function sample(extra: Record<string, unknown> = {}) {
  const dm = await ensureUserPerson(db, "dm-report@example.com");
  await db.prepare("UPDATE person SET access_role = 'decider' WHERE id = ?").bind(dm.id).run();
  const owner = await ownerPerson();
  const p = await createProject(
    db,
    {
      title: `Report ${++n}`,
      owner: owner.id,
      decision_maker: dm.id,
      target_date: "2027-03-01",
      objectives_md: "Ship the **pilot**.\n\n- faster\n- cheaper",
      scope_in_md: "Pilot line",
      scope_out_md: "Mass production",
      success_criteria_md: "Yield above 90%",
      ...extra,
    },
    SYS,
  );
  await upsertWorkpackage(db, p.id, { id: `${p.id}-w1`, title: "Build rig", status: "done", deliverable: "Rig" }, SYS);
  await upsertMilestone(db, p.id, { id: `${p.id}-m1`, title: "Gate one", due_date: "2026-12-01", gate: true }, SYS);
  const decider = testCaller({ personId: dm.id, role: "decider", channel: "dashboard", actor: "user:dm-report@example.com" });
  await recordGateDecision(db, `${p.id}-m1`, { decision: "go", note_md: "Budget confirmed" }, decider).catch(() => undefined);
  await upsertRisk(db, p.id, { title: "Supplier delay", type: "risk", probability: 4, impact: 4, action: "dual source" }, SYS);
  await upsertRisk(db, p.id, { title: "Weld defect", type: "nc", probability: 2, impact: 3, nc_cause: "bad flux" }, SYS);
  return p;
}

const get = async (id: string, format: string, init: Parameters<typeof call>[1] = {}) =>
  call(`/api/projects/${id}/report?format=${format}`, { jwt: await userJwt(), ...init });

beforeAll(installTestKeys);

describe("report", () => {
  it("md report contains objectives, milestones with decisions, risks, nc, lessons learned", async () => {
    const p = await sample();
    await db.prepare("UPDATE project SET lessons_learned_md = 'Order flux early' WHERE id = ?").bind(p.id).run();
    const res = await get(p.id, "md");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/markdown");
    const md = await res.text();
    expect(md).toContain(p.title);
    expect(md).toContain("Ship the **pilot**.");
    expect(md).toContain("Pilot line");
    expect(md).toContain("Gate one");
    expect(md).toMatch(/go/i);
    expect(md).toContain("Budget confirmed");
    expect(md).toContain("Supplier delay");
    expect(md).toContain("Weld defect");
    expect(md).toContain("bad flux");
    expect(md).toContain("Order flux early");
    expect(md).toContain("Build rig");
  });

  it("report uses project language else instance default", async () => {
    const de = await sample({ language: "de" });
    const dflt = await sample();
    const mdDe = await (await get(de.id, "md")).text();
    const mdDefault = await (await get(dflt.id, "md")).text();
    expect(mdDe).toContain(serverT("de", "report.objectives"));
    expect(mdDefault).toContain(serverT(POLICY.locales[0], "report.objectives"));
    expect(serverT("de", "report.objectives")).not.toBe(serverT("en", "report.objectives"));
    expect(reportLocale({ language: "de" })).toBe("de");
    expect(reportLocale({ language: null })).toBe(POLICY.locales[0]);
    expect(reportLocale({ language: "xx" })).toBe(POLICY.locales[0]);
    expect(await (await get(de.id, "html")).text()).toContain('lang="de"');
  });

  it("html report links only same-origin print css and has no script", async () => {
    const p = await sample();
    const res = await get(p.id, "html");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const html = await res.text();
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/style\s*=/i);
    const links = [...html.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatch(/rel="stylesheet"/);
    expect(links[0]).toMatch(/href="\/api\/report\/print\.css(\?[^"]*)?"/);
    expect(html).not.toMatch(/https?:\/\//i);
    const css = await call("/api/report/print.css", { jwt: await userJwt() });
    expect(css.status).toBe(200);
    expect(css.headers.get("Content-Type")).toContain("text/css");
    const text = await css.text();
    expect(text).toMatch(/@page\s*\{[^}]*size:\s*A4/i);
    expect(text).toContain("break-inside: avoid");
    expect(text).toContain("table-header-group");
    const unauth = await call("/api/report/print.css");
    expect(unauth.status).toBe(401);
  });

  it("html escapes every value, including markdown fields", async () => {
    const evil = `<script>alert(1)</script>`;
    const p = await sample({
      title: `T ${evil} ${++n}`,
      objectives_md: `# H <img src=x onerror=alert(1)>\n\n[click](javascript:alert(1)) ![i](https://evil.example/x.png) <b>bold</b>\n\n\`\`\`\n${evil}\n\`\`\``,
      scope_in_md: evil,
    });
    await upsertRisk(db, p.id, { title: `R ${evil}`, type: "risk", probability: 1, impact: 1 }, SYS);
    const html = await (await get(p.id, "html")).text();
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toMatch(/<b>/i);
    expect(html).not.toMatch(/href="javascript:/i);
    expect(html).not.toMatch(/evil\.example/);
    expect(html).toContain("&lt;script&gt;");
    expect(html).toMatch(/<h[1-6][^>]*>/);
  });

  it("html renders basic markdown (lists, bold) safely", async () => {
    const p = await sample();
    const html = await (await get(p.id, "html")).text();
    expect(html).toContain("<strong>pilot</strong>");
    expect(html).toMatch(/<li>faster<\/li>/);
  });

  it("internal fields and person contact data absent", async () => {
    const p = await sample();
    for (const format of ["md", "html"]) {
      const text = await (await get(p.id, format)).text();
      for (const secret of [PHONE, NOTE, MAIL, "dm-report@example.com"]) expect(text).not.toContain(secret);
      for (const internal of [
        "owner_person_id",
        "decision_maker_person_id",
        "schedule_rev",
        "schedule_issues",
        "deleted_at",
        "deleted_by",
        "gate_override",
        "closure_decision_pending",
        "progress_manual_reason",
        "last_changed_at",
        "version",
        "expected_version",
      ]) {
        expect(text).not.toContain(internal);
      }
      expect(text).toContain("Olga Owner");
    }
  });

  it("pdf returns 503 with message when BROWSER binding missing", async () => {
    const p = await sample();
    const res = await get(p.id, "pdf", { envOverride: { BROWSER: undefined } });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("pdf_unavailable");
    expect(body.message).toMatch(/PDF/);
    expect(body.message).toMatch(/html/i);
  });

  it("pdf returns 503 when the binding fails or is rate limited", async () => {
    const p = await sample();
    const limited: BrowserBinding = { quickAction: async () => new Response("slow down", { status: 429 }) };
    expect((await get(p.id, "pdf", { envOverride: { BROWSER: limited } })).status).toBe(503);
    const broken: BrowserBinding = {
      quickAction: async () => {
        throw new Error("boom");
      },
    };
    expect((await get(p.id, "pdf", { envOverride: { BROWSER: broken } })).status).toBe(503);
  });

  it("pdf returns application/pdf when binding stub returns bytes", async () => {
    const p = await sample();
    const bytes = new TextEncoder().encode("%PDF-1.7 stub");
    let seen: { action: string; options: Record<string, unknown> } | undefined;
    const stub: BrowserBinding = {
      quickAction: async (action, options) => {
        seen = { action, options };
        return new Response(bytes, { headers: { "Content-Type": "application/pdf" } });
      },
    };
    const res = await get(p.id, "pdf", { envOverride: { BROWSER: stub } });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Content-Disposition")).toMatch(/attachment; filename="[^"]+\.pdf"/);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
    expect(seen!.action).toBe("pdf");
    const html = String(seen!.options.html);
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain(p.title);
    expect(html).not.toMatch(/<link/i);
    const opts = seen!.options.pdfOptions as Record<string, unknown>;
    expect(opts.preferCSSPageSize).toBe(true);
    expect(opts.displayHeaderFooter).toBe(true);
    expect(String(opts.footerTemplate)).toContain("pageNumber");
    expect(String(opts.footerTemplate)).toContain("totalPages");
    expect(String(opts.headerTemplate)).toContain(p.title);
    expect(JSON.stringify(seen!.options.addStyleTag)).toContain("@page");
  });
});

describe("report hardening", () => {
  const okStub = (calls: Array<Record<string, unknown>>): BrowserBinding => ({
    quickAction: async (_a, options) => {
      calls.push(options);
      return new Response("%PDF-1.7", { headers: { "Content-Type": "application/pdf" } });
    },
  });

  it("logs the cause of a failed pdf render and keeps the client body generic", async () => {
    const p = await sample();
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const limited: BrowserBinding = { quickAction: async () => new Response("quota exhausted", { status: 429 }) };
      const res = await get(p.id, "pdf", { envOverride: { BROWSER: limited } });
      expect(res.status).toBe(503);
      expect(JSON.stringify(await res.json())).not.toContain("quota");
      const logged = JSON.stringify(spy.mock.calls);
      expect(logged).toContain("429");
      expect(logged).toContain("quota exhausted");
      spy.mockClear();
      const broken: BrowserBinding = {
        quickAction: async () => {
          throw new Error("boom");
        },
      };
      await get(p.id, "pdf", { envOverride: { BROWSER: broken } });
      expect(JSON.stringify(spy.mock.calls)).toContain("boom");
      spy.mockClear();
      await get(p.id, "pdf", { envOverride: { BROWSER: undefined } });
      expect(JSON.stringify(spy.mock.calls)).toContain("binding missing");
    } finally {
      spy.mockRestore();
    }
  });

  it("the html sent to the browser binding carries a restrictive CSP meta", async () => {
    const p = await sample();
    const calls: Array<Record<string, unknown>> = [];
    await get(p.id, "pdf", { envOverride: { BROWSER: okStub(calls) } });
    expect(String(calls[0].html)).toContain(
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">`,
    );
  });

  it("pdf returns 503 without calling the binding when policy.report.pdf is false", async () => {
    const p = await sample();
    const calls: Array<Record<string, unknown>> = [];
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const before = POLICY.report.pdf;
    POLICY.report.pdf = false;
    try {
      const res = await get(p.id, "pdf", { envOverride: { BROWSER: okStub(calls) } });
      expect(res.status).toBe(503);
      expect(calls).toHaveLength(0);
      expect((await get(p.id, "md")).status).toBe(200);
    } finally {
      POLICY.report.pdf = before;
      spy.mockRestore();
    }
  });

  it("orphan work packages sharing a missing parent appear once", async () => {
    const p = await sample();
    await upsertWorkpackage(db, p.id, { id: `${p.id}-par`, title: "Gone parent" }, SYS);
    for (const k of ["a", "b"])
      await upsertWorkpackage(db, p.id, { id: `${p.id}-o${k}`, title: `Orphan ${k}`, parent_id: `${p.id}-par` }, SYS);
    await db.prepare("UPDATE workpackage SET deleted_at = '2026-10-01T00:00:00Z' WHERE id = ?").bind(`${p.id}-par`).run();
    const model = await buildReport(db, p.id);
    expect(model.workpackages.filter((w) => w.title === "Orphan a")).toHaveLength(1);
    expect(model.workpackages.filter((w) => w.title === "Orphan b")).toHaveLength(1);
  });
});

describe("report access", () => {
  it("is user-only and read-only", async () => {
    const p = await sample();
    expect((await call(`/api/projects/${p.id}/report?format=md`)).status).toBe(401);
    expect((await call(`/api/projects/${p.id}/report?format=md`, { jwt: await serviceJwt() })).status).toBe(403);
    const post = await call(`/api/projects/${p.id}/report?format=md`, { method: "POST", jwt: await userJwt(), body: "{}" });
    expect(post.status).toBeGreaterThanOrEqual(400);
    const before = (await db.prepare("SELECT version FROM project WHERE id = ?").bind(p.id).first<{ version: number }>())!.version;
    await get(p.id, "md");
    await get(p.id, "html");
    const after = (await db.prepare("SELECT version FROM project WHERE id = ?").bind(p.id).first<{ version: number }>())!.version;
    expect(after).toBe(before);
  });

  it("rejects unknown format and unknown project", async () => {
    const p = await sample();
    expect((await get(p.id, "docx")).status).toBe(400);
    expect((await get("no-such-project", "md")).status).toBe(404);
  });

  it("a trashed project has no report", async () => {
    const p = await sample();
    await updateProject(db, p.id, {}, SYS).catch(() => undefined);
    await db.prepare("UPDATE project SET deleted_at = '2026-10-01T00:00:00Z' WHERE id = ?").bind(p.id).run();
    expect((await get(p.id, "md")).status).toBe(404);
  });
});

describe("server i18n", () => {
  it("en and de have the same keys, and a full report never shows a raw key", async () => {
    expect(Object.keys(STRINGS.de).sort()).toEqual(Object.keys(STRINGS.en).sort());
    const p = await sample();
    for (const format of ["md", "html"]) {
      const text = await (await get(p.id, format)).text();
      expect(text).not.toMatch(/\breport\.[A-Za-z]+\b/);
      expect(text).not.toMatch(/\b(decision|status|wpstatus|risktype|riskstatus)\.[a-z_]+\b/);
    }
  });

  it("falls back to en, fills placeholders and has de for every en key", () => {
    expect(serverT("en", "report.objectives")).toBeTruthy();
    expect(serverT("fr", "report.objectives")).toBe(serverT("en", "report.objectives"));
    expect(serverT("en", "report.pageHeader", { title: "X" })).toContain("X");
    expect(serverT("en", "no.such.key")).toBe("no.such.key");
  });
});
