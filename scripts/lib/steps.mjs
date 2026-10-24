// Step runner for setup: each step reports what it did; the first failure stops the run with a plain fix.

/**
 * @param {Array<{ id: string, title: string, run: (ctx: object) => Promise<string | void> }>} steps
 * @param {object} ctx  passed to every step; ctx.afterStep() (optional) runs after each success
 * @param {(line: string) => void} log
 * @param {(text: string) => string} [scrub]  removes secret values from messages
 */
export async function runSteps(steps, ctx, log, scrub = (s) => s) {
  for (const step of steps) {
    try {
      const note = await step.run(ctx);
      await ctx.afterStep?.();
      log(`  ✓ ${step.title}${note ? ` — ${scrub(note)}` : ""}`);
    } catch (e) {
      log(`  ✗ ${step.title}`);
      log(`    ${scrub(e?.message ?? String(e))}`);
      log(`    Fix the problem above, then run the same command again. Finished steps are skipped or reused.`);
      return { ok: false, failedStep: step.id };
    }
  }
  return { ok: true };
}
