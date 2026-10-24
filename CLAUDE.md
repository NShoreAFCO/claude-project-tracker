# Project tracker — instructions for Claude Code

- Spec: `docs/SPEC.md`. Verified API versions: `docs/VERIFIED.md`.
- Identity (name, theme, categories, seed, deploy config) lives in `instance/` (fallback `instance.example/`). Never put identity into core files.
- Never read, list, search or print anything in `secrets/` or `.dev.vars`.
- Verify with scripts (`npm test`, `npm run typecheck`, `npm run check`) before any browser check.
- Ask before deploying, pushing or deleting anything.
