// Risks & deviations tab: 5x5 heat map, list and form (spec F6). heatMapCells/heatMapSvg/riskForm drafted by Copilot.
import { t, fmtDate } from "./i18n.js";
import { api } from "./api.js";
import { h, clear, formDialog, saveWithConflict, toast, toastError, errorText, personBadge, menuButton } from "./dom.js";
import { riskBand } from "./risk-band.js";
import { changed, personOptions, wpOptions, deleteEntity } from "./forms.js";

export { riskBand };
const SVG_NS = "http://www.w3.org/2000/svg";
const RISK_TYPES = ["risk", "issue", "opportunity", "nc"];

/** SVG-namespace element factory for heatMapSvg (attrs are plain attributes; string children are text). */
export function svgEl(tag, attrs, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v !== undefined && v !== null) el.setAttribute(k, String(v));
  for (const c of children.flat()) if (c !== null && c !== undefined) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

/** The 25 heat-map cells (probability 5 at the top), counting non-closed entries. Pure and DOM-free. */
export function heatMapCells(risks) {
  const open = risks.filter((risk) => risk.status !== "closed");
  const cells = [];
  for (let probability = 5; probability >= 1; probability--) {
    for (let impact = 1; impact <= 5; impact++) {
      const matching = open.filter((risk) => risk.probability === probability && risk.impact === impact);
      const score = probability * impact;
      cells.push({ probability, impact, score, band: riskBand(score), count: matching.length, ids: matching.map((risk) => risk.id) });
    }
  }
  return cells;
}

/** Builds the heat-map SVG tree; svgEl creates the SVG-namespace elements, colours come from CSS classes. */
export function heatMapSvg(cells, { svgEl: el = svgEl, labels }) {
  const svg = el("svg", { viewBox: "0 0 300 300", role: "img", "aria-label": labels.title, class: "heatmap" });
  cells.forEach((cell) => {
    const row = 5 - cell.probability;
    const x = 40 + (cell.impact - 1) * 50;
    const y = 10 + row * 50;
    svg.append(el("rect", { x, y, width: 48, height: 48, class: `heat-cell band-${cell.band}` }, el("title", {}, labels.cellTitle(cell))));
    if (cell.count > 0) {
      svg.append(
        el(
          "text",
          { x: x + 24, y: y + 24, class: "heat-count", "text-anchor": "middle", "dominant-baseline": "middle" },
          String(cell.count),
        ),
      );
    }
  });
  for (let n = 1; n <= 5; n++) {
    svg.append(
      el("text", { x: 64 + (n - 1) * 50, y: 273, class: "heat-axis", "text-anchor": "middle" }, String(n)),
      el("text", { x: 30, y: 34 + (5 - n) * 50, class: "heat-axis", "text-anchor": "end", "dominant-baseline": "middle" }, String(n)),
    );
  }
  svg.append(
    el("text", { x: 164, y: 292, class: "heat-axis", "text-anchor": "middle" }, labels.impact),
    el("text", { x: 10, y: 135, class: "heat-axis", "text-anchor": "middle", transform: "rotate(-90 10 135)" }, labels.probability),
  );
  return svg;
}

const conflictSummary = (cur) => h("p", `${cur.title ?? ""} · v${cur.version}`);
const saveRisk = (body, ver) => (body.id ? api.updateRisk(body.id, body, ver) : api.createRisk(body));

/** Score text: "4 × 3 = 12". */
export const scoreText = (r) => `${r.probability} × ${r.impact} = ${r.score}`;

/** Create (existing = null) or edit a risk, issue, opportunity or nonconformity. Pickers are [[id, label]] lists. */
export function riskForm(projectId, existing, { persons, workpackages, milestones, onSaved }) {
  const pick = (list) => [["", t("none")], ...list];
  const nc = { field: "type", values: ["nc"] };
  const scale = (prefix) => [1, 2, 3, 4, 5].map((n) => [String(n), `${n} – ${t(`scale.${prefix}${n}`)}`]);
  const fields = [
    {
      name: "type",
      label: t("fRiskType"),
      type: "select",
      options: RISK_TYPES.map((v) => [v, t(`riskType.${v}`)]),
      value: existing?.type ?? "risk",
    },
    { name: "title", label: t("fTitle"), required: true, value: existing?.title ?? null },
    { name: "probability", label: t("fProbability"), type: "select", options: scale("p"), value: String(existing?.probability ?? 3) },
    {
      name: "impact",
      label: t("fImpact"),
      type: "select",
      options: scale("i"),
      value: String(existing?.impact ?? 3),
      hint: t("riskScaleHelp"),
    },
    { name: "owner", label: t("fOwner"), type: "person", options: persons, value: existing?.owner, noneLabel: t("noOwner") },
    {
      name: "response",
      label: t("fRiskResponse"),
      type: "select",
      options: pick(["avoid", "reduce", "transfer", "accept", "exploit"].map((v) => [v, t(`riskResponse.${v}`)])),
      value: existing?.response ?? "",
    },
    { name: "action", label: t("fRiskAction"), type: "textarea", rows: 3, value: existing?.action ?? null, full: true },
    { name: "due_date", label: t("due"), type: "date", value: existing?.due_date ?? null },
    {
      name: "status",
      label: t("fRiskStatus"),
      type: "select",
      options: ["open", "monitoring", "closed"].map((v) => [v, t(`riskStatus.${v}`)]),
      value: existing?.status ?? "open",
    },
    {
      name: "workpackage_id",
      label: t("fWorkpackage"),
      type: "select",
      options: pick(workpackages),
      value: existing?.workpackage_id ?? "",
    },
    { name: "milestone_id", label: t("milestone"), type: "select", options: pick(milestones), value: existing?.milestone_id ?? "" },
    { name: "description_md", label: t("fDescription"), type: "textarea", rows: 4, value: existing?.description_md ?? null, full: true },
    {
      name: "nc_detected_in_wp",
      label: t("fNcDetectedIn"),
      type: "select",
      options: pick(workpackages),
      value: existing?.nc_detected_in_wp ?? "",
      showWhen: nc,
    },
    { name: "nc_cause", label: t("fNcCause"), type: "textarea", rows: 3, value: existing?.nc_cause ?? null, showWhen: nc },
    { name: "nc_correction", label: t("fNcCorrection"), type: "textarea", rows: 3, value: existing?.nc_correction ?? null, showWhen: nc },
    {
      name: "nc_corrective_action",
      label: t("fNcCorrectiveAction"),
      type: "textarea",
      rows: 3,
      value: existing?.nc_corrective_action ?? null,
      showWhen: nc,
    },
    {
      name: "nc_effectiveness_check_date",
      label: t("fNcEffectivenessCheck"),
      type: "date",
      value: existing?.nc_effectiveness_check_date ?? null,
      showWhen: nc,
    },
  ];
  return formDialog({
    title: t(existing ? "formRiskEdit" : "formRiskNew"),
    fields,
    narrow: false,
    onSubmit: async (values) => {
      const body = { ...values, project_id: projectId, probability: Number(values.probability), impact: Number(values.impact) };
      for (const k of ["response", "workpackage_id", "milestone_id", "nc_detected_in_wp"]) if (body[k] === "") body[k] = null;
      if (existing) body.id = existing.id;
      const result = existing
        ? await saveWithConflict((ver) => saveRisk(body, ver), existing.version, conflictSummary)
        : await saveRisk(body);
      if (result?.cancelled) return undefined;
      if (!result?.reload) toast(t("saved"));
      changed(projectId);
      onSaved?.();
      return result || { ok: true };
    },
  });
}

