// Project popup: Overview (description, WP tree, branches, scorecard, token cost, timeline, copy buttons) and Kontext.
import { t, fmtDate, fmtDateTime, fmtNum, fmtPct, STRINGS } from "./i18n.js";
import { renderRisks } from "./risks.js";
import { basisLabel, riskChip, staleChip, lastActivity } from "./progress-view.js";
import { api } from "./api.js";
import { h, clear, openModal, statusChip, progressBar, copyText, toast, toastError, menuButton, personBadge, ageDays } from "./dom.js";
import { closureDialog } from "./closure.js";
import { renderMarkdown } from "./markdown.js";
import { catChip } from "./categories.js";
import {
  projectForm,
  wpForm,
  branchForm,
  scoresForm,
  tokenCostForm,
  logProgressForm,
  milestoneForm,
  adjustProgressDialog,
  adjustProjectProgressForm,
  markCompleteDialog,
  deleteEntity,
} from "./forms.js";
import { renderContextPanel, openDocViewer } from "./context.js";
import { collectIssues, issuesByEntity } from "./schedule-ui.js";
import { issueList, issueBadge, scheduleMeta, milestoneItem } from "./schedule-view.js";
import { decisionDialog, baselineDialog } from "./gates-ui.js";

/** Render sanitised markdown into a container (the only innerHTML use in the app). */
export function mdBlock(src) {
  const el = h("div.md");
  el.innerHTML = renderMarkdown(src || "");
  return el;
}

const block = (title, actions, ...content) => h("section.block", h("header", h("h3", title), actions || null), ...content);

