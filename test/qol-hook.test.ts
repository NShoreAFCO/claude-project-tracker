// QoL 0.3.0 (T03): the session hook sends the host name and HANDOFF.md.
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { call, installTestKeys, serviceJwt, userJwt } from "./helpers";

const db = env.DB;
let jwt: string;
beforeAll(async () => {
  await installTestKeys();
  jwt = await userJwt();
  const res = await call("/api/projects", {
    method: "POST",
    jwt,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "qolhook", title: "QoL hook", local_path: "C:/Users/jane/Documents/Devel/qolhook" }),
  });
  expect(res.status).toBeLessThan(300);
});

const hook = async (extra: Record<string, unknown>) => {
  const res = await call("/api/hooks/claude-code", {
    method: "POST",
    jwt: await serviceJwt(),
    body: JSON.stringify({ session_id: "q-1", cwd: "C:/Users/jane/Documents/Devel/qolhook", ...extra }),
  });
  return { status: res.status, body: (await res.json()) as any };
};
const doc = (slug: string) =>
  db.prepare("SELECT * FROM context_doc WHERE owner_id = 'qolhook' AND slug = ? AND deleted_at IS NULL").bind(slug).first<any>();
const host = async () => (await db.prepare("SELECT local_host FROM project WHERE id = 'qolhook'").first<any>()).local_host;

describe("hook host and HANDOFF.md", () => {
  it("stores the host on a match and logs it in the event diff", async () => {
    const r = await hook({ host: "devbox" });
    expect(r.body.matched).toBe("qolhook");
    expect(await host()).toBe("devbox");
    const ev = await db.prepare("SELECT diff_json FROM event WHERE project_id = 'qolhook' AND diff_json LIKE '%local_host%'").first<any>();
    expect(JSON.parse(ev.diff_json).local_host).toEqual([null, "devbox"]);
  });
  it("ignores a host over 100 characters and says so", async () => {
    const r = await hook({ host: "x".repeat(101) });
    expect(r.body.host).toMatch(/ignored/);
    expect(await host()).toBe("devbox");
  });
  it("stores the host in the same batch as the session id (one session update, one host event)", async () => {
    await db.prepare("UPDATE project SET local_host = NULL, session_id = NULL WHERE id = 'qolhook'").run();
    const before = (await db.prepare("SELECT COUNT(*) AS n FROM event WHERE project_id = 'qolhook' AND diff_json LIKE '%local_host%'").first<any>()).n;
    const r = await hook({ host: "samebox", session_id: "q-batch" });
    expect(r.status).toBe(200);
    const p = await db.prepare("SELECT local_host, session_id FROM project WHERE id = 'qolhook'").first<any>();
    expect(p).toMatchObject({ local_host: "samebox", session_id: "q-batch" });
    const after = (await db.prepare("SELECT COUNT(*) AS n FROM event WHERE project_id = 'qolhook' AND diff_json LIKE '%local_host%'").first<any>()).n;
    expect(after).toBe(before + 1);
    await hook({ host: "samebox", session_id: "q-batch" });
    expect((await db.prepare("SELECT COUNT(*) AS n FROM event WHERE project_id = 'qolhook' AND diff_json LIKE '%local_host%'").first<any>()).n).toBe(before + 1);
  });
  it("stores HANDOFF.md as a pinned sync doc; identical repeat is unchanged", async () => {
    const files = [
      { name: "session.md", content: "# S" },
      { name: "HANDOFF.md", content: "# Handoff\nnext" },
    ];
    const r1 = await hook({ context_files: files });
    expect(r1.body.context_files).toEqual({ "session-md": "written", handoff: "written" });
    const d = await doc("handoff");
    expect(d).toMatchObject({ title: "HANDOFF", pinned: 1, source: "sync", content_md: "# Handoff\nnext" });
    const r2 = await hook({ context_files: files });
    expect(r2.body.context_files).toEqual({ "session-md": "unchanged", handoff: "unchanged" });
    expect((await doc("handoff")).version).toBe(1);
  });
  it("does not re-pin a HANDOFF the user unpinned", async () => {
    await db.prepare("UPDATE context_doc SET pinned = 0 WHERE owner_id = 'qolhook' AND slug = 'handoff'").run();
    await hook({ context_files: [{ name: "HANDOFF.md", content: "# Handoff\nchanged" }] });
    expect(await doc("handoff")).toMatchObject({ pinned: 0, content_md: "# Handoff\nchanged", version: 2 });
  });
  it("still accepts the old single context_file", async () => {
    const r = await hook({ context_file: { name: "session.md", content: "# Old form" } });
    expect(r.status).toBe(200);
    expect((await doc("session-md")).content_md).toBe("# Old form");
    const r2 = await hook({ context_file: { name: "session.md", content: "# Old form" } });
    expect(r2.body.context_file).toBe("unchanged");
  });
  it("ignores inherited property names and nameless context_files entries", async () => {
    const r = await hook({
      context_files: [
        { name: "__proto__", content: "x" },
        { name: "constructor", content: "x" },
        { content: "no name" },
      ],
    });
    expect(r.status).toBe(200);
    expect(r.body.context_files).toBeUndefined();
  });
  it("refuses an oversize entry on its own and still stores the valid companion file", async () => {
    const big = "a".repeat(256 * 1024 + 1);
    const r = await hook({
      context_files: [
        { name: "HANDOFF.md", content: big },
        { name: "session.md", content: "# Session\nstored alongside" },
      ],
    });
    expect(r.status).toBe(200);
    expect((await doc("session-md")).content_md).toBe("# Session\nstored alongside");
    expect(r.body.context_files.handoff).toMatch(/skipped/);
    expect((await doc("handoff")).content_md).toBe("# Handoff\nchanged");
  });
});
