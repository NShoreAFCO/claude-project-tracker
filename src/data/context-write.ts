import type { Caller, ContextDocRow, ContextDocStatus, ContextRevisionRow } from "../types";
import { CONTEXT_DOC_MAX_BYTES, CONTEXT_OWNER_MAX_BYTES, CONTEXT_REVISIONS_KEPT } from "../types";
import { resolveOwner, type DocMeta, type OwnerRef } from "./context-read";
import { deleteEntity } from "./entities";
import {
  ConflictError,
  LIVE,
  NotFoundError,
  TooLargeError,
  ValidationError,
  eventStmt,
  eventStmtIfChanged,
  newId,
  now,
  slugify,
  utf8Bytes,
} from "./util";
import { touchProject } from "./activity";

type Source = "upload" | "paste" | "claude" | "sync";
const SOURCES: readonly Source[] = ["upload", "paste", "claude", "sync"];

const kb = (n: number) => `${Math.round(n / 1024)} KB`;
const label = (d: Pick<ContextDocRow, "owner_kind" | "owner_id" | "slug">) => `${d.owner_kind}:${d.owner_id}/${d.slug}`;
const stripContent = ({ content_md: _c, deleted_at: _d, deleted_by: _b, ...meta }: ContextDocRow): DocMeta => meta;
const DOC_STATUSES: readonly ContextDocStatus[] = ["draft", "released", "obsolete"];

function checkDocSize(bytes: number): void {
  if (bytes > CONTEXT_DOC_MAX_BYTES)
    throw new TooLargeError(`document is ${kb(bytes)}; the limit is ${kb(CONTEXT_DOC_MAX_BYTES)} per document`);
}

/** Bytes held by an owner's docs; docs in the trash do not count. */
async function ownerBytes(db: D1Database, ref: OwnerRef, excludeId?: string): Promise<number> {
  const r = await db
    .prepare(`SELECT COALESCE(SUM(bytes), 0) AS total FROM context_doc WHERE owner_kind = ? AND owner_id = ? AND id != ? AND ${LIVE()}`)
    .bind(ref.owner_kind, ref.owner_id, excludeId ?? "")
    .first<{ total: number }>();
  return r?.total ?? 0;
}

function checkOwnerSize(others: number, bytes: number): void {
  if (others + bytes > CONTEXT_OWNER_MAX_BYTES) {
    throw new TooLargeError(`owner would hold ${kb(others + bytes)}; the limit is ${kb(CONTEXT_OWNER_MAX_BYTES)} per owner`);
  }
}

/** Revision snapshot of the doc at `version`; no-op if the doc moved on (keeps revision and update consistent). */
function revisionStmt(db: D1Database, docId: string, version: number, by: Caller): D1PreparedStatement {
  return db
    .prepare(
      "INSERT INTO context_revision (doc_id, version, content_md, changed_at, changed_by) SELECT id, version, content_md, ?, ? FROM context_doc WHERE id = ? AND version = ?",
    )
    .bind(now(), by.actor, docId, version);
}

function pruneStmt(db: D1Database, docId: string): D1PreparedStatement {
  return db
    .prepare(
      "DELETE FROM context_revision WHERE doc_id = ? AND id NOT IN (SELECT id FROM context_revision WHERE doc_id = ? ORDER BY id DESC LIMIT ?)",
    )
    .bind(docId, docId, CONTEXT_REVISIONS_KEPT);
}

async function getDoc(db: D1Database, id: string): Promise<ContextDocRow> {
  const d = await db.prepare(`SELECT * FROM context_doc WHERE id = ? AND ${LIVE()}`).bind(id).first<ContextDocRow>();
  if (!d) throw new NotFoundError(`context document ${id} not found`);
  return d;
}

