/** HTTP layer of the report endpoint (spec F9): format dispatch, headers, PDF fallback. Read-only. */
import type { Env } from "../types";
import { ValidationError } from "../data/util";
import { buildReport } from "./build";
import { renderMarkdown } from "./markdown";
import { renderHtml } from "./html";
import { printCss } from "./print-css";
import { PdfUnavailableError, renderPdf } from "./pdf";
import { POLICY } from "../policy";
import { serverT } from "../i18n/server";

const FORMATS = ["md", "html", "pdf"];
const BASE_HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

/** Dashboard CSP only allows same-origin styles; the report page loads nothing else and runs no script. */
const REPORT_CSP = "default-src 'none'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'";

const fileName = (title: string, ext: string): string => {
  const base =
    title
      .normalize("NFKD")
      .replace(/[^A-Za-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "report";
  return `${base}.${ext}`;
};

export async function reportResponse(db: D1Database, env: Env, projectId: string, format: string): Promise<Response> {
  if (!FORMATS.includes(format)) throw new ValidationError("format must be md, html or pdf");
  if (format === "pdf" && POLICY.report?.pdf === false) {
    console.error("pdf render failed", { message: "PDF reports are switched off (policy.report.pdf)" });
    return pdfUnavailable();
  }
  const model = await buildReport(db, projectId);

  if (format === "md") {
    return new Response(renderMarkdown(model), {
      headers: {
        ...BASE_HEADERS,
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `inline; filename="${fileName(model.project.title, "md")}"`,
      },
    });
  }
  if (format === "html") {
    return new Response(renderHtml(model), {
      headers: {
        ...BASE_HEADERS,
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": REPORT_CSP,
        "Referrer-Policy": "no-referrer",
      },
    });
  }
  try {
    const bytes = await renderPdf(env, model);
    return new Response(bytes, {
      headers: {
        ...BASE_HEADERS,
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${fileName(model.project.title, "pdf")}"`,
      },
    });
  } catch (e) {
    if (e instanceof PdfUnavailableError) console.error("pdf render failed", { message: e.message, status: e.status, detail: e.detail });
    else console.error("pdf render failed", e);
    return pdfUnavailable();
  }
}

/** 503 body for the client; the cause stays in the server log. */
function pdfUnavailable(): Response {
  return new Response(JSON.stringify({ error: "pdf_unavailable", message: serverT("en", "report.pdfUnavailable") }), {
    status: 503,
    headers: { ...BASE_HEADERS, "Content-Type": "application/json; charset=utf-8", "Retry-After": "60" },
  });
}

export function printCssResponse(): Response {
  return new Response(printCss(POLICY.report?.paper === "letter" ? "letter" : "a4"), {
    headers: { ...BASE_HEADERS, "Content-Type": "text/css; charset=utf-8", "Cache-Control": "private, max-age=300" },
  });
}
