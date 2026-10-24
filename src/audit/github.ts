// GitHub REST client for the audit export (SPEC §8).
const GITHUB_API_BASE = "https://api.github.com";
export class GitHubError extends Error {
  readonly status: number;
  constructor(method: string, path: string, status: number, responseBody: string) {
    super(`${method.toUpperCase()} ${path} ${status}: ${responseBody.slice(0, 300)}`);
    this.name = "GitHubError";
    this.status = status;
  }
}
export interface FileChange {
  path: string;
  content: string | null;
}
export async function gh<T>(token: string, method: string, path: string, body?: unknown, accept?: string): Promise<T> {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const headers = new Headers({
    Authorization: `Bearer ${token}`,
    Accept: accept ?? "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "project-tracker-audit",
  });
  const init: RequestInit = {
    method: method.toUpperCase(),
    headers,
  };
  if (body !== undefined) {
    headers.set("Content-Type", "application/json");
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${GITHUB_API_BASE}${normalizedPath}`, init);
  if (!response.ok) {
    const responseBody = await response.text();
    throw new GitHubError(method, normalizedPath, response.status, responseBody);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  if (accept?.toLowerCase().includes("raw")) {
    return (await response.text()) as T;
  }
  return (await response.json()) as T;
}
export async function getDefaultBranch(token: string, repo: string): Promise<string> {
  const repository = await gh<{ default_branch: string }>(token, "GET", `/repos/${repo}`);
  return repository.default_branch;
}
export async function getHead(token: string, repo: string, branch: string): Promise<{ commitSha: string; treeSha: string }> {
  const reference = await gh<{ object: { sha: string } }>(token, "GET", `/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
  const commitSha = reference.object.sha;
  const commit = await gh<{ tree: { sha: string } }>(token, "GET", `/repos/${repo}/git/commits/${encodeURIComponent(commitSha)}`);
  return {
    commitSha,
    treeSha: commit.tree.sha,
  };
}

const contentsPath = (repo: string, path: string) => `/repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}`;

export async function listBlobPaths(token: string, repo: string, treeSha: string): Promise<Set<string>> {
  const res = await gh<{ truncated: boolean; tree: Array<{ path: string; type: string }> }>(
    token,
    "GET",
    `/repos/${repo}/git/trees/${encodeURIComponent(treeSha)}?recursive=1`,
  );
  if (res.truncated) throw new Error("tree truncated");
  return new Set(res.tree.filter((e) => e.type === "blob").map((e) => e.path));
}

/** Raw file text at `ref`, or null if the file does not exist. */
export async function readRawFile(token: string, repo: string, path: string, ref: string): Promise<string | null> {
  try {
    return await gh<string>(
      token,
      "GET",
      `${contentsPath(repo, path)}?ref=${encodeURIComponent(ref)}`,
      undefined,
      "application/vnd.github.raw+json",
    );
  } catch (e) {
    if (e instanceof GitHubError && e.status === 404) return null;
    throw e;
  }
}

/** One commit via the Git Data API (tree with inline content → commit → fast-forward ref). */
export async function commitFiles(
  token: string,
  repo: string,
  branch: string,
  parent: { commitSha: string; treeSha: string },
  changes: FileChange[],
  message: string,
): Promise<string> {
  const tree = changes.map((c) =>
    c.content === null
      ? { path: c.path, mode: "100644", type: "blob", sha: null }
      : { path: c.path, mode: "100644", type: "blob", content: c.content },
  );
  const newTree = await gh<{ sha: string }>(token, "POST", `/repos/${repo}/git/trees`, { base_tree: parent.treeSha, tree });
  const commit = await gh<{ sha: string }>(token, "POST", `/repos/${repo}/git/commits`, {
    message,
    tree: newTree.sha,
    parents: [parent.commitSha],
  });
  await gh(token, "PATCH", `/repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, { sha: commit.sha, force: false });
  return commit.sha;
}

function utf8Base64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(bin);
}

/** Fallback: one Contents API commit per file. Returns the number of files written or deleted. */
export async function putFilesViaContents(
  token: string,
  repo: string,
  branch: string,
  changes: FileChange[],
  message: string,
): Promise<number> {
  let n = 0;
  for (const c of changes) {
    const p = contentsPath(repo, c.path);
    let sha: string | undefined;
    try {
      sha = (await gh<{ sha: string }>(token, "GET", `${p}?ref=${encodeURIComponent(branch)}`)).sha;
    } catch (e) {
      if (!(e instanceof GitHubError && e.status === 404)) throw e;
    }
    if (c.content !== null) {
      await gh(token, "PUT", p, { message, content: utf8Base64(c.content), branch, ...(sha ? { sha } : {}) });
      n++;
    } else if (sha) {
      await gh(token, "DELETE", p, { message, sha, branch });
      n++;
    }
  }
  return n;
}
