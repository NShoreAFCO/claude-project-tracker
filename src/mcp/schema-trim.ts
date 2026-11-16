import type { z } from "zod";

/**
 * Shrinks the JSON Schema that tools/list emits for a tool's input. Only the emitted schema changes: the zod schema
 * still validates every call, so what is accepted or refused is unchanged. Every cut keeps the described input set:
 *  - `$schema` at the root (the dialect is the protocol's default);
 *  - the safe-integer `minimum`/`maximum` zod adds to every `.int()` (zod's .int() also limits to safe integers; values that large are not realistic inputs, and zod still refuses them);
 *  - `anyOf: [{type: X, ...keywords}, {type: "null"}]` becomes `type: [X, "null"]` with the same keywords. That is
 *    equivalent because the keywords of a typed member apply to that type only; an `enum` gets `null` added.
 */

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
type Json = Record<string, any>;

const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** Keywords whose value is a map of name -> schema, a single schema, or a list of schemas. */
const SCHEMA_MAPS = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"];
const SCHEMA_SINGLE = [
  "items",
  "additionalProperties",
  "not",
  "contains",
  "propertyNames",
  "if",
  "then",
  "else",
  "unevaluatedItems",
  "unevaluatedProperties",
];
const SCHEMA_LISTS = ["anyOf", "oneOf", "allOf", "prefixItems"];

/** Keywords that apply to every instance type: a member carrying one cannot be merged into a type list. */
const CROSS_TYPE = ["anyOf", "oneOf", "allOf", "not", "if", "then", "else", "$ref", "$dynamicRef", "const"];

function collapseNullable(node: Json): Json {
  const any = node.anyOf;
  if (!Array.isArray(any) || any.length !== 2) return node;
  const nullAt = any.findIndex((m) => isObj(m) && Object.keys(m).length === 1 && m.type === "null");
  if (nullAt < 0) return node;
  const other = any[1 - nullAt];
  if (!isObj(other) || typeof other.type !== "string" || other.type === "null") return node;
  if (CROSS_TYPE.some((k) => k in other)) return node;
  const { anyOf: _drop, ...siblings } = node;
  if ("type" in siblings) return node;
  // A key on both sides with different values would change meaning: leave the node alone.
  for (const k of Object.keys(siblings)) if (k in other && JSON.stringify(other[k]) !== JSON.stringify(siblings[k])) return node;
  if (Array.isArray(other.enum) && other.enum.includes(null)) return node;
  const merged: Json = { ...siblings, ...other, type: [other.type, "null"] };
  if (Array.isArray(other.enum)) merged.enum = [...other.enum, null];
  return merged;
}

function trimNode(node: Json): Json {
  const out: Json = { ...node };
  for (const k of SCHEMA_MAPS) {
    const m = out[k];
    if (isObj(m)) out[k] = Object.fromEntries(Object.entries(m).map(([name, s]) => [name, isObj(s) ? trimNode(s) : s]));
  }
  for (const k of SCHEMA_SINGLE) if (isObj(out[k])) out[k] = trimNode(out[k] as Json);
  for (const k of SCHEMA_LISTS) {
    const l = out[k];
    if (Array.isArray(l)) out[k] = l.map((s) => (isObj(s) ? trimNode(s) : s));
  }
  if (out.type === "integer") {
    if (out.minimum === -MAX_SAFE) delete out.minimum;
    if (out.maximum === MAX_SAFE) delete out.maximum;
  }
  return collapseNullable(out);
}

/** The trimmed form of a tool input JSON Schema (pure; the input is not changed). */
export function trimInputJsonSchema(schema: Json): Json {
  const { $schema: _dialect, ...rest } = schema;
  return trimNode(rest);
}

/**
 * Wraps a zod object so the SDK's tools/list (and its pre-dispatch header check) get the trimmed JSON Schema,
 * while `~standard.validate` is the original's, untouched.
 */
export function withTrimmedJsonSchema<S extends z.ZodType>(schema: S): S {
  const std = (
    schema as unknown as {
      "~standard": { validate: (v: unknown) => unknown; jsonSchema: { input: (o: Json) => Json; output: (o: Json) => Json } };
    }
  )["~standard"];
  const wrapped = {
    "~standard": {
      ...std,
      validate: (v: unknown) => std.validate(v),
      jsonSchema: {
        input: (o: Json) => trimInputJsonSchema(std.jsonSchema.input(o)),
        output: (o: Json) => std.jsonSchema.output(o),
      },
    },
  };
  return wrapped as unknown as S;
}
