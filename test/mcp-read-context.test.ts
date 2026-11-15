import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { cutToBytes, findSection, sectionHeadings } from "../src/data/context-read";
import { mcpApiHandler } from "../src/mcp/server";
import type { Env } from "../src/types";

let id = 0;
async function call(name: string, args: Record<string, unknown>): Promise<any> {
  const ctx = createExecutionContext() as ExecutionContext & { props?: unknown };
  ctx.props = { email: "user@example.com", clientName: "Claude Test" };
  const res = await mcpApiHandler.fetch(
    new Request("https://tracker.test/mcp", {
      method: "POST",
      headers: { Host: "tracker.test", "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }),
    }),
    env as Env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  const t = await res.text();
  return (t.startsWith("{") ? JSON.parse(t) : JSON.parse(t.split("\n").find((l) => l.startsWith("data: "))!.slice(6))).result;
}
const text = (r: any): string => r.content[0].text;

async function fixture(): Promise<Record<string, unknown>> {
  const p = JSON.parse(text(await call("create_project", { title: "ReadCtx" })));
  const addr = { owner_kind: "project", owner_id: p.id, slug: "handover" };
  for (const h of ["Alpha", "Beta", "Gamma", "Delta"]) {
    await call("append_context", { ...addr, heading: h, text: `body of ${h} ${"x".repeat(400)}` });
  }
  return addr;
}

describe("pure helpers", () => {
  const md = "pre\n\n## A one\n\na\n\n## B two\n\nb\n\n## A one again\n\nc\n";
  it("lists headings with sizes", () => {
    expect(sectionHeadings(md).map((h) => h.heading)).toEqual(["## A one", "## B two", "## A one again"]);
    expect(sectionHeadings(md)[0].bytes).toBe("## A one\n\na\n\n".length);
  });
  it("finds the last matching section, case-insensitive", () => {
    expect(findSection(md, "a ONE")).toBe("## A one again\n\nc\n");
    expect(findSection(md, "zzz")).toBeNull();
  });
  it("cuts at a section boundary and counts what is left out", () => {
    const cut = cutToBytes(md, 40);
    expect(cut.text).toBe("pre\n\n## A one\n\na\n\n## B two\n\nb\n\n");
    expect(cut.more).toBe(1);
    expect(cutToBytes(md, 10000)).toEqual({ text: md, more: 0 });
  });
});

describe("read_context parts", () => {
  it("returns the whole document by default", async () => {
    const addr = await fixture();
    const t = text(await call("read_context", addr));
    for (const h of ["Alpha", "Beta", "Gamma", "Delta"]) expect(t).toContain(`## ${h}`);
  });
  it("tail_sections keeps the header and the last n sections", async () => {
    const addr = await fixture();
    const t = text(await call("read_context", { ...addr, tail_sections: 2 }));
    expect(t.startsWith("--- context: project:")).toBe(true);
    expect(t).toContain("## Delta");
    expect(t).toContain("## Gamma");
    expect(t).not.toContain("## Beta");
  });
  it("section returns one section, case-insensitive", async () => {
    const addr = await fixture();
    const t = text(await call("read_context", { ...addr, section: "beta" }));
    expect(t).toContain("body of Beta");
    expect(t).not.toContain("body of Gamma");
  });
  it("section not found is not_found and names the heading", async () => {
    const addr = await fixture();
    const r = await call("read_context", { ...addr, section: "Omega" });
    expect(r.isError).toBe(true);
    const e = JSON.parse(text(r));
    expect(e.error).toBe("not_found");
    expect(e.message).toContain("Omega");
  });
  it("headings lists headings with sizes only", async () => {
    const addr = await fixture();
    const t = text(await call("read_context", { ...addr, headings: true }));
    expect(t).toMatch(/## Alpha .*\(\d+ bytes\)/);
    expect(t.split("\n").filter((l) => l.includes(" bytes)")).length).toBe(4);
    expect(t).not.toContain("body of");
  });
  it("refuses more than one of tail_sections, section, headings", async () => {
    const addr = await fixture();
    for (const extra of [{ tail_sections: 1, section: "A" }, { tail_sections: 1, headings: true }, { section: "A", headings: true }]) {
      const r = await call("read_context", { ...addr, ...extra });
      expect(r.isError).toBe(true);
      expect(JSON.parse(text(r)).error).toBe("invalid");
    }
  });
  it("max_bytes cuts at a section boundary and says how many sections are left", async () => {
    const addr = await fixture();
    const t = text(await call("read_context", { ...addr, max_bytes: 1000 }));
    expect(Buffer.byteLength(t)).toBeLessThanOrEqual(1000);
    expect(t).toMatch(/… \d+ more sections, use tail_sections or section$/);
    expect(t).toContain("## Alpha");
    expect(t).not.toContain("## Delta");
    // every section kept is whole
    for (const m of t.matchAll(/body of (\w+) (x+)/g)) expect(m[2].length).toBe(400);
  });
  it("max_bytes combines with tail_sections", async () => {
    const addr = await fixture();
    const t = text(await call("read_context", { ...addr, tail_sections: 3, max_bytes: 1000 }));
    expect(Buffer.byteLength(t)).toBeLessThanOrEqual(1000);
    expect(t).toContain("## Beta");
    expect(t).not.toContain("## Alpha");
  });
  it("a document without headings is returned whole, and headings is empty", async () => {
    const p = JSON.parse(text(await call("create_project", { title: "NoHeadings" })));
    const addr = { owner_kind: "project", owner_id: p.id, slug: "plain" };
    await call("write_context", { ...addr, title: "plain", content_md: "just text, no headings" });
    expect(text(await call("read_context", { ...addr, tail_sections: 2 }))).toContain("just text, no headings");
    expect(text(await call("read_context", { ...addr, headings: true }))).not.toContain("just text");
    const r = await call("read_context", { ...addr, section: "x" });
    expect(JSON.parse(text(r)).error).toBe("not_found");
  });
});
