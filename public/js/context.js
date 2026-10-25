// Context repository UI (SPEC §9.2): per-owner doc list, inherited docs, upload, paste, editor with live preview,
// append mode, history with line diff and restore, bundle copy/download.
import { t, fmtBytes, fmtDateTime, STRINGS } from "./i18n.js";
import { api } from "./api.js";
import { h, clear, openModal, toast, toastError, copyText, confirmDialog, saveWithConflict, menuButton } from "./dom.js";
import { renderMarkdown } from "./markdown.js";
import { lineDiff } from "./diff.js";
import { changed, wpOptions, deleteEntity } from "./forms.js";

const OWNER_MAX = 2 * 1024 * 1024;
const smallBtn = (label, onClick, cls = "ghost", extra = {}) =>
  h(`button.btn.small.${cls}`, { type: "button", ...extra, on: { click: onClick } }, label);
const md = (src) => {
  const el = h("div.md");
  el.innerHTML = renderMarkdown(src || ""); // sanitised: escape-first renderer, allow-listed links only
  return el;
};

function ownerLabel(detail, o) {
  if (o.owner_kind === "project") return `${t("ownerKind.project")}: ${detail.project.title}`;
  if (o.owner_kind === "branch") {
    const b = detail.branches.find((x) => x.id === o.owner_id);
    return `${t("ownerKind.branch")}: ${b ? `${b.repo}@${b.name}` : o.owner_id}`;
  }
  const find = (tree) => {
    for (const w of tree || []) {
      if (w.id === o.owner_id) return w;
      const c = find(w.children);
      if (c) return c;
    }
    return null;
  };
  return `${t("ownerKind.workpackage")}: ${find(detail.workpackages)?.title ?? o.owner_id}`;
}

function bundleParams(detail, o) {
  const p = { project_id: detail.project.id };
  if (o.owner_kind === "workpackage") p.workpackage_id = o.owner_id;
  if (o.owner_kind === "branch") p.branch_id = o.owner_id;
  return p;
}

export async function renderContextPanel(container, { detail, owner, onOwner }) {
  const p = detail.project;
  // owner picker: project, every WP (indented), every branch
  const sel = h(
    "select",
    { "aria-label": t("ctxTitle", { owner: "" }), on: { change: (e) => e.target.value && onOwner(JSON.parse(e.target.value)) } },
    h("option", { value: JSON.stringify({ owner_kind: "project", owner_id: p.id }) }, `${t("ownerKind.project")}: ${p.title}`),
    wpOptions(detail.workpackages).map(([id, label]) =>
      h("option", { value: JSON.stringify({ owner_kind: "workpackage", owner_id: id }) }, `${t("ownerKind.workpackage")}: ${label}`),
    ),
    detail.branches.map((b) =>
      h("option", { value: JSON.stringify({ owner_kind: "branch", owner_id: b.id }) }, `${t("ownerKind.branch")}: ${b.repo}@${b.name}`),
    ),
  );
  sel.value = JSON.stringify({ owner_kind: owner.owner_kind, owner_id: owner.owner_id });

  // bundles leave obsolete documents out unless asked for
  const obsolete = h("input", { type: "checkbox", id: "ctx-obsolete" });
  const obsoleteLabel = h("label.check", { for: "ctx-obsolete" }, obsolete, t("ctxIncludeObsolete"));
  const downloadLink = h(
    "a.btn.small.secondary",
    { href: api.bundleUrl(bundleParams(detail, owner)), download: "" },
    t("ctxBundleDownload"),
  );
  obsolete.addEventListener("change", () => {
    downloadLink.href = api.bundleUrl({ ...bundleParams(detail, owner), include_obsolete: obsolete.checked ? "true" : "" });
  });

  const listHost = h("div", h("p", t("loading")));
  clear(
    container,
    h("div.toolbar", h("div", { style: { flex: "1 1 280px" } }, sel)),
    h("h3", t("ctxTitle", { owner: ownerLabel(detail, owner) })),
    h(
      "div.toolbar",
      smallBtn(t("ctxBundleCopy"), () => copyBundle(detail, owner, obsolete.checked), "secondary"),
      downloadLink,
      obsoleteLabel,
    ),
    h("div.callout", t("ctxReferenceNote")),
    listHost,
    addSection(detail, owner),
  );

  let docs;
  try {
    docs = await api.contextList(owner.owner_kind, owner.owner_id, true);
  } catch (e) {
    clear(listHost, h("div.callout.conflict", t("errorGeneric", { msg: e.message })));
    return;
  }
  const own = docs.filter((d) => !d.inherited);
  const inherited = docs.filter((d) => d.inherited);
  const used = own.reduce((s, d) => s + d.bytes, 0);
  clear(
    listHost,
    h("p.meta", t("ctxSize", { used: fmtBytes(used) }), used > OWNER_MAX * 0.9 ? " ⚠" : ""),
    own.length ? docList(own, detail) : h("p.empty", t("ctxNoDocs")),
    inherited.length
      ? h(
          "details.inherited",
          h("summary", t("ctxInherited", { n: inherited.length })),
          h("p.meta", t("ctxInheritedHint")),
          inherited.map((d) =>
            h(
              "div.callout",
              h("strong", d.title),
              " ",
              h("span.meta", t("ctxFrom", { owner: `${t(`ownerKind.${d.owner_kind}`)} ${d.owner_title}` })),
              h("div.meta", `${fmtBytes(d.bytes)} · ${t("ctxVersion", { v: d.version })} · ${fmtDateTime(d.updated_at)}`),
              smallBtn(t("ctxOpen"), () => openDocViewer(d.id)),
            ),
          ),
        )
      : null,
  );
}

