import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { mcpApiHandler, type Reg } from "../src/mcp/server";
import { registerTools } from "../src/mcp/tools";
import { trimInputJsonSchema, withTrimmedJsonSchema } from "../src/mcp/schema-trim";
import type { Env } from "../src/types";

type Json = Record<string, any>;
const SAFE = Number.MAX_SAFE_INTEGER;

let id = 0;
async function rpc(method: string, params: Record<string, unknown> = {}): Promise<any> {
  const ctx = createExecutionContext() as ExecutionContext & { props?: unknown };
  ctx.props = { email: "user@example.com", clientName: "Claude Test" };
  const res = await mcpApiHandler.fetch(
    new Request("https://tracker.test/mcp", {
      method: "POST",
      headers: {
        Host: "tracker.test",
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    }),
    env as Env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  return text.startsWith("{")
    ? JSON.parse(text)
    : JSON.parse(
        text
          .split("\n")
          .find((l) => l.startsWith("data: "))!
          .slice(6),
      );
}

interface Registered {
  schema: z.ZodObject;
  title: string;
  readOnly: boolean;
}

/** Every tool as registered: its zod input schema (with the `return` switch the server adds to acknowledging tools). */
function registered(): Map<string, Registered> {
  const out = new Map<string, Registered>();
  const reg: Reg = (name, config) => {
    const schema = config.ack ? config.inputSchema.extend({ return: z.enum(["ack", "full"]).optional() }) : config.inputSchema;
    out.set(name, { schema, title: config.title, readOnly: !!config.readOnly });
  };
  registerTools(reg);
  return out;
}

/** The JSON Schema zod emits for the schema, as the SDK asks for it, before any trimming. */
function rawJson(schema: z.ZodObject): Json {
  const j = (schema as any)["~standard"].jsonSchema.input({ target: "draft-2020-12" }) as Json;
  return { type: "object", ...j };
}

/** What a schema constrains, whatever its spelling: these must not change when only the form does. */
function facts(root: unknown) {
  const acc = { patterns: [] as string[], enums: [] as string[], required: [] as string[], limits: [] as string[], props: [] as string[] };
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    for (const [k, v] of Object.entries(node as Json)) {
      if (k === "pattern") acc.patterns.push(String(v));
      else if (k === "required" && Array.isArray(v)) acc.required.push(...v.map(String));
      else if (k === "enum" && Array.isArray(v)) acc.enums.push(JSON.stringify(v.filter((x) => x !== null).sort()));
      else if (["maxLength", "minLength", "maxItems", "minItems", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"].includes(k))
        acc.limits.push(`${k}=${v}`);
      else if ((k === "minimum" || k === "maximum") && typeof v === "number" && Math.abs(v) !== SAFE) acc.limits.push(`${k}=${v}`);
      if (k === "properties" && v && typeof v === "object") acc.props.push(...Object.keys(v as Json));
      walk(v);
    }
  };
  walk(root);
  return {
    patterns: acc.patterns.sort(),
    enums: acc.enums.sort(),
    required: acc.required.sort(),
    limits: acc.limits.sort(),
    props: acc.props.sort(),
  };
}

const tools = registered();

describe("trimInputJsonSchema", () => {
  it("drops the root $schema only", () => {
    expect(trimInputJsonSchema({ $schema: "x", type: "object", properties: { $schema: { type: "string" } } })).toEqual({
      type: "object",
      properties: { $schema: { type: "string" } },
    });
  });

  it("drops the safe-integer bounds of an integer and nothing else", () => {
    const out = trimInputJsonSchema({
      type: "object",
      properties: {
        a: { type: "integer", minimum: -SAFE, maximum: SAFE },
        b: { type: "integer", minimum: 0, maximum: SAFE },
        c: { type: "integer", minimum: -SAFE, maximum: 10 },
        d: { type: "number", minimum: -SAFE, maximum: SAFE },
      },
    });
    expect(out.properties).toEqual({
      a: { type: "integer" },
      b: { type: "integer", minimum: 0 },
      c: { type: "integer", maximum: 10 },
      d: { type: "number", minimum: -SAFE, maximum: SAFE },
    });
  });

  it("turns anyOf with null into a type list and keeps the keywords", () => {
    const out = trimInputJsonSchema({
      type: "object",
      properties: {
        date: { description: "d", anyOf: [{ type: "string", pattern: "^x$" }, { type: "null" }] },
        text: { anyOf: [{ type: "null" }, { type: "string", maxLength: 5 }] },
        n: { anyOf: [{ type: "number", minimum: 0 }, { type: "null" }] },
        list: { anyOf: [{ type: "array", items: { type: "string" }, maxItems: 3 }, { type: "null" }] },
      },
    });
    expect(out.properties).toEqual({
      date: { description: "d", type: ["string", "null"], pattern: "^x$" },
      text: { type: ["string", "null"], maxLength: 5 },
      n: { type: ["number", "null"], minimum: 0 },
      list: { type: ["array", "null"], items: { type: "string" }, maxItems: 3 },
    });
  });

  it("adds null to an enum, so null stays valid and nothing else becomes valid", () => {
    const out = trimInputJsonSchema({
      type: "object",
      properties: { e: { anyOf: [{ type: "string", enum: ["a", "b"] }, { type: "null" }] } },
    });
    expect(out.properties.e).toEqual({ type: ["string", "null"], enum: ["a", "b", null] });
  });

  it("leaves alternatives alone when merging could change the meaning", () => {
    const keep = [
      { anyOf: [{ type: "string" }, { type: "number" }] },
      { anyOf: [{ type: "string" }, { type: "number" }, { type: "null" }] },
      { anyOf: [{ const: "a" }, { type: "null" }] },
      { anyOf: [{ type: "string", not: { const: "a" } }, { type: "null" }] },
      { anyOf: [{ $ref: "#/$defs/x" }, { type: "null" }] },
      { anyOf: [{ type: "string", description: "one" }, { type: "null" }], description: "two" },
      { anyOf: [{ type: "string" }, { type: "null", description: "n" }] },
      { type: "string", anyOf: [{ type: "string" }, { type: "null" }] },
    ];
    for (const node of keep) expect(trimInputJsonSchema({ type: "object", properties: { p: node } }).properties.p).toEqual(node);
  });

  it("walks nested schemas but not property names or data", () => {
    const out = trimInputJsonSchema({
      type: "object",
      properties: {
        anyOf: { type: "integer", maximum: SAFE },
        maximum: { type: "string" },
        nested: { type: "object", properties: { x: { anyOf: [{ type: "string", pattern: "p" }, { type: "null" }] } } },
        arr: { type: "array", items: { anyOf: [{ type: "integer", minimum: -SAFE }, { type: "null" }] } },
        e: { type: "string", enum: ["maximum", "anyOf"], default: { anyOf: [{ type: "string" }, { type: "null" }] } },
      },
      additionalProperties: { anyOf: [{ type: "string", maxLength: 1 }, { type: "null" }] },
    });
    expect(out).toEqual({
      type: "object",
      properties: {
        anyOf: { type: "integer" },
        maximum: { type: "string" },
        nested: { type: "object", properties: { x: { type: ["string", "null"], pattern: "p" } } },
        arr: { type: "array", items: { type: ["integer", "null"] } },
        e: { type: "string", enum: ["maximum", "anyOf"], default: { anyOf: [{ type: "string" }, { type: "null" }] } },
      },
      additionalProperties: { type: ["string", "null"], maxLength: 1 },
    });
  });

  it("does not change its input", () => {
    const input = { $schema: "x", type: "object", properties: { a: { anyOf: [{ type: "string" }, { type: "null" }] } } };
    const copy = JSON.parse(JSON.stringify(input));
    trimInputJsonSchema(input);
    expect(input).toEqual(copy);
  });
});

describe("validation is the zod schema's, unchanged", () => {
  // [tool, input, accepted]. Each row is checked against the plain zod schema (so the row says what is accepted today)
  // and against the wrapped schema the server registers (which must agree to the letter).
  const D = "2026-11-16";
  const P = { project_id: "p1" };
  const CASES: Array<[string, Json, boolean]> = [
    [
      "upsert_workpackage",
      { ...P, title: "T", start_date: D, end_date: null, parent_id: null, sort: 3, status: "doing", category: null, human: null },
      true,
    ],
    ["upsert_workpackage", { ...P, start_date: "2026-1-16" }, false],
    ["upsert_workpackage", { ...P, start_date: "2026-11-16T00:00:00Z" }, false],
    ["upsert_workpackage", { ...P, blocked_since: null, actual_start: D, actual_end: D }, true],
    ["upsert_workpackage", { ...P, sort: 1.5 }, false],
    ["upsert_workpackage", { ...P, sort: 2 ** 60 }, false],
    ["upsert_workpackage", { ...P, sort: -(2 ** 60) }, false],
    ["upsert_workpackage", { ...P, expected_version: 2.5 }, false],
    ["upsert_workpackage", { ...P, expected_version: 7 }, true],
    ["upsert_workpackage", { ...P, status: "finished" }, false],
    ["upsert_workpackage", { ...P, category: "nonsense" }, false],
    ["upsert_workpackage", { ...P, verification: "none" }, true],
    ["upsert_workpackage", { ...P, verification: null }, false],
    ["upsert_workpackage", { ...P, progress: 100 }, true],
    ["upsert_workpackage", { ...P, progress: 101 }, false],
    ["upsert_workpackage", { ...P, weight: 0 }, false],
    ["upsert_workpackage", { ...P, effort_planned_pd: null, effort_actual_pd: 0 }, true],
    ["upsert_workpackage", { ...P, effort_planned_pd: -1 }, false],
    ["upsert_workpackage", { ...P, deliverable: "x".repeat(500) }, true],
    ["upsert_workpackage", { ...P, deliverable: "x".repeat(501) }, false],
    ["upsert_workpackage", { ...P, verified_by: "x".repeat(201) }, false],
    ["upsert_workpackage", { ...P, priority_stakeholders: null }, true],
    ["upsert_workpackage", { ...P, priority_stakeholders: Array(51).fill("a") }, false],
    ["upsert_workpackage", { ...P, human: "yes" }, false],
    ["upsert_workpackage", { ...P, unknown_key: 1 }, true],
    ["upsert_workpackage", { title: "no project" }, false],
    ["upsert_workpackage", { ...P, return: "full" }, true],
    ["upsert_workpackage", { ...P, return: "everything" }, false],
    ["log_progress", { ...P, summary: "s", progress: 40, effort_pd: 0.5, claude_tokens: 10, copilot_prompts: 0, note: false }, true],
    ["log_progress", { ...P, summary: "" }, false],
    ["log_progress", { ...P, summary: "s", effort_pd: 0 }, false],
    ["log_progress", { ...P, summary: "s", effort_pd: 1001 }, false],
    ["log_progress", { ...P, summary: "s", claude_tokens: -1 }, false],
    ["log_progress", { ...P, summary: "s", claude_tokens: 1.5 }, false],
    ["log_progress", { ...P, summary: "s", claude_tokens: 2 ** 60 }, false],
    ["log_progress", { ...P, summary: "s", workpackage_id: null, session_id: null }, true],
    ["log_progress", { ...P, summary: "s", handover_md: "x".repeat(20001) }, false],
    ["log_progress", { ...P, summary: "s", handover_md: "" }, false],
    ["log_progress", { ...P, summary: "s", extra: true }, true],
    [
      "apply_changes",
      {
        ...P,
        ops: [
          { op: "wp", title: "A" },
          { op: "ms", due_date: D, extra: 1 },
        ],
      },
      true,
    ],
    ["apply_changes", { ...P, ops: [] }, true],
    ["apply_changes", { ...P, ops: [{ op: "task" }] }, false],
    ["apply_changes", { ...P, ops: [{ title: "no op" }] }, false],
    ["apply_changes", { ...P, ops: [{ op: "wp", ref: 5 }] }, false],
    ["apply_changes", { ...P, ops: "wp" }, false],
    ["apply_changes", { ops: [] }, false],
    ["upsert_milestone", { ...P, title: "M", due_date: D, gate: true, requires: ["a"], unlocks: [], sort: 1 }, true],
    ["upsert_milestone", { ...P, due_date: null }, true],
    ["upsert_milestone", { ...P, due_date: "16.11.2026" }, false],
    ["upsert_milestone", { ...P, gate: "true" }, false],
    ["upsert_milestone", { ...P, sort: 0.5 }, false],
    ["upsert_milestone", { ...P, requires: null }, false],
    ["upsert_milestone", { ...P, expected_version: 1, workpackage_id: null }, true],
    ["upsert_milestone", { ...P, bogus: "x" }, true],
    ["upsert_risk", { ...P, type: "nc", probability: 5, impact: 1, response: null, due_date: D, nc_effectiveness_check_date: null }, true],
    ["upsert_risk", { ...P, probability: 6 }, false],
    ["upsert_risk", { ...P, response: "ignore" }, false],
    ["create_project", { title: "T", start_date: D, language: null, category: null, owner: null }, true],
    ["create_project", { title: "" }, false],
    ["create_project", { title: "T", target_date: "soon" }, false],
    ["create_project", { title: "T", owner: "x".repeat(201) }, false],
    ["update_project", { id: "p", patch: { target_date: null, status: "done" } }, true],
    ["update_project", { id: "p", patch: { status: "finished" } }, false],
    ["record_gate_decision", { milestone_id: "m", decision: "go", evidence: ["a"] }, true],
    ["record_gate_decision", { milestone_id: "m", decision: "maybe" }, false],
    ["get_project", { id: "p", view: "summary" }, true],
    ["get_project", { id: "p", view: "tiny" }, false],
    ["delete_entity", { kind: "project", id: "p", confirm: true }, true],
    ["delete_entity", { kind: "project", id: "p", confirm: false }, false],
    ["delete_context", { doc_id: "d", confirm: true }, true],
    ["set_context_meta", { doc_id: "d", pinned: true, status: "released", sort: 1 }, true],
    ["set_context_meta", { doc_id: "d", status: "final" }, false],
    ["append_context", { text: "t", doc_id: null }, true],
    ["append_context", { text: "" }, false],
  ];

  const issueList = (issues: ReadonlyArray<{ path?: ReadonlyArray<unknown>; message: string }> | undefined) =>
    (issues ?? []).map((i) => `${(i.path ?? []).map(String).join(".")}: ${i.message}`);

  it.each(CASES.map((c, i) => [i, c[0], JSON.stringify(c[1]).slice(0, 70), c[2]] as const))(
    "#%i %s %s -> accepted: %s",
    async (i, name, _label, accepted) => {
      const input = CASES[i][1];
      const t = tools.get(name);
      expect(t, `tool ${name}`).toBeDefined();
      const plain = t!.schema.safeParse(input);
      expect(plain.success).toBe(accepted);
      const wrapped = await (withTrimmedJsonSchema(t!.schema) as any)["~standard"].validate(input);
      expect(!wrapped.issues).toBe(accepted);
      if (plain.success) expect(wrapped.value).toEqual(plain.data);
      else expect(issueList(wrapped.issues)).toEqual(issueList(plain.error.issues as any));
    },
  );

  it("every registered tool's validate is the original's", async () => {
    for (const [name, t] of tools) {
      const w = (withTrimmedJsonSchema(t.schema) as any)["~standard"];
      for (const input of [{}, { project_id: "p" }, { id: "x", text: "y" }]) {
        const a = await (t.schema as any)["~standard"].validate(input);
        const b = await w.validate(input);
        expect([name, JSON.stringify(b)]).toEqual([name, JSON.stringify(a)]);
      }
    }
  });
});

describe("emitted tools/list", () => {
  let listed: Array<{ name: string; title?: string; inputSchema: Json; annotations?: Json }>;
  beforeAll(async () => {
    listed = (await rpc("tools/list")).result.tools;
  });

  it("lists every registered tool", () => {
    expect(listed.map((t) => t.name).sort()).toEqual([...tools.keys()].sort());
  });

  it("has no $schema, no readOnlyHint false, no safe-integer bounds and no nullable anyOf", () => {
    const text = JSON.stringify(listed);
    expect(text).not.toContain("$schema");
    expect(text).not.toContain('"readOnlyHint":false');
    expect(text).not.toContain(String(SAFE));
    expect(text).not.toContain('{"type":"null"}');
  });

  it("keeps readOnlyHint true on read tools and destructiveHint on the writing ones", () => {
    for (const t of listed) {
      const reg = tools.get(t.name)!;
      expect([t.name, t.annotations?.readOnlyHint === true]).toEqual([t.name, reg.readOnly]);
      if (!reg.readOnly) expect([t.name, typeof t.annotations?.destructiveHint]).toEqual([t.name, "boolean"]);
    }
    expect(listed.find((t) => t.name === "delete_entity")?.annotations?.destructiveHint).toBe(true);
    expect(listed.find((t) => t.name === "upsert_workpackage")?.annotations?.destructiveHint).toBe(false);
  });

  it("drops a title that only restates the tool name and keeps the others", () => {
    for (const t of listed) {
      const reg = tools.get(t.name)!;
      const same = reg.title.toLowerCase().replace(/ /g, "") === t.name.replace(/_/g, "");
      expect([t.name, t.title]).toEqual([t.name, same ? undefined : reg.title]);
    }
    expect(listed.find((t) => t.name === "search")?.title).toBe("Search project data");
  });

  it("describes the same input set: every pattern, enum, required and limit it had", () => {
    let patterns = 0;
    for (const t of listed) {
      const before = facts(rawJson(tools.get(t.name)!.schema));
      const after = facts(t.inputSchema);
      expect([t.name, after]).toEqual([t.name, before]);
      patterns += after.patterns.length;
    }
    // Guard against both sides going empty together.
    expect(patterns).toBeGreaterThanOrEqual(10);
  });

  it("is the trimmed form of what zod emits, tool by tool", () => {
    for (const t of listed) expect([t.name, t.inputSchema]).toEqual([t.name, trimInputJsonSchema(rawJson(tools.get(t.name)!.schema))]);
  });

  it("keeps null valid exactly where it was valid", () => {
    const wp = listed.find((t) => t.name === "upsert_workpackage")!.inputSchema.properties;
    expect(wp.category.enum).toContain(null);
    expect(wp.category.type).toEqual(["string", "null"]);
    expect(wp.start_date).toMatchObject({ type: ["string", "null"], pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
    expect(wp.verification.enum).not.toContain(null);
    expect(wp.status.enum).not.toContain(null);
    expect(wp.sort).toEqual({ type: "integer" });
    expect(wp.progress).toEqual({ type: "number", minimum: 0, maximum: 100 });
    const ops = listed.find((t) => t.name === "apply_changes")!.inputSchema.properties.ops;
    expect(ops.items.properties.op.enum).toEqual(["wp", "ms"]);
  });
});
