# Updating from the package (upstream)

Your repository has two kinds of files:

- **Core**: everything except `instance/`. It comes from the package and is updated by merging.
- **Instance**: `instance/` is yours. The package never contains this folder, so a merge can never conflict with it.

The one rule: **do not edit core files in your repository.** If core needs a fix, make it in the package (or send it there) and merge it back. Then updates stay a plain, conflict-free merge.

## One-time: add the package as "upstream"

A fork already has it. For a repository created from the template:

```powershell
git remote add upstream https://github.com/<owner>/<package-repo>.git
git fetch upstream
git merge upstream/main --allow-unrelated-histories -m "Track the package as upstream"
```

`--allow-unrelated-histories` is needed only this first time, because a template copy starts with its own history. If git reports conflicts in that first merge, take the package's version of every core file, since you have not changed core:

```powershell
git checkout --theirs -- . ':!instance'
git add -A
git commit -m "Track the package as upstream"
```

## Each update

```powershell
git fetch upstream
git merge upstream/main
npm install
npm test
npm run check
npm run db:migrate:remote
npm run deploy
git push
```

- `npm test` and `npm run check` must pass before you deploy. If `check` reports a missing theme token, the update added one: add it to `instance/theme.css` (the update notes and `docs/THEMING.md` name it).
- `npm run db:migrate:remote` applies new database migrations, if any. It is safe to run when there are none.
- The package runs the same `typecheck`, `test` and `check` steps in GitHub Actions (`.github/workflows/ci.yml`) on every pull request and on `main`. `.github/` is core: do not edit it in a deployment, and the denylist in `npm run check` applies to it.
- Read the package's release notes for anything else to do.

## Sending a fix to the package

1. Fork the package repository (`gh repo fork <owner>/<package-repo> --clone`) if you don't have one.
2. Make the change there, with a test, and run `npm test` and `npm run check`. In the package itself, `checks.denylist` is `true`: your organisation's names must not appear in core.
3. Open a pull request against the package.

## For the package maintainers: bringing changes from a branded deployment

A deployment that follows the rule above has core files identical to the package. Changes made there in core can be brought over directly:

```powershell
# in the package repository
git remote add deployment https://github.com/<owner>/<deployment-repo>.git
git fetch deployment
git cherry-pick <commit>        # commits that only touch core
```

Commits that touch both core and `instance/` must be split first. Run `npm run check` before pushing; it fails if a deployment's name slipped into core.
