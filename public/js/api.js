// Thin fetch wrapper for /api/*. Access cookies ride along automatically (same origin).
export class ApiError extends Error {
  constructor(status, body) {
    super((body && (body.message || body.error)) || `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
  get isConflict() {
    return this.status === 409;
  }
  /** Machine-readable reason of a refused transition (409 body `current.code`), e.g. PROJECT_CLOSED. */
  get code() {
    return this.body?.current?.code ?? null;
  }
  get isAuth() {
    return this.status === 401 || this.status === 403;
  }
}

async function request(method, path, body, isForm = false) {
  const init = { method, credentials: "same-origin", headers: { Accept: "application/json" } };
  if (body !== undefined) {
    if (isForm) init.body = body;
    else {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
  }
  const res = await fetch(path, init);
  const type = res.headers.get("Content-Type") || "";
  const data = type.includes("application/json") ? await res.json().catch(() => null) : await res.text();
  if (!res.ok) throw new ApiError(res.status, typeof data === "object" ? data : { message: data });
  return data;
}

const q = (params) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") s.set(k, String(v));
  const str = s.toString();
  return str ? `?${str}` : "";
};

export const api = {
  whoami: () => request("GET", "/api/whoami"),
  projects: (filter = {}) => request("GET", `/api/projects${q(filter)}`),
  project: (id) => request("GET", `/api/projects/${encodeURIComponent(id)}`),
  createProject: (body) => request("POST", "/api/projects", body),
  updateProject: (id, patch, expected_version) =>
    request("PATCH", `/api/projects/${encodeURIComponent(id)}`, { ...patch, expected_version }),
  deleteProject: (id) => request("DELETE", `/api/projects/${encodeURIComponent(id)}`),

  moveWorkpackages: (id, to_project_id, ids) =>
    request("POST", `/api/projects/${encodeURIComponent(id)}/move-workpackages`, { to_project_id, ids }),

  persons: () => request("GET", "/api/persons"),
  createPerson: (body) => request("POST", "/api/persons", body),
  updatePerson: (id, body, expected_version) => request("PATCH", `/api/persons/${encodeURIComponent(id)}`, { ...body, expected_version }),
  updateMe: (body, expected_version) => request("PATCH", "/api/persons/me", { ...body, expected_version }),
  deletePerson: (id) => request("DELETE", `/api/persons/${encodeURIComponent(id)}`),

  trash: () => request("GET", "/api/trash"),
  restoreTrash: (kind, id) => request("POST", `/api/trash/${encodeURIComponent(kind)}/${encodeURIComponent(id)}/restore`),
  purgeTrash: (kind, id) => request("DELETE", `/api/trash/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`),
  deletePreview: (kind, id) => request("GET", `/api/delete-preview${q({ kind, id })}`),

  workpackages: (project_id) => request("GET", `/api/workpackages${q({ project_id })}`),
  createWp: (body) => request("POST", "/api/workpackages", body),
  updateWp: (id, body, expected_version) => request("PATCH", `/api/workpackages/${encodeURIComponent(id)}`, { ...body, expected_version }),
  deleteWp: (id) => request("DELETE", `/api/workpackages/${encodeURIComponent(id)}`),
  createMilestone: (body) => request("POST", "/api/milestones", body),
  updateMilestone: (id, body, expected_version) =>
    request("PATCH", `/api/milestones/${encodeURIComponent(id)}`, { ...body, expected_version }),
  deleteMilestone: (id) => request("DELETE", `/api/milestones/${encodeURIComponent(id)}`),
  recordDecision: (milestone_id, body) => request("POST", `/api/milestones/${encodeURIComponent(milestone_id)}/decisions`, body),
  gateOverride: (wp_id, reason) => request("POST", `/api/workpackages/${encodeURIComponent(wp_id)}/gate-override`, { reason }),
  createBaseline: (project_id, label) => request("POST", `/api/projects/${encodeURIComponent(project_id)}/baselines`, { label }),

  risks: (filter = {}) => request("GET", `/api/risks${q(filter)}`),
  createRisk: (body) => request("POST", "/api/risks", body),
  updateRisk: (id, body, expected_version) => request("PATCH", `/api/risks/${encodeURIComponent(id)}`, { ...body, expected_version }),
  deleteRisk: (id) => request("DELETE", `/api/risks/${encodeURIComponent(id)}`),

  linkBranch: (body) => request("POST", "/api/branches", body),
  deleteBranch: (id) => request("DELETE", `/api/branches/${encodeURIComponent(id)}`),
  setScores: (project_id, scores) => request("POST", "/api/scores", { project_id, scores }),
  logTokenCost: (body) => request("POST", "/api/token-cost", body),
  logProgress: (body) => request("POST", "/api/progress", body),

  events: (params) => request("GET", `/api/events${q(params)}`),
  inbox: () => request("GET", "/api/inbox"),
  assignInbox: (id, project_id) => request("POST", `/api/inbox/${id}/assign`, { project_id }),
  search: (query) => request("GET", `/api/search${q({ q: query })}`),

  contextList: (owner_kind, owner_id, inherited = false) =>
    request("GET", `/api/context${q({ owner_kind, owner_id, inherited: inherited ? "true" : "" })}`),
  contextGet: (id) => request("GET", `/api/context/${encodeURIComponent(id)}`),
  contextCreate: (body) => request("POST", "/api/context", body),
  contextReplace: (id, body) => request("PUT", `/api/context/${encodeURIComponent(id)}`, body),
  contextMeta: (id, body) => request("PATCH", `/api/context/${encodeURIComponent(id)}`, body),
  contextAppend: (id, body) => request("POST", `/api/context/${encodeURIComponent(id)}/append`, body),
  contextDelete: (id) => request("DELETE", `/api/context/${encodeURIComponent(id)}`),
  contextRevisions: (id) => request("GET", `/api/context/${encodeURIComponent(id)}/revisions`),
  contextRevision: (rev) => request("GET", `/api/context/revisions/${encodeURIComponent(rev)}`),
  contextRestore: (id, revision_id, expected_version) =>
    request("POST", `/api/context/${encodeURIComponent(id)}/restore`, { revision_id, expected_version }),
  contextUpload: (form) => request("POST", "/api/context/upload", form, true),
  bundle: (params) => request("GET", `/api/context/bundle${q(params)}`),
  bundleUrl: (params) => `/api/context/bundle${q({ ...params, format: "md" })}`,
};
