import { INSTANCE } from "../generated/instance";
import { POLICY } from "../policy";

export type Locale = string;

export const STRINGS: Record<string, Record<string, string>> = {
  en: {
    "report.status": "Status",
    "report.objectives": "Objectives",
    "report.scopeIn": "In Scope",
    "report.scopeOut": "Out of Scope",
    "report.successCriteria": "Success Criteria",
    "report.workpackages": "Work Packages",
    "report.milestones": "Milestones",
    "report.gate": "Gate",
    "report.decision": "Decision",
    "report.decidedBy": "Decided by",
    "report.risks": "Risks",
    "report.deviations": "Nonconformities",
    "report.lessonsLearned": "Lessons Learned",
    "report.closureNote": "Closure Note",
    "report.owner": "Owner",
    "report.sponsor": "Sponsor",
    "report.decisionMaker": "Decision Maker",
    "report.progress": "Progress",
    "report.target": "Target",
    "report.start": "Start",
    "report.end": "End",
    "report.due": "Due",
    "report.reached": "Reached",
    "report.generated": "Generated",
    "report.none": "None",
    "report.pageHeader": "{title}",
    "report.pageOf": "Page",
    "report.of": "of",
    "report.title": "Title",
    "report.action": "Action",
    "report.score": "Score",
    "report.type": "Type",
    "report.cause": "Cause",
    "report.correction": "Correction",
    "report.correctiveAction": "Corrective Action",
    "report.effectiveness": "Effectiveness",
    "report.deliverable": "Deliverable",
    "report.pdfUnavailable": "PDF generation is not available right now. Use the HTML or Markdown version instead.",

    "decision.go": "Go",
    "decision.go_with_conditions": "Go with Conditions",
    "decision.hold": "Hold",
    "decision.stop": "Stop",
    "decision.none": "None",
    "decision.pending": "Pending",

    "status.idea": "Idea",
    "status.active": "Active",
    "status.on_hold": "On Hold",
    "status.done": "Done",
    "status.abandoned": "Abandoned",

    "wpstatus.todo": "To Do",
    "wpstatus.doing": "In Progress",
    "wpstatus.blocked": "Blocked",
    "wpstatus.waiting": "Waiting",
    "wpstatus.done": "Done",
    "wpstatus.dropped": "Dropped",

    "risktype.risk": "Risk",
    "risktype.issue": "Issue",
    "risktype.opportunity": "Opportunity",

    "riskstatus.open": "Open",
    "riskstatus.monitoring": "Monitoring",
    "riskstatus.closed": "Closed",
  },

  de: {
    "report.status": "Status",
    "report.objectives": "Ziele",
    "report.scopeIn": "Im Umfang",
    "report.scopeOut": "Außerhalb des Umfangs",
    "report.successCriteria": "Erfolgskriterien",
    "report.workpackages": "Arbeitspakete",
    "report.milestones": "Meilensteine",
    "report.gate": "Gate",
    "report.decision": "Entscheidung",
    "report.decidedBy": "Entschieden von",
    "report.risks": "Risiken",
    "report.deviations": "Nichtkonformitäten",
    "report.lessonsLearned": "Erkenntnisse",
    "report.closureNote": "Abschlussnotiz",
    "report.owner": "Verantwortlich",
    "report.sponsor": "Sponsor",
    "report.decisionMaker": "Entscheidungsträger",
    "report.progress": "Fortschritt",
    "report.target": "Ziel",
    "report.start": "Start",
    "report.end": "Ende",
    "report.due": "Fällig",
    "report.reached": "Erreicht",
    "report.generated": "Erstellt",
    "report.none": "Keine",
    "report.pageHeader": "{title}",
    "report.pageOf": "Seite",
    "report.of": "von",
    "report.title": "Titel",
    "report.action": "Maßnahme",
    "report.score": "Bewertung",
    "report.type": "Typ",
    "report.cause": "Ursache",
    "report.correction": "Korrektur",
    "report.correctiveAction": "Korrekturmaßnahme",
    "report.effectiveness": "Wirksamkeit",
    "report.deliverable": "Liefergegenstand",
    "report.pdfUnavailable": "Die PDF-Erstellung ist derzeit nicht verfügbar. Verwenden Sie stattdessen die HTML- oder Markdown-Version.",

    "decision.go": "Freigabe",
    "decision.go_with_conditions": "Freigabe mit Auflagen",
    "decision.hold": "Zurückgestellt",
    "decision.stop": "Stopp",
    "decision.none": "Keine",
    "decision.pending": "Ausstehend",

    "status.idea": "Idee",
    "status.active": "Aktiv",
    "status.on_hold": "Pausiert",
    "status.done": "Abgeschlossen",
    "status.abandoned": "Aufgegeben",

    "wpstatus.todo": "Offen",
    "wpstatus.doing": "In Bearbeitung",
    "wpstatus.blocked": "Blockiert",
    "wpstatus.waiting": "Wartend",
    "wpstatus.done": "Abgeschlossen",
    "wpstatus.dropped": "Verworfen",

    "risktype.risk": "Risiko",
    "risktype.issue": "Problem",
    "risktype.opportunity": "Chance",

    "riskstatus.open": "Offen",
    "riskstatus.monitoring": "Unter Beobachtung",
    "riskstatus.closed": "Geschlossen",
  },
};

function instanceString(locale: string, key: string): string | undefined {
  const strings = INSTANCE.strings as Record<string, Record<string, unknown>> | undefined;

  let value: unknown = strings?.[locale];

  for (const segment of key.split(".")) {
    if (value === null || typeof value !== "object" || !Object.prototype.hasOwnProperty.call(value, segment)) {
      return undefined;
    }

    value = (value as Record<string, unknown>)[segment];
  }

  return typeof value === "string" ? value : undefined;
}

function interpolate(value: string, vars?: Record<string, string | number>): string {
  if (!vars) return value;

  return value.replace(/\{([^{}]+)\}/g, (placeholder, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : placeholder,
  );
}

export function serverT(locale: string, key: string, vars?: Record<string, string | number>): string {
  const resolvedLocale = STRINGS[locale] ? locale : "en";

  const value = instanceString(resolvedLocale, key) ?? STRINGS[resolvedLocale]?.[key] ?? STRINGS.en[key] ?? key;

  return interpolate(value, vars);
}

export function reportLocale(project: { language?: string | null }): string {
  if (project.language && POLICY.locales.includes(project.language)) {
    return project.language;
  }

  return POLICY.locales[0] ?? "en";
}
