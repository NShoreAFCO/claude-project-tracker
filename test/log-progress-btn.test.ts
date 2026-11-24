// Visible "Log progress" button on open leaf rows of the project overview.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dispatch, installFakeDom } from "./fake-dom";

const state = vi.hoisted(() => ({ write: true }));
vi.mock("../public/js/access.js", async (orig) => ({
  ...(await orig<object>()),
  can: () => state.write,
  gate: (el: any) => {
    if (el && !state.write) {
      el.hidden = true;
      return null;
    }
    return el;
  },
}));
const logProgressForm = vi.hoisted(() => vi.fn());
vi.mock("../public/js/forms.js", async (orig) => ({ ...(await orig<object>()), logProgressForm }));
// @ts-expect-error untyped JS module
import { logProgressRowButton, isOpenLeaf } from "../public/js/project.js";

const tree = [{ id: "p", status: "in_progress", children: [{ id: "a", status: "in_progress", progress: 40 }] }];
const leaf = (status: string) => ({ id: "a", status, progress: 40 });

describe("logProgressRowButton", () => {
  let doc: any;
  beforeEach(() => {
    doc = installFakeDom();
    state.write = true;
    logProgressForm.mockClear();
  });

  it("an open leaf row gets the button", () => {
    for (const s of ["not_started", "in_progress", "waiting", "blocked"]) {
      const b = logProgressRowButton("proj", tree, leaf(s));
      expect(b, s).not.toBeNull();
      expect(b.textContent).toBe("Log progress");
    }
  });

  it("done, dropped and parent rows get none", () => {
    expect(logProgressRowButton("proj", tree, leaf("done"))).toBeNull();
    expect(logProgressRowButton("proj", tree, leaf("dropped"))).toBeNull();
    expect(logProgressRowButton("proj", tree, tree[0])).toBeNull();
    expect(isOpenLeaf(tree[0])).toBe(false);
  });

  it("a viewer gets none", () => {
    state.write = false;
    expect(logProgressRowButton("proj", tree, leaf("in_progress"))).toBeNull();
  });

  it("a click opens the dialog on that work package", () => {
    const w = leaf("in_progress");
    const b = logProgressRowButton("proj", tree, w);
    dispatch(doc, b, "click");
    expect(logProgressForm).toHaveBeenCalledWith("proj", tree, { wp: w });
  });
});
