// Natural code order for work packages: WP1, WP1.1, WP1.2, WP2 ... WP10. The server keeps its own order; views sort here.

const tokens = (code) => String(code).match(/\d+|[A-Za-z]+/g) ?? [];

const hasCode = (w) => typeof w?.code === "string" && w.code.trim() !== "";

/** Compares two code strings in natural order; numeric parts compare as numbers, a prefix sorts first. Null-safe: a missing code sorts last. */
export function compareCode(a, b) {
  const ea = a == null || String(a).trim() === "";
  const eb = b == null || String(b).trim() === "";
  if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1;
  const ta = tokens(a);
  const tb = tokens(b);
  for (let i = 0; i < Math.min(ta.length, tb.length); i++) {
    const x = ta[i];
    const y = tb[i];
    const nx = /^\d/.test(x);
    const ny = /^\d/.test(y);
    if (nx && ny) {
      const d = Number(x) - Number(y);
      if (d) return d < 0 ? -1 : 1;
    } else if (nx !== ny) {
      return nx ? 1 : -1; // letters (the prefix) before numbers
    } else {
      const lx = x.toLowerCase();
      const ly = y.toLowerCase();
      if (lx !== ly) return lx < ly ? -1 : 1;
    }
  }
  if (ta.length !== tb.length) return ta.length < tb.length ? -1 : 1;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

const cmpText = (a, b) => ((a ?? "") < (b ?? "") ? -1 : (a ?? "") > (b ?? "") ? 1 : 0);

/** Sorts siblings by code; rows without a code follow the coded ones, by `sort`, then `title`. Stable; returns a new array. */
export function sortByCode(wps) {
  return (wps ?? [])
    .map((w, i) => ({ w, i }))
    .sort((x, y) => {
      const cx = hasCode(x.w);
      const cy = hasCode(y.w);
      if (cx && cy) return compareCode(x.w.code, y.w.code) || x.i - y.i;
      if (cx !== cy) return cx ? -1 : 1;
      return (x.w.sort ?? 0) - (y.w.sort ?? 0) || cmpText(x.w.title, y.w.title) || x.i - y.i;
    })
    .map((x) => x.w);
}

/** `sortByCode` at every level of a WP tree; returns new nodes, the input is untouched. */
export function sortTreeByCode(wps) {
  return sortByCode(wps).map((w) => (w.children?.length ? { ...w, children: sortTreeByCode(w.children) } : w));
}

/**
 * Orders flat work package rows (portfolio lists). `mode`: "project" (project, then code), "in_progress" (doing first,
 * then project order), "start" / "end" (date, empty last, then project and code), "upcoming" (same as "end").
 */
export function sortWpRows(rows, mode = "project") {
  const byProject = (a, b) =>
    cmpText(a.project_title, b.project_title) || cmpText(a.project_id, b.project_id) || compareCode(a.code, b.code);
  const byDate = (key) => (a, b) => {
    const na = !a[key];
    const nb = !b[key];
    if (na !== nb) return na ? 1 : -1;
    return cmpText(a[key], b[key]) || byProject(a, b);
  };
  const cmp =
    mode === "in_progress"
      ? (a, b) => (b.status === "doing") - (a.status === "doing") || byProject(a, b)
      : mode === "start"
        ? byDate("start_date")
        : mode === "end" || mode === "upcoming"
          ? byDate("end_date")
          : byProject;
  return (rows ?? []).map((r, i) => ({ r, i })).sort((x, y) => cmp(x.r, y.r) || x.i - y.i).map((x) => x.r);
}