async function copyBundle(detail, owner, includeObsolete = false) {
  try {
    const b = await api.bundle({ ...bundleParams(detail, owner), include_obsolete: includeObsolete ? "true" : "" });
    await copyText(b.markdown);
    if (b.omitted?.length) toast(t("ctxBundleOmitted", { n: b.omitted.length }));
  } catch (e) {
    toastError(e);
  }
}

/** Document control badge (spec F10): draft | released | obsolete. */
function docStatusBadge(d) {
  const status = d.status || "draft";
  return h(`span.badge.doc-status.doc-${status}`, { style: { "margin-left": "0.4rem" } }, t(`docStatus.${status}`));
}

async function setDocStatus(d, status, projectId) {
  try {
    await api.contextMeta(d.id, { status });
    toast(t("ctxStatusSet", { status: t(`docStatus.${status}`) }));
  } catch (e) {
    toastError(e);
  }
  changed(projectId);
}

function docList(docs, detail) {
  const projectId = detail.project.id;
  const ordered = [...docs].sort((a, b) => b.pinned - a.pinned || a.sort - b.sort || a.title.localeCompare(b.title));
  const list = h("ul.ctx-list");
  let dragId = null;

  async function persistOrder(ids) {
    try {
      for (let i = 0; i < ids.length; i++) {
        const d = ordered.find((x) => x.id === ids[i]);
        if (d.sort !== i * 10) await api.contextMeta(d.id, { sort: i * 10 });
      }
    } catch (e) {
      toastError(e);
    }
    changed(projectId);
  }
  const move = (id, delta) => {
    const ids = ordered.map((d) => d.id);
    const i = ids.indexOf(id);
    const j = i + delta;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    persistOrder(ids);
  };

  for (const d of ordered) {
    const li = h(
      "li.ctx-item",
      {
        draggable: "true",
        dataset: { id: d.id },
        on: {
          dragstart: (e) => {
            dragId = d.id;
            li.classList.add("dragging");
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", d.id);
          },
          dragend: () => li.classList.remove("dragging"),
          dragover: (e) => {
            if (!dragId || dragId === d.id) return;
            e.preventDefault();
            li.classList.add("drop-target");
          },
          dragleave: () => li.classList.remove("drop-target"),
          drop: (e) => {
            e.preventDefault();
            li.classList.remove("drop-target");
            if (!dragId || dragId === d.id) return;
            const ids = ordered.map((x) => x.id).filter((x) => x !== dragId);
            ids.splice(ids.indexOf(d.id), 0, dragId);
            dragId = null;
            persistOrder(ids);
          },
        },
      },
      h("span.handle", { title: t("ctxDragHint"), "aria-hidden": "true" }, "⠿"),
      h(
        "div.info",
        h("span", { title: t(`source.${d.source}`), "aria-label": t(`source.${d.source}`) }, `${STRINGS.sourceIcon[d.source] || ""} `),
        h("strong", d.title),
        d.pinned ? h("span.badge", { style: { "margin-left": "0.4rem" } }, `📌 ${t("ctxPinned")}`) : null,
        docStatusBadge(d),
        h(
          "div.sub",
          `${fmtBytes(d.bytes)} · ${t("ctxVersion", { v: d.version })} · ${t("ctxUpdated", { when: fmtDateTime(d.updated_at), by: d.updated_by })}`,
        ),
        d.status === "released" && d.released_at
          ? h("div.sub", t("ctxReleasedBy", { when: fmtDateTime(d.released_at), by: d.released_by || t("none") }))
          : null,
      ),
      h(
        "div.actions",
        smallBtn("↑", () => move(d.id, -1), "ghost", { "aria-label": t("ctxMoveUp") }),
        smallBtn("↓", () => move(d.id, 1), "ghost", { "aria-label": t("ctxMoveDown") }),
        smallBtn(d.pinned ? t("ctxUnpin") : t("ctxPin"), async () => {
          try {
            await api.contextMeta(d.id, { pinned: !d.pinned });
          } catch (e) {
            toastError(e);
          }
          changed(projectId);
        }),
        smallBtn(t("ctxOpen"), () => openDocViewer(d.id)),
        smallBtn(t("ctxEdit"), () => openEditor(d.id)),
        smallBtn(t("ctxAppend"), () => openAppend(d.id, d.title, projectId)),
        smallBtn(t("ctxHistory"), () => openHistory(d.id)),
        d.status === "released" ? null : smallBtn(t("ctxRelease"), () => setDocStatus(d, "released", projectId), "secondary"),
        menuButton(t("moreActions"), [
          ...(d.status === "obsolete" ? [] : [{ label: t("ctxMarkObsolete"), onClick: () => setDocStatus(d, "obsolete", projectId) }]),
          ...(d.status === "draft" ? [] : [{ label: t("ctxBackToDraft"), onClick: () => setDocStatus(d, "draft", projectId) }]),
          { label: t("delete"), danger: true, onClick: () => deleteEntity("context_doc", d.id, d.title, projectId) },
        ]),
      ),
    );
    list.append(li);
  }
  return list;
}

