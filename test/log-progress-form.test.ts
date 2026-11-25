// logProgressForm: optional { wp } preselects the work package and pre-fills its current progress.
import { beforeEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({ fields: [] as any[] }));
vi.mock("../public/js/dom.js", async (orig) => ({
  ...(await orig<object>()),
  formDialog: (o: any) => {
    captured.fields = o.fields;
    return Promise.resolve(null);
  },
}));
// @ts-expect-error untyped JS module
import { logProgressForm } from "../public/js/forms.js";

const tree = [{ id: "a", code: "WP1", title: "A", status: "in_progress", progress: 40 }];
const field = (name: string) => captured.fields.find((f) => f.name === name);

describe("logProgressForm", () => {
  beforeEach(() => {
    captured.fields = [];
  });

  it("without wp: nothing preselected, progress empty (as before)", () => {
    logProgressForm("proj", tree);
    expect(field("workpackage_id").value).toBe("");
    expect(field("progress").value).toBeUndefined();
  });

  it("with wp: work package selected, progress holds its current value", () => {
    logProgressForm("proj", tree, { wp: tree[0] });
    expect(field("workpackage_id").value).toBe("a");
    expect(field("progress").value).toBe(40);
    expect(field("progress").max).toBe(100);
  });

  it("a progress of 0 is pre-filled too", () => {
    logProgressForm("proj", tree, { wp: { ...tree[0], progress: 0 } });
    expect(field("progress").value).toBe(0);
  });

  it("the progress field carries the hint", () => {
    logProgressForm("proj", tree);
    expect(field("progress").hint).toMatch(/100/);
  });
});
