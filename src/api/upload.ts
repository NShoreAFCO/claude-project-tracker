import type { Caller, ContextDocRow, OwnerKind } from "../types";
import { CONTEXT_DOC_MAX_BYTES } from "../types";
import { writeContext } from "../data/context-write";
import { ValidationError } from "../data/util";

const ALLOWED = /\.(md|markdown|txt)$/i;
export const MAX_UPLOAD_REQUEST = 3 * 1024 * 1024;
const MAX_FILES = 20;

export type UploadResult =
  { filename: string; ok: true; doc: Omit<ContextDocRow, "content_md"> } | { filename: string; ok: false; error: string };

/** Strict UTF-8 decode (BOM stripped); null if the bytes are not valid UTF-8 or contain NUL. */
export function decodeUtf8(bytes: ArrayBuffer): string | null {
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    return text.includes("\u0000") ? null : text;
  } catch {
    return null;
  }
}

/**
 * POST /api/context/upload (multipart/form-data): owner_kind, owner_id, replace ("true" to overwrite
 * a doc with the same slug, else a -2 suffix is used), pinned?, files (1..20 × .md/.markdown/.txt).
 * Each file is processed independently; one bad file does not stop the others.
 */
export async function handleUpload(request: Request, db: D1Database, by: Caller): Promise<{ results: UploadResult[] }> {
  if (!(request.headers.get("Content-Type") ?? "").toLowerCase().startsWith("multipart/form-data")) {
    throw new ValidationError("expected multipart/form-data");
  }
  const len = Number(request.headers.get("Content-Length") ?? "0");
  if (len > MAX_UPLOAD_REQUEST) throw new ValidationError(`upload request larger than ${MAX_UPLOAD_REQUEST / 1024 / 1024} MB`);

  const form = await request.formData();
  const ownerKind = String(form.get("owner_kind") ?? "") as OwnerKind;
  const ownerId = String(form.get("owner_id") ?? "");
  const replace = form.get("replace") === "true";
  const pinned = form.get("pinned") === "true";
  if (!ownerKind || !ownerId) throw new ValidationError("owner_kind and owner_id are required");

  const files = form.getAll("files").filter((f): f is File => typeof f !== "string");
  if (!files.length) throw new ValidationError("no files in field 'files'");
  if (files.length > MAX_FILES) throw new ValidationError(`at most ${MAX_FILES} files per upload`);

  const results: UploadResult[] = [];
  for (const file of files) {
    const filename = (file.name || "upload.md").split(/[\\/]/).pop()!.slice(0, 200);
    if (!ALLOWED.test(filename)) {
      results.push({ filename, ok: false, error: "only .md, .markdown and .txt files are accepted" });
      continue;
    }
    if (file.size > CONTEXT_DOC_MAX_BYTES) {
      results.push({ filename, ok: false, error: `file is ${Math.round(file.size / 1024)} KB; the limit is 256 KB per document` });
      continue;
    }
    const text = decodeUtf8(await file.arrayBuffer());
    if (text === null) {
      results.push({ filename, ok: false, error: "file is not valid UTF-8 text" });
      continue;
    }
    const base = filename.replace(ALLOWED, "");
    try {
      const doc = await writeContext(
        db,
        {
          owner_kind: ownerKind,
          owner_id: ownerId,
          title: base || filename,
          slug: base,
          content_md: text,
          source: "upload",
          filename,
          pinned,
          replace,
        },
        by,
      );
      const { content_md: _c, ...meta } = doc;
      results.push({ filename, ok: true, doc: meta });
    } catch (e) {
      const err = e as { status?: number; message?: string };
      if (err.status === 404 || err.status === 400) throw e; // owner problems apply to all files
      results.push({ filename, ok: false, error: err.message ?? "upload failed" });
    }
  }
  return { results };
}
