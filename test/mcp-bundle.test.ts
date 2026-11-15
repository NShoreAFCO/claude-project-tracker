import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { testCaller } from "./helpers";
import { createProject } from "../src/data/projects";
import { upsertRisk } from "../src/data/risks";
import { upsertMilestone } from "../src/data/milestones";
import { getContextBundle, tailSections } from "../src/data/context-read";
import { appendContext, writeContext } from "../src/data/context-write";
import { utf8Bytes } from "../src/data/util";

const db = env.DB;
const A = testCaller({ actor: "user:test@example.com" });
let n = 0;
const proj = () => createProject(db, { title: `Bundle-${++n}` }, A);
const doc = (pid: string, title: string, content_md: string, extra: Record<string, unknown> = {}) =>
  writeContext(db, { owner_kind: "project", owner_id: pid, title, content_md, ...extra }, A);

describe("tailSections", () => {
  it("returns the whole text when there are no headings", () => {
    expect(tailSections("just text\nmore", 2)).toEqual({ text: "just text\nmore", truncated: false });
  });
  it("returns the whole text when there are n or fewer sections", () => {
    const md = "## A\n\na\n\n## B\n\nb\n";
    expect(tailSections(md, 2)).toEqual({ text: md, truncated: false });
    expect(tailSections(md, 5).truncated).toBe(false);
  });
  it("keeps the last n sections and drops text before them", () => {
    const md = "preamble\n\n## A\n\na\n\n## B\n\nb\n\n## C\n\nc\n";
    expect(tailSections(md, 2)).toEqual({ text: "## B\n\nb\n\n## C\n\nc\n", truncated: true });
    expect(tailSections(md, 1).text).toBe("## C\n\nc\n");
  });
  it("keeps a preamble when no section is dropped", () => {
    const md = "preamble\n\n## A\n\na\n";
    expect(tailSections(md, 2)).toEqual({ text: md, truncated: false });
  });
});

describe("context bundle budget", () => {
  it("never exceeds max_bytes with risks and gates present", async () => {
    const p = await proj();
    await upsertRisk(db, p.id, { title: "Supply risk", probability: 3, impact: 3 }, A);
    await upsertMilestone(db, p.id, { title: "G1", gate: true, due_date: "2027-01-01" }, A);
    for (let i = 0; i < 8; i++) await doc(p.id, `d${i}`, "x".repeat(300 + i * 50));
    for (const max of [1000, 1500, 2000, 3000]) {
      const b = await getContextBundle(db, { project_id: p.id, max_bytes: max });
      expect(b.bytes).toBeLessThanOrEqual(max);
      expect(utf8Bytes(b.markdown)).toBe(b.bytes);
    }
    const b = await getContextBundle(db, { project_id: p.id, max_bytes: 2000 });
    expect(b.markdown).toContain("## Open risks");
    expect(b.omitted.length).toBeGreaterThan(0);
  });

  it("skips a large doc and still adds later small ones, listing the omitted one", async () => {
    const p = await proj();
    await doc(p.id, "small-a", "a".repeat(200));
    await doc(p.id, "huge", "h".repeat(5000));
    await doc(p.id, "small-b", "b".repeat(200));
    const b = await getContextBundle(db, { project_id: p.id, max_bytes: 2000 });
    expect(b.included).toHaveLength(2);
    expect(b.omitted.map((d) => d.slug)).toEqual(["huge"]);
    expect(b.markdown).toContain("## Not included (size limit)");
    expect(b.markdown).toContain(`project:${p.id}/huge`);
    expect(b.markdown).not.toContain("h".repeat(50));
    expect(b.bytes).toBeLessThanOrEqual(2000);
  });

  it("orders unpinned docs by updated_at descending, pinned first", async () => {
    const p = await proj();
    const old = await doc(p.id, "aaa-old", "OLDDOC");
    const mid = await doc(p.id, "mmm-mid", "MIDDOC");
    const fresh = await doc(p.id, "zzz-new", "NEWDOC");
    await doc(p.id, "pin", "PINDOC", { pinned: true });
    for (const [d, ts] of [
      [old, "2026-01-01T00:00:00.000Z"],
      [mid, "2026-02-01T00:00:00.000Z"],
      [fresh, "2026-03-01T00:00:00.000Z"],
    ] as const)
      await db.prepare("UPDATE context_doc SET updated_at = ? WHERE id = ?").bind(ts, d.id).run();
    const md = (await getContextBundle(db, { project_id: p.id })).markdown;
    const idx = ["PINDOC", "NEWDOC", "MIDDOC", "OLDDOC"].map((s) => md.indexOf(s));
    expect(idx.every((i) => i > 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  });

  it("adds the last 2 sections of a handover that does not fit whole", async () => {
    const p = await proj();
    const h = await doc(p.id, "handover", "");
    for (const s of ["one", "two", "three", "four"])
      await appendContext(db, { owner_kind: "project", owner_id: p.id, slug: "handover", heading: s, text: `${s.toUpperCase()}-BODY ${"z".repeat(500)}` }, A);
    expect(h.slug).toBe("handover");
    const b = await getContextBundle(db, { project_id: p.id, max_bytes: 1700 });
    expect(b.included).toEqual([h.id]);
    expect(b.omitted).toHaveLength(0);
    expect(b.markdown).toContain("(earlier sections omitted, read_context for the rest)");
    expect(b.markdown).toContain("THREE-BODY");
    expect(b.markdown).toContain("FOUR-BODY");
    expect(b.markdown).not.toContain("TWO-BODY");
    expect(b.bytes).toBeLessThanOrEqual(1700);
  });

  it("falls back to 1 section, then omits the handover", async () => {
    const p = await proj();
    const h = await doc(p.id, "handover", "");
    for (const s of ["one", "two", "three"])
      await appendContext(db, { owner_kind: "project", owner_id: p.id, slug: "handover", heading: s, text: `${s.toUpperCase()}-BODY ${"z".repeat(500)}` }, A);
    const one = await getContextBundle(db, { project_id: p.id, max_bytes: 1000 });
    expect(one.included).toEqual([h.id]);
    expect(one.markdown).toContain("THREE-BODY");
    expect(one.markdown).not.toContain("TWO-BODY");
    await appendContext(db, { owner_kind: "project", owner_id: p.id, slug: "handover", heading: "four", text: "w".repeat(1200) }, A);
    const none = await getContextBundle(db, { project_id: p.id, max_bytes: 1000 });
    expect(none.included).toEqual([]);
    expect(none.omitted.map((d) => d.slug)).toEqual(["handover"]);
    expect(none.bytes).toBeLessThanOrEqual(1000);
  });
});
