# Keeping up with upstream

This repository is a snapshot of
[`robince/cloudflare-obsidian-livesync-mcp`](https://github.com/robince/cloudflare-obsidian-livesync-mcp)
taken at commit `a14fc4b`, with local changes on top (Workers Builds, the
Durable Object alarm backup, setup-URI script, and this documentation).

The snapshot was committed as a single squashed commit, so upstream history is
**not** an ancestor of ours. `git merge upstream/main` would try to merge two
unrelated trees and produce noise. Instead we keep an explicit pin and port
upstream work deliberately.

## The pin

`upstream.json` records three things:

```json
{
  "repository": "https://github.com/robince/cloudflare-obsidian-livesync-mcp.git",
  "branch": "main",
  "baseCommit": "a14fc4b96d346b774f17ce61d438fe075fad588f",
  "syncedAt": "2026-11-13"
}
```

`baseCommit` is the upstream commit our tree already contains. Everything after
it is "new". Bumping the pin is what marks work as reviewed.

## Commands

| Command | Does |
| --- | --- |
| `npm run upstream:check` | Fetch upstream and list commits and changed files since the pin, marking files we also changed. Add `-- --all` to list every file, `-- --no-fetch` to work offline. |
| `npm run upstream:diff -- <path>` | Print the upstream patch for one file. Use this when the file needs a hand port. |
| `npm run upstream:apply -- <path...>` | Apply the upstream patch for files we have not touched. Add `--3way` for files we have changed (staged result, review before committing). |
| `npm run upstream:accept -- --yes` | Move the pin to the current upstream head, after the ported work is tested. |
| `npm run test:upstream` | Unit tests for the tool itself. |

## Reading the report

```
2 new commits:
  a03a403  2026-11-13  Add second module
  7739a40  2026-11-13  Add extra feature and tweak storage

5 changed files  +8 -0
  M  README.md              changed here too - port by hand
  A  src/extra-feature.ts   applies cleanly
  M  src/index.ts           applies cleanly
  M  src/pouch-database.ts  changed here too - port by hand
```

- **applies cleanly** — we have not edited that file, so
  `upstream:apply` is safe.
- **changed here too** — both sides edited it. Read `upstream:diff` and port by
  hand, or try `--3way` and check the result.
- **deleted here** — we removed the file (for example the upstream PouchDB
  workflow). Decide whether the upstream change revives a need for it.
- **MCP-only** files live under `apps/cloudflare-obsidian-mcp/`. This
  deployment runs only the storage Worker, so they can normally be skipped.
- **Dependencies changed** — port, then `npm ci` and the full suite.

## Reviewing a new upstream release

Start from the repository, not from the diff tool:

1. Open
   `https://github.com/robince/cloudflare-obsidian-livesync-mcp/compare/<pinned>...main`
   and read the commits in order, including their descriptions.
2. Check the upstream `README.md`/`COMPATIBILITY.md` diff for changed
   requirements (runtime version, new binding, protocol behaviour).
3. Run `npm run upstream:check` here. It fetches the same repository, so the
   two views agree; the script adds what GitHub cannot show — which files **this**
   clone has also edited.
4. Read the patch of every commit you are considering:
   `npm run upstream:diff -- <path>`.
5. Apply the decision table below, then report before porting.

### Before accepting a port

- [ ] No new binding, cron, queue, or paid feature is required (free tier).
- [ ] Any new Durable Object `migrations` tag is copied into `wrangler.jsonc`.
- [ ] The alarm backup patch in `src/pouch-database.ts` still applies, or was
      re-applied by hand.
- [ ] `wrangler.jsonc` still has this deployment's Worker `name`, `crons: []`, the R2
      binding, and the `BACKUP_*` values.
- [ ] No upstream deploy script or `CLOUDFLARE_API_TOKEN` step was introduced.
- [ ] `npm run check:storage` passes and the suites for the touched area pass.
- [ ] `npm run dry-run` bundles.
- [ ] If deployed: `GET /vault` answers, and an Obsidian edit reaches the server.

## Porting workflow

1. `npm run upstream:check`
2. Read the commit subjects. Decide what is worth porting (see below).
3. For each file: `npm run upstream:apply -- <path>` or
   `npm run upstream:diff -- <path>` and edit by hand.
4. Run `npm run check:storage`, then the suites that the change touches
   (`npm test`, or `npx vitest run test/backup.test.ts` for backup work).
5. Deploy and confirm the Worker still serves `/vault` and that Obsidian syncs.
6. `npm run upstream:accept -- --yes`, then commit `upstream.json` together
   with the ported files.

Do these one upstream release at a time. A single `accept` that skips several
releases is fine as long as every change in between was reviewed.

## What is worth porting

| Upstream change | Port? |
| --- | --- |
| Storage Worker protocol, revisions, sequence, compaction, auth | Yes — this is our core. |
| Backup format, verification, restore, retention | Yes, and run the backup tests. |
| Durable Object schema/migrations | Yes, but check `migrations` in `wrangler.jsonc` first; a new tag must be added or existing data will not migrate. |
| Dependency bumps, especially security advisories | Usually yes; then `npm ci`, `npm run check:storage`, `npm test`, `npm run dry-run`. |
| MCP Worker (`apps/cloudflare-obsidian-mcp/`) | No, unless a shared package or the storage contract changes with it. |
| Staging/E2E tooling (`scripts/staging/`, `test/live`) | Only if we use it. |
| README/docs about the upstream deployment | Usually no; our README describes this deployment. |
| New Cloudflare feature requirements (compatibility date/flags) | Yes if storage needs them; verify with a dry run before pushing. |

When a change is unclear, read its commit message and the files it touches with
`npm run upstream:diff -- <path>` before deciding. Porting is a choice, not an
obligation: our deployment is storage-only and must stay on the free tier.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `pinned commit ... does not exist` | upstream force-pushed or rewrote history | find the equivalent commit (`git fetch --depth=...` or the GitHub compare view), set `baseCommit` to the newest commit whose changes we already have, then re-check. |
| `fatal: couldn't find remote ref main` | remote renamed its default branch | update `branch` in `upstream.json`. |
| `patch did not apply` | the file drifted, or the change depends on another file | apply the dependency first, or port by hand with `upstream:diff`. |
| `not changed upstream since the pin` | typo in the path, or the file was only renamed | run `upstream:check -- --all` and use the path shown there. |
| `remote "upstream" now points at ...` | `upstream.json` is the source of truth | expected; the script keeps the git remote in sync with the file. |

The script only reads from upstream. It never pushes, never touches `origin`,
and only writes `upstream.json` (on `accept`).
