// Sanitising Markdown → HTML for untrusted context content (SPEC §4.1, §9.2).
// Safety model: every piece of source text is HTML-escaped before any formatting is applied, and every tag this
// module generates is parked in a placeholder table, so later passes never see (or alter) generated markup.
// Only href values with an allow-listed scheme become links; there are no images, styles or event attributes.

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

const SAFE_HREF = /^(https?:\/\/|mailto:|#)/i;
const PH = "\u0000"; // placeholder delimiter; stripped from the source first

function inline(raw, store) {
  const keep = (html) => `${PH}${store.push(html) - 1}${PH}`;
  const link = (text, href) => {
    const url = href.trim();
    if (!SAFE_HREF.test(url) || url.includes(PH)) return text;
    return keep(`<a href="${url}" target="_blank" rel="noopener noreferrer">`) + text + keep("</a>");
  };
  let s = escapeHtml(raw);
  // code spans first: their content is final
  s = s.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_, _t, code) => keep(`<code>${code.trim()}</code>`));
  // images become links to the image, text = alt
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^)]*&quot;)?\)/g, (_, alt, href) => link(alt || href, href));
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^)]*&quot;)?\)/g, (_, text, href) => link(text, href));
  // bare URLs stop at escaped quotes/brackets (&quot; &#39; &lt; &gt;) but keep &amp;
  s = s.replace(/(^|[\s(])(https?:\/\/(?:[^\s<&]|&amp;)*[^\s<&.,;:!?)\]'"])/g, (_, pre, url) => pre + link(url, url));
  s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, (_, x) => keep("<strong>") + x + keep("</strong>"));
  s = s.replace(/__(?=\S)([\s\S]*?\S)__/g, (_, x) => keep("<strong>") + x + keep("</strong>"));
  s = s.replace(/(^|[^*\w])\*(?=\S)([^*]*?\S)\*(?![*\w])/g, (_, pre, x) => pre + keep("<em>") + x + keep("</em>"));
  s = s.replace(/(^|[^_\w])_(?=\S)([^_]*?\S)_(?![_\w])/g, (_, pre, x) => pre + keep("<em>") + x + keep("</em>"));
  return s;
}

const restore = (s, store) => {
  // placeholders can nest (a link inside bold); resolve until stable
  for (let i = 0; i < 5 && s.includes(PH); i++) s = s.replace(new RegExp(`${PH}(\\d+)${PH}`, "g"), (_, n) => store[Number(n)] ?? "");
  return s;
};

const isRule = (l) => /^ {0,3}([-*_])( *\1){2,} *$/.test(l);
const heading = (l) => /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l);
const fence = (l) => /^ {0,3}(`{3,}|~{3,})/.exec(l);
const listItem = (l) => /^( *)([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(l);
const isTableSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
const cells = (l) =>
  l
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, "|"));

function renderList(lines, store) {
  // lines: [{ indent, ordered, text }]; one level of nesting
  const out = [];
  let i = 0;
  const base = lines[0].indent;
  const tag = lines[0].ordered ? "ol" : "ul";
  out.push(`<${tag}>`);
  while (i < lines.length) {
    const item = lines[i];
    let html = `<li>${inline(item.text, store)}`;
    i++;
    const nested = [];
    while (i < lines.length && lines[i].indent >= base + 2) nested.push(lines[i++]);
    if (nested.length) html += renderList(nested, store);
    out.push(`${html}</li>`);
  }
  out.push(`</${tag}>`);
  return out.join("");
}

export function renderMarkdown(src) {
  const store = [];
  const lines = String(src ?? "")
    .replace(/\u0000/g, "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const f = fence(line);
    if (f) {
      const close = new RegExp(`^ {0,3}${f[1][0] === "`" ? "`" : "~"}{${f[1].length},}\\s*$`);
      const code = [];
      i++;
      while (i < lines.length && !close.test(lines[i])) code.push(lines[i++]);
      i++; // closing fence (or end of input)
      out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }
    const hd = heading(line);
    if (hd) {
      const lvl = Math.min(hd[1].length + 1, 6);
      out.push(`<h${lvl}>${inline(hd[2], store)}</h${lvl}>`);
      i++;
      continue;
    }
    if (isRule(line)) {
      out.push("<hr>");
      i++;
      continue;
    }
    if (/^ {0,3}>/.test(line)) {
      const quote = [];
      while (i < lines.length && /^ {0,3}>/.test(lines[i])) quote.push(lines[i++].replace(/^ {0,3}> ?/, ""));
      out.push(`<blockquote>${renderMarkdown(quote.join("\n"))}</blockquote>`);
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(cells(lines[i++]));
      out.push(
        "<table><thead><tr>" +
          head.map((c) => `<th>${inline(c, store)}</th>`).join("") +
          "</tr></thead><tbody>" +
          rows.map((r) => "<tr>" + head.map((_, k) => `<td>${inline(r[k] ?? "", store)}</td>`).join("") + "</tr>").join("") +
          "</tbody></table>",
      );
      continue;
    }
    if (listItem(line)) {
      const items = [];
      while (i < lines.length) {
        const m = listItem(lines[i]);
        if (m) {
          items.push({ indent: m[1].length, ordered: /\d/.test(m[2]), text: m[3] });
          i++;
        } else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) {
          items[items.length - 1].text += ` ${lines[i++].trim()}`; // continuation line
        } else break;
      }
      out.push(renderList(items, store));
      continue;
    }
    const para = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !fence(lines[i]) &&
      !heading(lines[i]) &&
      !isRule(lines[i]) &&
      !/^ {0,3}>/.test(lines[i]) &&
      !listItem(lines[i])
    )
      para.push(lines[i++].trim());
    out.push(`<p>${inline(para.join(" "), store)}</p>`);
  }
  return restore(out.join("\n"), store);
}