const typeChip = (type) => h(`span.chip.risk-type.rt-${type}`, t(`riskType.${type}`));
const scoreChip = (r) => h(`span.chip.risk-score.band-${riskBand(r.score)}`, { title: scoreText(r) }, String(r.score));

/** Renders the tab into `body`. detail = project detail payload (for pickers). */
export async function renderRisks(body, { detail, projectId, isCurrent = () => true }) {
  let risks;
  try {
    risks = await api.risks({ project_id: projectId });
  } catch (e) {
    if (isCurrent()) clear(body, h("div.callout.conflict", { role: "alert" }, errorText(e)));
    return;
  }
  let persons = [];
  try {
    persons = await personOptions();
  } catch (e) {
    toastError(e);
  }
  if (!isCurrent()) return;
  const wps = wpOptions(detail.workpackages);
  const wpTitle = (id) => wps.find(([i]) => i === id)?.[1].replace(/^(— )+/, "");
  const open = (existing) =>
    riskForm(projectId, existing, { persons, workpackages: wps, milestones: detail.milestones.map((m) => [m.id, m.title]) });

  const rows = risks.map((r) =>
    h(
      "tr",
      { class: r.status === "closed" ? "closed" : "" },
      h("td", typeChip(r.type)),
      h(
        "td",
        h("strong", r.title),
        r.type === "nc" && r.nc_cause ? h("div.meta", h("span", `${t("fNcCause")}: ${r.nc_cause}`)) : null,
        r.action ? h("div.meta", h("span", `${t("fRiskAction")}: ${r.action}`)) : null,
      ),
      h("td", scoreChip(r)),
      h("td", personBadge(r.owner, { label: t("fOwner") }) ?? t("none")),
      h("td", r.response ? t(`riskResponse.${r.response}`) : t("none")),
      h("td", r.due_date ? fmtDate(r.due_date) : t("none")),
      h("td", t(`riskStatus.${r.status}`)),
      h("td", r.workpackage_id ? (wpTitle(r.workpackage_id) ?? t("none")) : t("none")),
      h(
        "td",
        h(
          "div.actions",
          h("button.btn.small.ghost", { type: "button", on: { click: () => open(r) } }, t("edit")),
          menuButton(t("moreActions"), [
            { label: t("delete"), danger: true, onClick: () => deleteEntity("risk", r.id, r.title, projectId) },
          ]),
        ),
      ),
    ),
  );
  const legend = h(
    "ul.heat-legend",
    ["low", "medium", "high", "critical"].map((b) => h("li", h(`span.swatch.band-${b}`), t(`riskBand.${b}`))),
  );
  const addBtn = h("button.btn.small.secondary", { type: "button", on: { click: () => open(null) } }, `+ ${t("addRisk")}`);
  clear(
    body,
    h(
      "section.block",
      h("header", h("h3", t("riskHeatMap")), addBtn),
      h(
        "div.heat-wrap",
        heatMapSvg(heatMapCells(risks), {
          labels: {
            title: t("riskHeatMapTitle"),
            probability: t("fProbability"),
            impact: t("fImpact"),
            cellTitle: (c) => t(c.count === 1 ? "heatCellTitle_one" : "heatCellTitle", { p: c.probability, i: c.impact, n: c.count }),
          },
        }),
        legend,
      ),
    ),
    h(
      "section.block",
      h("header", h("h3", t("riskList"))),
      risks.length
        ? h(
            "div.table-wrap",
            h(
              "table",
              h(
                "thead",
                h(
                  "tr",
                  [
                    t("fRiskType"),
                    t("fTitle"),
                    t("colScore"),
                    t("fOwner"),
                    t("fRiskResponse"),
                    t("due"),
                    t("fRiskStatus"),
                    t("colWp"),
                    "",
                  ].map((x) => h("th", x)),
                ),
              ),
              h("tbody", rows),
            ),
          )
        : h("p.empty", t("noRisks")),
    ),
  );
}
