// Line diff for context revisions: common prefix/suffix trimmed, LCS on the middle.
// Returns [{ op: "same" | "add" | "del", line }]. Above MAX_CELLS the middle is shown as delete-all + add-all.
const MAX_CELLS = 4_000_000;

export function lineDiff(oldText, newText) {
  const a = String(oldText ?? "").replace(/\r\n?/g, "\n").split("\n");
  const b = String(newText ?? "").replace(/\r\n?/g, "\n").split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) endA--, endB--;

  const out = a.slice(0, start).map((line) => ({ op: "same", line }));
  const A = a.slice(start, endA);
  const B = b.slice(start, endB);
  const n = A.length;
  const m = B.length;
  if (n * m > MAX_CELLS) {
    out.push(...A.map((line) => ({ op: "del", line })), ...B.map((line) => ({ op: "add", line })));
  } else {
    // dp[i][j] = LCS length of A[i..] and B[j..], stored row-major in one typed array
    const w = m + 1;
    const dp = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        dp[i * w + j] = A[i] === B[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (A[i] === B[j]) out.push({ op: "same", line: A[i++] }), j++;
      else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) out.push({ op: "del", line: A[i++] });
      else out.push({ op: "add", line: B[j++] });
    }
    while (i < n) out.push({ op: "del", line: A[i++] });
    while (j < m) out.push({ op: "add", line: B[j++] });
  }
  out.push(...a.slice(endA).map((line) => ({ op: "same", line })));
  return out;
}
