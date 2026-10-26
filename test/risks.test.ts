import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { testCaller } from "./helpers";
import { createProject, getProjectDetail, listProjects } from "../src/data/projects";
import { getContextBundle } from "../src/data/context-read";
import { deleteEntity, deletePreview, restoreEntity } from "../src/data/entities";
import { setScores } from "../src/data/logs";
import { upsertWorkpackage } from "../src/data/workpackages";
import { upsertMilestone } from "../src/data/milestones";
import { listRisks, riskCriterion, upsertRisk } from "../src/data/risks";
import { ConflictError, ValidationError } from "../src/data/util";
import { POLICY } from "../src/policy";
const db = env.DB;
const A = testCaller({ actor: "test" });
let n = 0;
const proj = () => createProject(db, { title: `Risk project ${++n}`, owner: "Owner" }, A);

describe("risk log", () => {
  it("score derived", async () => {
    const project = await proj();

    const created = await upsertRisk(
      db,
      project.id,
      {
        title: "Delivery risk",
        probability: 4,
        impact: 5,
        score: 99,
      },
      A,
    );

    expect(created.score).toBe(20);
    expect(created.version).toBe(1);

    const updated = await upsertRisk(
      db,
      project.id,
      {
        id: created.id,
        impact: 2,
        score: 99,
      },
      A,
      created.version,
    );

    expect(updated.score).toBe(8);
    expect(updated.version).toBe(2);

    await expect(
      upsertRisk(
        db,
        project.id,
        {
          title: "Invalid probability",
          probability: 6,
          impact: 2,
        },
        A,
      ),
    ).rejects.toThrow(ValidationError);

    await expect(
      upsertRisk(
        db,
        project.id,
        {
          id: created.id,
          impact: 3,
        },
        A,
        1,
      ),
    ).rejects.toThrow(ConflictError);
  });

  it("nc fields stored only for type nc", async () => {
    const project = await proj();

    const nc = await upsertRisk(
      db,
      project.id,
      {
        title: "Weld defect",
        type: "nc",
        probability: 2,
        impact: 3,
        nc_cause: "weld",
      },
      A,
    );

    expect(nc.nc_cause).toBe("weld");

    await expect(
      upsertRisk(
        db,
        project.id,
        {
          title: "Ordinary risk",
          type: "risk",
          probability: 2,
          impact: 3,
          nc_cause: "weld",
        },
        A,
      ),
    ).rejects.toThrow(ValidationError);

    const converted = await upsertRisk(
      db,
      project.id,
      {
        id: nc.id,
        type: "risk",
      },
      A,
      nc.version,
    );

    expect(converted.nc_cause).toBe(null);
  });

  it("bundle lists open risks", async () => {
    const project = await proj();

    await upsertRisk(
      db,
      project.id,
      {
        title: "Supplier slips",
        probability: 4,
        impact: 4,
        status: "open",
      },
      A,
    );

    await upsertRisk(
      db,
      project.id,
      {
        title: "Old one",
        probability: 5,
        impact: 5,
        status: "closed",
      },
      A,
    );

    const bundle = await getContextBundle(db, { project_id: project.id });

    expect(bundle.markdown.includes("Open risks")).toBe(true);
    expect(bundle.markdown.includes("Supplier slips")).toBe(true);
    expect(bundle.markdown.includes("Old one")).toBe(false);
  });

  it("risk criterion derived when risks exist, manual fallback otherwise", async () => {
    expect(riskCriterion([])).toBe(null);
    expect(riskCriterion([1])).toBe(0);
    expect(riskCriterion([25])).toBe(10);
    expect(riskCriterion([3, 13])).toBe(5);

    const project = await proj();

    await setScores(db, project.id, [{ criterion: "risk", value: 8 }], A);

    const manualDetail = await getProjectDetail(db, project.id);
    const manualRiskScore = manualDetail.scores.find((score) => score.criterion === "risk");

    expect(manualRiskScore?.value).toBe(8);
    expect(manualRiskScore?.derived).toBeFalsy();

    const risk = await upsertRisk(
      db,
      project.id,
      {
        title: "Critical risk",
        probability: 5,
        impact: 5,
        status: "open",
      },
      A,
    );

    const derivedDetail = await getProjectDetail(db, project.id);
    const derivedRiskScore = derivedDetail.scores.find((score) => score.criterion === "risk");

    expect(derivedRiskScore?.value).toBe(10);
    expect(derivedRiskScore?.derived).toBe(true);

    await upsertRisk(
      db,
      project.id,
      {
        id: risk.id,
        status: "closed",
      },
      A,
      risk.version,
    );

    const fallbackDetail = await getProjectDetail(db, project.id);
    const fallbackRiskScore = fallbackDetail.scores.find((score) => score.criterion === "risk");

    expect(fallbackRiskScore?.value).toBe(8);
    expect(fallbackRiskScore?.derived).toBeFalsy();
  });

  it("risk ≥15 without action counts as portfolio warning", async () => {
    const project = await proj();

    const high = await upsertRisk(
      db,
      project.id,
      {
        title: "High untreated risk",
        probability: 3,
        impact: 5,
      },
      A,
    );

    let detail = await getProjectDetail(db, project.id);
    expect(detail.risk_summary.high_without_action).toBe(1);

    let projects = await listProjects(db);
    let card = projects.find((item) => item.id === project.id);
    expect(card?.risk_summary.high_without_action).toBe(1);

    await upsertRisk(
      db,
      project.id,
      {
        id: high.id,
        action: "Add buffer",
      },
      A,
      high.version,
    );

    detail = await getProjectDetail(db, project.id);
    expect(detail.risk_summary.high_without_action).toBe(0);

    projects = await listProjects(db);
    card = projects.find((item) => item.id === project.id);
    expect(card?.risk_summary.high_without_action).toBe(0);

    await upsertRisk(
      db,
      project.id,
      {
        title: "Medium untreated risk",
        probability: 2,
        impact: 5,
      },
      A,
    );

    detail = await getProjectDetail(db, project.id);
    expect(detail.risk_summary.high_without_action).toBe(0);

    projects = await listProjects(db);
    card = projects.find((item) => item.id === project.id);
    expect(card?.risk_summary.high_without_action).toBe(0);
  });

  it("score scales come from POLICY", () => {
    expect(Object.keys(POLICY.score_scales).length > 0).toBe(true);

    const riskScale = POLICY.score_scales.risk;
    expect(riskScale).toBeTruthy();

    for (const level of ["0", "5", "10"] as const) {
      for (const locale of POLICY.locales) {
        expect(typeof riskScale[level][locale]).toBe("string");
        expect(riskScale[level][locale].length > 0).toBe(true);
      }
    }
  });

  it("trash", async () => {
    const project = await proj();

    const risk = await upsertRisk(
      db,
      project.id,
      {
        title: "Trash risk",
        type: "risk",
        status: "open",
        probability: 3,
        impact: 4,
      },
      A,
    );

    await upsertRisk(
      db,
      project.id,
      {
        title: "Monitoring issue",
        type: "issue",
        status: "monitoring",
        probability: 2,
        impact: 2,
      },
      A,
    );

    expect((await listRisks(db, { project_id: project.id })).some((item) => item.id === risk.id)).toBe(true);

    await deleteEntity(db, "risk", risk.id, A);

    expect((await listRisks(db, { project_id: project.id })).some((item) => item.id === risk.id)).toBe(false);

    await restoreEntity(db, "risk", risk.id, A);

    expect((await listRisks(db, { project_id: project.id })).some((item) => item.id === risk.id)).toBe(true);

    const openRisks = await listRisks(db, {
      project_id: project.id,
      status: "open",
    });
    expect(openRisks.map((item) => item.id)).toEqual([risk.id]);

    const issues = await listRisks(db, {
      project_id: project.id,
      type: "issue",
    });
    expect(issues.map((item) => item.title)).toEqual(["Monitoring issue"]);

    const monitoringIssues = await listRisks(db, {
      project_id: project.id,
      status: "monitoring",
      type: "issue",
    });
    expect(monitoringIssues.map((item) => item.title)).toEqual(["Monitoring issue"]);
  });
});

