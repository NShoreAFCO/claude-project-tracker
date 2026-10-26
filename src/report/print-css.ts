export function printCss(paper: "a4" | "letter"): string {
  const pageSize = paper === "a4" ? "A4" : "Letter";

  return `
@page {
  size: ${pageSize};
  margin: 22mm 18mm 24mm;
}

body,
main.report {
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 10.5pt;
  line-height: 1.4;
  color: CanvasText;
  background: Canvas;
}

h1,
h2,
h3 {
  break-after: avoid;
}

h2 {
  border-bottom: 1px solid GrayText;
}

table {
  width: 100%;
  border-collapse: collapse;
}

thead {
  display: table-header-group;
}

tr,
article.card,
li {
  break-inside: avoid;
}

th,
td {
  border-bottom: 1px solid GrayText;
  padding: 3px 6px;
  text-align: left;
  vertical-align: top;
}

td.lvl-1 {
  padding-left: 12px;
}

td.lvl-2 {
  padding-left: 24px;
}

td.lvl-3 {
  padding-left: 36px;
}

td.lvl-4 {
  padding-left: 48px;
}

td.lvl-5 {
  padding-left: 60px;
}

dl.facts {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 3px 12px;
}

article.card {
  border: 1px solid GrayText;
  padding: 6px 10px;
  margin-bottom: 8px;
}

pre,
code {
  font-family: ui-monospace, "SFMono-Regular", Consolas, "Liberation Mono", monospace;
  white-space: pre-wrap;
}

blockquote {
  border-left: 3px solid GrayText;
  padding-left: 10px;
  margin-left: 0;
}

@media screen {
  main.report {
    max-width: 900px;
    margin-left: auto;
    margin-right: auto;
    padding: 16px;
  }
}
`;
}
