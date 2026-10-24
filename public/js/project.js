// Project popup: Overview (description, WP tree, branches, scorecard, token cost, timeline, copy buttons) and Kontext.
import { t, fmtDate, fmtDateTime, fmtNum, fmtPct, STRINGS } from "./i18n.js";
import { api } from "./api.js";
import { h, clear, openModal, statusChip, progressBar, copyText, toastError } from "./dom.js";
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
  saveWpProgress,
  deleteEntity,
} from "./forms.js";
import { renderContextPanel, openDocViewer } from "./context.js";

/** Render sanitised markdown into a container (the only innerHTML use in the app). */
export function mdBlock(src) {
  const el = h("div.md");
  el.innerHTML = renderMarkdown(src || "");
  return el;
}

const block = (title, actions, ...content) => h("section.block", h("header", h("h3", title), actions || null), ...content);
const smallBtn = (label, onClick, cls = "ghost") => h(`button.btn.small.${cls}`, { type: "button", on: { click: onClick } }, label);

export async function openProject(id, { tab = "overview", owner = null, openDoc = null } = {}) {
  let detail;
  let current = { tab, owner };
  const fold = { open: new Set(), blocks: { branches: true, tokenCost: false, timeline: true } };
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
  history.replaceState(null, "", `#/p/${encodeURIComponent(id)}${tab === "context" ? "/kontext" : ""}`);

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

  async function load() {
    try {
      detail = await api.project(id);
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
    history.replaceState(null, "", `#/p/${encodeURIComponent(id)}${name === "context" ? "/kontext" : ""}`);
    render();
  }

  function render() {
    const p = detail.project;
    m.heading.replaceChildren(p.title, " ", statusChip(p.status));
    clear(
      tabs,
      ["overview", "context"].map((name) =>
        h(
          "button",
          { type: "button", role: "tab", "aria-selected": String(current.tab === name), on: { click: () => setTab(name) } },
          name === "overview" ? t("tabOverview") : t("tabContext"),
        ),
      ),
    );
    clear(m.foot);
    if (current.tab === "context") {
      const own = current.owner || { owner_kind: "project", owner_id: p.id };
      clear(m.body);
      renderContextPanel(m.body, { detail, owner: own, onOwner: (o) => setTab("context", o) });
    } else {
      clear(m.body, overview(detail));
      m.foot.append(
        smallBtn(t("delete"), () => deleteEntity("project", p.id, p.title, p.id).then((ok) => ok && m.close()), "danger"),
        smallBtn(t("logProgress"), () => logProgressForm(p.id, detail.workpackages), "secondary"),
        smallBtn(t("edit"), () => projectForm(p), ""),
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

  function wpNode(w) {
    const leaf = !w.children?.length;
    const open = !leaf && fold.open.has(w.id);
    let slider = null;
    if (leaf) {
      const out = h("output", fmtPct(w.progress));
      const input = h("input", {
        type: "range",
        min: 0,
        max: 100,
        step: 5,
        value: String(w.progress),
        "aria-label": `${t("progress")}: ${w.title}`,
        on: {
          input: (e) => (out.textContent = fmtPct(e.target.value)),
          change: (e) => saveWpProgress(id, w, Number(e.target.value)),
        },
      });
      slider = h("div.slider", input, out);
    } else slider = progressBar(w.effective_progress);

    const dates = w.start_date || w.end_date ? h("span.meta", `${fmtDate(w.start_date)} – ${fmtDate(w.end_date)}`) : null;
    const lockingMilestone = w.locked ? detail.milestones.find((ms) => ms.unlocks?.includes(w.id) && ms.reached_at === null) : null;
    const name = lockingMilestone?.title || "";

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
          w.is_human ? h("span.badge.human", { title: t("human"), "aria-label": t("human") }, "👤") : null,
          w.locked ? h("span.badge.locked", { title: t("lockedBy", { name }) }, "🔒 ", t("locked")) : null,
          !leaf ? h("span.meta", t("subCount", { n: w.children.length })) : null,
          ctxBadge("workpackage", w.id),
          dates,
        ),
        slider,
        h(
          "div.actions",
          smallBtn(t("edit"), () => wpForm(id, w, detail.workpackages)),
          smallBtn(`+ ${t("addSubWorkpackage")}`, () => wpForm(id, null, detail.workpackages, w.id)),
          smallBtn(t("delete"), () => deleteEntity("workpackage", w.id, w.title, id), "danger"),
        ),
        w.blocked_by ? h("div.blocked", `${t("blockedBy")}: ${w.blocked_by}`) : null,
        w.description_md ? h("details.blocked", h("summary", t("description")), mdBlock(w.description_md)) : null,
      ),
      !leaf && open ? h("ul", w.children.map(wpNode)) : null,
    );
  }

  function overview(d) {
    const p = d.project;
    const allWps = flatten(d.workpackages);
    const wpTitle = Object.fromEntries(allWps.map((w) => [w.id, w.title]));
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
            smallBtn(t("delete"), () => deleteEntity("branch", b.id, `${b.repo}@${b.name}`, id), "danger"),
          ),
        ),
      ),
    );

    const todayDate = new Date();
    const today = `${todayDate.getFullYear()}-${String(todayDate.getMonth() + 1).padStart(2, "0")}-${String(todayDate.getDate()).padStart(2, "0")}`;

    const milestoneItems = d.milestones.map((ms) => {
      const state = ms.done ? "done" : ms.due_date && ms.due_date < today ? "overdue" : "open";
      const label = state === "done" ? t("reached") : state === "overdue" ? t("overdue") : t("msOpen");
      const requires = ms.requires?.length ? ms.requires.map((wpId) => wpTitle[wpId] || wpId).join(", ") : t("none");
      const unlocks = ms.unlocks?.length ? ms.unlocks.map((wpId) => wpTitle[wpId] || wpId).join(", ") : t("none");

      return h(
        "li.ms",
        h(`span.ms-diamond.${state}`, { "aria-hidden": "true" }),
        h("strong", ms.title),
        h(`span.ms-state.${state}`, label),
        h("div.meta", `${t("due")}: ${fmtDate(ms.due_date)}`, " · ", `${t("requires")}: ${requires}`, " · ", `${t("unlocks")}: ${unlocks}`),
        h(
          "div.actions",
          smallBtn(t("edit"), () => milestoneForm(id, ms, detail.workpackages)),
          smallBtn(t("delete"), () => deleteEntity("milestone", ms.id, ms.title, id), "danger"),
        ),
      );
    });

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
      smallBtn(`+ ${t("addWorkpackage")}`, () => wpForm(id, null, d.workpackages), "secondary"),
    );

    return h(
      "div",
      progressBar(d.progress),
      h("div", { style: { margin: "0.8rem 0" } }, facts),
      copies,
      block(
        t("description"),
        smallBtn(t("edit"), () => projectForm(p)),
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
        d.workpackages.length ? h("ul.tree", d.workpackages.map(wpNode)) : h("p.empty", t("noWorkpackages")),
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