function addSection(detail, owner) {
  const projectId = detail.project.id;
  const fileInput = h("input", {
    type: "file",
    multiple: true,
    accept: ".md,.markdown,.txt,text/markdown,text/plain",
    class: "sr-only",
    id: "ctx-file",
  });
  const replace = h("input", { type: "checkbox", id: "ctx-replace" });
  const results = h("div", { role: "status" });

  async function upload(files) {
    if (!files?.length) return;
    const form = new FormData();
    form.set("owner_kind", owner.owner_kind);
    form.set("owner_id", owner.owner_id);
    form.set("replace", replace.checked ? "true" : "false");
    for (const f of files) form.append("files", f, f.name);
    try {
      const { results: r } = await api.contextUpload(form);
      const ok = r.filter((x) => x.ok).length;
      clear(
        results,
        h("p", t("ctxUploaded", { ok, n: r.length })),
        r.filter((x) => !x.ok).map((x) => h("div.callout.conflict", t("ctxUploadFailed", { file: x.filename, error: x.error }))),
      );
      // the panel re-renders on change, so rejected files are also reported in a toast
      const failed = r.filter((x) => !x.ok);
      if (failed.length) toast(failed.map((x) => t("ctxUploadFailed", { file: x.filename, error: x.error })).join(" · "), true);
      if (ok) changed(projectId);
    } catch (e) {
      toastError(e);
    }
  }
  fileInput.addEventListener("change", () => upload(fileInput.files).then(() => (fileInput.value = "")));

  const zone = h(
    "div.dropzone",
    {
      on: {
        dragover: (e) => {
          if (![...(e.dataTransfer?.types || [])].includes("Files")) return;
          e.preventDefault();
          zone.classList.add("over");
        },
        dragleave: () => zone.classList.remove("over"),
        drop: (e) => {
          if (!e.dataTransfer?.files?.length) return;
          e.preventDefault();
          zone.classList.remove("over");
          upload(e.dataTransfer.files);
        },
      },
    },
    h("p", t("ctxDrop"), " ", h("label.btn.small.secondary", { for: "ctx-file", style: { display: "inline-block" } }, t("ctxPick"))),
    fileInput,
    h("p.meta", t("ctxAccept")),
    h("label.check", { for: "ctx-replace", style: { "justify-content": "center" } }, replace, t("ctxReplace")),
  );

  const title = h("input", { id: "ctx-paste-title", required: true });
  const text = h("textarea", { id: "ctx-paste-text", rows: 10 });
  const err = h("div.callout.conflict", { hidden: true, role: "alert" });
  const paste = h(
    "form",
    {
      on: {
        submit: async (e) => {
          e.preventDefault();
          err.hidden = true;
          if (!title.value.trim() || !text.value.trim()) {
            err.textContent = t("required", { field: `${t("ctxPasteTitle")} / ${t("ctxPasteText")}` });
            err.hidden = false;
            return;
          }
          try {
            await api.contextCreate({ ...owner, title: title.value.trim(), content_md: text.value, source: "paste" });
            toast(t("saved"));
            title.value = "";
            text.value = "";
            changed(projectId);
          } catch (e2) {
            err.textContent = t("errorGeneric", { msg: e2.message });
            err.hidden = false;
          }
        },
      },
    },
    h("div.field", h("label", { for: "ctx-paste-title" }, t("ctxPasteTitle")), title),
    h("div.field", h("label", { for: "ctx-paste-text" }, t("ctxPasteText")), text),
    err,
    h("button.btn", { type: "submit" }, t("save")),
  );

  return h(
    "section.block",
    h("header", h("h3", t("add"))),
    zone,
    results,
    h("details", h("summary.btn.small.ghost", t("ctxPaste")), h("div", { style: { "margin-top": "0.8rem" } }, paste)),
  );
}