describe("risk log trash", () => {
  it("trashed risk is excluded from risk_summary, bundle, derived score and list_risks", async () => {
    const project = await proj();
    const risk = await upsertRisk(db, project.id, { title: "Gone soon", probability: 5, impact: 5 }, A);
    await setScores(db, project.id, [{ criterion: "risk", value: 3 }], A);
    expect((await getProjectDetail(db, project.id)).risk_summary.open).toBe(1);

    await deleteEntity(db, "risk", risk.id, A);

    const detail = await getProjectDetail(db, project.id);
    expect(detail.risk_summary).toEqual({ open: 0, max_score: null, high_without_action: 0 });
    const score = detail.scores.find((s) => s.criterion === "risk");
    expect(score?.value).toBe(3);
    expect((score as { derived?: boolean }).derived).toBeUndefined();
    expect((await getContextBundle(db, { project_id: project.id })).markdown).not.toContain("Gone soon");
    expect((await listRisks(db, { project_id: project.id })).length).toBe(0);
    expect((await listRisks(db, {})).some((r) => r.id === risk.id)).toBe(false);
  });

  it("risks of a trashed project are hidden from list_risks and come back on restore", async () => {
    const project = await proj();
    const risk = await upsertRisk(db, project.id, { title: "Follows project", probability: 4, impact: 4 }, A);
    const own = await upsertRisk(db, project.id, { title: "Trashed on its own", probability: 2, impact: 2 }, A);
    await deleteEntity(db, "risk", own.id, A);

    await deleteEntity(db, "project", project.id, A);

    expect((await listRisks(db, {})).some((r) => r.id === risk.id)).toBe(false);
    expect((await listRisks(db, { project_id: project.id })).length).toBe(0);

    await restoreEntity(db, "project", project.id, A);

    expect((await listRisks(db, {})).some((r) => r.id === risk.id)).toBe(true);
    expect((await listRisks(db, {})).some((r) => r.id === own.id)).toBe(false);
  });
});

