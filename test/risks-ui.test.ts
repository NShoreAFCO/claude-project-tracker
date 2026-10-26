import { beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error untyped JS module
import { heatMapCells, heatMapSvg, riskBand, scoreText } from "../public/js/risks.js";
// @ts-expect-error untyped JS module
import { basisText } from "../public/js/progress-view.js";
// @ts-expect-error untyped JS module
import { deleteText } from "../public/js/dom.js";
import { call, installTestKeys, userJwt } from "./helpers";

beforeAll(async () => {
  await installTestKeys();
});

describe("riskBand boundaries", () => {
  it.each([
    [1, "low"],
    [4, "low"],
    [5, "medium"],
    [9, "medium"],
    [10, "high"],
    [14, "high"],
    [15, "critical"],
    [25, "critical"],
  ])("maps score %i to %s", (score, expected) => {
    expect(riskBand(score)).toBe(expected);
  });
});

describe("heatMapCells", () => {
  it("creates the ordered 5x5 heat map and aggregates open risks", () => {
    const cells = heatMapCells([
      { id: "r1", probability: 5, impact: 5, status: "open" },
      { id: "r2", probability: 3, impact: 4, status: "open" },
      { id: "r3", probability: 3, impact: 4, status: "open" },
      { id: "closed", probability: 3, impact: 4, status: "closed" },
    ]);

    expect(cells).toHaveLength(25);

    expect(cells[0]).toMatchObject({
      probability: 5,
      impact: 1,
      score: 5,
    });
    expect(cells[24]).toMatchObject({
      probability: 1,
      impact: 5,
      score: 5,
    });

    const shared = cells.find((cell: any) => cell.probability === 3 && cell.impact === 4);
    expect(shared).toBeDefined();
    expect(shared.count).toBe(2);
    expect(shared.ids).toHaveLength(2);
    expect(shared.ids).toEqual(expect.arrayContaining(["r2", "r3"]));
    expect(shared.ids).not.toContain("closed");

    const critical = cells.find((cell: any) => cell.probability === 5 && cell.impact === 5);
    expect(critical).toMatchObject({
      score: 25,
      band: "critical",
      count: 1,
    });
    expect(critical.ids).toContain("r1");
  });
});

describe("heatMapSvg", () => {
  it("builds an accessible SVG with 25 banded rects and counts only occupied cells", () => {
    const cells = heatMapCells([
      { id: "r1", probability: 5, impact: 5, status: "open" },
      { id: "r2", probability: 2, impact: 3, status: "open" },
      { id: "r3", probability: 2, impact: 3, status: "open" },
    ]);

    type FakeNode = {
      tag: string;
      attrs: Record<string, unknown>;
      children: Array<FakeNode | string>;
      append: (...children: Array<FakeNode | string>) => void;
    };

    const svgEl = (tag: string, attrs: Record<string, unknown> = {}, ...children: Array<FakeNode | string>): FakeNode => {
      const node: FakeNode = {
        tag,
        attrs,
        children: [...children],
        append(...c) {
          this.children.push(...c);
        },
      };
      return node;
    };

    const root = heatMapSvg(cells, {
      svgEl,
      labels: {
        title: "Risk heat map",
        probability: "Probability",
        impact: "Impact",
        cellTitle: (c: { probability: number; impact: number; count: number }) =>
          `Probability ${c.probability} × impact ${c.impact}: ${c.count}`,
      },
    }) as FakeNode;

    const walk = (node: FakeNode): FakeNode[] => [
      node,
      ...node.children.flatMap((child) => (typeof child === "string" ? [] : walk(child))),
    ];

    const nodes = walk(root);
    const rects = nodes.filter((node) => node.tag === "rect");
    const texts = nodes.filter((node) => node.tag === "text");

    expect(root.tag).toBe("svg");
    expect(root.attrs.role).toBe("img");
    expect(root.attrs["aria-label"]).toBe("Risk heat map");
    expect(root.attrs.viewBox).toBeTruthy();
    const titles = nodes.filter((n) => n.tag === "title").map((n) => n.children[0]);
    expect(titles).toContain("Probability 5 × impact 5: 1");
    expect(titles.some((x) => /^P\d x I\d/.test(String(x)))).toBe(false);

    expect(rects).toHaveLength(25);
    for (const rect of rects) {
      expect(String(rect.attrs.class ?? "")).toMatch(/heat-cell band-/);
    }

    const countTexts = texts.filter(
      (node) =>
        node.attrs.class === "heat-count" &&
        node.children.some((child) => typeof child === "string" && /^\d+$/.test(child) && Number(child) > 0),
    );

    const occupiedCells = cells.filter((cell: any) => cell.count > 0);
    expect(countTexts).toHaveLength(occupiedCells.length);
    expect(countTexts.map((node) => node.children.find((child) => typeof child === "string"))).toEqual(expect.arrayContaining(["1", "2"]));
  });
});

describe("scoreText", () => {
  it("formats probability, impact, and score", () => {
    expect(
      scoreText({
        probability: 3,
        impact: 4,
        score: 12,
      }),
    ).toBe("3 × 4 = 12");
  });
});

describe("basisText", () => {
  it("includes the reason for manual progress", () => {
    const text = basisText({
      mode: "manual",
      done: 0,
      total: 0,
      weighted_percent: 42,
      reason: "Estimate agreed",
    });

    expect(text).toContain("Estimate agreed");
  });

  it("includes done and total for derived progress", () => {
    const text = basisText({
      mode: "derived",
      done: 3,
      total: 5,
      weighted_percent: 60,
      reason: "",
    });

    expect(text).toContain("3");
    expect(text).toContain("5");
  });
});

describe("deleteText", () => {
  it("distinguishes deletion with child risks from deletion without children", async () => {
    const withChildren = deleteText("project", "Example", {
      risks: 2,
      workpackages: 0,
      milestones: 0,
      context_docs: 0,
    });
    const withoutChildren = deleteText("project", "Example", {
      risks: 0,
      workpackages: 0,
      milestones: 0,
      context_docs: 0,
    });

    expect(withChildren).not.toBe(withoutChildren);

    // @ts-expect-error untyped JS module
    const { t } = await import("../public/js/i18n.js");
    expect(t("deleteKids.risks", { n: 2 })).not.toBe("deleteKids.risks"); // key exists in the active locale
    expect(withChildren).toContain(t("deleteKids.risks", { n: 2 }));
  });
});

describe("assets", () => {
  it.each(["/js/risks.js", "/js/progress-view.js"])("%s requires authentication and contains no unsafe HTML sinks", async (path) => {
    const unauthenticated = await call(path, {});
    expect(unauthenticated.status).toBe(401);

    const jwt = await userJwt();
    const authenticated = await call(path, { jwt });
    expect(authenticated.status).toBe(200);

    const source = await authenticated.text();

    expect(source).not.toMatch(/\binnerHTML\b/);
    expect(source).not.toMatch(/\binsertAdjacentHTML\b/);
    expect(source).not.toMatch(/javascript\s*:/i);
    expect(source).not.toMatch(
      /<[^>]*\son(?:abort|animationend|animationiteration|animationstart|auxclick|beforeinput|beforetoggle|blur|cancel|canplay|canplaythrough|change|click|close|contextmenu|copy|cuechange|cut|dblclick|drag|dragend|dragenter|dragleave|dragover|dragstart|drop|durationchange|emptied|ended|error|focus|focusin|focusout|formdata|input|invalid|keydown|keypress|keyup|load|loadeddata|loadedmetadata|loadstart|mousedown|mouseenter|mouseleave|mousemove|mouseout|mouseover|mouseup|paste|pause|play|playing|pointercancel|pointerdown|pointerenter|pointerleave|pointermove|pointerout|pointerover|pointerup|progress|ratechange|reset|resize|scroll|scrollend|securitypolicyviolation|seeked|seeking|select|selectionchange|selectstart|slotchange|stalled|submit|suspend|timeupdate|toggle|touchcancel|touchend|touchmove|touchstart|transitioncancel|transitionend|transitionrun|transitionstart|volumechange|waiting|wheel)\s*=/i,
    );
  });
});