export async function openDocViewer(docId) {
  try {
    const d = await api.contextGet(docId);
    const m = openModal({ title: d.title });
    m.body.append(h("p.meta", h("code", d.header)), h("div.callout", t("ctxReferenceNote")), md(d.content_md));
    m.foot.append(
      smallBtn(t("copy"), () => copyText(d.content_md), "secondary"),
      smallBtn(t("close"), () => m.close(), ""),
    );
  } catch (e) {
    toastError(e);
  }
}

/** Editor with live preview; saves with expected_version (409 → conflict dialog). */
export async function openEditor(docId) {
  let d;
  try {
    d = await api.contextGet(docId);
  } catch (e) {
    return toastError(e);
  }
  const m = openModal({ title: t("ctxEditTitle") });
  const title = h("input", { id: "ed-title", value: d.title });
  const area = h("textarea", { id: "ed-text", rows: 22 });
  area.value = d.content_md;
  const preview = h("div.preview.md", { "aria-live": "off" });
  const err = h("div.callout.conflict", { hidden: true, role: "alert" });
  let timer;
  const update = () => {
    clearTimeout(timer);
    timer = setTimeout(() => (preview.innerHTML = renderMarkdown(area.value)), 150);
  };
  area.addEventListener("input", update);
  preview.innerHTML = renderMarkdown(area.value);
  m.body.append(
    h("div.field", h("label", { for: "ed-title" }, t("fTitle")), title),
    h("p.meta", t("ctxVersion", { v: d.version })),
    h("div.editor", h("div", h("label", { for: "ed-text" }, t("ctxPasteText")), area), h("div", h("label", t("ctxPreview")), preview)),
    err,
  );
  const save = h("button.btn", { type: "button" }, t("save"));
  save.addEventListener("click", async () => {
    save.disabled = true;
    err.hidden = true;
    try {
      const res = await saveWithConflict(
        (ver) => api.contextReplace(d.id, { title: title.value, content_md: area.value, expected_version: ver }),
        d.version,
        (cur) => h("p", `${cur.title} · v${cur.version} · ${cur.updated_by}`),
      );
      if (res?.cancelled) return;
      if (res?.reload) {
        m.close();
        changed(d.project_id);
        return openEditor(d.id);
      }
      toast(t("saved"));
      changed(d.project_id);
      m.close();
    } catch (e) {
      err.textContent = t("errorGeneric", { msg: e.message });
      err.hidden = false;
    } finally {
      save.disabled = false;
    }
  });
  m.foot.append(
    smallBtn(t("cancel"), () => m.close()),
    save,
  );
}

