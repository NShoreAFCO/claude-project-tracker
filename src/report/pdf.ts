import type { Env } from "../types";
import type { ReportModel } from "./build";
import { renderHtml } from "./html";
import { printCss } from "./print-css";
import { escapeHtml } from "./md-html";
import { serverT } from "../i18n/server";

export class PdfUnavailableError extends Error {
  constructor(
    message: string,
    /** HTTP status of the Browser Rendering response, when there was one. */
    readonly status?: number,
    /** Start of the response body or the underlying error text, for the server log only. */
    readonly detail?: string,
  ) {
    super(message);
  }
}

/** Blocks everything but inline styles in the page the browser renders (defence in depth: the HTML has no script or external load). */
const BROWSER_CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">`;

export async function renderPdf(env: Env, m: ReportModel): Promise<ArrayBuffer> {
  if (!env.BROWSER) {
    throw new PdfUnavailableError("BROWSER binding missing");
  }

  const projectTitle = m.project.title;

  try {
    const res = await env.BROWSER.quickAction("pdf", {
      html: renderHtml(m, { stylesheet: false }).replace("<head>", `<head>\n${BROWSER_CSP}`),
      addStyleTag: [{ content: printCss(m.paper) }],
      pdfOptions: {
        format: m.paper,
        preferCSSPageSize: true,
        printBackground: true,
        displayHeaderFooter: true,
        margin: {
          top: "22mm",
          bottom: "24mm",
          left: "18mm",
          right: "18mm",
        },
        headerTemplate:
          '<div style="font-size:8px;width:100%;padding:0 18mm;">' +
          "<span>" +
          escapeHtml(projectTitle) +
          "</span>" +
          '<span style="float:right">' +
          escapeHtml(m.generated) +
          "</span>" +
          "</div>",
        footerTemplate:
          '<div style="font-size:8px;width:100%;padding:0 18mm;text-align:right;">' +
          escapeHtml(serverT(m.locale, "report.pageOf")) +
          ' <span class="pageNumber"></span> ' +
          escapeHtml(serverT(m.locale, "report.of")) +
          ' <span class="totalPages"></span>' +
          "</div>",
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new PdfUnavailableError(`PDF rendering failed with status ${res.status}`, res.status, body.slice(0, 500));
    }

    const content = await res.arrayBuffer();

    if (content.byteLength === 0) {
      throw new PdfUnavailableError("PDF rendering returned empty content");
    }

    return content;
  } catch (error) {
    if (error instanceof PdfUnavailableError) {
      throw error;
    }

    const detail = error instanceof Error && error.message ? `: ${error.message}` : "";

    throw new PdfUnavailableError(
      `PDF rendering failed${detail}`,
      undefined,
      error instanceof Error ? (error.stack ?? error.message).slice(0, 500) : String(error).slice(0, 500),
    );
  }
}