describe("risk links to trashed items", () => {
  it("a link to a trashed WP or milestone reads as absent; restoring the item brings it back", async () => {
    const project = await proj();
    const parent = await upsertWorkpackage(db, project.id, { title: "parent" }, A);
    const child = await upsertWorkpackage(db, project.id, { title: "child", parent_id: parent.id }, A);
    const m = await upsertMilestone(db, project.id, { title: "m on parent", workpackage_id: parent.id }, A);
    const r = await upsertRisk(
      db,
      project.id,
      { title: "Linked risk", probability: 2, impact: 2, workpackage_id: child.id, milestone_id: m.id },
      A,
    );
    const links = async () => {
      const x = (await listRisks(db, { project_id: project.id })).find((y) => y.id === r.id)!;
      return [x.workpackage_id, x.milestone_id];
    };
    // deleting the subtree (the child and the milestone go with the parent) leaves the risk live
    await deleteEntity(db, "workpackage", parent.id, A);
    expect(await links()).toEqual([null, null]);
    expect((await getProjectDetail(db, project.id)).project.id).toBe(project.id);
    // the risk stays editable; the stored link is kept for a restore
    const edited = await upsertRisk(db, project.id, { id: r.id, title: "Linked risk (edited)" }, A);
    expect([edited.title, edited.workpackage_id, edited.milestone_id]).toEqual(["Linked risk (edited)", null, null]);
    await restoreEntity(db, "workpackage", parent.id, A);
    expect(await links()).toEqual([child.id, m.id]);
  });
});

describe("delete preview", () => {
  it("counts the risks a project delete takes along", async () => {
    const project = await proj();
    await upsertRisk(db, project.id, { title: "One", probability: 2, impact: 2 }, A);
    await upsertRisk(db, project.id, { title: "Two", probability: 3, impact: 3 }, A);
    expect((await deletePreview(db, "project", project.id)).children).toMatchObject({ risks: 2 });
  });
});