/** Append a stamped section (atomic on the server; concurrent sessions don't overwrite each other). */
export function openAppend(docId, docTitle, projectId) {
  const m = openModal({ title: `${t("ctxAppendTitle")}: ${docTitle}`, narrow: false });
  const heading = h("input", { id: "ap-head" });
  const area = h("textarea", { id: "ap-text", rows: 12 });
  const preview = h("div.preview.md");
  area.addEventListener("input", () => (preview.innerHTML = renderMarkdown(area.value)));
  const err = h("div.callout.conflict", { hidden: true, role: "alert" });
  m.body.append(
    h("p.meta", t("ctxAppendHint")),
    h("div.field", h("label", { for: "ap-head" }, t("ctxAppendHeading")), heading),
    h("div.editor", h("div", h("label", { for: "ap-text" }, t("ctxPasteText")), area), h("div", h("label", t("ctxPreview")), preview)),
    err,
  );
  const save = h("button.btn", { type: "button" }, t("ctxAppend"));
  save.addEventListener("click", async () => {
    if (!area.value.trim()) {
      err.textContent = t("required", { field: t("ctxPasteText") });
      err.hidden = false;
      return;
    }
    save.disabled = true;
    try {
      await api.contextAppend(docId, { text: area.value, heading: heading.value.trim() || undefined });
      toast(t("saved"));
      changed(projectId);
      m.close();
    } catch (e) {
      err.textContent = t("errorGeneric", { msg: e.message });
      err.hidden = false;
    } finally {
      save.disabled = false;
    }
  });
  m.foot.append(
    smallBtn(t("cancel"), () => m.close()),
    save,
  );
}

/** Revision list → line diff against the current version → restore. */
export async function openHistory(docId) {
  let d;
  let revs;
  try {
    [d, revs] = await Promise.all([api.contextGet(docId), api.contextRevisions(docId)]);
  } catch (e) {
    return toastError(e);
  }
  const m = openModal({ title: t("ctxHistoryTitle", { title: d.title }) });
  const view = h("div");
  const list = h("ul.timeline");
  if (!revs.length) m.body.append(h("p.empty", t("ctxNoRevisions")));
  for (const r of revs) {
    list.append(
      h(
        "li",
        h("time", { datetime: r.changed_at }, fmtDateTime(r.changed_at)),
        h(
          "div",
          h("button.linkbtn", { type: "button", on: { click: () => showRev(r) } }, t("ctxRevision", { v: r.version })),
          ` · ${r.changed_by} · ${fmtBytes(r.bytes)}`,
        ),
      ),
    );
  }
  if (revs.length) m.body.append(list, view);

  async function showRev(meta) {
    clear(view, h("p", t("loading")));
    try {
      const rev = await api.contextRevision(meta.id);
      const diff = lineDiff(rev.content_md, d.content_md);
      const box = h("div.diff", { role: "region", "aria-label": t("ctxDiffTo") });
      for (const x of diff) {
        const sign = x.op === "add" ? "+ " : x.op === "del" ? "− " : "  ";
        box.append(h(`div.${x.op}`, sign + x.line));
      }
      clear(
        view,
        h("h3", `${t("ctxRevision", { v: rev.version })} → ${t("ctxVersion", { v: d.version })}`),
        h("p.meta", t("ctxDiffTo")),
        box,
        h(
          "div.toolbar",
          { style: { "margin-top": "0.8rem" } },
          h(
            "button.btn",
            {
              type: "button",
              on: {
                click: async () => {
                  if (!(await confirmDialog(t("ctxConfirmRestore", { v: rev.version })))) return;
                  try {
                    const res = await saveWithConflict((ver) => api.contextRestore(d.id, rev.id, ver), d.version);
                    if (res?.cancelled) return;
                    if (res?.reload) {
                      m.close();
                      changed(d.project_id);
                      return openHistory(d.id);
                    }
                    toast(t("ctxRestored", { v: rev.version }));
                    changed(d.project_id);
                    m.close();
                  } catch (e) {
                    toastError(e);
                  }
                },
              },
            },
            t("ctxRestore"),
          ),
        ),
      );
    } catch (e) {
      clear(view, h("div.callout.conflict", t("errorGeneric", { msg: e.message })));
    }
  }
  m.foot.append(smallBtn(t("close"), () => m.close(), ""));
}