/** Download a Blob under a file name. */
function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = h("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/** Report button (spec F9): PDF by default; the menu offers HTML (new tab) and Markdown (download). */
function reportActions(projectId) {
  const open = async (format) => {
    try {
      const blob = await api.report(projectId, format);
      if (format === "md") return saveBlob(blob, `${projectId}.md`);
      const url = URL.createObjectURL(new Blob([blob], { type: format === "pdf" ? "application/pdf" : "text/html" }));
      window.open(url, "_blank", "noopener");
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) {
      if (e.status === 503 && e.body?.error === "pdf_unavailable") toast(t("reportPdfUnavailable"), true);
      else toastError(e);
    }
  };
  return h(
    "span.report-actions",
    h("button.btn.small.secondary", { type: "button", on: { click: () => open("pdf") } }, t("report")),
    menuButton(t("reportFormats"), [
      { label: t("reportHtml"), onClick: () => open("html") },
      { label: t("reportMd"), onClick: () => open("md") },
    ]),
  );
}

const smallBtn = (label, onClick, cls = "ghost") => h(`button.btn.small.${cls}`, { type: "button", on: { click: onClick } }, label);

export async function openProject(id, { tab = "overview", owner = null, openDoc = null } = {}) {
  let detail;
  let current = { tab, owner };
  const fold = { open: new Set(), issuesOnly: false, blocks: { branches: true, tokenCost: false, timeline: true } };
  const tabs = h("div.tabs", { role: "tablist" });
  const m = openModal({
    title: t("loading"),
    headExtra: tabs,
    onClose: () => {
      window.removeEventListener("tracker:changed", onChanged);
      // only reset the URL if it still points at this project (close events fire asynchronously)
      if (location.hash.startsWith(`#/p/${encodeURIComponent(id)}`) && !document.querySelector("dialog[open]"))
        history.replaceState(null, "", "#/");
    },
  });
  history.replaceState(null, "", `#/p/${encodeURIComponent(id)}${tab === "context" ? "/kontext" : tab === "risks" ? "/risks" : ""}`);

  const cblock = (key, title, actions, ...content) => {
    const open = fold.blocks[key];
    return h(
      "section.block",
      h(
        "header",
        h(
          "h3",
          h(
            "button.fold-toggle",
            {
              type: "button",
              "aria-expanded": String(open),
              on: {
                click: () => {
                  fold.blocks[key] = !fold.blocks[key];
                  render();
                },
              },
            },
            open ? "▾ " : "▸ ",
            title,
          ),
        ),
        open ? actions || null : null,
      ),
      ...(open ? content : []),
    );
  };

  let personNames = new Map();
  async function load() {
    try {
      detail = await api.project(id);
      personNames = new Map((await api.persons().catch(() => [])).map((x) => [x.id, x.name]));
    } catch (e) {
      if (e.status === 404) return m.close();
      toastError(e);
      return;
    }
    render();
  }

  const onChanged = (e) => {
    if (!e.detail?.project_id || e.detail.project_id === id) load();
  };
  window.addEventListener("tracker:changed", onChanged);

  function setTab(name, owner) {
    current = { tab: name, owner: owner ?? (name === "context" ? current.owner : null) };
    history.replaceState(null, "", `#/p/${encodeURIComponent(id)}${name === "context" ? "/kontext" : name === "risks" ? "/risks" : ""}`);
    render();
  }

  let renderSeq = 0;
  function render() {
    const seq = ++renderSeq;
    const p = detail.project;
    m.heading.replaceChildren(p.title, " ", statusChip(p.status));
    clear(
      tabs,
      ["overview", "risks", "context"].map((name) =>
        h(
          "button",
          { type: "button", role: "tab", "aria-selected": String(current.tab === name), on: { click: () => setTab(name) } },
          name === "overview" ? t("tabOverview") : name === "risks" ? t("tabRisks") : t("tabContext"),
        ),
      ),
    );
    clear(m.foot);
    if (current.tab === "context") {
      const own = current.owner || { owner_kind: "project", owner_id: p.id };
      clear(m.body);
      renderContextPanel(m.body, { detail, owner: own, onOwner: (o) => setTab("context", o) });
    } else if (current.tab === "risks") {
      renderRisks(m.body, { detail, projectId: id, isCurrent: () => seq === renderSeq && current.tab === "risks" });
    } else {
      clear(m.body, overview(detail));
      m.foot.append(
        menuButton(t("moreActions"), [
          { label: t("setBaseline"), onClick: () => baselineDialog(p.id) },
          { label: t("delete"), danger: true, onClick: () => deleteEntity("project", p.id, p.title, p.id).then((ok) => ok && m.close()) },
        ]),
        ["done", "abandoned"].includes(p.status)
          ? null
          : smallBtn(t("closeProject"), () => closureDialog({ project: p, workpackages: detail.workpackages }), "secondary"),
        h("a.btn.small.secondary", { href: `#/gantt?project=${encodeURIComponent(p.id)}` }, t("cardGantt")),
        reportActions(p.id),
        smallBtn(t("logProgress"), () => logProgressForm(p.id, detail.workpackages), "secondary"),
        smallBtn(t("edit"), () => projectForm(p, { workpackages: detail.workpackages }), ""),
      );
    }
  }

  function ctxCount(kind, ownerId) {
    return detail.context_index.filter((d) => d.owner_kind === kind && d.owner_id === ownerId).length;
  }

  const ctxBadge = (kind, ownerId) =>
    h(
      "button.badge",
      {
        type: "button",
        title: t("tabContext"),
        "aria-label": t("contextBadge", { n: ctxCount(kind, ownerId) }),
        on: { click: () => setTab("context", { owner_kind: kind, owner_id: ownerId }) },
      },
      `≡ ${ctxCount(kind, ownerId)}`,
    );

  /** blocked_by is wp:<id>, ms:<id>, ext:<text> or free text; show titles instead of ids. */
  function blockedLabel(raw) {
    const m = /^(wp|ms|ext):([\s\S]*)$/.exec(String(raw).trim());
    if (!m) return raw;
    if (m[1] === "ext") return m[2].trim();
    const list = m[1] === "wp" ? flatten(detail.workpackages) : detail.milestones;
    return list.find((x) => x.id === m[2].trim())?.title ?? m[2].trim();
  }
  function blockedAge(w) {
    const n = w.status === "blocked" ? ageDays(w.blocked_since) : null;
    return n === null ? null : ` · ${t("blockedSince", { n, date: fmtDate(w.blocked_since) })}`;
  }

  /** Title of a work package or milestone of this project (schedule issue texts name the other party). */
  const titleOf = (x) => flatten(detail.workpackages).find((w) => w.id === x)?.title ?? detail.milestones.find((ms) => ms.id === x)?.title;

  /** Work packages shown in the list: all, or (issues filter) those with issues and their ancestors. */
  function issueWpIds(d) {
    const withIssues = issuesByEntity(collectIssues(d));
    const keep = new Set();
    const walk = (w) => {
      let hit = withIssues.has(w.id);
      for (const c of w.children || []) hit = walk(c) || hit;
      if (hit) keep.add(w.id);
      return hit;
    };
    d.workpackages.forEach(walk);
    return keep;
  }

  function wpNode(w, shown) {
    const leaf = !w.children?.length;
    const open = !leaf && (fold.open.has(w.id) || (shown && fold.issuesOnly));
    let slider = null;
    if (leaf) {
      // read-only: changes go through "Adjust progress" (spec F7)
      const input = h("input", {
        type: "range",
        min: 0,
        max: 100,
        step: 5,
        value: String(w.progress),
        disabled: true,
        "aria-label": `${t("progress")}: ${w.title}`,
      });
      slider = h("div.slider", input, h("output", fmtPct(w.progress)));
    } else slider = progressBar(w.effective_progress);

    const dates = w.start_date || w.end_date ? h("span.meta", `${fmtDate(w.start_date)} – ${fmtDate(w.end_date)}`) : null;
    const lockingMilestone = w.locked ? detail.milestones.find((ms) => ms.unlocks?.includes(w.id) && ms.reached_at === null) : null;
    const name = lockingMilestone?.title || "";
    const schedMeta = scheduleMeta(w).filter((n) => !n.classList.contains("critical"));
    if (w.effort_planned_pd != null || w.effort_actual_pd != null)
      schedMeta.push(
        h(
          "span",
          t("effortLabel"),
          ": ",
          h("b", t("effortValue", { actual: fmtNum(w.effort_actual_pd ?? 0), planned: fmtNum(w.effort_planned_pd) })),
        ),
      );
    if (leaf && w.last_progress_at) schedMeta.push(lastActivity(w.last_progress_at));

    return h(
      "li",
      h(
        "div.wp",
        h(
          "div.title",
          !leaf
            ? h(
                "button.chev",
                {
                  type: "button",
                  "aria-expanded": String(open),
                  "aria-label": `${t(open ? "collapse" : "expand")} ${w.title}`,
                  on: {
                    click: () => {
                      if (open) fold.open.delete(w.id);
                      else fold.open.add(w.id);
                      render();
                    },
                  },
                },
                open ? "▾" : "▸",
              )
            : null,
          h("strong", w.title),
          statusChip(w.status),
          w.effective_category ? catChip("w", w.effective_category, !w.category && !!w.effective_category) : null,
          personBadge(w.effective_owner, { inherited: !w.owner, label: w.owner ? t("fOwner") : t("inheritedOwner") }),
          w.is_human ? h("span.badge.human", { title: t("human"), "aria-label": t("human") }, "👤") : null,
          w.locked ? h("span.badge.locked", { title: t("lockedBy", { name }) }, "🔒 ", t("locked")) : null,
          issueBadge(w, titleOf),
          w.critical ? h("span.badge.critical", t("criticalMark")) : null,
          verifyBadge(w),
          !leaf ? h("span.meta", t("subCount", { n: w.children.length })) : null,
          ctxBadge("workpackage", w.id),
          dates,
        ),
        slider,
        h(
          "div.actions",
          leaf && w.status !== "done" && w.status !== "dropped" ? smallBtn(t("adjustProgress"), () => adjustProgressDialog(id, w)) : null,
          leaf && w.progress >= 100 && w.status !== "done" && w.status !== "dropped"
            ? smallBtn(t("markComplete"), () => markCompleteDialog(id, w), "secondary")
            : null,
          smallBtn(t("edit"), () => wpForm(id, w, detail.workpackages, null, detail.milestones)),
          smallBtn(`+ ${t("addSubWorkpackage")}`, () => wpForm(id, null, detail.workpackages, w.id, detail.milestones)),
          menuButton(t("moreActions"), [
            { label: t("delete"), danger: true, onClick: () => deleteEntity("workpackage", w.id, w.title, id) },
          ]),
        ),
        schedMeta.length ? h("div.meta", schedMeta) : null,
        issueList(w, titleOf),
        w.blocked_by ? h("div.blocked", `${t("blockedBy")}: ${blockedLabel(w.blocked_by)}`, blockedAge(w)) : null,
        w.waiting_reason ? h("div.blocked", `${t("fWaitingReason")}: ${w.waiting_reason}`) : null,
        w.drop_reason ? h("div.blocked", `${t("fDropReason")}: ${w.drop_reason}`) : null,
        w.description_md ? h("details.blocked", h("summary", t("description")), mdBlock(w.description_md)) : null,
      ),
      !leaf && open
        ? h(
            "ul",
            w.children.filter((c) => !shown || shown.has(c.id)).map((c) => wpNode(c, shown)),
          )
        : null,
    );
  }

  /** Verified (person + date) or done-but-unverified (legacy rows, verification required). */
  function verifyBadge(w) {
    if (w.verified_by && w.verified_at) {
      const tip = t("verifiedTip", {
        name: personNames.get(w.verified_by) || w.verified_by,
        date: fmtDate(String(w.verified_at).slice(0, 10)),
      });
      return h("span.badge.verified", { title: tip, "aria-label": tip }, "✔");
    }
    if (w.status === "done" && w.verification && w.verification !== "none")
      return h("span.badge.unverified", { title: t("unverifiedTip"), "aria-label": t("unverifiedTip") }, "⚠");
    return null;
  }

  function objectivesBlock(p) {
    const parts = [
      ["fObjectives", p.objectives_md],
      ["fScopeIn", p.scope_in_md],
      ["fScopeOut", p.scope_out_md],
      ["fSuccess", p.success_criteria_md],
    ].filter(([, v]) => v);
    return h(
      "details.block.objectives",
      h("summary", h("h3", t("objectivesScope"))),
      parts.length ? parts.map(([k, v]) => [h("h4", t(k)), mdBlock(v)]) : h("p.empty", t("objectivesEmpty")),
    );
  }

  function overview(d) {
    const p = d.project;
    const allWps = flatten(d.workpackages);
    const wpTitle = Object.fromEntries(allWps.map((w) => [w.id, w.title]));
    const allIssues = collectIssues(d);
    const shownWps = fold.issuesOnly && allIssues.length ? issueWpIds(d) : null;
    const expandableWps = allWps.filter((w) => w.children?.length);
    const hasFoldedWp = expandableWps.some((w) => !fold.open.has(w.id));

    const copies = h(
      "div",
      p.session_id
        ? h(
            "div.copyrow",
            h("code", `claude --resume ${p.session_id}`),
            smallBtn(t("copy"), () => copyText(`claude --resume ${p.session_id}`)),
          )
        : null,
      p.local_path
        ? h(
            "div.copyrow",
            h("code", p.local_path),
            smallBtn(t("copy"), () => copyText(p.local_path)),
          )
        : null,
    );

    const facts = h(
      "div.meta",
      h("span", `${t("originLabel")}: `, h("b", `${STRINGS.originIcon[p.origin] || ""} ${t(`origin.${p.origin}`)}`)),
      h("span", `${t("start")}: `, h("b", fmtDate(p.start_date))),
      h("span", `${t("target")}: `, h("b", fmtDate(p.target_date))),
      p.repo_url ? h("span", `${t("repo")}: `, safeLink(p.repo_url)) : null,
      (p.tags || []).length
        ? h(
            "span",
            (p.tags || []).map((x) => h("span.badge", x)),
          )
        : null,
      ctxBadge("project", p.id),
      d.baseline ? h("span", t("baselineInfo", { label: d.baseline.label, date: fmtDate(d.baseline.created_at.slice(0, 10)) })) : null,
      allIssues.length
        ? h(
            "button.badge.issue",
            {
              type: "button",
              "aria-pressed": String(fold.issuesOnly),
              title: fold.issuesOnly ? t("issuesOnlyOn") : t("issuesOnlyHint"),
              on: {
                click: () => {
                  fold.issuesOnly = !fold.issuesOnly;
                  render();
                },
              },
            },
            `⚠ ${t("scheduleIssues", { n: allIssues.length })}`,
          )
        : null,
    );

    // owner, sponsor, decision maker (spec F1): chip + name, or the free text
    const personLine = h(
      "div.meta.people",
      [
        ["owner", p.owner],
        ["sponsor", p.sponsor],
        ["decision_maker", p.decision_maker],
      ].map(([role, ref]) =>
        h(
          "span",
          `${t(`role.${role}`)}: `,
          ref ? [personBadge(ref, { label: t(`role.${role}`) }), " ", h("b", ref.name || ref.text)] : h("b", t("noOwner")),
        ),
      ),
    );
    const followLinks = [
      ...(p.follows || []).map((x) => [t("followsProject"), x]),
      ...(p.followed_by || []).map((x) => [t("followedByProject"), x]),
    ];
    const closureBlocks = [];
    if (p.closure_due)
      closureBlocks.push(
        h(
          "div.callout",
          { role: "status" },
          h("strong", t("closureDue")),
          " ",
          t("closureDueHint"),
          " ",
          smallBtn(t("closeProject"), () => closureDialog({ project: p, workpackages: d.workpackages }), "secondary"),
        ),
      );
    if (p.stalled_blocked)
      closureBlocks.push(h("div.callout.conflict", { role: "status" }, h("strong", t("chipBlocked")), " ", t("stalledHint")));
    if (p.closure_note_md || p.lessons_learned_md)
      closureBlocks.push(
        block(
          t("closureRecord"),
          null,
          p.closure_note_md ? [h("h4", t("fClosureNote")), mdBlock(p.closure_note_md)] : null,
          p.lessons_learned_md ? [h("h4", t("fLessons")), mdBlock(p.lessons_learned_md)] : null,
        ),
      );

    const branchRows = d.branches.map((b) =>
      h(
        "tr",
        h("td", b.repo),
        h("td", h("strong", b.name), b.note ? h("div.meta", b.note) : null),
        h("td", t(`kind.${b.kind}`)),
        h("td", statusChip(b.status)),
        h("td", b.pr_number ? (b.pr_url ? safeLink(b.pr_url, `#${b.pr_number}`) : `#${b.pr_number}`) : t("none")),
        h("td", b.last_commit || t("none"), b.last_activity ? h("div.meta", fmtDateTime(b.last_activity)) : null),
        h("td", b.workpackage_id ? wpTitle[b.workpackage_id] || b.workpackage_id : t("none")),
        h(
          "td",
          h(
            "div.actions",
            ctxBadge("branch", b.id),
            smallBtn(t("edit"), () => branchForm(id, b, d.workpackages)),
            menuButton(t("moreActions"), [
              { label: t("delete"), danger: true, onClick: () => deleteEntity("branch", b.id, `${b.repo}@${b.name}`, id) },
            ]),
          ),
        ),
      ),
    );

    const todayDate = new Date();
    const today = `${todayDate.getFullYear()}-${String(todayDate.getMonth() + 1).padStart(2, "0")}-${String(todayDate.getDate()).padStart(2, "0")}`;

    const milestoneItems = d.milestones.map((ms) =>
      milestoneItem(ms, {
        today,
        titleOf,
        requiresText: ms.requires?.length ? ms.requires.map((wpId) => wpTitle[wpId] || wpId).join(", ") : t("none"),
        unlocksText: ms.unlocks?.length ? ms.unlocks.map((wpId) => wpTitle[wpId] || wpId).join(", ") : t("none"),
        decide: () => decisionDialog({ project: p, milestone: ms }),
        actions: [
          smallBtn(t("edit"), () => milestoneForm(id, ms, detail.workpackages)),
          menuButton(t("moreActions"), [
            { label: t("delete"), danger: true, onClick: () => deleteEntity("milestone", ms.id, ms.title, id) },
          ]),
        ],
      }),
    );

    const workpackageActions = h(
      "div.actions",
      smallBtn(hasFoldedWp ? t("unfoldAll") : t("foldAll"), () => {
        if (hasFoldedWp) {
          expandableWps.forEach((w) => fold.open.add(w.id));
        } else {
          fold.open.clear();
        }
        render();
      }),
      smallBtn(`+ ${t("addWorkpackage")}`, () => wpForm(id, null, d.workpackages, null, d.milestones), "secondary"),
    );

    return h(
      "div",
      progressBar(d.progress),
      h(
        "div.meta",
        basisLabel(p.progress_basis),
        smallBtn(t("adjustProgress"), () => adjustProjectProgressForm(p)),
        riskChip(d.risk_summary),
        staleChip(p.stale),
        lastActivity(p.last_progress_at ?? p.created_at),
      ),
      h("div", { style: { margin: "0.8rem 0" } }, facts, personLine),
      followLinks.length
        ? h(
            "div.meta",
            followLinks.map(([label, x]) =>
              h("span", `${label}: `, h("button.linkbtn", { type: "button", on: { click: () => openProject(x) } }, x)),
            ),
          )
        : null,
      objectivesBlock(p),
      closureBlocks,
      copies,
      block(
        t("description"),
        smallBtn(t("edit"), () => projectForm(p, { workpackages: d.workpackages })),
        p.description_md ? mdBlock(p.description_md) : h("p.meta", p.summary || t("noDescription")),
      ),
      block(
        t("scorecard"),
        smallBtn(t("setScores"), () => scoresForm(id, d.scores), "secondary"),
        d.scores.length
          ? h(
              "div.table-wrap",
              h(
                "table",
                h(
                  "thead",
                  h(
                    "tr",
                    [t("colCriterion"), t("colValue"), t("colNote"), t("colWhen")].map((x) => h("th", x)),
                  ),
                ),
                h(
                  "tbody",
                  d.scores.map((s) =>
                    h(
                      "tr",
                      h("td", t(`criteria.${s.criterion}`)),
                      h("td.num", `${fmtNum(s.value)} / 10`),
                      h("td", s.note || t("none")),
                      h("td", fmtDateTime(s.recorded_at)),
                    ),
                  ),
                ),
              ),
            )
          : h("p.empty", t("noScores")),
      ),
      block(
        t("milestones"),
        smallBtn(`+ ${t("addMilestone")}`, () => milestoneForm(id, null, detail.workpackages), "secondary"),
        d.milestones.length ? h("ul.milestones", milestoneItems) : h("p.empty", t("noMilestones")),
      ),
      block(
        t("workpackages"),
        workpackageActions,
        d.workpackages.length
          ? h(
              "ul.tree",
              d.workpackages.filter((w) => !shownWps || shownWps.has(w.id)).map((w) => wpNode(w, shownWps)),
            )
          : h("p.empty", t("noWorkpackages")),
      ),
      cblock(
        "branches",
        t("branches"),
        smallBtn(`+ ${t("addBranch")}`, () => branchForm(id, null, d.workpackages), "secondary"),
        d.branches.length
          ? h(
              "div.table-wrap",
              h(
                "table",
                h(
                  "thead",
                  h(
                    "tr",
                    [t("colRepo"), t("colName"), t("colKind"), t("colStatus"), t("colPr"), t("colLastCommit"), t("colWp"), ""].map((x) =>
                      h("th", x),
                    ),
                  ),
                ),
                h("tbody", branchRows),
              ),
            )
          : h("p.empty", t("noBranches")),
      ),
      cblock(
        "tokenCost",
        t("tokenCost"),
        smallBtn(`+ ${t("addTokenCost")}`, () => tokenCostForm(id, d.workpackages), "secondary"),
        d.token_cost.entries.length
          ? h(
              "div.table-wrap",
              h(
                "table",
                h(
                  "thead",
                  h(
                    "tr",
                    [t("colWhen"), t("colWp"), t("colClaudeTokens"), t("colCopilotPrompts"), t("colNote")].map((x) => h("th", x)),
                  ),
                ),
                h(
                  "tbody",
                  d.token_cost.entries.map((c) =>
                    h(
                      "tr",
                      h("td", fmtDateTime(c.recorded_at)),
                      h("td", c.workpackage_id ? wpTitle[c.workpackage_id] || c.workpackage_id : t("none")),
                      h("td.num", fmtNum(c.claude_tokens)),
                      h("td.num", fmtNum(c.copilot_prompts)),
                      h("td", c.note || t("none")),
                    ),
                  ),
                  h(
                    "tr",
                    h("td", h("strong", t("sum"))),
                    h("td"),
                    h("td.num", h("strong", fmtNum(d.token_cost.claude_tokens))),
                    h("td.num", h("strong", fmtNum(d.token_cost.copilot_prompts))),
                    h("td"),
                  ),
                ),
              ),
            )
          : h("p.empty", t("noTokenCost")),
      ),
      timeline(d.events),
    );
  }

  function timeline(events) {
    const list = h("ul.timeline");
    const more = smallBtn(t("moreEvents"), async () => {
      const last = list.lastElementChild?.dataset.id;
      try {
        const older = await api.events({ project_id: id, before_id: last, limit: 30 });
        older.forEach((e) => list.append(eventItem(e)));
        if (older.length < 30) more.remove();
      } catch (e) {
        toastError(e);
      }
    });
    events.forEach((e) => list.append(eventItem(e)));
    return cblock("timeline", t("timeline"), null, events.length ? list : h("p.empty", t("noEvents")), events.length >= 10 ? more : null);
  }

  await load();
  if (openDoc) openDocViewer(openDoc);
  return m;
}

export function eventItem(e) {
  return h(
    "li",
    { dataset: { id: String(e.id) } },
    h("time", { datetime: e.ts }, fmtDateTime(e.ts)),
    h("div", h("span.who", e.actor), " · ", `${e.entity} ${e.action}`, e.summary ? h("div", e.summary) : null),
  );
}

/** Only http(s) links are rendered as anchors. */
export function safeLink(url, text) {
  return /^https?:\/\//i.test(url || "")
    ? h("a", { href: url, target: "_blank", rel: "noopener noreferrer" }, text || url)
    : h("span", text || url);
}

export function flatten(tree, out = []) {
  for (const w of tree || []) {
    out.push(w);
    flatten(w.children, out);
  }
  return out;
}
