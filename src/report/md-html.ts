export function escapeHtml(s: string | number): string {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c]!,
  );
}

function inline(text: string): string {
  const tokens: string[] = [];
  const token = (html: string) => {
    const i = tokens.push(html) - 1;
    return `\u0000${i}\u0000`;
  };

  let s = text
    .replace(/\u0000/g, "")
    .replace(/!\[([^\]]*)\]\(([^)]*)\)/g, (_m, alt: string) => token(escapeHtml(alt)))
    .replace(/\[([^\]]+)\]\(([^)]*)\)/g, (_m, label: string, url: string) => {
      const shown = escapeHtml(label);
      return token(/^(?:https?:\/\/|mailto:)/i.test(url) ? `${shown} (${escapeHtml(url)})` : shown);
    })
    .replace(/`([^`\n]+)`/g, (_m, code: string) => token(`<code>${escapeHtml(code)}</code>`));

  s = escapeHtml(s)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/__(.+?)__/g, "<strong>$1</strong>")
    .replace(/\*([^*\n]+?)\*/g, "<em>$1</em>")
    .replace(/_([^_\n]+?)_/g, "<em>$1</em>");

  return s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => tokens[+i]);
}

export function renderMarkdownSafe(md: string): string {
  if (!md.trim()) return "";

  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];

  for (let i = 0; i < lines.length;) {
    const line = lines[i];

    if (!line.trim()) {
      i++;
      continue;
    }

    if (/^```/.test(line)) {
      i++;
      const code: string[] = [];
      while (i < lines.length && !/^```/.test(lines[i])) {
        code.push(lines[i++]);
      }
      if (i < lines.length) i++;
      out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = Math.min(6, heading[1].length + 2);
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i++;
      continue;
    }

    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (ul) {
      const items: string[] = [];
      while (i < lines.length) {
        const m = /^\s*[-*+]\s+(.*)$/.exec(lines[i]);
        if (!m) break;
        items.push(`<li>${inline(m[1])}</li>`);
        i++;
      }
      out.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    const ol = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (ol) {
      const items: string[] = [];
      while (i < lines.length) {
        const m = /^\s*\d+\.\s+(.*)$/.exec(lines[i]);
        if (!m) break;
        items.push(`<li>${inline(m[1])}</li>`);
        i++;
      }
      out.push(`<ol>${items.join("")}</ol>`);
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length) {
        const m = /^\s*>\s?(.*)$/.exec(lines[i]);
        if (!m) break;
        quoted.push(m[1]);
        i++;
      }
      out.push(`<blockquote>${inline(quoted.join("\n")).replace(/\n/g, "<br>")}</blockquote>`);
      continue;
    }

    const para: string[] = [];
    while (i < lines.length && lines[i].trim()) {
      if (
        para.length &&
        (/^```/.test(lines[i]) ||
          /^(#{1,6})\s+/.test(lines[i]) ||
          /^\s*[-*+]\s+/.test(lines[i]) ||
          /^\s*\d+\.\s+/.test(lines[i]) ||
          /^\s*>\s?/.test(lines[i]))
      )
        break;
      para.push(lines[i++]);
    }
    out.push(`<p>${inline(para.join("\n")).replace(/\n/g, "<br>")}</p>`);
  }

  return out.join("\n");
}