/** Replace content of an existing doc (shared by writeContext update and restoreRevision). */
async function replaceContent(
  db: D1Database,
  existing: ContextDocRow,
  patch: { content_md: string; title?: string; pinned?: boolean; sort?: number; source?: Source; filename?: string | null },
  by: Caller,
  action: string,
  summarySuffix = "",
): Promise<ContextDocRow> {
  const bytes = utf8Bytes(patch.content_md);
  checkDocSize(bytes);
  checkOwnerSize(await ownerBytes(db, existing, existing.id), bytes);
  const ts = now();
  const res = await db.batch([
    revisionStmt(db, existing.id, existing.version, by),
    db
      .prepare(
        "UPDATE context_doc SET content_md = ?, bytes = ?, title = ?, pinned = ?, sort = ?, source = ?, filename = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE id = ? AND version = ?",
      )
      .bind(
        patch.content_md,
        bytes,
        patch.title ?? existing.title,
        patch.pinned === undefined ? existing.pinned : patch.pinned ? 1 : 0,
        patch.sort ?? existing.sort,
        patch.source ?? existing.source,
        patch.filename === undefined ? existing.filename : patch.filename,
        ts,
        by.actor,
        existing.id,
        existing.version,
      ),
    eventStmtIfChanged(db, {
      by,
      project_id: existing.project_id,
      entity: "context_doc",
      entity_id: existing.id,
      action,
      summary: label(existing) + summarySuffix,
      diff: { version: [existing.version, existing.version + 1], bytes: [existing.bytes, bytes] },
    }),
    pruneStmt(db, existing.id),
    ...touchProject(db, by, existing.project_id, ts),
  ]);
  if (!res[1].meta.changes) {
    // Lost a race between read and write: report like an expected_version mismatch.
    throw new ConflictError("version conflict", stripContent(await getDoc(db, existing.id)));
  }
  return getDoc(db, existing.id);
}

/** Create or replace a context document. */
export async function writeContext(
  db: D1Database,
  args: OwnerRef & {
    title: string;
    content_md: string;
    slug?: string | null;
    source?: Source;
    filename?: string | null;
    pinned?: boolean;
    sort?: number;
    expected_version?: number;
    replace?: boolean;
  },
  by: Caller,
): Promise<ContextDocRow> {
  const title = args.title?.trim();
  if (!title) throw new ValidationError("title is required");
  if (typeof args.content_md !== "string") throw new ValidationError("content_md is required");
  const source = args.source ?? "claude";
  if (!SOURCES.includes(source)) throw new ValidationError(`source must be one of ${SOURCES.join("|")}`);
  const owner = await resolveOwner(db, args);
  const bytes = utf8Bytes(args.content_md);
  checkDocSize(bytes);

  const base = slugify(args.slug || title);
  const find = (slug: string) =>
    db
      .prepare(`SELECT * FROM context_doc WHERE owner_kind = ? AND owner_id = ? AND slug = ? AND ${LIVE()}`)
      .bind(owner.owner_kind, owner.owner_id, slug)
      .first<ContextDocRow>();

  let slug = base;
  let existing = await find(slug);
  if (existing && args.replace === false) {
    for (let n = 2; existing; n++) {
      slug = `${base}-${n}`;
      existing = await find(slug);
    }
  }

  if (existing) {
    if (typeof args.expected_version === "number" && args.expected_version !== existing.version) {
      throw new ConflictError("version conflict", stripContent(existing));
    }
    return replaceContent(
      db,
      existing,
      { content_md: args.content_md, title, pinned: args.pinned, sort: args.sort, source, filename: args.filename },
      by,
      "update",
    );
  }

  checkOwnerSize(await ownerBytes(db, owner), bytes);
  const ts = now();
  const id = newId();
  await db.batch([
    db
      .prepare(
        "INSERT INTO context_doc (id, project_id, owner_kind, owner_id, title, slug, source, filename, content_md, pinned, sort, bytes, version, created_at, updated_at, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)",
      )
      .bind(
        id,
        owner.project_id,
        owner.owner_kind,
        owner.owner_id,
        title,
        slug,
        source,
        args.filename ?? null,
        args.content_md,
        args.pinned ? 1 : 0,
        args.sort ?? 0,
        bytes,
        ts,
        ts,
        by.actor,
        by.actor,
      ),
    eventStmt(db, {
      by,
      project_id: owner.project_id,
      entity: "context_doc",
      entity_id: id,
      action: "create",
      summary: label({ ...owner, slug }),
      diff: { bytes: [null, bytes] },
    }),
    ...touchProject(db, by, owner.project_id, ts),
  ]);
  return getDoc(db, id);
}

/**
 * Append a stamped section. Atomic in one batch, never read-modify-write, so concurrent sessions
 * appending to the same doc (e.g. slug 'handover') all survive. Creates the doc if missing.
 */
