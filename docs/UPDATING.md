# Updating from the package (upstream)

Your repository has two kinds of files:

- **Core**: everything except `instance/`. It comes from the package and is updated by merging.
- **Instance**: `instance/` is yours. The package never contains this folder, so a merge can never conflict with it.

The one rule: **do not edit core files in your repository.** If core needs a fix, make it in the package (or send it there) and merge it back. Then updates stay a plain, conflict-free merge.

## One-time: add the package as "upstream"

A fork already has it. For a repository created from the template:

```powershell
git remote add upstream https://github.com/NShoreAFCO/claude-project-tracker.git
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
- Release v0.3.0: migration 0007 (`npm run db:migrate:remote`); add the three `--underlay-*` theme tokens to `instance/theme.css`; re-run `npm run hook:install` on each machine; the gate lock now needs the gate to be reached (breaking, see `CHANGELOG.md`).
- Read `CHANGELOG.md` for anything else to do. Release R1 needs `policy.admins` in `instance/instance.config.json` (the admin email address or addresses, which must be among `deploy.allowedEmails`); until then `npm run setup:check` fails. Running `npm run setup` again asks for it.
- Release R5 enforces roles: viewers cannot write, and closing or reopening a project and verifying a `sign_off` need the `decider` role. Check the People view before you deploy and give the right people `decider`.
- Without a saved token file (`secrets/`), the scripts that call Cloudflare (`db:migrate:remote`, `deploy`, backup) use wrangler's own login: run `npx wrangler login` once (`npx wrangler whoami` shows the state). The account comes from the instance config. If neither a token nor a login exists, the message "run npm run setup first" appears.

## Sending a fix to the package

1. Fork the package repository (`gh repo fork NShoreAFCO/claude-project-tracker --clone`) if you don't have one.
2. Make the change there, with a test, and run `npm test` and `npm run check`. Keep your organisation's names out of core: the maintainers check pull requests for organisation names before merging.
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

## Reconstructing actual dates (one-off, after updating to 0.3.x)

Work packages created before the actual dates existed may lack `actual_start` / `actual_end`. `scripts/reconstruct-timeline.mjs` proposes them from the tracker's own history. It is a dry run unless you pass `--apply`.

Set the connection once in your terminal (the same variables the session-end hook uses):

```powershell
$env:TRACKER_URL = "https://<your-tracker-host>"
$env:TRACKER_CF_CLIENT_ID = "<service token id>"
$env:TRACKER_CF_CLIENT_SECRET = "<service token secret>"
```

Then, per project:

```powershell
node scripts/reconstruct-timeline.mjs --project <project-id>                      # table only
node scripts/reconstruct-timeline.mjs --project <project-id> --git <path-to-repo> # add commit dates of linked branches
node scripts/reconstruct-timeline.mjs --project <project-id> --apply              # write the changes
```

The table lists, per work package, the current and proposed start and end, and where each proposed value comes from. Check it before using `--apply`.

Start of a work package without one, first match wins: the earliest progress event (notes do not count; events of a work package that is still `todo` are ignored), the opening of a gate that unlocks it, the parent's start, the project start date, the project creation date. With `--git`, the first commit date on a linked branch replaces the gate, parent and project fallbacks and any later event date. The end is set for done work packages only: the date it was set to done, else the last commit, else the last progress event. The start is never later than the end. A gate counts as opening only if its latest decision is go. If `--git` is given and git fails (bad repository path, git missing, timeout), the script prints the error and exits with code 2 without proposing or writing anything.

`--apply` writes only the fields that change, as explicit sets through the REST API, and never overwrites an existing date. Exit codes: 0 success, 1 the tracker could not be read or a write failed, 2 bad usage or missing environment variables.
