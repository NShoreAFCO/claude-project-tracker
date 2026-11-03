// Minimal DOM for render tests: just enough of Node/Element/document for public/js/dom.js `h`/`clear` and the views.
type Listener = { fn: (e: any) => void; capture: boolean };

export class FNode {
  parentNode: FEl | null = null;
  get parentElement() {
    return this.parentNode;
  }
  get textContent(): string {
    return "";
  }
}
export class FText extends FNode {
  constructor(public data: string) {
    super();
  }
  get textContent() {
    return this.data;
  }
}

const parseCompound = (sel: string) => {
  const m = /^([a-z0-9]*)((?:\.[\w-]+)*)((?:\[[^\]]+\])*)$/i.exec(sel.trim());
  if (!m) throw new Error(`fake-dom: unsupported selector ${sel}`);
  const attrs = [...m[3].matchAll(/\[([\w-]+)(?:="?([^\]"]*)"?)?\]/g)].map((a) => [a[1], a[2]] as const);
  return { tag: m[1].toLowerCase(), classes: m[2].split(".").filter(Boolean), attrs };
};

export class FEl extends FNode {
  tagName: string;
  childNodes: FNode[] = [];
  attrs = new Map<string, string>();
  listeners = new Map<string, Listener[]>();
  classes = new Set<string>();
  dataset: Record<string, string> = {};
  style = { setProperty: (_k: string, _v: string) => {} };
  hidden = false;
  checked = false;
  value = "";
  type = "";
  title = "";
  href = "";
  disabled = false;
  constructor(
    tag: string,
    public doc: FDoc,
  ) {
    super();
    this.tagName = tag.toUpperCase();
  }
  get id() {
    return this.attrs.get("id") ?? "";
  }
  set id(v: string) {
    this.attrs.set("id", v);
  }
  get className() {
    return [...this.classes].join(" ");
  }
  set className(v: string) {
    this.classes = new Set(v.split(/\s+/).filter(Boolean));
  }
  classList = {
    add: (c: string) => void this.classes.add(c),
    contains: (c: string) => this.classes.has(c),
    toggle: (c: string, force?: boolean) => {
      const on = force ?? !this.classes.has(c);
      on ? this.classes.add(c) : this.classes.delete(c);
      return on;
    },
  };
  get children() {
    return this.childNodes.filter((n): n is FEl => n instanceof FEl);
  }
  get textContent(): string {
    return this.childNodes.map((n) => n.textContent).join("");
  }
  set textContent(v: string) {
    this.replaceChildren();
    if (v) this.append(new FText(v));
  }
  append(...nodes: (FNode | string)[]) {
    for (const n of nodes) {
      const node = typeof n === "string" ? new FText(n) : n;
      node.parentNode?.childNodes.splice(node.parentNode.childNodes.indexOf(node), 1);
      node.parentNode = this;
      this.childNodes.push(node);
    }
  }
  replaceChildren(...nodes: FNode[]) {
    const active = this.doc.activeElement;
    for (const n of this.childNodes) n.parentNode = null;
    this.childNodes = [];
    if (active && !this.doc.body.contains(active) && active !== this.doc.body) this.doc.activeElement = this.doc.body;
    this.append(...nodes);
  }
  setAttribute(k: string, v: string) {
    this.attrs.set(k, String(v));
    if (k === "class") this.className = String(v);
  }
  getAttribute(k: string) {
    if (k === "class") return this.className || null;
    return this.attrs.get(k) ?? null;
  }
  hasAttribute(k: string) {
    return this.attrs.has(k);
  }
  contains(n: FNode | null): boolean {
    for (let x: FNode | null = n; x; x = x.parentNode) if (x === this) return true;
    return false;
  }
  focus() {
    this.doc.activeElement = this;
  }
  close() {
    this.attrs.delete("open");
  }
  matches(sel: string) {
    const { tag, classes, attrs } = parseCompound(sel);
    return (
      (!tag || this.tagName.toLowerCase() === tag) &&
      classes.every((c) => this.classes.has(c)) &&
      attrs.every(([k, v]) => (v === undefined ? this.attrs.has(k) : this.attrs.get(k) === v))
    );
  }
  closest(sel: string): FEl | null {
    for (let x: FEl | null = this; x; x = x.parentNode) if (x.matches(sel)) return x;
    return null;
  }
  querySelectorAll(sel: string): FEl[] {
    const out: FEl[] = [];
    const walk = (el: FEl) => {
      for (const c of el.children) {
        if (c.matches(sel)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel: string) {
    return this.querySelectorAll(sel)[0] ?? null;
  }
  addEventListener(type: string, fn: (e: any) => void, opt?: boolean | { capture?: boolean }) {
    const capture = typeof opt === "object" ? !!opt.capture : !!opt;
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), { fn, capture }]);
  }
  removeEventListener(type: string, fn: (e: any) => void, opt?: boolean | { capture?: boolean }) {
    const capture = typeof opt === "object" ? !!opt.capture : !!opt;
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((l) => !(l.fn === fn && l.capture === capture)),
    );
  }
  listenerCount(type: string) {
    return (this.listeners.get(type) ?? []).length;
  }
}

export class FDoc extends FEl {
  body: FEl;
  documentElement: FEl;
  activeElement: FEl;
  constructor() {
    super("#document", null as any);
    this.doc = this;
    this.documentElement = new FEl("html", this);
    this.body = new FEl("body", this);
    this.documentElement.append(this.body);
    this.activeElement = this.body;
  }
  createElement(tag: string) {
    return new FEl(tag, this);
  }
  createTextNode(s: string) {
    return new FText(s);
  }
  getElementById(id: string): FEl | null {
    return this.body.querySelectorAll(`[id=${id}]`)[0] ?? null;
  }
  // document-level lookups search the whole tree under body
  querySelectorAll(sel: string) {
    return this.body.querySelectorAll(sel);
  }
}

/** Dispatch with capture-on-document first, then bubbling target -> document. Returns the event. */
export function dispatch(doc: FDoc, target: FEl | FDoc, type: string, init: Record<string, unknown> = {}) {
  let stopped = false;
  const e: any = {
    type,
    target,
    defaultPrevented: false,
    preventDefault() {
      e.defaultPrevented = true;
    },
    stopPropagation() {
      stopped = true;
    },
    ...init,
  };
  const run = (el: FEl | FDoc, capture: boolean) => {
    for (const l of [...(el.listeners.get(type) ?? [])]) if (l.capture === capture) l.fn(e);
  };
  run(doc, true);
  if (stopped) return e;
  const path: (FEl | FDoc)[] = [];
  for (let x: FEl | null = target as FEl; x; x = x.parentNode) path.push(x);
  if (!path.includes(doc)) path.push(doc);
  for (const el of path) {
    run(el, false);
    if (stopped) break;
  }
  return e;
}

/** Install the globals dom.js expects; returns the document. */
export function installFakeDom() {
  const doc = new FDoc();
  const g = globalThis as Record<string, unknown>;
  g.document = doc;
  g.Node = FNode;
  return doc;
}