export async function appendContext(
  db: D1Database,
  args: ({ doc_id: string } | (OwnerRef & { slug: string })) & { text: string; heading?: string | null; title?: string | null },
  by: Caller,
): Promise<ContextDocRow> {
  const text = args.text?.trim();
  if (!text) throw new ValidationError("text is required");
  const ts = now();
  const heading = (args.heading?.trim() || "Update").replace(/\s+/g, " ");
  const section = `\n\n## ${heading} (${ts}, ${by.actor})\n\n${text}\n`;
  const add = utf8Bytes(section);
  checkDocSize(add);

  let owner: OwnerRef & { project_id: string };
  let keySql: string;
  let keyArgs: string[];
  const pre: D1PreparedStatement[] = [];

  if ("doc_id" in args && args.doc_id) {
    const d = await db
      .prepare(`SELECT owner_kind, owner_id, project_id FROM context_doc WHERE id = ? AND ${LIVE()}`)
      .bind(args.doc_id)
      .first<OwnerRef & { project_id: string }>();
    if (!d) throw new NotFoundError(`context document ${args.doc_id} not found`);
    owner = d;
    keySql = "id = ? AND deleted_at IS NULL";
    keyArgs = [args.doc_id];
  } else {
    const ref = args as OwnerRef & { slug: string };
    const info = await resolveOwner(db, ref);
    const slug = slugify(ref.slug ?? "");
    owner = info;
    keySql = "owner_kind = ? AND owner_id = ? AND slug = ? AND deleted_at IS NULL";
    keyArgs = [info.owner_kind, info.owner_id, slug];
    pre.push(
      db
        .prepare(
          "INSERT INTO context_doc (id, project_id, owner_kind, owner_id, title, slug, source, filename, content_md, pinned, sort, bytes, version, created_at, updated_at, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, 'claude', NULL, '', 0, 0, 0, 1, ?, ?, ?, ?) ON CONFLICT(owner_kind, owner_id, slug) DO NOTHING",
        )
        .bind(newId(), info.project_id, info.owner_kind, info.owner_id, args.title?.trim() || slug, slug, ts, ts, by.actor, by.actor),
    );
  }

  // Same guard on every statement: doc cap and owner cap, evaluated inside the transaction.
  const guard = `${keySql} AND bytes + ? <= ? AND (SELECT COALESCE(SUM(bytes), 0) FROM context_doc WHERE owner_kind = ? AND owner_id = ? AND deleted_at IS NULL) + ? <= ?`;
  const guardArgs = [...keyArgs, add, CONTEXT_DOC_MAX_BYTES, owner.owner_kind, owner.owner_id, add, CONTEXT_OWNER_MAX_BYTES];

  const stmts = [
    ...pre,
    db
      .prepare(
        `INSERT INTO context_revision (doc_id, version, content_md, changed_at, changed_by) SELECT id, version, content_md, ?, ? FROM context_doc WHERE ${guard} AND bytes > 0`,
      )
      .bind(ts, by.actor, ...guardArgs),
    db
      .prepare(
        `UPDATE context_doc SET content_md = content_md || ?, bytes = bytes + ?, version = version + 1, updated_at = ?, updated_by = ? WHERE ${guard}`,
      )
      .bind(section, add, ts, by.actor, ...guardArgs),
    // Event only if the UPDATE above applied (changes() refers to the previous statement).
    db
      .prepare(
        `INSERT INTO event (ts, actor, person_id, project_id, entity, entity_id, action, summary, diff_json) SELECT ?, ?, ?, ?, 'context_doc', (SELECT id FROM context_doc WHERE ${keySql}), 'append', ?, ? WHERE changes() > 0`,
      )
      .bind(
        ts,
        by.actor,
        by.personId,
        owner.project_id,
        ...keyArgs,
        `${owner.owner_kind}:${owner.owner_id} append: ${heading}`,
        JSON.stringify({ bytes_added: [0, add] }),
      ),
    db
      .prepare(
        `DELETE FROM context_revision WHERE doc_id = (SELECT id FROM context_doc WHERE ${keySql}) AND id NOT IN (SELECT id FROM context_revision WHERE doc_id = (SELECT id FROM context_doc WHERE ${keySql}) ORDER BY id DESC LIMIT ?)`,
      )
      .bind(...keyArgs, ...keyArgs, CONTEXT_REVISIONS_KEPT),
  ];
  stmts.push(...touchProject(db, by, owner.project_id, ts));
  const res = await db.batch(stmts);
  const doc = await db
    .prepare(`SELECT * FROM context_doc WHERE ${keySql}`)
    .bind(...keyArgs)
    .first<ContextDocRow>();
  if (!doc) throw new NotFoundError("context document not found");
  if (!res[pre.length + 1].meta.changes) {
    throw new TooLargeError(
      `append of ${kb(add)} would exceed ${kb(CONTEXT_DOC_MAX_BYTES)} per document or ${kb(CONTEXT_OWNER_MAX_BYTES)} per owner`,
    );
  }
  return doc;
}

