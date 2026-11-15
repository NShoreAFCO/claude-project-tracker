/**
 * Deterministic synthetic project for the MCP size budgets: 60 work packages on 3 levels (6/18/36), each with a
 * 300-char description and a 150-char acceptance text, 6 milestones (2 gates), 5 risks, 4 project documents plus
 * 1 work package document, and 32 progress notes. Built through the MCP tools, so it matches real usage.
 */
export type ToolCall = (name: string, args: Record<string, unknown>) => Promise<any>;
const parse = (r: any): any => JSON.parse(r.content[0].text);

/** Deterministic filler text of exactly `n` characters. */
export function filler(seed: string, n: number): string {
  const words = ["measure", "sample", "review", "report", "plan", "verify", "design", "build", "check", "record"];
  let out = "";
  for (let i = 0; out.length < n; i++) out += `${words[(i * 7 + seed.length) % words.length]}-${seed} `;
  return out.slice(0, n);
}

export interface BudgetProject {
  id: string;
  topWp: { id: string; code: string };
  leafWp: { id: string; code: string };
}

export async function buildBudgetProject(rawCall: ToolCall): Promise<BudgetProject> {
  // A rejected fixture write would silently shrink the project and invalidate the budgets: fail loudly instead.
  const call: ToolCall = async (name, args) => {
    const r = await rawCall(name, args);
    if (r?.isError) throw new Error(`budget fixture: ${name} failed: ${r.content?.[0]?.text}`);
    return r;
  };
  const p = parse(await call("create_project", { title: "Budget Project", summary: filler("summary", 200) }));
  const wps: Array<{ id: string; code: string; level: number }> = [];
  const mk = async (code: string, level: number, parent: string | null, dep: string | null) => {
    const w = parse(
      await call("upsert_workpackage", {
        project_id: p.id,
        code,
        title: `Work package ${code}`,
        parent_id: parent,
        description_md: filler(`d${code}`, 300),
        acceptance_criteria_md: filler(`a${code}`, 150),
        ...(dep ? { depends_on: [dep] } : {}),
      }),
    );
    wps.push({ id: w.id, code, level });
    return w.id as string;
  };
  for (let i = 1; i <= 6; i++) {
    const top = await mk(`WP${i}`, 1, null, null);
    for (let j = 1; j <= 3; j++) {
      const sub = await mk(`WP${i}.${j}`, 2, top, null);
      let first: string | null = null;
      for (let k = 1; k <= 2; k++) {
        const t = await mk(`T${i}${j}${k}`, 3, sub, k === 2 ? first : null);
        if (k === 1) first = t;
      }
    }
  }
  const tops = wps.filter((w) => w.level === 1);
  for (let i = 0; i < 6; i++) {
    await call("upsert_milestone", {
      project_id: p.id,
      title: `Milestone ${i + 1}`,
      description_md: filler(`m${i}`, 120),
      gate: i === 2 || i === 5,
      requires: [tops[i].id],
    });
  }
  for (let i = 0; i < 5; i++) {
    await call("upsert_risk", {
      project_id: p.id,
      type: "risk",
      title: `Risk ${i + 1}`,
      description_md: filler(`r${i}`, 200),
      probability: 2 + (i % 3),
      impact: 2 + (i % 4),
      response: "reduce",
      action: filler(`ra${i}`, 80),
    });
  }
  const docs: Array<[string, number]> = [
    ["handover", 19300],
    ["structure", 6000],
    ["decisions", 4000],
    ["notes", 3000],
  ];
  for (const [slug, size] of docs) {
    await call("write_context", { owner_kind: "project", owner_id: p.id, slug, title: slug, content_md: filler(slug, size) });
  }
  await call("write_context", { owner_kind: "workpackage", owner_id: tops[0].id, slug: "wp-notes", title: "WP notes", content_md: filler("wpdoc", 2000) });
  for (let i = 0; i < 32; i++) {
    await call("log_progress", {
      project_id: p.id,
      workpackage_id: wps[i % wps.length].id,
      note: true,
      summary: filler(`n${i}`, 160),
    });
  }
  const leaf = wps.filter((w) => w.level === 3).slice(-1)[0];
  return { id: p.id, topWp: tops[0], leafWp: leaf };
}