/** Move a doc to the trash (spec F10); the delete event keeps its full content. Restore with restoreEntity. */
export async function deleteContext(db: D1Database, docId: string, by: Caller): Promise<{ deleted: string; children: number }> {
  return deleteEntity(db, "context_doc", docId, by);
}

export async function listRevisions(
  db: D1Database,
  docId: string,
): Promise<Array<Omit<ContextRevisionRow, "content_md"> & { bytes: number }>> {
  await getDoc(db, docId);
  const { results } = await db
    .prepare(
      "SELECT id, doc_id, version, changed_at, changed_by, length(CAST(content_md AS BLOB)) AS bytes FROM context_revision WHERE doc_id = ? ORDER BY id DESC",
    )
    .bind(docId)
    .all<Omit<ContextRevisionRow, "content_md"> & { bytes: number }>();
  return results;
}

export async function getRevision(db: D1Database, revisionId: number): Promise<ContextRevisionRow> {
  const r = await db
    .prepare(`SELECT r.* FROM context_revision r JOIN context_doc d ON d.id = r.doc_id AND ${LIVE("d")} WHERE r.id = ?`)
    .bind(revisionId)
    .first<ContextRevisionRow>();
  if (!r) throw new NotFoundError(`revision ${revisionId} not found`);
  return r;
}

export async function restoreRevision(
  db: D1Database,
  docId: string,
  revisionId: number,
  by: Caller,
  expectedVersion?: number,
): Promise<ContextDocRow> {
  const rev = await getRevision(db, revisionId);
  if (rev.doc_id !== docId) throw new ValidationError("revision does not belong to this document");
  const existing = await getDoc(db, docId);
  if (typeof expectedVersion === "number" && expectedVersion !== existing.version)
    throw new ConflictError("version conflict", stripContent(existing));
  return replaceContent(db, existing, { content_md: rev.content_md }, by, "restore", ` (restored v${rev.version})`);
}

/**
 * Title / pin / sort / document status only: no revision, no version bump. Becoming `released` stamps
 * released_by (the actor) and released_at; other status changes keep the last release stamp.
 */
export async function setContextMeta(
  db: D1Database,
  docId: string,
  patch: { title?: string; pinned?: boolean; sort?: number; status?: string },
  by: Caller,
): Promise<ContextDocRow> {
  const d = await getDoc(db, docId);
  if (patch.status !== undefined && !DOC_STATUSES.includes(patch.status as ContextDocStatus))
    throw new ValidationError(`status must be one of ${DOC_STATUSES.join("|")}`);
  const title = patch.title?.trim() || d.title;
  const pinned = patch.pinned === undefined ? d.pinned : patch.pinned ? 1 : 0;
  const sort = typeof patch.sort === "number" && Number.isFinite(patch.sort) ? Math.trunc(patch.sort) : d.sort;
  const status = (patch.status as ContextDocStatus | undefined) ?? d.status;
  const release = status === "released" && d.status !== "released";
  const releasedBy = release ? by.actor : d.released_by;
  const releasedAt = release ? now() : d.released_at;
  await db.batch([
    db
      .prepare(
        `UPDATE context_doc SET title = ?, pinned = ?, sort = ?, status = ?, released_by = ?, released_at = ? WHERE id = ? AND ${LIVE()}`,
      )
      .bind(title, pinned, sort, status, releasedBy, releasedAt, docId),
    eventStmt(db, {
      by,
      project_id: d.project_id,
      entity: "context_doc",
      entity_id: docId,
      action: "meta",
      summary: label(d),
      diff: Object.fromEntries(
        (
          [
            ["title", d.title, title],
            ["pinned", d.pinned, pinned],
            ["sort", d.sort, sort],
            ["status", d.status, status],
            ["released_by", d.released_by, releasedBy],
            ["released_at", d.released_at, releasedAt],
          ] as const
        )
          .filter(([, a, b]) => a !== b)
          .map(([k, a, b]) => [k, [a, b]]),
      ),
    }),
  ]);
  return getDoc(db, docId);
}
